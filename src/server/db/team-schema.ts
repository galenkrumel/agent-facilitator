/**
 * The Team Agent's schema: closed decisions only.
 *
 * One row per closed decision, keyed by the decision it came from — which is
 * what makes the write idempotent. The closing Workflow's last step may be
 * retried after it has already succeeded, and history that grew a duplicate
 * every time a step was replayed would not be history.
 *
 * Deliberately flat and deliberately denormalised. This is an archive, not a
 * second copy of the decision model: nothing here is joined to, queried across
 * or ranked, because the MVP has no historical search, retrieval or knowledge
 * management and is not to grow one by accident.
 */
export const TEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS closed_decisions (
  decision_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  outcome TEXT NOT NULL,               -- the owner-declared outcome, by label
  closed_at INTEGER NOT NULL,
  memo TEXT NOT NULL,                  -- JSON ClosingMemo
  significant_learnings TEXT NOT NULL, -- JSON string[]
  stored_at INTEGER NOT NULL
);
`;
