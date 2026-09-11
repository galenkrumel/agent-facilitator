import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext } from "agents";
import { DECISION_SCHEMA } from "../db/decision-schema.ts";
import { hashCredential, newCredential } from "../auth/credentials.ts";
import { newSessionId, readSessionId, SESSION_TTL_MS } from "../auth/sessions.ts";
import { permissionsFor } from "../domain/decisions.ts";
import { validateSubmission, type InitialSubmissionInput } from "../domain/submissions.ts";
import type {
  Confidence,
  CurrentPosition,
  Decision,
  DecisionBootstrap,
  DecisionOption,
  InitialSubmission,
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

type ParticipantRow = {
  id: string;
  display_name: string;
  is_owner: number;
  created_at: number;
  last_visited_at: number | null;
};

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
export class DecisionAgent extends Agent<Env> {
  onStart() {
    this.ctx.storage.sql.exec(DECISION_SCHEMA);
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

    if (revealed) await this.scheduleRevealAnalysis();
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

    await this.scheduleRevealAnalysis();
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
   * Hands Reveal analysis to the Workflow — strictly after the transaction has
   * committed, and strictly outside it. The decision is already in DISCUSS by
   * the time this runs, so a scheduling failure is logged and swallowed: no AI
   * problem may undo a transition participants have already been shown.
   */
  private async scheduleRevealAnalysis(): Promise<void> {
    try {
      await this.env.FACILITATOR_WORKFLOW.create({
        params: { decisionId: this.name, type: "REVEAL" }
      });
    } catch (e) {
      console.error(`could not schedule Reveal analysis for decision ${this.name}`, e);
    }
  }

  /** Everything the browser needs to render the decision on connect. */
  @callable()
  getBootstrap(): DecisionBootstrap {
    const viewerId = this.viewerId();
    const decision = this.decision();
    const participants = this.participants();
    const viewer = participants.find((p) => p.id === viewerId);
    if (!viewer) throw new Error("unknown participant");

    const rows = this.sql<SubmissionRow>`SELECT * FROM initial_submissions ORDER BY submitted_at`;
    const submissions = rows.map(
      (r): InitialSubmission => ({
        participantId: r.participant_id,
        optionId: r.option_id,
        confidence: r.confidence as Confidence,
        reasons: JSON.parse(r.reasons),
        submittedAt: r.submitted_at
      })
    );
    const ownSubmission = submissions.find((s) => s.participantId === viewerId) ?? null;

    const positions = this.sql<{
      participant_id: string;
      option_id: string | null;
      confidence: number | null;
      updated_at: number;
    }>`SELECT * FROM current_positions`;

    return {
      decision,
      viewer: { participantId: viewer.id, displayName: viewer.displayName, isOwner: viewer.isOwner },
      participants,
      permissions: permissionsFor(decision, viewer, ownSubmission !== null),
      ownSubmission,
      // Who has submitted is public during Submit; what they submitted is not.
      submittedParticipantIds: submissions.map((s) => s.participantId),
      submissions: decision.status === "SUBMIT" ? [] : submissions,
      positions: positions.map(
        (r): CurrentPosition => ({
          participantId: r.participant_id,
          optionId: r.option_id,
          confidence: r.confidence as Confidence | null,
          updatedAt: r.updated_at
        })
      )
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
