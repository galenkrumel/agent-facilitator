/**
 * The domain contracts. Server, client and (from M4) the facilitator all speak
 * these types; nothing re-declares them locally.
 */

/**
 * Frame → Submit → Discuss → Close. Framing is the act of creating the
 * decision rather than a persisted state, so there is no `FRAME` status: a
 * decision exists from the moment it is framed, in `SUBMIT`.
 * Reveal is the SUBMIT → DISCUSS transition, not a phase.
 */
export type DecisionStatus = "SUBMIT" | "DISCUSS" | "CLOSED";

/** 2–4 owner-supplied options plus the automatically added `other`. */
export type DecisionOption = { id: string; label: string };

export type Decision = {
  id: string;
  question: string;
  context: string | null;
  options: DecisionOption[];
  status: DecisionStatus;
  ownerParticipantId: string;
  createdAt: number;
  revealedAt: number | null;
  closedAt: number | null;
  /** Owner-declared. Never inferred by the facilitator. */
  outcomeOptionId: string | null;
};

export type Participant = {
  id: string;
  displayName: string;
  isOwner: boolean;
  createdAt: number;
  /** Last opening of the decision — the "since your last visit" boundary. */
  lastVisitedAt: number | null;
};

export type Confidence = 1 | 2 | 3 | 4 | 5;

/** Private until Reveal, immutable after it. */
export type InitialSubmission = {
  participantId: string;
  optionId: string;
  confidence: Confidence;
  /** Up to three. */
  reasons: string[];
  submittedAt: number;
};

/** Authoritative over the initial submission. Null for non-submitters. */
export type CurrentPosition = {
  participantId: string;
  optionId: string | null;
  confidence: Confidence | null;
  updatedAt: number;
};

export type MessageAuthor =
  | { kind: "PARTICIPANT"; participantId: string }
  | { kind: "FACILITATOR" };

/** Chronological, immutable, flat. `seq` is the canonical order. */
export type Message = {
  seq: number;
  author: MessageAuthor;
  body: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Facilitator state. Internal working model — richer than the board exposes.

/** An inferred assumption is a hypothesis, never an asserted fact. */
export type AssumptionSource = "EXPLICIT" | "INFERRED";
export type AssumptionStatus = "OPEN" | "CONFIRMED" | "CHALLENGED" | "REFUTED";

export type FacilitatorAssumption = {
  id: string;
  /** Who appears to hold it. Null when it belongs to no single participant. */
  participantId: string | null;
  statement: string;
  source: AssumptionSource;
  status: AssumptionStatus;
  firstSeenSeq: number;
  updatedAt: number;
};

/** Unresolved question or fact that materially separates positions. */
export type Crux = {
  id: string;
  question: string;
  status: "OPEN" | "RESOLVED";
  createdAt: number;
  updatedAt: number;
};

/** Internal only — conflicts are not a participant-facing board category. */
export type Conflict = {
  id: string;
  description: string;
  participantIds: string[];
  status: "OPEN" | "RESOLVED";
  createdAt: number;
};

export type ActionItem = {
  id: string;
  description: string;
  ownerParticipantId: string | null;
  createdAt: number;
};

/** Scheduling/coalescing bookkeeping for asynchronous analysis (M4). */
export type FacilitatorMeta = {
  analysisRunning: boolean;
  analysisPending: boolean;
  lastAnalyzedSeq: number;
  lastError: string | null;
};

/**
 * An intervention the facilitator has already made, and what it was about.
 *
 * `issueKey` is the facilitator's own identifier for the underlying issue, so
 * a second intervention about the same issue is recognisable as the same issue
 * however differently it is worded. `stateDigest` is what the decision
 * materially looked like when it was made — the Decision Agent compares the
 * two to decide whether anything has changed enough to be worth saying again.
 */
export type FacilitatorIntervention = {
  id: string;
  issueKey: string;
  /** The message it was posted as. */
  messageSeq: number;
  stateDigest: string;
  createdAt: number;
};

/** An open question the facilitator has put to one participant (e.g. "what is
 *  your confidence now?") and is still waiting on. */
export type PendingParticipantRequest = {
  id: string;
  participantId: string;
  kind: "CONFIDENCE";
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Projections

/** Projected from current_positions — there is no board persistence table. */
export type PositionView = {
  participantId: string;
  displayName: string;
  optionId: string | null;
  confidence: Confidence | null;
  submitted: boolean;
};

/** The curated, participant-facing subset of the facilitator's model. */
export type BoardView = {
  positions: PositionView[];
  cruxes: Crux[];
  actionItems: ActionItem[];
};

/** Neutral orientation on entering a decision. */
export type StateBrief = {
  kind: "FIRST_VISIT" | "RETURNING";
  /** Boundary for a returning brief: the participant's last visit. */
  since: number | null;
  generatedAt: number;
  /** Neutral and factual. Never a recommendation, however implicit. */
  summary: string;
  openCruxes: string[];
  /** Assumptions the discussion has challenged or refuted. Not a board category. */
  challengedAssumptions: string[];
  questionsForYou: string[];
};

/**
 * What the owner is shown before closing: the things the discussion has left
 * open. Advisory only — nothing here can prevent or alter a closure, and it
 * deliberately names no option as the one to take.
 *
 * Composed from authoritative state rather than generated, so it is the same
 * every time it is read and cannot introduce anything the facilitator has not
 * already recorded. Assumptions and conflicts appear here and nowhere else on
 * a participant's screen: this is the owner's view of the facilitator's own
 * working model, at the one moment that model is about to stop mattering.
 */
export type ClosingAdvisory = {
  unresolvedCruxes: Crux[];
  unresolvedConflicts: Conflict[];
  /** Assumptions the discussion has challenged or refuted. */
  challengedAssumptions: FacilitatorAssumption[];
  /** The deterministic reading of dissent: current positions that differ. */
  dissentingPositions: PositionView[];
};

export type Permissions = {
  canSubmit: boolean;
  canPostMessage: boolean;
  canChangePosition: boolean;
  canDeclareSubmissionsComplete: boolean;
  canClose: boolean;
};

export type Viewer = {
  participantId: string;
  displayName: string;
  isOwner: boolean;
};

/** Everything a freshly connected browser needs to render the decision. */
export type DecisionBootstrap = {
  decision: Decision;
  viewer: Viewer;
  participants: Participant[];
  permissions: Permissions;
  /** The viewer's own submission. Other submissions stay private until Reveal. */
  ownSubmission: InitialSubmission | null;
  /** Who has submitted — never what — is visible during Submit. */
  submittedParticipantIds: string[];
  /** Empty until Reveal, when every submission becomes a visible historical fact. */
  submissions: InitialSubmission[];
  /**
   * The participant-facing board: current positions, cruxes, action items.
   * Empty until Reveal, and the only positions the browser is given — a
   * `CurrentPosition` row and its owner's name are never sent separately.
   */
  board: BoardView;
  /** The whole discussion, in sequence order. Empty until Reveal opens it. */
  messages: Message[];
  /** Null until the decision is closed; then always present, however it went. */
  closingMemo: ClosingMemoRecord | null;
};

// ---------------------------------------------------------------------------
// Realtime

/** Whether asynchronous facilitator analysis is in flight (M4 drives it). */
export type FacilitatorStatus = "IDLE" | "ANALYZING" | "ERROR";

/**
 * The small projection the Decision Agent synchronises to every connected
 * browser. Deliberately counts and versions rather than content: SQLite stays
 * the authority, and a browser that notices a version move re-reads from it.
 *
 * Nothing here is private — a count of submissions is already visible during
 * Submit, and no message body, option or confidence passes through it.
 */
export type DecisionRealtimeState = {
  status: DecisionStatus;
  participantCount: number;
  submittedCount: number;
  messageCount: number;
  messagesVersion: number;
  positionsVersion: number;
  boardVersion: number;
  facilitatorStatus: FacilitatorStatus;
  lastActivityAt: number | null;
  /**
   * How far the closing synthesis has got. Null until the decision is closed.
   *
   * A lifecycle signal, not a second source of truth: the memo itself never
   * rides on the projection, and a browser that sees this move re-reads the
   * decision from the Agent like it does for everything else. It is separate
   * from `facilitatorStatus` on purpose — a discussion analysis can still be
   * in flight at the moment the owner closes, and the two are unrelated.
   */
  closingMemoStatus: ClosingMemoStatus | null;
};

// ---------------------------------------------------------------------------
// Facilitator I/O contracts (implemented in M4–M6)

/** Read from the Decision Agent by the Workflow; the Workflow owns none of it. */
export type FacilitatorContext = {
  decision: Decision;
  participants: Participant[];
  submissions: InitialSubmission[];
  positions: CurrentPosition[];
  messages: Message[];
  assumptions: FacilitatorAssumption[];
  cruxes: Crux[];
  conflicts: Conflict[];
  actionItems: ActionItem[];
  /** What the facilitator has already said, and about which issue. */
  interventions: FacilitatorIntervention[];
  meta: FacilitatorMeta;
};

/**
 * A position change the facilitator believes it has observed.
 *
 * Only an `explicit` one may move a current position: reasoning that evolves
 * is not a change of position. `null` means *unchanged* here — not "no
 * position", as it does on `CurrentPosition` — so a participant who restates
 * only their confidence leaves `optionId` null, and one who names only a new
 * option leaves `confidence` null and is asked for a new one.
 */
export type ObservedPositionChange = {
  participantId: string;
  optionId: string | null;
  confidence: Confidence | null;
  explicit: boolean;
};

/** One message, with the facilitator's identifier for what it is about. */
export type Intervention = {
  /** Stable across analyses: the same underlying issue keeps the same key. */
  issueKey: string;
  message: string;
};

/** Validated model output. Carries its analyzed range so stale results can be
 *  rejected by the Decision Agent. */
export type FacilitatorAnalysisResult = {
  analyzedThroughSeq: number;
  assumptions: Omit<FacilitatorAssumption, "id" | "updatedAt">[];
  cruxes: Omit<Crux, "id" | "createdAt" | "updatedAt">[];
  conflicts: Omit<Conflict, "id" | "createdAt">[];
  actionItems: Omit<ActionItem, "id" | "createdAt">[];
  positionChanges: ObservedPositionChange[];
  /** Silence is a valid outcome. */
  intervention: Intervention | null;
};

/**
 * The closing memo: what the discussion amounted to, written once, around an
 * outcome the owner has already declared.
 *
 * The outcome is not a field the model fills in. It is copied from the closed
 * decision, so a memo that changed it would have to be a different type — the
 * requirement that "the facilitator never chooses the outcome" is structural
 * here rather than a rule something has to check.
 *
 * The list fields are the model's *selection* from what the facilitator
 * already recorded, not its own writing: each entry is matched back against
 * that state and dropped if it matches nothing. `reasoning` and `dissent` are
 * prose, and are the only places the model composes anything.
 */
export type ClosingMemo = {
  /** The outcome the owner declared. The facilitator cannot alter it. */
  outcomeOptionId: string;
  reasoning: string;
  refutedAssumptions: string[];
  unresolvedIssues: string[];
  dissent: string[];
  actionItems: string[];
};

/** PENDING from the close transaction itself; then one of the other two. */
export type ClosingMemoStatus = "PENDING" | "READY" | "FAILED";

/**
 * The memo and how its synthesis went. A failure is reported as a failure: a
 * closed decision with no memo says so rather than showing invented content,
 * and the outcome above it is unaffected either way.
 */
export type ClosingMemoRecord = {
  status: ClosingMemoStatus;
  /** Only ever set when READY, and immutable once it is. */
  memo: ClosingMemo | null;
  /** Only ever set when FAILED. */
  failure: string | null;
  /** When the owner closed the decision. */
  requestedAt: number;
  completedAt: number | null;
};

/**
 * One closed decision, as the Team Agent keeps it. Denormalised on purpose:
 * team history outlives the Decision Agent that produced it, so it carries the
 * outcome's label rather than an option id only that agent can resolve.
 */
export type ClosedDecisionRecord = {
  decisionId: string;
  question: string;
  /** The owner-declared outcome, by label. */
  outcome: string;
  closedAt: number;
  memo: ClosingMemo;
  /**
   * What the team learned that outlasts this decision: the assumptions the
   * discussion challenged or refuted. Derived from authoritative facilitator
   * state, never from the model — history is not a place for a hypothesis.
   */
  significantLearnings: string[];
};
