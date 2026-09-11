import { describe, expect, it } from "vitest";
import { composeBrief, type BriefInput } from "../../src/server/domain/brief.ts";
import type { Decision, Participant } from "../../src/shared/types.ts";

/**
 * How the brief reads. The Agent tests prove it is composed from authoritative
 * state and that reading it records the visit; what is left is the wording,
 * which is the part a participant actually meets.
 */

const DECISION: Decision = {
  id: "d1",
  question: "Ship in February or slip to March?",
  context: null,
  options: [
    { id: "opt-1", label: "Ship in February" },
    { id: "opt-2", label: "Slip to March" },
    { id: "other", label: "Other" }
  ],
  status: "DISCUSS",
  ownerParticipantId: "ada",
  createdAt: 0,
  revealedAt: 10,
  closedAt: null,
  outcomeOptionId: null
};

const person = (id: string, lastVisitedAt: number | null = null): Participant => ({
  id,
  displayName: id[0]!.toUpperCase() + id.slice(1),
  isOwner: id === "ada",
  createdAt: 0,
  lastVisitedAt
});

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    decision: DECISION,
    viewer: person("ada"),
    participants: [person("ada"), person("grace"), person("lin")],
    positions: [
      { participantId: "ada", optionId: "opt-1", confidence: 4, updatedAt: 10 },
      { participantId: "grace", optionId: "opt-1", confidence: 3, updatedAt: 10 }
    ],
    cruxes: [],
    actionItems: [],
    assumptions: [],
    messages: [],
    pendingRequests: [],
    submittedCount: 2,
    now: 1000,
    ...overrides
  };
}

describe("the first-visit brief", () => {
  it("groups who holds what, and says who holds nothing", () => {
    const brief = composeBrief(input());
    expect(brief.kind).toBe("FIRST_VISIT");
    expect(brief.summary).toMatch(
      /Current positions: Ada and Grace → Ship in February; Lin → no position\./
    );
  });

  it("recommends nothing, counts or not", () => {
    const brief = composeBrief(
      input({
        cruxes: [
          { id: "c1", question: "Is the crash rate release-blocking?", status: "OPEN", createdAt: 20, updatedAt: 20 }
        ],
        messages: [
          { seq: 1, author: { kind: "PARTICIPANT", participantId: "ada" }, body: "One.", createdAt: 20 }
        ]
      })
    );
    expect(brief.summary).toMatch(/1 message so far\./);
    expect(brief.summary).toMatch(/1 open crux\./);
    expect(brief.openCruxes).toEqual(["Is the crash rate release-blocking?"]);
    // Nothing in a brief may read as advice, a lean, or a score.
    expect(brief.summary).not.toMatch(/should|stronger|better|recommend|suggest|risk/i);
  });
});

describe("the returning brief", () => {
  const returning = (overrides: Partial<BriefInput> = {}) =>
    composeBrief(input({ viewer: person("ada", 100), ...overrides }));

  it("counts only what happened after the last visit", () => {
    const brief = returning({
      messages: [
        { seq: 1, author: { kind: "PARTICIPANT", participantId: "grace" }, body: "Before.", createdAt: 50 },
        { seq: 2, author: { kind: "FACILITATOR" }, body: "After.", createdAt: 150 }
      ],
      positions: [
        { participantId: "ada", optionId: "opt-1", confidence: 4, updatedAt: 10 },
        { participantId: "grace", optionId: "opt-2", confidence: 2, updatedAt: 150 }
      ]
    });
    expect(brief.kind).toBe("RETURNING");
    expect(brief.since).toBe(100);
    expect(brief.summary).toMatch(/Since your last visit: 1 new message and Grace changed position\./);
  });

  it("reports a quiet decision as quiet", () => {
    expect(returning().summary).toMatch(/^Nothing has changed since your last visit\./);
  });

  it("carries only assumptions challenged since the last visit", () => {
    const assumption = (id: string, updatedAt: number, status: "OPEN" | "CHALLENGED") => ({
      id,
      participantId: "ada",
      statement: `assumption ${id}`,
      source: "INFERRED" as const,
      status,
      firstSeenSeq: 1,
      updatedAt
    });
    const brief = returning({
      assumptions: [
        assumption("old", 50, "CHALLENGED"),
        assumption("new", 150, "CHALLENGED"),
        assumption("unchallenged", 150, "OPEN")
      ]
    });
    expect(brief.challengedAssumptions).toEqual(["assumption new"]);
  });
});

describe("before the reveal", () => {
  it("counts the submissions and says nothing about them", () => {
    const brief = composeBrief(
      input({
        decision: { ...DECISION, status: "SUBMIT", revealedAt: null },
        positions: [],
        submittedCount: 1
      })
    );
    expect(brief.summary).toMatch(/1 of 3 submitted/);
    expect(brief.summary).not.toMatch(/February|March/);
  });
});
