import { describe, expect, it } from "vitest";
import {
  completionFrom,
  LIMITS,
  parseAnalysis,
  parseClosingMemo
} from "../../src/server/facilitator/parse.ts";
import { TRANSCRIPT } from "../../evals/transcript.ts";
import type { FacilitatorAssumption, FacilitatorContext } from "../../src/shared/types.ts";

/**
 * The validation pipeline, which is the only thing standing between an
 * untrusted model and the Decision Agent's SQLite.
 *
 * The context is the evaluation's transcript, so the participants these tests
 * name are real ones and "unknown participant" means what it says.
 */

const PRIYA = TRANSCRIPT.participants[0]!.id;
const ANALYZED_THROUGH = TRANSCRIPT.messages.length;

/** A well-formed model response, as the schema constrains it. */
function output(overrides: Record<string, unknown> = {}) {
  return {
    assumptions: [
      { participant: "Priya", statement: "The migration is six weeks", source: "EXPLICIT", status: "OPEN" }
    ],
    cruxes: [{ question: "Can the contract be extended?", status: "OPEN" }],
    conflicts: [{ description: "Priya and Marcus disagree", participants: ["Priya", "Marcus"], status: "OPEN" }],
    actionItems: [{ description: "Ask Arcus about the renewal", owner: "Marcus" }],
    positionChanges: [],
    intervention: {
      issue: "contract-extension",
      message: "Are you assuming the contract cannot be extended, Marcus?"
    },
    ...overrides
  };
}

/** One well-formed observed change, overridable field by field. */
function change(overrides: Record<string, unknown> = {}) {
  return {
    positionChanges: [
      {
        participant: "Priya",
        option: "Move to Northwind before Q3",
        confidence: 4,
        explicit: true,
        ...overrides
      }
    ]
  };
}

const parse = (value: unknown) => parseAnalysis(value, TRANSCRIPT);

describe("parsing the model's response", () => {
  it("accepts an object, which is what structured-output mode returns", () => {
    const result = parse(output());
    expect(result.assumptions[0]!.statement).toBe("The migration is six weeks");
    expect(result.intervention?.message).toMatch(/Are you assuming/);
  });

  it("accepts the same thing as text", () => {
    expect(parse(JSON.stringify(output())).cruxes).toHaveLength(1);
  });

  it("recovers JSON from a code fence or a sentence of preamble", () => {
    const json = JSON.stringify(output());
    expect(parse("```json\n" + json + "\n```").cruxes).toHaveLength(1);
    expect(parse(`Here is my analysis:\n${json}\nLet me know.`).cruxes).toHaveLength(1);
  });

  it("refuses text that contains no JSON at all", () => {
    expect(() => parse("I could not analyze this discussion.")).toThrow(/no JSON object/);
  });

  it("refuses JSON that is not an object", () => {
    // A JSON array has no braces to find, so text fails a step earlier than a
    // value the runtime already parsed. Both are refusals.
    expect(() => parse("[1, 2, 3]")).toThrow(/no JSON object/);
    expect(() => parse([1, 2, 3])).toThrow(/not an object/);
    expect(() => parse(42)).toThrow(/not an object/);
  });

  it("takes the analyzed range from the transcript, never from the model", () => {
    // A model claiming to have read more than it was sent is exactly how a
    // stale result would slip past the Decision Agent's staleness check.
    const result = parse({ ...output(), analyzedThroughSeq: 9999 });
    expect(result.analyzedThroughSeq).toBe(ANALYZED_THROUGH);
  });
});

describe("schema validation", () => {
  it("refuses an unknown enum value", () => {
    expect(() =>
      parse(output({ assumptions: [{ participant: "Priya", statement: "x", source: "GUESSED", status: "OPEN" }] }))
    ).toThrow(/source must be one of/);
    expect(() => parse(output({ cruxes: [{ question: "x", status: "PENDING" }] }))).toThrow(
      /status must be one of/
    );
  });

  it("refuses an empty or missing statement", () => {
    expect(() =>
      parse(output({ assumptions: [{ participant: "Priya", statement: "   ", source: "EXPLICIT", status: "OPEN" }] }))
    ).toThrow(/non-empty string/);
  });

  it("refuses a field that should be a list but is not", () => {
    expect(() => parse(output({ cruxes: "none" }))).toThrow(/cruxes must be an array/);
  });

  it("treats a missing list as an empty one — silence on a category is allowed", () => {
    const result = parse({ intervention: null });
    expect(result).toMatchObject({ assumptions: [], cruxes: [], conflicts: [], actionItems: [] });
  });

  it("caps how much state one response can push into the decision", () => {
    const many = Array.from({ length: LIMITS.assumptions + 10 }, (_, i) => ({
      participant: "Priya",
      statement: `assumption ${i}`,
      source: "INFERRED",
      status: "OPEN"
    }));
    expect(parse(output({ assumptions: many })).assumptions).toHaveLength(LIMITS.assumptions);
  });
});

describe("semantic validation", () => {
  it("resolves display names to participants, ignoring case and spacing", () => {
    const result = parse(
      output({ assumptions: [{ participant: " priya ", statement: "x", source: "EXPLICIT", status: "OPEN" }] })
    );
    expect(result.assumptions[0]!.participantId).toBe(PRIYA);
  });

  it("keeps an assumption the whole team holds", () => {
    const result = parse(
      output({ assumptions: [{ participant: null, statement: "x", source: "INFERRED", status: "OPEN" }] })
    );
    expect(result.assumptions[0]!.participantId).toBeNull();
  });

  it("drops an assumption attributed to someone who is not in the decision", () => {
    // There is nobody to ask about it, so it is not an assumption this
    // decision holds — and inventing a participant must not reach SQLite.
    const result = parse(
      output({
        assumptions: [
          { participant: "Priya", statement: "kept", source: "EXPLICIT", status: "OPEN" },
          { participant: "Napoleon", statement: "dropped", source: "INFERRED", status: "OPEN" }
        ]
      })
    );
    expect(result.assumptions.map((a) => a.statement)).toEqual(["kept"]);
  });

  it("keeps a conflict but drops the participants it invented", () => {
    const result = parse(
      output({
        conflicts: [{ description: "A disagreement", participants: ["Priya", "Napoleon"], status: "OPEN" }]
      })
    );
    expect(result.conflicts[0]!.participantIds).toEqual([PRIYA]);
  });

  it("leaves an action item unowned rather than owned by a stranger", () => {
    const result = parse(output({ actionItems: [{ description: "Ask Arcus", owner: "Napoleon" }] }));
    expect(result.actionItems[0]!.ownerParticipantId).toBeNull();
  });
});

describe("the intervention", () => {
  it("is null when the facilitator has nothing to say", () => {
    expect(parse(output({ intervention: null })).intervention).toBeNull();
    expect(parse(output({ intervention: { issue: "x", message: "   " } })).intervention).toBeNull();
  });

  it("is held to the same rules as a participant's message", () => {
    expect(parse(output({ intervention: { issue: "x", message: "  Trimmed.  " } }))).toMatchObject({
      intervention: { message: "Trimmed." }
    });
    expect(() => parse(output({ intervention: { issue: "x", message: "y".repeat(5000) } }))).toThrow(
      /exceeds/
    );
    expect(() => parse(output({ intervention: "a bare string" }))).toThrow(/object or null/);
  });

  it("carries an issue key, normalised so the same issue compares equal", () => {
    expect(
      parse(output({ intervention: { issue: " Contract Extension ", message: "Ask them." } }))
        .intervention?.issueKey
    ).toBe("contract-extension");
    expect(() => parse(output({ intervention: { issue: "", message: "Ask them." } }))).toThrow(
      /non-empty/
    );
    expect(() =>
      parse(output({ intervention: { issue: "x".repeat(200), message: "Ask them." } }))
    ).toThrow(/too long/);
  });
});

describe("observed position changes", () => {
  it("resolves the participant and the option label they named", () => {
    expect(parse(output(change())).positionChanges).toEqual([
      { participantId: PRIYA, optionId: "opt-1", confidence: 4, explicit: true }
    ]);
  });

  it("drops anything the facilitator only inferred", () => {
    // The one rule protecting a participant's stated position: reasoning that
    // shifts is not a change, and nothing downstream ever sees one.
    expect(parse(output(change({ explicit: false }))).positionChanges).toEqual([]);
    expect(() => parse(output(change({ explicit: "yes" })))).toThrow(/must be a boolean/);
  });

  it("keeps a confidence-only change, where no option is named", () => {
    expect(parse(output(change({ option: null }))).positionChanges).toEqual([
      { participantId: PRIYA, optionId: null, confidence: 4, explicit: true }
    ]);
  });

  it("keeps an option change with no confidence — the Agent asks for it", () => {
    expect(parse(output(change({ confidence: null }))).positionChanges).toEqual([
      { participantId: PRIYA, optionId: "opt-1", confidence: null, explicit: true }
    ]);
  });

  it("drops a change naming an option or a person the decision does not have", () => {
    expect(parse(output(change({ option: "Switch to Stripe" }))).positionChanges).toEqual([]);
    expect(parse(output(change({ participant: "Napoleon" }))).positionChanges).toEqual([]);
  });

  it("refuses a confidence outside 1–5", () => {
    expect(() => parse(output(change({ confidence: 9 })))).toThrow(/integer 1–5/);
    expect(() => parse(output(change({ confidence: 2.5 })))).toThrow(/integer 1–5/);
  });

  it("caps how many changes one response can apply", () => {
    const many = Array.from({ length: LIMITS.positionChanges + 5 }, () => ({
      participant: "Priya",
      option: "Stay with Arcus for another year",
      confidence: 3,
      explicit: true
    }));
    expect(parse(output({ positionChanges: many })).positionChanges).toHaveLength(
      LIMITS.positionChanges
    );
  });
});

describe("unwrapping the runtime's envelope", () => {
  it("reads the Workers AI shape", () => {
    expect(completionFrom({ response: { ok: true } })).toEqual({ ok: true });
    expect(completionFrom({ response: "{}" })).toBe("{}");
  });

  it("reads the OpenAI chat-completions shape", () => {
    expect(completionFrom({ choices: [{ message: { content: "{}" } }] })).toBe("{}");
  });

  it("reads the OpenAI responses shape", () => {
    expect(
      completionFrom({ output: [{ content: [{ type: "output_text", text: "{}" }] }] })
    ).toBe("{}");
  });

  it("refuses an envelope with no completion in it", () => {
    expect(() => completionFrom({ usage: { total_tokens: 12 } })).toThrow(/no completion/);
    expect(() => completionFrom(null)).toThrow(/no completion/);
  });
});

/**
 * The closing memo's validation, which is a stricter job than the analysis's.
 *
 * A memo is the decision's permanent record. An analysis that gets something
 * wrong is corrected by the next one; a memo that quietly gained a refuted
 * assumption nobody ever refuted is what the team reads in six months. So the
 * three list fields are validated by grounding — the model selects from the
 * statements the facilitator actually recorded, and anything else is dropped.
 */
describe("parsing the closing memo", () => {
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

  /** The transcript, closed on "stay with Arcus", with state to select from. */
  const CLOSED: FacilitatorContext = {
    ...TRANSCRIPT,
    decision: { ...TRANSCRIPT.decision, status: "CLOSED", closedAt: 1, outcomeOptionId: "opt-2" },
    assumptions: [
      assumption("The Arcus contract cannot be extended month to month", "REFUTED"),
      assumption("The migration is six weeks", "OPEN")
    ],
    cruxes: [
      { id: "c1", question: "Can the contract be extended?", status: "OPEN", createdAt: 0, updatedAt: 0 },
      { id: "c2", question: "Is Sam free?", status: "RESOLVED", createdAt: 0, updatedAt: 0 }
    ],
    conflicts: [
      { id: "x1", description: "Priya and Marcus price the delay differently", participantIds: [], status: "OPEN", createdAt: 0 }
    ],
    actionItems: [{ id: "a1", description: "Ask Arcus about the renewal", ownerParticipantId: null, createdAt: 0 }]
  };

  function memo(overrides: Record<string, unknown> = {}) {
    return {
      reasoning: "The team weighed a 40k saving against six weeks of engineering it does not have.",
      refutedAssumptions: ["The Arcus contract cannot be extended month to month"],
      unresolvedIssues: ["Can the contract be extended?"],
      dissent: ["Marcus still holds that the fee difference outweighs the migration cost."],
      actionItems: ["Ask Arcus about the renewal"],
      ...overrides
    };
  }

  const parse = (value: unknown, context: FacilitatorContext = CLOSED) =>
    parseClosingMemo(value, context);

  it("accepts a well-formed memo and keeps every grounded field", () => {
    expect(parse(memo())).toEqual({
      outcomeOptionId: "opt-2",
      reasoning: "The team weighed a 40k saving against six weeks of engineering it does not have.",
      refutedAssumptions: ["The Arcus contract cannot be extended month to month"],
      unresolvedIssues: ["Can the contract be extended?"],
      dissent: ["Marcus still holds that the fee difference outweighs the migration cost."],
      actionItems: ["Ask Arcus about the renewal"]
    });
  });

  it("accepts the same thing as text, fence and preamble included", () => {
    const json = JSON.stringify(memo());
    expect(parse("```json\n" + json + "\n```").reasoning).toMatch(/40k/);
  });

  /**
   * The one guarantee that has to hold whatever the model does: the outcome is
   * copied from the closed decision, and there is no field on the response it
   * could have come from.
   */
  it("takes the outcome from the decision, never from the model", () => {
    expect(parse(memo({ outcomeOptionId: "opt-1", decision: "Move to Northwind" })).outcomeOptionId).toBe(
      "opt-2"
    );
  });

  it("refuses to write a memo for a decision with no declared outcome", () => {
    expect(() => parse(memo(), TRANSCRIPT)).toThrow(/no declared outcome/);
  });

  it("drops a refuted assumption the facilitator never recorded", () => {
    const result = parse(
      memo({
        refutedAssumptions: [
          "The Arcus contract cannot be extended month to month",
          "Northwind has a worse support team"
        ]
      })
    );
    expect(result.refutedAssumptions).toEqual([
      "The Arcus contract cannot be extended month to month"
    ]);
  });

  /** An assumption nobody disputed is not a refuted one, however true. */
  it("drops an assumption that is real but was never challenged", () => {
    expect(parse(memo({ refutedAssumptions: ["The migration is six weeks"] })).refutedAssumptions).toEqual(
      []
    );
  });

  it("drops an unresolved issue that was in fact resolved", () => {
    expect(parse(memo({ unresolvedIssues: ["Is Sam free?"] })).unresolvedIssues).toEqual([]);
  });

  it("accepts an open conflict as an unresolved issue", () => {
    expect(
      parse(memo({ unresolvedIssues: ["Priya and Marcus price the delay differently"] }))
        .unresolvedIssues
    ).toEqual(["Priya and Marcus price the delay differently"]);
  });

  it("drops an action item nobody committed to", () => {
    expect(parse(memo({ actionItems: ["Ship it in February"] })).actionItems).toEqual([]);
  });

  /** The model copies out of prose; a capital letter is not a different item. */
  it("matches case- and space-insensitively, and keeps the facilitator's wording", () => {
    expect(
      parse(memo({ refutedAssumptions: ["  the arcus CONTRACT cannot be extended month to month "] }))
        .refutedAssumptions
    ).toEqual(["The Arcus contract cannot be extended month to month"]);
  });

  it("does not let a reworded item through", () => {
    expect(
      parse(memo({ refutedAssumptions: ["The Arcus contract can be extended after all"] }))
        .refutedAssumptions
    ).toEqual([]);
  });

  it("keeps one copy of an item the model listed twice", () => {
    const listed = ["Ask Arcus about the renewal", "ask arcus about the renewal"];
    expect(parse(memo({ actionItems: listed })).actionItems).toEqual(["Ask Arcus about the renewal"]);
  });

  it("bounds each list", () => {
    const many = Array.from({ length: LIMITS.memoItems + 5 }, () => "Ask Arcus about the renewal");
    expect(parse(memo({ actionItems: many })).actionItems).toHaveLength(1);
  });

  /**
   * Dissent has no canonical list to select from, so it is grounded in the one
   * thing that can be checked: whether the team actually ended up disagreeing.
   */
  it("keeps dissent when the final positions differ", () => {
    expect(parse(memo()).dissent).toHaveLength(1);
  });

  it("drops dissent entirely when the team converged", () => {
    const converged: FacilitatorContext = {
      ...CLOSED,
      positions: CLOSED.positions.map((p) => ({ ...p, optionId: "opt-2" }))
    };
    expect(parse(memo(), converged).dissent).toEqual([]);
  });

  it("refuses a memo with no reasoning at all", () => {
    expect(() => parse(memo({ reasoning: "   " }))).toThrow(/reasoning/);
    expect(() => parse(memo({ reasoning: 12 }))).toThrow(/reasoning/);
  });

  it("refuses reasoning long enough to be the transcript again", () => {
    expect(() => parse(memo({ reasoning: "x".repeat(LIMITS.reasoning + 1) }))).toThrow(/too long/);
  });

  it("refuses a response that is not an object", () => {
    // Text without braces fails a step earlier than a value the runtime has
    // already parsed for us. Both are refusals.
    expect(() => parse("[]")).toThrow(/no JSON object/);
    expect(() => parse([1, 2, 3])).toThrow(/not an object/);
  });

  it("treats a missing list as an empty one", () => {
    const result = parse({ reasoning: "They weighed the saving against the capacity." });
    expect(result.refutedAssumptions).toEqual([]);
    expect(result.unresolvedIssues).toEqual([]);
    expect(result.actionItems).toEqual([]);
  });

  it("refuses a list that is not an array", () => {
    expect(() => parse(memo({ actionItems: "Ask Arcus about the renewal" }))).toThrow(/must be an array/);
  });

  it("refuses a list with a non-string in it", () => {
    expect(() => parse(memo({ refutedAssumptions: [42] }))).toThrow(/must contain strings/);
  });
});
