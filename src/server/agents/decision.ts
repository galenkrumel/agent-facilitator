import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext } from "agents";
import { DECISION_SCHEMA } from "../db/decision-schema.ts";
import { hashCredential, newCredential } from "../auth/credentials.ts";
import { newSessionId, readSessionId, SESSION_TTL_MS } from "../auth/sessions.ts";
import { permissionsFor } from "../domain/decisions.ts";
import { validateMessageBody } from "../domain/messages.ts";
import { validateSubmission, type InitialSubmissionInput } from "../domain/submissions.ts";
import type { FacilitatorWorkflowParams } from "../workflows/facilitator.ts";
import type {
  ActionItem,
  Confidence,
  Conflict,
  Crux,
  CurrentPosition,
  Decision,
  DecisionBootstrap,
  DecisionOption,
  DecisionRealtimeState,
  FacilitatorAnalysisResult,
  FacilitatorAssumption,
  FacilitatorContext,
  FacilitatorStatus,
  InitialSubmission,
  Message,
  Participant
} from "../../shared/types.ts";

/** What the owner supplies when framing a decision. */
export type FrameDecisionInput = {
  question: string;
  context?: string | null;
  /** 2–4 labels. `Other` is added automatically. */
  options: string[];
  /** Display names. The first is the owner. */
  participants: string[];
};

/** Credentials handed back once, at framing. Only hashes are persisted. */
export type FramedParticipant = { id: string; displayName: string; isOwner: boolean; credential: string };

type DecisionRow = {
  id: string;
  question: string;
  context: string | null;
  options: string;
  status: string;
  owner_participant_id: string;
  created_at: number;
  revealed_at: number | null;
  closed_at: number | null;
  outcome_option_id: string | null;
};

type SubmissionRow = {
  participant_id: string;
  option_id: string;
  confidence: number;
  reasons: string;
  submitted_at: number;
};

type MessageRow = {
  seq: number;
  author_participant_id: string | null;
  body: string;
  created_at: number;
};

type ParticipantRow = {
  id: string;
  display_name: string;
  is_owner: number;
  created_at: number;
  last_visited_at: number | null;
};

type FacilitatorMetaRow = {
  /** 0 when idle; otherwise when the in-flight analysis claimed the slot. */
  analysis_running: number;
  analysis_pending: number;
  last_analyzed_seq: number;
  last_error: string | null;
};

/**
 * How long one analysis may hold the single analysis slot.
 *
 * The Workflow releases the slot itself, whether it succeeds or fails. This
 * only covers the case where it never gets to: a Workflow that could not be
 * created, or an instance that died between steps. Without it one lost run
 * would silence the facilitator for the life of the decision.
 */
const ANALYSIS_TIMEOUT_MS = 5 * 60_000;

/** Per-connection identity, established at connect and kept across hibernation. */
type ConnectionState = { participantId: string };

/** Closes an unauthenticated WebSocket. Private-use close code. */
const UNAUTHENTICATED = 4401;

/**
 * Transactional authority for one active decision: participants, initial
 * submissions, current positions, messages, facilitator state, board
 * projection, visit state.
 *
 * The Durable Object's single-threaded execution is the serialization
 * boundary — every mutation is decided here, never in the Worker.
 */
export class DecisionAgent extends Agent<Env, DecisionRealtimeState> {
  onStart() {
    this.ctx.storage.sql.exec(DECISION_SCHEMA);
  }

  /**
   * The realtime projection is derived from SQLite by this Agent and nothing
   * else. The Agents SDK also lets a connected client push state; here that
   * would let one participant announce to every other browser a version SQLite
   * never produced, so a client-sourced update is refused rather than relayed.
   */
  validateStateChange(_next: DecisionRealtimeState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("the decision projection is read-only");
  }

  // -------------------------------------------------------------------------
  // Durable Object RPC — called by the Worker, never by a browser.

  /**
   * Frames the decision this agent is named for. One decision per agent, so a
   * second call is a programming error rather than an update.
   */
  async frameDecision(input: FrameDecisionInput): Promise<FramedParticipant[]> {
    if (this.decisionRow()) throw new Error("decision already framed");

    const labels = input.options.map((o) => o.trim()).filter(Boolean);
    if (labels.length < 2 || labels.length > 4) throw new Error("a decision needs 2–4 options");
    const names = input.participants.map((p) => p.trim()).filter(Boolean);
    if (names.length === 0) throw new Error("a decision needs an owner");
    if (!input.question.trim()) throw new Error("a decision needs a question");

    // The application adds `Other`; the owner does not have to think of it.
    const options: DecisionOption[] = labels
      .map((label, i) => ({ id: `opt-${i + 1}`, label }))
      .concat({ id: "other", label: "Other" });

    const framed: FramedParticipant[] = names.map((displayName, i) => ({
      id: crypto.randomUUID(),
      displayName,
      isOwner: i === 0,
      credential: newCredential()
    }));
    // Hash before writing: no `await` may separate the inserts below, or
    // another request could observe a half-framed decision.
    const hashes = await Promise.all(framed.map((p) => hashCredential(p.credential)));

    const now = Date.now();
    this.sql`
      INSERT INTO decisions (id, question, context, options, status, owner_participant_id, created_at)
      VALUES (${this.name}, ${input.question.trim()}, ${input.context?.trim() || null},
              ${JSON.stringify(options)}, ${"SUBMIT"}, ${framed[0]!.id}, ${now})
    `;
    framed.forEach((p, i) => {
      this.sql`
        INSERT INTO participants (id, display_name, credential_hash, is_owner, created_at)
        VALUES (${p.id}, ${p.displayName}, ${hashes[i]!}, ${p.isOwner ? 1 : 0}, ${now})
      `;
    });
    this.sql`INSERT INTO facilitator_meta (id) VALUES (1)`;
    this.publishProjection();
    return framed;
  }

  /**
   * Exchanges a persistent participant credential for a browser-local session.
   * The credential stays reusable — from another browser, another device, or
   * the same link opened again later.
   */
  async startSession(credential: string): Promise<string | null> {
    const hash = await hashCredential(credential);
    const [participant] = this.sql<{ id: string }>`
      SELECT id FROM participants WHERE credential_hash = ${hash}
    `;
    if (!participant) return null;

    const sessionId = newSessionId();
    const now = Date.now();
    this.sql`
      INSERT INTO sessions (id_hash, participant_id, created_at, expires_at)
      VALUES (${await hashCredential(sessionId)}, ${participant.id}, ${now}, ${now + SESSION_TTL_MS})
    `;
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // WebSocket

  /**
   * Authenticates the connection from its session cookie. The Agent, not the
   * Worker, resolves the session: it owns the sessions table, so there is no
   * second hop and no header for the Worker to have to be trusted about.
   */
  async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const sessionId = readSessionId(ctx.request, this.name);
    const participantId = sessionId ? await this.participantForSession(sessionId) : null;
    if (!participantId) {
      connection.close(UNAUTHENTICATED, "no valid session for this decision");
      return;
    }
    connection.setState({ participantId });
  }

  private async participantForSession(sessionId: string): Promise<string | null> {
    const [row] = this.sql<{ participant_id: string; expires_at: number }>`
      SELECT participant_id, expires_at FROM sessions WHERE id_hash = ${await hashCredential(sessionId)}
    `;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.sql`DELETE FROM sessions WHERE expires_at <= ${Date.now()}`;
      return null;
    }
    return row.participant_id;
  }

  /** The authenticated participant behind the current call. */
  private viewerId(): string {
    const { connection } = getCurrentAgent<DecisionAgent>();
    const participantId = (connection as Connection<ConnectionState> | undefined)?.state?.participantId;
    if (!participantId) throw new Error("unauthenticated");
    return participantId;
  }

  // -------------------------------------------------------------------------
  // Callable from the browser

  /**
   * Records the viewer's initial position, revealing the decision if that was
   * the last one outstanding. Returns the state the browser should now render.
   */
  @callable()
  async submitInitialPosition(input: InitialSubmissionInput): Promise<DecisionBootstrap> {
    await this.submitFor(this.viewerId(), input);
    return this.getBootstrap();
  }

  /** Owner-forced Reveal: Submit has run its course whether or not everyone answered. */
  @callable()
  async declareSubmissionsComplete(): Promise<DecisionBootstrap> {
    await this.declareCompleteFor(this.viewerId());
    return this.getBootstrap();
  }

  /** Adds the viewer's message to the one shared discussion thread. */
  @callable()
  async postMessage(body: string): Promise<DecisionBootstrap> {
    await this.postMessageFor(this.viewerId(), body);
    return this.getBootstrap();
  }

  // -------------------------------------------------------------------------
  // Lifecycle. Each takes the participant explicitly rather than reading the
  // connection, so the transactional core can be driven directly by runtime
  // tests; the `@callable()` shims above are the only authenticated entrance.

  /**
   * The submission transaction. Everything between the first read and the last
   * write is synchronous: a Durable Object only interleaves work at an `await`,
   * so with none here no concurrent call can observe a half-applied submission.
   * `transactionSync` adds the rollback — a throw anywhere undoes the lot.
   */
  async submitFor(participantId: string, input: InitialSubmissionInput): Promise<void> {
    const revealed = this.ctx.storage.transactionSync(() => {
      const decision = this.decision();
      // Also the post-Reveal guard: a submission that arrives after Reveal, or
      // races one, finds the decision already out of SUBMIT and is rejected.
      if (decision.status !== "SUBMIT") {
        throw new Error("Initial submissions are closed — this decision has been revealed.");
      }
      const [participant] = this.sql<{ id: string }>`
        SELECT id FROM participants WHERE id = ${participantId}
      `;
      if (!participant) throw new Error("You are not a participant in this decision.");
      // Belt and braces: initial_submissions.participant_id is also a primary
      // key, so the invariant holds even if this check were ever skipped.
      const [existing] = this.sql<{ participant_id: string }>`
        SELECT participant_id FROM initial_submissions WHERE participant_id = ${participantId}
      `;
      if (existing) throw new Error("You have already submitted an initial position.");

      const submission = validateSubmission(decision.options, input);
      const now = Date.now();
      this.sql`
        INSERT INTO initial_submissions (participant_id, option_id, confidence, reasons, submitted_at)
        VALUES (${participantId}, ${submission.optionId}, ${submission.confidence},
                ${JSON.stringify(submission.reasons)}, ${now})
      `;

      // Everyone invited has answered, so Submit has ended on its own. Reveal
      // rides inside this same transaction: there is no moment at which the
      // final submission exists but the decision has not moved on.
      const [outstanding] = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM participants p
        WHERE NOT EXISTS (SELECT 1 FROM initial_submissions s WHERE s.participant_id = p.id)
      `;
      if (outstanding!.n > 0) return false;
      this.revealDecision(now);
      return true;
    });

    this.publishProjection();
    if (revealed) await this.scheduleAnalysis("REVEAL");
  }

  /**
   * Owner-forced Reveal. Participation is voluntary, so a participant who has
   * not submitted must not be able to hold the decision up.
   */
  async declareCompleteFor(participantId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const decision = this.decision();
      if (decision.ownerParticipantId !== participantId) {
        throw new Error("Only the owner can declare submissions complete.");
      }
      if (decision.status !== "SUBMIT") {
        throw new Error("This decision has already been revealed.");
      }
      this.revealDecision(Date.now());
    });

    this.publishProjection();
    await this.scheduleAnalysis("REVEAL");
  }

  /**
   * The canonical SUBMIT → DISCUSS transition. Automatic and owner-forced
   * Reveal both come through here; there is deliberately no second lifecycle
   * path to keep in step. The caller supplies the transaction.
   */
  private revealDecision(now: number): void {
    this.sql`UPDATE decisions SET status = ${"DISCUSS"}, revealed_at = ${now}`;
    // Submitters carry their initial position forward as their current one.
    // Non-submitters get no row at all: they have no position to hold, and
    // their initial submission stays absent rather than becoming an empty one.
    this.sql`
      INSERT INTO current_positions (participant_id, option_id, confidence, updated_at)
      SELECT participant_id, option_id, confidence, ${now} FROM initial_submissions
    `;
  }

  /**
   * The message transaction. One shared chronological thread: no replies, no
   * editing, no deletion, so a message is only ever appended. Synchronous
   * throughout for the same reason submission is — a Durable Object cannot
   * interleave without an `await`, so no concurrent call can see half of it.
   *
   * The sequence number is allocated by SQLite. `AUTOINCREMENT` never reuses a
   * number, so the canonical order of the transcript stays stable even across
   * a rolled-back attempt.
   */
  async postMessageFor(participantId: string, body: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const decision = this.decision();
      if (decision.status !== "DISCUSS") {
        throw new Error(
          decision.status === "SUBMIT"
            ? "The discussion opens once initial positions are revealed."
            : "This decision is closed — the discussion is frozen."
        );
      }
      const [participant] = this.sql<{ id: string }>`
        SELECT id FROM participants WHERE id = ${participantId}
      `;
      if (!participant) throw new Error("You are not a participant in this decision.");

      this.sql`
        INSERT INTO messages (author_participant_id, body, created_at)
        VALUES (${participantId}, ${validateMessageBody(body)}, ${Date.now()})
      `;
    });

    this.publishProjection();
    // Deliberately last: the facilitator is handed a message that is already
    // committed and already on everyone's screen. AI is not in the transaction.
    await this.scheduleAnalysis("DISCUSSION");
  }

  // -------------------------------------------------------------------------
  // Realtime

  /**
   * Synchronises the projection to every connected browser.
   *
   * Always after a transaction has returned, never inside one: a broadcast
   * cannot be rolled back, so a projection published from within a transaction
   * could describe a decision that never ended up existing.
   */
  private publishProjection(): void {
    this.setState(this.projection());
  }

  /**
   * The projection: counts and versions, never content.
   *
   * A browser watching this learns only that something moved, and re-reads the
   * decision from the Agent — so SQLite stays the single authority and no
   * private detail (an option, a confidence, a message body) rides on the
   * broadcast. Every version is derived from the rows themselves rather than
   * kept in a counter, which cannot drift from what was actually committed.
   */
  private projection(): DecisionRealtimeState {
    const decision = this.decision();
    const [counts] = this.sql<{
      participants: number;
      submitted: number;
      messages: number;
      messages_version: number;
      positions_version: number;
      last_message_at: number | null;
      board_version: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM participants) AS participants,
        (SELECT COUNT(*) FROM initial_submissions) AS submitted,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COALESCE(MAX(seq), 0) FROM messages) AS messages_version,
        (SELECT COALESCE(MAX(updated_at), 0) FROM current_positions) AS positions_version,
        (SELECT MAX(created_at) FROM messages) AS last_message_at,
        MAX(
          (SELECT COALESCE(MAX(updated_at), 0) FROM facilitator_cruxes),
          (SELECT COALESCE(MAX(created_at), 0) FROM facilitator_action_items)
        ) AS board_version
    `;
    const meta = this.facilitatorMeta();

    return {
      status: decision.status,
      participantCount: counts!.participants,
      submittedCount: counts!.submitted,
      messageCount: counts!.messages,
      messagesVersion: counts!.messages_version,
      positionsVersion: counts!.positions_version,
      // Derived like the others, from the facilitator state the board is
      // projected out of. M5 adds the projection itself; the version moves as
      // soon as there is something for it to move for.
      boardVersion: counts!.board_version,
      facilitatorStatus: facilitatorStatus(meta),
      // The last thing the team can see happening. Reveal is the first such
      // moment: before it there is only private submission, which is nobody
      // else's activity to observe.
      lastActivityAt: counts!.last_message_at ?? decision.revealedAt
    };
  }

  // -------------------------------------------------------------------------
  // The facilitator boundary. Analysis is scheduled from here, runs in the
  // Workflow, and comes back through here to be validated and applied — the
  // Agent stays the only thing that writes decision state.

  /**
   * Hands analysis to the Workflow — strictly after the transaction has
   * committed, and strictly outside it. Whatever the participant did is
   * durable and already on every screen by the time this runs, so a scheduling
   * failure is recorded and swallowed: no AI problem may undo work
   * participants have already been shown.
   */
  private async scheduleAnalysis(type: FacilitatorWorkflowParams["type"]): Promise<void> {
    if (!this.ctx.storage.transactionSync(() => this.claimAnalysisSlot())) {
      // Coalesced into the run already in flight. It will pick these messages
      // up when it finishes, so nothing is lost by not starting a second one.
      this.publishProjection();
      return;
    }
    this.publishProjection();

    try {
      await this.env.FACILITATOR_WORKFLOW.create({ params: { decisionId: this.name, type } });
    } catch (e) {
      console.error(`could not schedule ${type} analysis for decision ${this.name}`, e);
      await this.failAnalysis(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Takes the single analysis slot, or marks that there is more to analyze.
   *
   * Only one analysis runs at a time: concurrent runs would race to write the
   * same derived state, and each reads the whole transcript anyway, so a second
   * one would mostly re-read what the first is already reading. Messages that
   * arrive mid-run set `analysis_pending`, and the finishing run schedules the
   * follow-up. Synchronous, so the read and the write cannot be interleaved.
   */
  private claimAnalysisSlot(): boolean {
    const meta = this.facilitatorMeta();
    if (!meta) return false; // no decision has been framed here
    const now = Date.now();
    if (meta.analysis_running && now - meta.analysis_running < ANALYSIS_TIMEOUT_MS) {
      this.sql`UPDATE facilitator_meta SET analysis_pending = 1 WHERE id = 1`;
      return false;
    }
    this.sql`
      UPDATE facilitator_meta
      SET analysis_running = ${now}, analysis_pending = 0, last_error = NULL WHERE id = 1
    `;
    return true;
  }

  /**
   * Everything the facilitator is allowed to read, as one snapshot.
   *
   * The Workflow calls this instead of being handed the transcript: state lives
   * here, and a Workflow that carried the discussion in its own payload would
   * be a second copy of it that could be resumed with an old one.
   */
  async getFacilitatorContext(): Promise<FacilitatorContext> {
    const decision = this.decision();
    const meta = this.facilitatorMeta();
    const submissions = this.submissions();

    return {
      decision,
      participants: this.participants(),
      // The facilitator is blind to initial submissions until the Reveal, in
      // exactly the way participants are. Analysis is never scheduled during
      // SUBMIT, so this only ever guards a mistake — but it guards it here,
      // where the data would otherwise leave the Agent.
      submissions: decision.status === "SUBMIT" ? [] : submissions,
      positions: this.positions(),
      messages: this.messages(),
      assumptions: this.sql<{
        id: string;
        participant_id: string | null;
        statement: string;
        source: string;
        status: string;
        first_seen_seq: number;
        updated_at: number;
      }>`SELECT * FROM facilitator_assumptions ORDER BY first_seen_seq, statement`.map(
        (r): FacilitatorAssumption => ({
          id: r.id,
          participantId: r.participant_id,
          statement: r.statement,
          source: r.source as FacilitatorAssumption["source"],
          status: r.status as FacilitatorAssumption["status"],
          firstSeenSeq: r.first_seen_seq,
          updatedAt: r.updated_at
        })
      ),
      cruxes: this.cruxes(),
      conflicts: this.sql<{
        id: string;
        description: string;
        participant_ids: string;
        status: string;
        created_at: number;
      }>`SELECT * FROM facilitator_conflicts ORDER BY created_at`.map(
        (r): Conflict => ({
          id: r.id,
          description: r.description,
          participantIds: JSON.parse(r.participant_ids),
          status: r.status as Conflict["status"],
          createdAt: r.created_at
        })
      ),
      actionItems: this.actionItems(),
      meta: {
        analysisRunning: Boolean(meta?.analysis_running),
        analysisPending: meta?.analysis_pending === 1,
        lastAnalyzedSeq: meta?.last_analyzed_seq ?? 0,
        lastError: meta?.last_error ?? null
      }
    };
  }

  /**
   * Applies a validated analysis, and releases the analysis slot.
   *
   * Returns whether the result was applied. Two things are refused here rather
   * than in the Workflow, because only the Agent knows them:
   *
   * - a result with no run in flight is a duplicate — a retried Workflow step,
   *   or a result whose slot was reclaimed after its run went missing;
   * - a result that analyzed less of the transcript than the last applied one
   *   is stale, and must not overwrite the newer understanding.
   *
   * The application itself is one synchronous transaction. Anything the result
   * still gets wrong — a participant who does not exist, a duplicate id —
   * throws, and the whole thing rolls back: malformed AI output leaves the
   * decision exactly as it was.
   */
  async applyAnalysis(result: FacilitatorAnalysisResult): Promise<boolean> {
    const outcome = this.ctx.storage.transactionSync(() => {
      const meta = this.facilitatorMeta();
      if (!meta || !meta.analysis_running) return { applied: false, pending: false };

      const stale = result.analyzedThroughSeq < meta.last_analyzed_seq;
      if (!stale) this.replaceFacilitatorState(result);

      // Everything now in the transcript has been accounted for, including any
      // message the facilitator just posted — which is why that message does
      // not become "new discussion" for the next run to react to.
      const [latest] = this.sql<{ seq: number }>`SELECT COALESCE(MAX(seq), 0) AS seq FROM messages`;
      this.sql`
        UPDATE facilitator_meta
        SET analysis_running = 0,
            analysis_pending = 0,
            last_analyzed_seq = ${stale ? meta.last_analyzed_seq : latest!.seq},
            last_error = NULL
        WHERE id = 1
      `;
      return { applied: !stale, pending: meta.analysis_pending === 1 };
    });

    this.publishProjection();
    if (outcome.pending) await this.scheduleAnalysis("DISCUSSION");
    return outcome.applied;
  }

  /**
   * Gives up on the current analysis: the model failed, its output never passed
   * validation, or the Workflow could not be started. The decision is untouched
   * — the failure is recorded so the browser can show the facilitator as
   * degraded, and the slot is freed so the next message can try again.
   */
  async failAnalysis(reason: string): Promise<void> {
    const pending = this.ctx.storage.transactionSync(() => {
      const meta = this.facilitatorMeta();
      this.sql`
        UPDATE facilitator_meta
        SET analysis_running = 0, analysis_pending = 0, last_error = ${reason.slice(0, 500)}
        WHERE id = 1
      `;
      return meta?.analysis_pending === 1;
    });

    this.publishProjection();
    if (pending) await this.scheduleAnalysis("DISCUSSION");
  }

  /**
   * Replaces the facilitator's derived state with what the latest analysis
   * understood, inside the caller's transaction.
   *
   * Replaced rather than accumulated: every run re-reads the whole discussion
   * and returns its current reading of it, so the alternative is merging two
   * readings of the same messages and slowly collecting near-duplicates of
   * every assumption the model has ever worded differently. Ids and first-seen
   * sequences survive for items whose text is unchanged, so a crux that has
   * been open since message 4 still says so.
   */
  private replaceFacilitatorState(result: FacilitatorAnalysisResult): void {
    const now = Date.now();
    const known = new Set(this.sql<{ id: string }>`SELECT id FROM participants`.map((r) => r.id));
    // A participant the analysis invented would otherwise become a row
    // referencing nobody. The foreign keys would catch it too; this catches it
    // with a message that says what happened.
    const participant = (id: string | null): string | null => {
      if (id !== null && !known.has(id)) throw new Error(`analysis referenced unknown participant ${id}`);
      return id;
    };
    const key = (text: string) => text.trim().toLowerCase();

    const priorAssumptions = new Map(
      this.sql<{ id: string; statement: string; first_seen_seq: number }>`
        SELECT id, statement, first_seen_seq FROM facilitator_assumptions
      `.map((r) => [key(r.statement), r])
    );
    this.sql`DELETE FROM facilitator_assumptions`;
    for (const a of dedupe(result.assumptions, (a) => key(a.statement))) {
      const prior = priorAssumptions.get(key(a.statement));
      this.sql`
        INSERT INTO facilitator_assumptions
          (id, participant_id, statement, source, status, first_seen_seq, updated_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${participant(a.participantId)}, ${a.statement},
                ${a.source}, ${a.status}, ${prior?.first_seen_seq ?? a.firstSeenSeq}, ${now})
      `;
    }

    const priorCruxes = new Map(
      this.sql<{ id: string; question: string; created_at: number }>`
        SELECT id, question, created_at FROM facilitator_cruxes
      `.map((r) => [key(r.question), r])
    );
    this.sql`DELETE FROM facilitator_cruxes`;
    for (const c of dedupe(result.cruxes, (c) => key(c.question))) {
      const prior = priorCruxes.get(key(c.question));
      this.sql`
        INSERT INTO facilitator_cruxes (id, question, status, created_at, updated_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${c.question}, ${c.status},
                ${prior?.created_at ?? now}, ${now})
      `;
    }

    const priorConflicts = new Map(
      this.sql<{ id: string; description: string; created_at: number }>`
        SELECT id, description, created_at FROM facilitator_conflicts
      `.map((r) => [key(r.description), r])
    );
    this.sql`DELETE FROM facilitator_conflicts`;
    for (const c of dedupe(result.conflicts, (c) => key(c.description))) {
      const prior = priorConflicts.get(key(c.description));
      c.participantIds.forEach(participant);
      this.sql`
        INSERT INTO facilitator_conflicts (id, description, participant_ids, status, created_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${c.description},
                ${JSON.stringify(c.participantIds)}, ${c.status}, ${prior?.created_at ?? now})
      `;
    }

    const priorItems = new Map(
      this.sql<{ id: string; description: string; created_at: number }>`
        SELECT id, description, created_at FROM facilitator_action_items
      `.map((r) => [key(r.description), r])
    );
    this.sql`DELETE FROM facilitator_action_items`;
    for (const item of dedupe(result.actionItems, (i) => key(i.description))) {
      const prior = priorItems.get(key(item.description));
      this.sql`
        INSERT INTO facilitator_action_items (id, description, owner_participant_id, created_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${item.description},
                ${participant(item.ownerParticipantId)}, ${prior?.created_at ?? now})
      `;
    }

    // M5 applies `positionChanges`: only an explicit change may move a current
    // position, and one that omits confidence has to be followed up. Until
    // then the facilitator does not report them, and could not apply one here
    // if it did — a current position is a participant's own to state.

    if (result.intervention) this.postIntervention(result.intervention, now);
  }

  /**
   * Posts the facilitator's message into the same thread, with no author.
   *
   * Deliberately not `postMessageFor`: that schedules analysis, and an
   * intervention that triggered the analysis that produced the next
   * intervention would be a facilitator talking to itself.
   */
  private postIntervention(body: string, now: number): void {
    const [last] = this.sql<{ body: string }>`
      SELECT body FROM messages WHERE author_participant_id IS NULL ORDER BY seq DESC LIMIT 1
    `;
    // The crudest possible guard against repeating an intervention: refuse to
    // say the same thing twice in a row. M5 owns the real question — whether
    // the underlying issue has materially changed.
    if (last?.body === body) return;
    this.sql`
      INSERT INTO messages (author_participant_id, body, created_at)
      VALUES (${null}, ${body}, ${now})
    `;
  }

  private facilitatorMeta(): FacilitatorMetaRow | undefined {
    return this.sql<FacilitatorMetaRow>`
      SELECT analysis_running, analysis_pending, last_analyzed_seq, last_error
      FROM facilitator_meta WHERE id = 1
    `[0];
  }

  /** Everything the browser needs to render the decision on connect. */
  @callable()
  getBootstrap(): DecisionBootstrap {
    const viewerId = this.viewerId();
    const decision = this.decision();
    const participants = this.participants();
    const viewer = participants.find((p) => p.id === viewerId);
    if (!viewer) throw new Error("unknown participant");

    const submissions = this.submissions();
    const ownSubmission = submissions.find((s) => s.participantId === viewerId) ?? null;

    return {
      decision,
      viewer: { participantId: viewer.id, displayName: viewer.displayName, isOwner: viewer.isOwner },
      participants,
      permissions: permissionsFor(decision, viewer, ownSubmission !== null),
      ownSubmission,
      // Who has submitted is public during Submit; what they submitted is not.
      submittedParticipantIds: submissions.map((s) => s.participantId),
      submissions: decision.status === "SUBMIT" ? [] : submissions,
      positions: this.positions(),
      messages: this.messages()
    };
  }

  // -------------------------------------------------------------------------

  private decisionRow(): DecisionRow | undefined {
    return this.sql<DecisionRow>`SELECT * FROM decisions LIMIT 1`[0];
  }

  private decision(): Decision {
    const row = this.decisionRow();
    if (!row) throw new Error("decision not found");
    return {
      id: row.id,
      question: row.question,
      context: row.context,
      options: JSON.parse(row.options),
      status: row.status as Decision["status"],
      ownerParticipantId: row.owner_participant_id,
      createdAt: row.created_at,
      revealedAt: row.revealed_at,
      closedAt: row.closed_at,
      outcomeOptionId: row.outcome_option_id
    };
  }

  /**
   * The whole discussion in sequence order. Short enough to send in full, which
   * makes the bootstrap a refresh reads and the re-read a realtime update
   * triggers the same path — so a live browser cannot drift from a refreshed one.
   */
  private messages(): Message[] {
    return this.sql<MessageRow>`
      SELECT seq, author_participant_id, body, created_at FROM messages ORDER BY seq
    `.map(
      (r): Message => ({
        seq: r.seq,
        author: r.author_participant_id
          ? { kind: "PARTICIPANT", participantId: r.author_participant_id }
          : { kind: "FACILITATOR" },
        body: r.body,
        createdAt: r.created_at
      })
    );
  }

  private submissions(): InitialSubmission[] {
    return this.sql<SubmissionRow>`SELECT * FROM initial_submissions ORDER BY submitted_at`.map(
      (r): InitialSubmission => ({
        participantId: r.participant_id,
        optionId: r.option_id,
        confidence: r.confidence as Confidence,
        reasons: JSON.parse(r.reasons),
        submittedAt: r.submitted_at
      })
    );
  }

  private positions(): CurrentPosition[] {
    return this.sql<{
      participant_id: string;
      option_id: string | null;
      confidence: number | null;
      updated_at: number;
    }>`SELECT * FROM current_positions`.map((r) => ({
      participantId: r.participant_id,
      optionId: r.option_id,
      confidence: r.confidence as Confidence | null,
      updatedAt: r.updated_at
    }));
  }

  private cruxes(): Crux[] {
    return this.sql<{
      id: string;
      question: string;
      status: string;
      created_at: number;
      updated_at: number;
    }>`SELECT * FROM facilitator_cruxes ORDER BY created_at`.map((r) => ({
      id: r.id,
      question: r.question,
      status: r.status as Crux["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  private actionItems(): ActionItem[] {
    return this.sql<{
      id: string;
      description: string;
      owner_participant_id: string | null;
      created_at: number;
    }>`SELECT * FROM facilitator_action_items ORDER BY created_at`.map((r) => ({
      id: r.id,
      description: r.description,
      ownerParticipantId: r.owner_participant_id,
      createdAt: r.created_at
    }));
  }

  private participants(): Participant[] {
    // Owner first, then alphabetical. Framing writes every participant with
    // the same `created_at`, so ordering by it alone breaks ties on UUID —
    // arbitrary, and different on every decision.
    return this.sql<ParticipantRow>`
      SELECT id, display_name, is_owner, created_at, last_visited_at
      FROM participants ORDER BY is_owner DESC, display_name ASC, created_at
    `.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      isOwner: r.is_owner === 1,
      createdAt: r.created_at,
      lastVisitedAt: r.last_visited_at
    }));
  }
}

/**
 * What the browser is told about the facilitator. `ERROR` is not a failure of
 * the decision — it means the last analysis did not complete, which the team
 * can see and ignore, because nothing they can do depends on it.
 */
function facilitatorStatus(meta: FacilitatorMetaRow | undefined): FacilitatorStatus {
  if (meta?.analysis_running) return "ANALYZING";
  return meta?.last_error ? "ERROR" : "IDLE";
}

/** First occurrence wins. Two assumptions with the same text are one row. */
function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
