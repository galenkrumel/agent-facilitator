import type { Confidence, DecisionOption, InitialSubmission } from "../../shared/types.ts";

/** What a participant supplies when submitting an initial position. */
export type InitialSubmissionInput = {
  optionId: string;
  confidence: number;
  /** Up to three. Blank entries are dropped, so an untouched form field is not a reason. */
  reasons: string[];
};

export const MAX_REASONS = 3;

/**
 * Not a product rule — a bound on what one participant can write into the
 * Decision Agent. The requirements set no length, so this is generous.
 */
export const MAX_REASON_LENGTH = 500;

/** An input that has been checked against the decision it is being made on. */
export type ValidatedSubmission = Pick<InitialSubmission, "optionId" | "confidence" | "reasons">;

/**
 * Validates an initial submission against the decision's own options.
 *
 * Pure, so the Agent's transaction stays a straight line of reads and writes
 * with nothing to reason about, and so the rules are testable without a
 * Durable Object. Messages are participant-facing: they surface in the form.
 */
export function validateSubmission(
  options: DecisionOption[],
  input: InitialSubmissionInput
): ValidatedSubmission {
  if (!options.some((o) => o.id === input.optionId)) {
    throw new Error("That is not one of this decision's options.");
  }
  if (!Number.isInteger(input.confidence) || input.confidence < 1 || input.confidence > 5) {
    throw new Error("Confidence must be a whole number from 1 to 5.");
  }

  const reasons = (Array.isArray(input.reasons) ? input.reasons : [])
    .map((reason) => String(reason).trim())
    .filter(Boolean);
  if (reasons.length > MAX_REASONS) {
    throw new Error(`Give at most ${MAX_REASONS} reasons.`);
  }
  if (reasons.some((reason) => reason.length > MAX_REASON_LENGTH)) {
    throw new Error(`Keep each reason under ${MAX_REASON_LENGTH} characters.`);
  }

  return { optionId: input.optionId, confidence: input.confidence as Confidence, reasons };
}
