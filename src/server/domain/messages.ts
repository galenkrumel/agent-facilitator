/**
 * Not a product rule — a bound on what one participant can write into the
 * Decision Agent in a single message. The requirements set no length, so this
 * is generous: long enough for a considered argument, short enough that one
 * participant cannot fill the transcript the facilitator has to read.
 */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Validates a discussion message.
 *
 * Pure, for the same reason `validateSubmission` is: the Agent's transaction
 * stays a straight line of reads and writes, and the rules are testable
 * without a Durable Object. Messages are participant-facing — they surface in
 * the composer.
 *
 * Trimming is the whole normalisation story. Messages are immutable and there
 * is no editing, so what is stored is exactly what the participant meant to
 * say; the facilitator reads the same text everyone else does.
 */
export function validateMessageBody(body: unknown): string {
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) throw new Error("A message cannot be empty.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Keep each message under ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return trimmed;
}
