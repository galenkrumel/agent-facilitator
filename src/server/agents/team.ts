import { Agent } from "agents";
import { TEAM_SCHEMA } from "../db/team-schema.ts";
import type { ClosedDecisionRecord } from "../../shared/types.ts";

/**
 * The one team the MVP has.
 *
 * There is no team-creation path — no sign-up, no workspace, nothing that
 * could hand out a second team id — so inventing team plumbing to support
 * closing would be building the container before anything can put something in
 * it. Every closed decision is written here. M7 introduces real team identity
 * alongside the seeding that will actually create teams; until then this
 * constant is the whole of it, named rather than spelled out at the call site
 * so there is one place for that to change.
 */
export const DEFAULT_TEAM_ID = "default";

/**
 * Owns closed decision history: closing memos and the assumptions the
 * discussions that produced them challenged or refuted. Never holds active
 * decision state — an open decision lives entirely in its Decision Agent, and
 * nothing is written here until one has been closed and its memo committed.
 *
 * An archive, not an index. There is deliberately no search, no ranking and no
 * retrieval beyond reading one decision back by its id: the MVP does not
 * require historical browsing, and a query surface built speculatively here
 * would be the beginning of the knowledge-management system it explicitly
 * excludes.
 */
export class TeamAgent extends Agent<Env> {
  onStart() {
    this.ctx.storage.sql.exec(TEAM_SCHEMA);
  }

  /**
   * Files one closed decision, once.
   *
   * Idempotent by decision id, because the closing Workflow step that calls
   * this can be replayed after it has already succeeded — a retried step, a
   * resumed instance — and history that gained a duplicate every time would
   * not be history. The first write wins: a closed decision's record is as
   * immutable as the memo inside it.
   */
  async storeClosedDecision(record: ClosedDecisionRecord): Promise<void> {
    this.sql`
      INSERT INTO closed_decisions
        (decision_id, question, outcome, closed_at, memo, significant_learnings, stored_at)
      VALUES (${record.decisionId}, ${record.question}, ${record.outcome}, ${record.closedAt},
              ${JSON.stringify(record.memo)}, ${JSON.stringify(record.significantLearnings)},
              ${Date.now()})
      ON CONFLICT (decision_id) DO NOTHING
    `;
  }

  /**
   * Reads one closed decision back.
   *
   * Deliberately not `@callable()`: the Team Agent has no participant model and
   * no sessions, so anything a browser could reach here would be readable by
   * anyone who could name the agent. This is a plain Durable Object RPC, called
   * by the Worker and by the runtime tests.
   */
  async getClosedDecision(decisionId: string): Promise<ClosedDecisionRecord | null> {
    const [row] = this.sql<{
      decision_id: string;
      question: string;
      outcome: string;
      closed_at: number;
      memo: string;
      significant_learnings: string;
    }>`SELECT * FROM closed_decisions WHERE decision_id = ${decisionId}`;
    if (!row) return null;

    return {
      decisionId: row.decision_id,
      question: row.question,
      outcome: row.outcome,
      closedAt: row.closed_at,
      memo: JSON.parse(row.memo),
      significantLearnings: JSON.parse(row.significant_learnings)
    };
  }
}
