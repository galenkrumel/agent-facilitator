import { describe, expect, it } from "vitest";
import { completionFrom, LIMITS, parseAnalysis } from "../../src/server/facilitator/parse.ts";
import { TRANSCRIPT } from "../../evals/transcript.ts";

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
    intervention: "Are you assuming the contract cannot be extended, Marcus?",
    ...overrides
  };
}

const parse = (value: unknown) => parseAnalysis(value, TRANSCRIPT);

describe("parsing the model's response", () => {
  it("accepts an object, which is what structured-output mode returns", () => {
    const result = parse(output());
    expect(result.assumptions[0]!.statement).toBe("The migration is six weeks");
    expect(result.intervention).toMatch(/Are you assuming/);
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
    expect(parse(output({ intervention: "   " })).intervention).toBeNull();
  });

  it("is held to the same rules as a participant's message", () => {
    expect(parse(output({ intervention: "  Trimmed.  " })).intervention).toBe("Trimmed.");
    expect(() => parse(output({ intervention: "x".repeat(5000) }))).toThrow(/exceeds/);
    expect(() => parse(output({ intervention: 12 }))).toThrow(/string or null/);
  });

  it("never reports a position change — M5 owns applying those", () => {
    expect(parse(output({ positionChanges: [{ participant: "Priya", option: "opt-1" }] })).positionChanges).toEqual(
      []
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
