import type { Decision, Participant, Permissions } from "../../shared/types.ts";

/**
 * The authorization table from the requirements, as a pure projection of
 * status + ownership. Kept out of the Agent so it stays directly testable.
 */
export function permissionsFor(
  decision: Decision,
  viewer: Participant,
  hasSubmitted: boolean
): Permissions {
  const submitting = decision.status === "SUBMIT";
  const discussing = decision.status === "DISCUSS";
  return {
    // Initial submissions are one-shot and immutable.
    canSubmit: submitting && !hasSubmitted,
    canPostMessage: discussing,
    canChangePosition: discussing,
    // Participation is voluntary: the owner decides when Submit has run its course.
    canDeclareSubmissionsComplete: viewer.isOwner && submitting,
    canClose: viewer.isOwner && discussing
  };
}
