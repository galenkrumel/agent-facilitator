/**
 * The Decision Agent's authoritative schema. One Durable Object holds exactly
 * one decision, so `decisions` is a single row and everything else is keyed by
 * participant or by message sequence.
 *
 * The board is a projection of `current_positions` + facilitator state; there
 * is deliberately no generic `board_items` table.
 *
 * Applied on every start — `IF NOT EXISTS` makes it idempotent. There is no
 * migration story yet: decisions are short-lived and the schema is additive.
 */
export const DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  context TEXT,
  options TEXT NOT NULL,               -- JSON DecisionOption[]
  status TEXT NOT NULL,                -- SUBMIT | DISCUSS | CLOSED
  owner_participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revealed_at INTEGER,
  closed_at INTEGER,
  outcome_option_id TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the participant link secret
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_visited_at INTEGER
);

-- Browser-local sessions minted from a participant credential. The credential
-- itself stays in the link; the browser only ever holds a session id.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS initial_submissions (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  option_id TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  reasons TEXT NOT NULL,               -- JSON string[], max 3
  submitted_at INTEGER NOT NULL
);

-- Only participants who have a position. Reveal seeds it from the initial
-- submissions, so a participant who never submitted simply has no row: absence
-- is how "no current position" is represented, not a row full of nulls. The
-- columns stay nullable for M5, where the facilitator may observe someone
-- explicitly withdrawing to no position.
CREATE TABLE IF NOT EXISTS current_positions (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  option_id TEXT,
  confidence INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  author_participant_id TEXT REFERENCES participants(id), -- null = facilitator
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facilitator_assumptions (
  id TEXT PRIMARY KEY,
  participant_id TEXT REFERENCES participants(id),
  statement TEXT NOT NULL,
  source TEXT NOT NULL,                -- EXPLICIT | INFERRED
  status TEXT NOT NULL,                -- OPEN | CONFIRMED | CHALLENGED | REFUTED
  first_seen_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facilitator_cruxes (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  status TEXT NOT NULL,                -- OPEN | RESOLVED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Internal facilitator state. Never a participant-facing board category.
CREATE TABLE IF NOT EXISTS facilitator_conflicts (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  participant_ids TEXT NOT NULL,       -- JSON string[]
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facilitator_action_items (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  owner_participant_id TEXT REFERENCES participants(id),
  created_at INTEGER NOT NULL
);

-- Single row: AI scheduling/coalescing bookkeeping (M4).
CREATE TABLE IF NOT EXISTS facilitator_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  analysis_running INTEGER NOT NULL DEFAULT 0,
  analysis_pending INTEGER NOT NULL DEFAULT 0,
  last_analyzed_seq INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Questions the facilitator has put to a participant and is still waiting on
-- (e.g. confidence after an explicit position change).
CREATE TABLE IF NOT EXISTS pending_participant_requests (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  kind TEXT NOT NULL,                  -- CONFIDENCE
  created_at INTEGER NOT NULL
);
`;
