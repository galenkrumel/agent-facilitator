import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext } from "agents";
import { DECISION_SCHEMA } from "../db/decision-schema.ts";
import { hashCredential, newCredential } from "../auth/credentials.ts";
import { newSessionId, readSessionId, SESSION_TTL_MS } from "../auth/sessions.ts";
import { composeBrief } from "../domain/brief.ts";
import { composeClosingAdvisory, significantLearnings } from "../domain/closing.ts";
import { permissionsFor } from "../domain/decisions.ts";
import { validateMessageBody } from "../domain/messages.ts";
import { validateSubmission, type InitialSubmissionInput } from "../domain/submissions.ts";
import type { FacilitatorWorkflowParams } from "../workflows/facilitator.ts";
import type {
  ActionItem,
  BoardView,
  ClosedDecisionRecord,
  ClosingAdvisory,
  ClosingMemo,
  ClosingMemoRecord,
  ClosingMemoStatus,
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
  FacilitatorIntervention,
  FacilitatorStatus,
  InitialSubmission,
  Intervention,
  Message,
  ObservedPositionChange,
  Participant,
  PendingParticipantRequest,
  StateBrief
} from "../../shared/types.ts";

/** What the owner supplies when framing a decision. */
export type FrameDecisionInput = {
  question: string;
  context?: string | null;
  /** 2–4 labels. `Other` is added automatically. */
  options: string[];
  /** Display names. The first is the owner. */
  participants: string[];
  /**
   * Optional history the decision is framed as already having: the submissions
   * that were made and the discussion that followed them.
   *
   * This is how a decision is created part-way through its life — M7's seeded
   * scenario — and it is deliberately part of framing rather than a second
   * "seed" entrance. What comes out is an ordinary decision: the same tables,
   * the same Reveal, the same transcript, and a facilitator that then reads
   * that transcript like any other. Nothing downstream can tell the
   * difference, because there is no difference to tell.
   *
   * Indices into `participants` and `options`, because the caller is naming
   * people and options it has just supplied and does not know the ids this
   * call is about to mint.
   */
  submissions?: SeededSubmission[];
  messages?: SeededMessage[];
};

/** One participant's initial submission, as pre-existing state. */
export type SeededSubmission = {
  participant: number;
  option: number;
  confidence: number;
  reasons: string[];
};

/** One message already in the thread, backdated by `minutesAgo`. */
export type SeededMessage = { participant: number; body: string; minutesAgo: number };

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

type ClosingMemoRow = {
  status: ClosingMemoStatus;
  memo: string | null;
  failure: string | null;
  requested_at: number;
  completed_at: number | null;
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
   *
   * `submissions` and `messages` let it be framed as already having a past —
   * see `FrameDecisionInput`. Everything is validated before the first insert,
   * so a rejected history leaves no half-framed decision behind.
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

    // The past this decision is framed as already having, checked against the
    // rules a live submission or message goes through. State that could not
    // have arisen legitimately is not pre-existing state, it is forged state.
    const submissions = (input.submissions ?? []).map((s) => {
      if (!names[s.participant]) throw new Error(`there is no participant ${s.participant}`);
      const option = options[s.option];
      if (!option) throw new Error(`there is no option ${s.option}`);
      const validated = validateSubmission(options, {
        optionId: option.id,
        confidence: s.confidence,
        reasons: s.reasons
      });
      return { participant: s.participant, ...validated };
    });
    if (new Set(submissions.map((s) => s.participant)).size !== submissions.length) {
      throw new Error("a participant has more than one initial submission");
    }
    // Oldest first: `seq` is the canonical order of the transcript, so it has
    // to agree with the clock rather than with the order they were listed in.
    const messages = (input.messages ?? [])
      .map((m) => {
        if (!names[m.participant]) throw new Error(`there is no participant ${m.participant}`);
        if (!Number.isFinite(m.minutesAgo) || m.minutesAgo < 0) {
          throw new Error("a message was posted a negative number of minutes ago");
        }
        return { participant: m.participant, body: validateMessageBody(m.body), minutesAgo: m.minutesAgo };
      })
      .sort((a, b) => b.minutesAgo - a.minutesAgo);

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
    // A decision framed as having a history was framed before that history
    // started. Backdating the framing too is what keeps the seeded scenario
    // from reading as a two-day-old discussion on a decision created seconds
    // ago — the one detail that would give it away as manufactured.
    const framedAt = messages.length ? now - messages[0]!.minutesAgo * 60_000 - 60_000 : now;
    this.sql`
      INSERT INTO decisions (id, question, context, options, status, owner_participant_id, created_at)
      VALUES (${this.name}, ${input.question.trim()}, ${input.context?.trim() || null},
              ${JSON.stringify(options)}, ${"SUBMIT"}, ${framed[0]!.id}, ${framedAt})
    `;
    framed.forEach((p, i) => {
      this.sql`
        INSERT INTO participants (id, display_name, credential_hash, is_owner, created_at)
        VALUES (${p.id}, ${p.displayName}, ${hashes[i]!}, ${p.isOwner ? 1 : 0}, ${framedAt})
      `;
    });
    this.sql`INSERT INTO facilitator_meta (id) VALUES (1)`;

    // Then everything that had already happened. Reveal goes through
    // `revealDecision` like every other Reveal — a participant who was invited
    // and never submitted simply has no position, exactly as when an owner
    // declares submissions complete without them.
    if (submissions.length || messages.length) {
      submissions.forEach((s) => {
        this.sql`
          INSERT INTO initial_submissions (participant_id, option_id, confidence, reasons, submitted_at)
          VALUES (${framed[s.participant]!.id}, ${s.optionId}, ${s.confidence},
                  ${JSON.stringify(s.reasons)}, ${framedAt})
        `;
      });
      this.revealDecision(framedAt);
      messages.forEach((m) => {
        this.sql`
          INSERT INTO messages (author_participant_id, body, created_at)
          VALUES (${framed[m.participant]!.id}, ${m.body}, ${now - m.minutesAgo * 60_000})
        `;
      });
    }

    this.publishProjection();
    // The facilitator is handed a committed transcript and reads it, exactly as
    // it would after any other message. Nothing about the seeded scenario's
    // facilitator state is scripted: it is whatever the real facilitator makes
    // of the real discussion.
    if (messages.length) await this.scheduleAnalysis("DISCUSSION");
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

  /** Owner-only. Declares the outcome and ends the decision. */
  @callable()
  async closeDecision(outcomeOptionId: string): Promise<DecisionBootstrap> {
    await this.closeFor(this.viewerId(), outcomeOptionId);
    return this.getBootstrap();
  }

  /**
   * What the owner is warned about before closing.
   *
   * A separate read from `closeDecision`, and deliberately so: the owner has
   * to be able to see the warning and close anyway. Nothing in the advisory
   * reaches the close transaction, so there is no path by which an unresolved
   * crux could delay or refuse a closure — which is the requirement, stated as
   * a shape rather than as a rule.
   *
   * Owner-only because there is nothing here for anyone else. It is the only
   * place assumptions and conflicts leave the Agent for a screen, and putting
   * the facilitator's working model in front of every participant is exactly
   * what the board is shaped to avoid.
   */
  @callable()
  getClosingAdvisory(): ClosingAdvisory {
    const viewerId = this.viewerId();
    const viewer = this.participants().find((p) => p.id === viewerId);
    if (!viewer?.isOwner) throw new Error("Only the owner can close this decision.");

    return composeClosingAdvisory({
      positions: this.board().positions,
      cruxes: this.cruxes(),
      conflicts: this.conflicts(),
      assumptions: this.assumptions()
    });
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

  /**
   * The close transaction: the owner declares the outcome and the decision
   * ends. DISCUSS → CLOSED, one atomic step.
   *
   * The outcome and the status move together in a single statement, so there
   * is no instant — not even inside the transaction — at which a decision is
   * CLOSED without the outcome its owner declared. That invariant is the whole
   * reason the outcome is a parameter here rather than something set
   * separately and then closed over.
   *
   * The pending memo row is written here too, for the same reason: a closed
   * decision says immediately that a memo is coming, so a synthesis that never
   * arrives reads as a synthesis that failed rather than as one nobody asked
   * for. Nothing the facilitator holds is consulted — the advisory is advice,
   * and an unresolved crux cannot keep a team in a decision they have finished
   * having.
   *
   * Synchronous throughout, like every other mutation here: a Durable Object
   * only interleaves at an `await`, so a message racing this one either
   * commits first and is in the discussion the memo describes, or finds the
   * decision closed and is refused. First committed wins, with no lock.
   */
  async closeFor(participantId: string, outcomeOptionId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const decision = this.decision();
      if (decision.ownerParticipantId !== participantId) {
        throw new Error("Only the owner can close this decision.");
      }
      if (decision.status !== "DISCUSS") {
        throw new Error(
          decision.status === "SUBMIT"
            ? "This decision cannot be closed until its initial positions are revealed."
            : "This decision is already closed."
        );
      }
      if (!decision.options.some((o) => o.id === outcomeOptionId)) {
        throw new Error("The outcome must be one of this decision's options.");
      }

      const now = Date.now();
      this.sql`
        UPDATE decisions
        SET status = ${"CLOSED"}, closed_at = ${now}, outcome_option_id = ${outcomeOptionId}
      `;
      this.sql`
        INSERT INTO closing_memos (id, status, requested_at) VALUES (1, ${"PENDING"}, ${now})
      `;
    });

    this.publishProjection();
    await this.scheduleClosingSynthesis();
  }

  /**
   * Hands the closing memo to the Workflow, after the close has committed and
   * outside its transaction — the same rule analysis follows, and for the same
   * reason: AI is never inside a transaction, and a scheduling failure must
   * not be able to undo a closure the team has already been shown.
   *
   * Deliberately not through `claimAnalysisSlot`. A discussion analysis can
   * legitimately still be in flight at the moment the owner closes, and the
   * closing memo is not that analysis — sharing the slot would mean a straggler
   * run could delay or block the decision's permanent record. The memo row's
   * own status is what makes this run once.
   */
  private async scheduleClosingSynthesis(): Promise<void> {
    try {
      await this.env.FACILITATOR_WORKFLOW.create({
        params: { decisionId: this.name, type: "CLOSING" }
      });
    } catch (e) {
      console.error(`could not schedule closing synthesis for decision ${this.name}`, e);
      await this.failClosingMemo(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Commits the closing memo, and returns whether it was the one that landed.
   *
   * Written once. A memo that is already READY is never replaced — not by a
   * retried Workflow step, not by a second instance that was scheduled and
   * then resumed hours later, not by a failure report that arrives afterwards.
   * That is what makes the memo immutable, and it is enforced here rather than
   * upstream because the Agent is the only thing that knows what has already
   * been committed.
   *
   * A memo that describes a different outcome is refused outright. It cannot
   * normally happen — the outcome is copied out of this decision rather than
   * generated — so it arriving means the memo is about some other state, and
   * the one thing that must never be true is that a memo altered the outcome.
   */
  async applyClosingMemo(memo: ClosingMemo): Promise<boolean> {
    const applied = this.ctx.storage.transactionSync(() => {
      const row = this.closingMemoRow();
      if (!row || row.status === "READY") return false;
      if (memo.outcomeOptionId !== this.decision().outcomeOptionId) {
        throw new Error("a closing memo cannot change the declared outcome");
      }

      this.sql`
        UPDATE closing_memos
        SET status = ${"READY"}, memo = ${JSON.stringify(memo)},
            failure = NULL, completed_at = ${Date.now()}
        WHERE id = 1
      `;
      return true;
    });

    this.publishProjection();
    return applied;
  }

  /**
   * Records that the closing memo could not be written.
   *
   * The decision stays closed and the outcome stays exactly as the owner
   * declared it: the memo is a record of the decision, not a part of it. The
   * team is told the synthesis failed, which is the honest thing to show and
   * the only alternative to inventing one. A failure arriving after a valid
   * memo has already been committed is ignored — a late straggler cannot
   * demote a record that exists.
   */
  async failClosingMemo(reason: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const row = this.closingMemoRow();
      if (!row || row.status === "READY") return;
      this.sql`
        UPDATE closing_memos
        SET status = ${"FAILED"}, failure = ${reason.slice(0, 500)}, completed_at = ${Date.now()}
        WHERE id = 1
      `;
    });

    this.publishProjection();
  }

  /**
   * This decision as team history, or null while it has none.
   *
   * Null until the memo is READY: a history entry without the memo is a record
   * of something that has not finished happening, and the Team Agent's write
   * is idempotent by decision id, so a half-written one would be the version
   * that stuck.
   *
   * The learnings are derived here, from authoritative facilitator state,
   * rather than taken from the memo. The memo is the model's account of the
   * decision; what the team carries forward should not be.
   */
  async getClosedDecisionRecord(): Promise<ClosedDecisionRecord | null> {
    const record = this.closingMemoRecord();
    if (record?.status !== "READY" || !record.memo) return null;

    const decision = this.decision();
    if (decision.closedAt === null) return null;
    const outcome = decision.options.find((o) => o.id === decision.outcomeOptionId);

    return {
      decisionId: decision.id,
      question: decision.question,
      // By label: team history outlives the agent that could resolve an id.
      outcome: outcome?.label ?? decision.outcomeOptionId ?? "(not recorded)",
      closedAt: decision.closedAt,
      memo: record.memo,
      significantLearnings: significantLearnings(this.assumptions())
    };
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
      lastActivityAt: counts!.last_message_at ?? decision.revealedAt,
      // The signal, never the memo. A browser that watches this go from
      // PENDING to READY re-reads the decision and finds the memo waiting,
      // which is how it appears without a refresh — and how a FAILED synthesis
      // shows up as the failure it was rather than as a memo that never comes.
      closingMemoStatus: this.closingMemoRow()?.status ?? null
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
      assumptions: this.assumptions(),
      cruxes: this.cruxes(),
      conflicts: this.conflicts(),
      actionItems: this.actionItems(),
      interventions: this.interventions(),
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

      // Committed order decides the close/analysis race, exactly as it decides
      // the message/close one. An analysis whose inference finished after the
      // owner closed is a reading of a decision that has since been frozen, so
      // none of it lands: not a crux, not an intervention, not a position
      // change. The closed decision is what was committed before the close,
      // and the closing memo is written from that. The slot is released
      // either way, and no follow-up is scheduled — there is nothing further
      // to analyze.
      if (this.decision().status !== "DISCUSS") {
        this.sql`
          UPDATE facilitator_meta
          SET analysis_running = 0, analysis_pending = 0, last_error = NULL WHERE id = 1
        `;
        return { applied: false, pending: false };
      }

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
      // Messages that arrived mid-run would normally earn a follow-up. Not
      // once the decision is closed: there is nothing left to analyze, and a
      // retry would only be refused by `applyAnalysis`.
      return meta?.analysis_pending === 1 && this.decision().status === "DISCUSS";
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
      this.sql<{ id: string; statement: string; status: string; first_seen_seq: number; updated_at: number }>`
        SELECT id, statement, status, first_seen_seq, updated_at FROM facilitator_assumptions
      `.map((r) => [key(r.statement), r])
    );
    this.sql`DELETE FROM facilitator_assumptions`;
    for (const a of dedupe(result.assumptions, (a) => key(a.statement))) {
      const prior = priorAssumptions.get(key(a.statement));
      this.sql`
        INSERT INTO facilitator_assumptions
          (id, participant_id, statement, source, status, first_seen_seq, updated_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${participant(a.participantId)}, ${a.statement},
                ${a.source}, ${a.status}, ${prior?.first_seen_seq ?? a.firstSeenSeq},
                ${unchanged(prior, prior?.status === a.status, now)})
      `;
    }

    const priorCruxes = new Map(
      this.sql<{ id: string; question: string; status: string; created_at: number; updated_at: number }>`
        SELECT id, question, status, created_at, updated_at FROM facilitator_cruxes
      `.map((r) => [key(r.question), r])
    );
    this.sql`DELETE FROM facilitator_cruxes`;
    for (const c of dedupe(result.cruxes, (c) => key(c.question))) {
      const prior = priorCruxes.get(key(c.question));
      this.sql`
        INSERT INTO facilitator_cruxes (id, question, status, created_at, updated_at)
        VALUES (${prior?.id ?? crypto.randomUUID()}, ${c.question}, ${c.status},
                ${prior?.created_at ?? now}, ${unchanged(prior, prior?.status === c.status, now)})
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

    for (const change of result.positionChanges) this.applyPositionChange(change, now);
    if (result.intervention) this.postIntervention(result.intervention, now);
  }

  /**
   * Moves one participant's current position, because they said so.
   *
   * An inferred change is refused here as well as dropped by the parser: the
   * Agent is the authority on what may touch a position, and this is the rule
   * that keeps a current position the participant's own. What is left to
   * enforce beyond it is that the change is complete. A
   * participant who names a new option without a new confidence has a position
   * the decision cannot fully describe, so the confidence is cleared rather
   * than carried over from the option they have just left, and the facilitator
   * asks them for it. Answering is how the request is closed: the next
   * analysis observes the number and comes back through here.
   *
   * A participant who never submitted can still acquire a position this way.
   * Their initial submission stays absent — the current position is what the
   * decision is made of, and it is not a submission.
   */
  private applyPositionChange(change: ObservedPositionChange, now: number): void {
    if (!change.explicit) return;
    const [current] = this.sql<{ option_id: string | null; confidence: number | null }>`
      SELECT option_id, confidence FROM current_positions WHERE participant_id = ${change.participantId}
    `;
    const movedOption = change.optionId !== null && change.optionId !== current?.option_id;
    const optionId = change.optionId ?? current?.option_id ?? null;
    // A confidence they did not give is not one they still hold, if the option
    // under it has changed.
    const confidence = change.confidence ?? (movedOption ? null : (current?.confidence ?? null));
    if (!movedOption && confidence === (current?.confidence ?? null)) return; // nothing moved

    this.sql`
      INSERT INTO current_positions (participant_id, option_id, confidence, updated_at)
      VALUES (${change.participantId}, ${optionId}, ${confidence}, ${now})
      ON CONFLICT (participant_id) DO UPDATE
        SET option_id = excluded.option_id,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at
    `;

    if (confidence === null) this.requestConfidence(change.participantId, now);
    else {
      this.sql`
        DELETE FROM pending_participant_requests
        WHERE participant_id = ${change.participantId} AND kind = ${"CONFIDENCE"}
      `;
    }
  }

  /**
   * Asks a participant for the confidence their new position is missing.
   *
   * Deterministic rather than left to the model: the requirement is that the
   * decision state stays complete, and a question the facilitator might or
   * might not remember to ask does not keep it complete. Asked once — the
   * pending request is what makes it once — because a facilitator that repeats
   * the question every time it re-reads the discussion is the nagging the
   * intervention gate exists to prevent.
   */
  private requestConfidence(participantId: string, now: number): void {
    const [pending] = this.sql<{ id: string }>`
      SELECT id FROM pending_participant_requests
      WHERE participant_id = ${participantId} AND kind = ${"CONFIDENCE"}
    `;
    if (pending) return;

    this.sql`
      INSERT INTO pending_participant_requests (id, participant_id, kind, created_at)
      VALUES (${crypto.randomUUID()}, ${participantId}, ${"CONFIDENCE"}, ${now})
    `;
    const [participant] = this.sql<{ display_name: string }>`
      SELECT display_name FROM participants WHERE id = ${participantId}
    `;
    this.sql`
      INSERT INTO messages (author_participant_id, body, created_at)
      VALUES (${null}, ${`${participant!.display_name}, you've changed your position — how confident are you in it now, from 1 to 5?`}, ${now})
    `;
  }

  /**
   * The intervention gate, and the post if it opens.
   *
   * The facilitator observes continuously and intervenes selectively, so the
   * question here is not whether it has something to say — it usually does —
   * but whether saying it again would tell the team anything. An issue it has
   * already raised is raised again only when the decision has materially moved
   * underneath it since: a new or re-worded assumption, a crux appearing or
   * resolving, a conflict opening or closing, someone changing position.
   *
   * That is `materialDigest`, taken *after* this analysis has been written, so
   * it describes the decision the intervention would be made about. A
   * re-analysis that understood the discussion the same way produces the same
   * digest however differently the model words the intervention itself — which
   * is the difference between this and refusing to repeat a string.
   *
   * Its known ceiling: the digest covers the whole facilitator model rather
   * than the part belonging to one issue, so an unrelated *material*
   * development elsewhere in the decision can re-open an issue that has not
   * itself moved. Linking each issue to the state it rests on would need the
   * model to maintain that link across analyses, which is a good deal more to
   * trust it with than an issue key.
   *
   * Posting is deliberately not `postMessageFor`: that schedules analysis, and
   * an intervention that triggered the analysis that produced the next
   * intervention would be a facilitator talking to itself.
   */
  private postIntervention(intervention: Intervention, now: number): void {
    const digest = this.materialDigest();
    const [prior] = this.sql<{ state_digest: string }>`
      SELECT state_digest FROM facilitator_interventions
      WHERE issue_key = ${intervention.issueKey} ORDER BY created_at DESC LIMIT 1
    `;
    if (prior && prior.state_digest === digest) {
      // Worth a line: silence and suppression look identical from outside, and
      // "why did the facilitator say nothing" is otherwise unanswerable.
      console.log(`held back an intervention on ${intervention.issueKey}: nothing has changed`);
      return;
    }

    // A backstop for the same issue arriving under a new key: the model has
    // re-worded the identifier, but not the message.
    const [last] = this.sql<{ body: string }>`
      SELECT body FROM messages WHERE author_participant_id IS NULL ORDER BY seq DESC LIMIT 1
    `;
    if (last?.body === intervention.message) return;

    this.sql`
      INSERT INTO messages (author_participant_id, body, created_at)
      VALUES (${null}, ${intervention.message}, ${now})
    `;
    const [posted] = this.sql<{ seq: number }>`SELECT MAX(seq) AS seq FROM messages`;
    this.sql`
      INSERT INTO facilitator_interventions (id, issue_key, message_seq, state_digest, created_at)
      VALUES (${crypto.randomUUID()}, ${intervention.issueKey}, ${posted!.seq}, ${digest}, ${now})
    `;
  }

  /**
   * What the decision materially consists of right now, as one string.
   *
   * Deliberately not a timestamp or a row count: both move whenever an
   * analysis runs, and this has to stay still while the facilitator's
   * understanding does.
   *
   * *Open* assumptions are deliberately excluded, and that exclusion is the
   * whole difference between a gate that closes and one that does not. The
   * facilitator adds open assumptions constantly — every message anyone posts
   * gives it another one — so a digest that counted them moved on every
   * analysis, and an issue raised once could be raised again one message
   * later. It was: end-to-end, the facilitator asked about the same
   * unquantified cost twice in three messages, under the same issue key.
   *
   * What is left is what a participant would call a development: the board,
   * where anybody's position stands, and the assumptions whose standing has
   * changed — an assumption that has been challenged, refuted or agreed is a
   * thing that happened, where one merely noticed is not.
   */
  private materialDigest(): string {
    const [digest] = this.sql<{ value: string }>`
      SELECT
        COALESCE((SELECT group_concat(s, '|') FROM
          (SELECT statement || '~' || status AS s FROM facilitator_assumptions
           WHERE status <> 'OPEN' ORDER BY statement)), '') || '#' ||
        COALESCE((SELECT group_concat(s, '|') FROM
          (SELECT question || '~' || status AS s FROM facilitator_cruxes ORDER BY question)), '') || '#' ||
        COALESCE((SELECT group_concat(s, '|') FROM
          (SELECT description || '~' || status AS s FROM facilitator_conflicts ORDER BY description)), '') || '#' ||
        COALESCE((SELECT group_concat(s, '|') FROM
          (SELECT participant_id || '~' || COALESCE(option_id, '-') || '~' || COALESCE(confidence, '-') AS s
           FROM current_positions ORDER BY participant_id)), '')
        AS value
    `;
    return digest!.value;
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
      board: this.board(),
      messages: this.messages(),
      // Authoritative, and read the same way by a live browser and a refreshed
      // one: the projection only ever said that this had moved.
      closingMemo: this.closingMemoRecord()
    };
  }

  /**
   * The participant-facing board: current positions, cruxes, action items.
   *
   * A projection, computed on every read. Positions come from
   * `current_positions`, the rest from the facilitator's state — there is no
   * board table, because a board that is stored is a board that can disagree
   * with the decision it describes.
   *
   * Assumptions and conflicts are deliberately absent. The facilitator holds
   * more than it shows: an inferred assumption is a hypothesis about somebody,
   * and a wall of them presented as a list reads as a verdict on how the team
   * is thinking. They reach participants as questions, in the discussion, and
   * as the challenged ones in the brief.
   */
  private board(): BoardView {
    const positions = new Map(this.positions().map((p) => [p.participantId, p]));
    const submitted = new Set(
      this.sql<{ participant_id: string }>`
        SELECT participant_id FROM initial_submissions
      `.map((r) => r.participant_id)
    );

    return {
      // Every participant, including those with no position: they are in the
      // discussion, and showing them as absent is more honest than omitting them.
      positions: this.participants().map((participant) => {
        const position = positions.get(participant.id);
        return {
          participantId: participant.id,
          displayName: participant.displayName,
          optionId: position?.optionId ?? null,
          confidence: position?.confidence ?? null,
          submitted: submitted.has(participant.id)
        };
      }),
      cruxes: this.cruxes(),
      actionItems: this.actionItems()
    };
  }

  /**
   * Orientation on opening the decision, and the visit that moves the boundary.
   *
   * Called once per opening rather than on every realtime update — reading the
   * brief *is* the visit, so a browser that re-read it whenever the projection
   * moved would reset "since your last visit" to seconds ago and have nothing
   * to report ever again.
   *
   * The visit is recorded after the brief is composed, so this brief describes
   * what happened since the previous opening and the next one starts here.
   */
  @callable()
  getCurrentStateBrief(): StateBrief {
    const viewerId = this.viewerId();
    return this.ctx.storage.transactionSync(() => {
      const participants = this.participants();
      const viewer = participants.find((p) => p.id === viewerId);
      if (!viewer) throw new Error("unknown participant");

      const brief = composeBrief({
        decision: this.decision(),
        viewer,
        participants,
        positions: this.positions(),
        cruxes: this.cruxes(),
        actionItems: this.actionItems(),
        assumptions: this.assumptions(),
        messages: this.messages(),
        pendingRequests: this.pendingRequests(),
        submittedCount: this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM initial_submissions`[0]!.n,
        now: Date.now()
      });

      this.sql`UPDATE participants SET last_visited_at = ${brief.generatedAt} WHERE id = ${viewerId}`;
      return brief;
    });
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

  private assumptions(): FacilitatorAssumption[] {
    return this.sql<{
      id: string;
      participant_id: string | null;
      statement: string;
      source: string;
      status: string;
      first_seen_seq: number;
      updated_at: number;
    }>`SELECT * FROM facilitator_assumptions ORDER BY first_seen_seq, statement`.map((r) => ({
      id: r.id,
      participantId: r.participant_id,
      statement: r.statement,
      source: r.source as FacilitatorAssumption["source"],
      status: r.status as FacilitatorAssumption["status"],
      firstSeenSeq: r.first_seen_seq,
      updatedAt: r.updated_at
    }));
  }

  private interventions(): FacilitatorIntervention[] {
    return this.sql<{
      id: string;
      issue_key: string;
      message_seq: number;
      state_digest: string;
      created_at: number;
    }>`SELECT * FROM facilitator_interventions ORDER BY created_at`.map((r) => ({
      id: r.id,
      issueKey: r.issue_key,
      messageSeq: r.message_seq,
      stateDigest: r.state_digest,
      createdAt: r.created_at
    }));
  }

  private pendingRequests(): PendingParticipantRequest[] {
    return this.sql<{
      id: string;
      participant_id: string;
      kind: string;
      created_at: number;
    }>`SELECT * FROM pending_participant_requests ORDER BY created_at`.map((r) => ({
      id: r.id,
      participantId: r.participant_id,
      kind: r.kind as PendingParticipantRequest["kind"],
      createdAt: r.created_at
    }));
  }

  private conflicts(): Conflict[] {
    return this.sql<{
      id: string;
      description: string;
      participant_ids: string;
      status: string;
      created_at: number;
    }>`SELECT * FROM facilitator_conflicts ORDER BY created_at`.map((r) => ({
      id: r.id,
      description: r.description,
      participantIds: JSON.parse(r.participant_ids),
      status: r.status as Conflict["status"],
      createdAt: r.created_at
    }));
  }

  private closingMemoRow(): ClosingMemoRow | undefined {
    return this.sql<ClosingMemoRow>`SELECT * FROM closing_memos WHERE id = 1`[0];
  }

  /** The memo and how its synthesis went, or null before the decision closes. */
  private closingMemoRecord(): ClosingMemoRecord | null {
    const row = this.closingMemoRow();
    if (!row) return null;
    return {
      status: row.status,
      memo: row.memo === null ? null : JSON.parse(row.memo),
      failure: row.failure,
      requestedAt: row.requested_at,
      completedAt: row.completed_at
    };
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

/**
 * When an item survives an analysis unchanged, it keeps the timestamp it had.
 *
 * Every run rewrites the whole facilitator model, so stamping `now` on each
 * row would make everything look freshly changed — and "what has changed since
 * your last visit" and the intervention gate both depend on the difference.
 */
function unchanged(prior: { updated_at: number } | undefined, same: boolean, now: number): number {
  return prior && same ? prior.updated_at : now;
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
