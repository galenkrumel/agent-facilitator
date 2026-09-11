import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext } from "agents";
import { DECISION_SCHEMA } from "../db/decision-schema.ts";
import { hashCredential, newCredential } from "../auth/credentials.ts";
import { newSessionId, readSessionId, SESSION_TTL_MS } from "../auth/sessions.ts";
import { permissionsFor } from "../domain/decisions.ts";
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

  /** Everything the browser needs to render the decision on connect. */
  @callable()
  getBootstrap(): DecisionBootstrap {
    const viewerId = this.viewerId();
    const decision = this.decision();
    const participants = this.participants();
    const viewer = participants.find((p) => p.id === viewerId);
    if (!viewer) throw new Error("unknown participant");

    const [own] = this.sql<{
      participant_id: string;
      option_id: string;
      confidence: number;
      reasons: string;
      submitted_at: number;
    }>`SELECT * FROM initial_submissions WHERE participant_id = ${viewerId}`;

    const ownSubmission: InitialSubmission | null = own
      ? {
          participantId: own.participant_id,
          optionId: own.option_id,
          confidence: own.confidence as Confidence,
          reasons: JSON.parse(own.reasons),
          submittedAt: own.submitted_at
        }
      : null;

    const submitted = this.sql<{ participant_id: string }>`
      SELECT participant_id FROM initial_submissions
    `;

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
      submittedParticipantIds: submitted.map((r) => r.participant_id),
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
