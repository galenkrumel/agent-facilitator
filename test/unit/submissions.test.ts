import { describe, expect, it } from "vitest";
import {
  MAX_REASONS,
  MAX_REASON_LENGTH,
  validateSubmission
} from "../../src/server/domain/submissions.ts";
import type { DecisionOption } from "../../src/shared/types.ts";

const OPTIONS: DecisionOption[] = [
  { id: "opt-1", label: "Ship in February" },
  { id: "opt-2", label: "Slip to March" },
  { id: "other", label: "Other" }
];

const valid = { optionId: "opt-1", confidence: 3, reasons: ["The beta is stable"] };

describe("validateSubmission", () => {
  it("accepts a well-formed submission", () => {
    expect(validateSubmission(OPTIONS, valid)).toEqual({
      optionId: "opt-1",
      confidence: 3,
      reasons: ["The beta is stable"]
    });
  });

  it("accepts the automatically added Other option", () => {
    expect(validateSubmission(OPTIONS, { ...valid, optionId: "other" }).optionId).toBe("other");
  });

  it("rejects an option the decision does not offer", () => {
    expect(() => validateSubmission(OPTIONS, { ...valid, optionId: "opt-9" })).toThrow(/not one of/);
    expect(() => validateSubmission(OPTIONS, { ...valid, optionId: "" })).toThrow(/not one of/);
  });

  it("requires confidence to be a whole number from 1 to 5", () => {
    for (const confidence of [1, 2, 3, 4, 5]) {
      expect(validateSubmission(OPTIONS, { ...valid, confidence }).confidence).toBe(confidence);
    }
    for (const confidence of [0, 6, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateSubmission(OPTIONS, { ...valid, confidence })).toThrow(/1 to 5/);
    }
  });

  it("allows no reasons at all — only the position is required", () => {
    expect(validateSubmission(OPTIONS, { ...valid, reasons: [] }).reasons).toEqual([]);
  });

  it(`rejects more than ${MAX_REASONS} reasons`, () => {
    const reasons = ["a", "b", "c", "d"];
    expect(() => validateSubmission(OPTIONS, { ...valid, reasons })).toThrow(/at most 3/);
    expect(validateSubmission(OPTIONS, { ...valid, reasons: reasons.slice(0, 3) }).reasons).toHaveLength(3);
  });

  it("drops blank reasons rather than counting untouched form fields", () => {
    const reasons = ["  Cheaper  ", "", "   ", "Faster"];
    expect(validateSubmission(OPTIONS, { ...valid, reasons }).reasons).toEqual(["Cheaper", "Faster"]);
  });

  it("bounds what a single participant can write into the Agent", () => {
    const reasons = ["x".repeat(MAX_REASON_LENGTH + 1)];
    expect(() => validateSubmission(OPTIONS, { ...valid, reasons })).toThrow(/characters/);
    expect(validateSubmission(OPTIONS, { ...valid, reasons: ["x".repeat(MAX_REASON_LENGTH)] }).reasons)
      .toHaveLength(1);
  });

  it("tolerates a client that sends no reasons array at all", () => {
    expect(validateSubmission(OPTIONS, { ...valid, reasons: undefined as never }).reasons).toEqual([]);
  });
});
