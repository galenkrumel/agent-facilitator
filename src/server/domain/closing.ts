/**
 * What closing is made of, apart from the transaction itself.
 *
 * All of it deterministic, and all of it derived from authoritative state. The
 * facilitator's judgement is already in that state — it decided what is a
 * crux, what is a conflict, which assumption has been challenged. What is
 * decided here is only which of it the owner is shown before closing and which
 * of it outlives the decision, and neither is a thing the model should get
 * another say in moments before the outcome is declared.
 *
 * Pure, so the whole of it is testable without a Durable Object.
 */
import type {
  ClosingAdvisory,
  Conflict,
  Crux,
  FacilitatorAssumption,
  FacilitatorContext,
  PositionView
} from "../../shared/types.ts";

/**
 * "Significant", for M6, means the discussion moved it: an assumption somebody
 * disputed or that was established to be wrong. An assumption merely noticed
 * is not a learning — the facilitator adds one of those on almost every
 * message — and one that was agreed is not something the team found out.
 */
const CHALLENGED: FacilitatorAssumption["status"][] = ["CHALLENGED", "REFUTED"];

export type ClosingAdvisoryInput = {
  positions: PositionView[];
  cruxes: Crux[];
  conflicts: Conflict[];
  assumptions: FacilitatorAssumption[];
};

/**
 * The advisory the owner sees before closing: what the discussion is leaving
 * behind. Advisory in the strict sense — the close transaction never reads it,
 * so nothing in here can block, delay or alter a closure.
 */
export function composeClosingAdvisory(input: ClosingAdvisoryInput): ClosingAdvisory {
  return {
    unresolvedCruxes: input.cruxes.filter((c) => c.status === "OPEN"),
    unresolvedConflicts: input.conflicts.filter((c) => c.status === "OPEN"),
    challengedAssumptions: challengedAssumptions(input.assumptions),
    dissentingPositions: dissentingPositions(input.positions)
  };
}

export function challengedAssumptions(assumptions: FacilitatorAssumption[]): FacilitatorAssumption[] {
  return assumptions.filter((a) => CHALLENGED.includes(a.status));
}

/**
 * What the team takes with it. The statements of the assumptions the
 * discussion challenged or refuted, and nothing else: team history is durable
 * learning, not a dump of the facilitator's working model.
 */
export function significantLearnings(assumptions: FacilitatorAssumption[]): string[] {
  return challengedAssumptions(assumptions).map((a) => a.statement);
}

/**
 * The three lists the closing memo may draw its items from.
 *
 * One function because the prompt and the validator must not be able to
 * disagree about it: the model is shown these exact strings and asked to pick
 * from them, and the validator drops anything that is not one of them. If the
 * two ever built the list differently, the model would be asked for something
 * it would then be penalised for giving.
 *
 * This is what stops the memo inventing. The model still decides which of them
 * mattered enough to write down — that judgement is the point of asking it —
 * but it cannot add a fourth refuted assumption the discussion never had.
 */
export function closingKnownState(context: FacilitatorContext): {
  refutedAssumptions: string[];
  unresolvedIssues: string[];
  actionItems: string[];
} {
  return {
    refutedAssumptions: significantLearnings(context.assumptions),
    // A crux nobody answered and a conflict nobody resolved are the same thing
    // to the team reading the memo: something the decision was taken without.
    unresolvedIssues: [
      ...context.cruxes.filter((c) => c.status === "OPEN").map((c) => c.question),
      ...context.conflicts.filter((c) => c.status === "OPEN").map((c) => c.description)
    ],
    actionItems: context.actionItems.map((i) => i.description)
  };
}

/**
 * Dissent, deterministically: the positions themselves, when the team is
 * holding more than one of them.
 *
 * Every held position is returned rather than a minority's. Which side is the
 * minority is exactly the sort of thing this product must not point at — a
 * facilitator that hands the owner a list headed "the people still
 * disagreeing" has told them whose view to discount. The fact worth reporting
 * is that the team did not converge, and that fact is symmetric.
 *
 * Generic over the position shape because two callers need the same rule from
 * different sides: the advisory works from the board's `PositionView`, and the
 * memo validator from the raw `CurrentPosition` rows.
 */
export function dissentingPositions<T extends { optionId: string | null }>(positions: T[]): T[] {
  const held = positions.filter((p) => p.optionId !== null);
  return new Set(held.map((p) => p.optionId)).size > 1 ? held : [];
}
