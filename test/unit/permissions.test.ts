import { describe, expect, it } from "vitest";
import { permissionsFor } from "../../src/server/domain/decisions.ts";
import type { Decision, DecisionStatus, Participant } from "../../src/shared/types.ts";

const owner: Participant = {
  id: "owner",
  displayName: "Ada",
  isOwner: true,
  createdAt: 0,
  lastVisitedAt: null
};
const participant: Participant = { ...owner, id: "grace", displayName: "Grace", isOwner: false };

function decision(status: DecisionStatus): Decision {
  return {
    id: "d",
    question: "Ship in February or slip to March?",
    context: null,
    options: [{ id: "opt-1", label: "Ship" }, { id: "other", label: "Other" }],
    status,
    ownerParticipantId: owner.id,
    createdAt: 0,
    revealedAt: status === "SUBMIT" ? null : 1,
    closedAt: status === "CLOSED" ? 2 : null,
    outcomeOptionId: status === "CLOSED" ? "opt-1" : null
  };
}

describe("permissionsFor", () => {
  it("lets a participant submit exactly once, during Submit", () => {
    expect(permissionsFor(decision("SUBMIT"), participant, false).canSubmit).toBe(true);
    expect(permissionsFor(decision("SUBMIT"), participant, true).canSubmit).toBe(false);
    expect(permissionsFor(decision("DISCUSS"), participant, false).canSubmit).toBe(false);
  });

  it("opens discussion and position changes only after Reveal", () => {
    const submitting = permissionsFor(decision("SUBMIT"), participant, true);
    expect(submitting.canPostMessage).toBe(false);
    expect(submitting.canChangePosition).toBe(false);

    const discussing = permissionsFor(decision("DISCUSS"), participant, true);
    expect(discussing.canPostMessage).toBe(true);
    expect(discussing.canChangePosition).toBe(true);
  });

  it("reserves declaring submissions complete and closing for the owner", () => {
    expect(permissionsFor(decision("SUBMIT"), owner, false).canDeclareSubmissionsComplete).toBe(true);
    expect(permissionsFor(decision("SUBMIT"), participant, false).canDeclareSubmissionsComplete).toBe(false);
    expect(permissionsFor(decision("DISCUSS"), owner, true).canClose).toBe(true);
    expect(permissionsFor(decision("DISCUSS"), participant, true).canClose).toBe(false);
  });

  it("freezes a closed decision for everyone, owner included", () => {
    expect(Object.values(permissionsFor(decision("CLOSED"), owner, true))).toEqual([
      false,
      false,
      false,
      false,
      false
    ]);
  });
});
