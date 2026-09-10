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
  summary: string;
  openCruxes: string[];
  questionsForYou: string[];
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
  /** Empty until Reveal. */
  positions: CurrentPosition[];
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
  meta: FacilitatorMeta;
};

/** Only `explicit` position changes may update a current position. */
export type ObservedPositionChange = {
  participantId: string;
  optionId: string | null;
  confidence: Confidence | null;
  explicit: boolean;
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
  intervention: string | null;
};

export type ClosingMemo = {
  /** The outcome the owner declared. The facilitator cannot alter it. */
  outcomeOptionId: string;
  reasoning: string;
  refutedAssumptions: string[];
  unresolvedIssues: string[];
  dissent: string[];
  actionItems: string[];
};
