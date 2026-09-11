import { describe, expect, it } from "vitest";
import {
  closingKnownState,
  composeClosingAdvisory,
  dissentingPositions,
  significantLearnings,
  type ClosingAdvisoryInput
} from "../../src/server/domain/closing.ts";
import type {
  ActionItem,
  Conflict,
  Crux,
  Decision,
  FacilitatorAssumption,
  FacilitatorContext,
  PositionView
} from "../../src/shared/types.ts";

/**
 * What closing is made of, apart from the transaction.
 *
 * All of it pure, and all of it the part that decides what the owner sees
 * before ending the decision and what the team keeps afterwards. The Agent
 * tests prove it is composed from authoritative state; this is the composition
 * itself.
 */

const assumption = (
  statement: string,
  status: FacilitatorAssumption["status"]
): FacilitatorAssumption => ({
  id: statement,
  participantId: null,
  statement,
  source: "INFERRED",
  status,
  firstSeenSeq: 1,
  updatedAt: 0
});

const crux = (question: string, status: Crux["status"] = "OPEN"): Crux => ({
  id: question,
  question,
  status,
  createdAt: 0,
  updatedAt: 0
});

const conflict = (description: string, status: Conflict["status"] = "OPEN"): Conflict => ({
  id: description,
  description,
  participantIds: [],
  status,
  createdAt: 0
});

const position = (participantId: string, optionId: string | null): PositionView => ({
  participantId,
  displayName: participantId,
  optionId,
  confidence: 3,
  submitted: true
});

function advisory(overrides: Partial<ClosingAdvisoryInput> = {}) {
  return composeClosingAdvisory({
    positions: [],
    cruxes: [],
    conflicts: [],
    assumptions: [],
    ...overrides
  });
}

describe("the closing advisory", () => {
  it("is empty when the discussion left nothing open", () => {
    expect(advisory()).toEqual({
      unresolvedCruxes: [],
      unresolvedConflicts: [],
      challengedAssumptions: [],
      dissentingPositions: []
    });
  });

  it("reports only the cruxes and conflicts that are still open", () => {
    const result = advisory({
      cruxes: [crux("How long is the contract?"), crux("Can we hire?", "RESOLVED")],
      conflicts: [conflict("Ada and Grace price the delay differently"), conflict("settled", "RESOLVED")]
    });

    expect(result.unresolvedCruxes.map((c) => c.question)).toEqual(["How long is the contract?"]);
    expect(result.unresolvedConflicts.map((c) => c.description)).toEqual([
      "Ada and Grace price the delay differently"
    ]);
  });

  /**
   * An assumption merely noticed is not something the owner needs warning
   * about — the facilitator adds one of those on almost every message. What is
   * worth saying at closing is what the discussion actually disputed.
   */
  it("reports the assumptions the discussion challenged or refuted, and no others", () => {
    const result = advisory({
      assumptions: [
        assumption("the contract renews", "OPEN"),
        assumption("March is free", "CHALLENGED"),
        assumption("the beta is stable", "REFUTED"),
        assumption("we agreed the scope", "CONFIRMED")
      ]
    });

    expect(result.challengedAssumptions.map((a) => a.statement)).toEqual([
      "March is free",
      "the beta is stable"
    ]);
  });

  it("reports dissent when the team is holding more than one position", () => {
    const result = advisory({
      positions: [position("ada", "opt-1"), position("grace", "opt-2"), position("lin", null)]
    });

    // Everyone holding a position, not a minority: which side is the minority
    // is exactly what this product must not point at.
    expect(result.dissentingPositions.map((p) => p.participantId)).toEqual(["ada", "grace"]);
  });

  it("reports no dissent when everyone who has a position holds the same one", () => {
    const result = advisory({
      positions: [position("ada", "opt-1"), position("grace", "opt-1"), position("lin", null)]
    });

    expect(result.dissentingPositions).toEqual([]);
  });

  it("reports no dissent when only one person has a position at all", () => {
    expect(dissentingPositions([position("ada", "opt-1"), position("grace", null)])).toEqual([]);
  });
});

describe("significant learnings", () => {
  /**
   * "Significant", for M6, means the discussion moved it. An assumption nobody
   * disputed is not something the team found out.
   */
  it("is the statements of the challenged and refuted assumptions", () => {
    expect(
      significantLearnings([
        assumption("the contract renews", "OPEN"),
        assumption("March is free", "CHALLENGED"),
        assumption("we agreed the scope", "CONFIRMED"),
        assumption("the beta is stable", "REFUTED")
      ])
    ).toEqual(["March is free", "the beta is stable"]);
  });

  it("is empty when nothing was challenged", () => {
    expect(significantLearnings([assumption("the contract renews", "OPEN")])).toEqual([]);
  });
});

describe("the memo's known state", () => {
  const DECISION: Decision = {
    id: "d1",
    question: "Ship in February or slip to March?",
    context: null,
    options: [{ id: "opt-1", label: "Ship in February" }],
    status: "CLOSED",
    ownerParticipantId: "ada",
    createdAt: 0,
    revealedAt: 1,
    closedAt: 2,
    outcomeOptionId: "opt-1"
  };

  const item = (description: string): ActionItem => ({
    id: description,
    description,
    ownerParticipantId: null,
    createdAt: 0
  });

  const context = {
    decision: DECISION,
    participants: [],
    submissions: [],
    positions: [],
    messages: [],
    assumptions: [assumption("March is free", "CHALLENGED"), assumption("noticed", "OPEN")],
    cruxes: [crux("How long is the contract?"), crux("Can we hire?", "RESOLVED")],
    conflicts: [conflict("they price the delay differently"), conflict("settled", "RESOLVED")],
    actionItems: [item("Ada to confirm the contract end date")],
    interventions: [],
    meta: { analysisRunning: false, analysisPending: false, lastAnalyzedSeq: 0, lastError: null }
  } satisfies FacilitatorContext;

  /**
   * This is what the memo may draw from, and one function produces it for both
   * the prompt and the validator — so the model can never be asked for
   * something it would then be penalised for giving.
   */
  it("offers the challenged assumptions, the open cruxes and conflicts, and the commitments", () => {
    expect(closingKnownState(context)).toEqual({
      refutedAssumptions: ["March is free"],
      unresolvedIssues: ["How long is the contract?", "they price the delay differently"],
      actionItems: ["Ada to confirm the contract end date"]
    });
  });
});
