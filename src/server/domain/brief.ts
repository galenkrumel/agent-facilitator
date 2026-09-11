/**
 * The Current State Brief: what a participant is told on opening the decision.
 *
 * Composed from authoritative state rather than written by the model, for the
 * reason the requirements give for the brief existing at all — it is
 * orientation, and it must be neutral. A generated summary of a disagreement
 * is one sentence away from being an argument about it, and a participant who
 * reads "the case for slipping has grown" has been recommended an option by a
 * facilitator that is not allowed to recommend one. Counting what changed
 * cannot do that, arrives instantly, needs no Workflow, and cannot be stale.
 *
 * The facilitator's judgement still reaches the participant here — the cruxes,
 * the challenged assumptions and the questions are all its reading of the
 * discussion. What is deterministic is the summarising, not the substance.
 *
 * Pure, so the whole of it is testable without a Durable Object.
 */
import type {
  ActionItem,
  Crux,
  CurrentPosition,
  Decision,
  FacilitatorAssumption,
  Message,
  Participant,
  PendingParticipantRequest,
  StateBrief
} from "../../shared/types.ts";

export type BriefInput = {
  decision: Decision;
  /** The participant the brief is for. `lastVisitedAt` is the boundary. */
  viewer: Participant;
  participants: Participant[];
  positions: CurrentPosition[];
  cruxes: Crux[];
  actionItems: ActionItem[];
  assumptions: FacilitatorAssumption[];
  messages: Message[];
  /** Open requests, of which only the viewer's own are shown to them. */
  pendingRequests: PendingParticipantRequest[];
  /** How many have submitted. During Submit, all the brief may say. */
  submittedCount: number;
  now: number;
};

const CHALLENGED: FacilitatorAssumption["status"][] = ["CHALLENGED", "REFUTED"];

export function composeBrief(input: BriefInput): StateBrief {
  const { decision, viewer, now } = input;
  const since = viewer.lastVisitedAt;
  const kind = since === null ? "FIRST_VISIT" : "RETURNING";

  const questionsForYou = input.pendingRequests
    .filter((r) => r.participantId === viewer.id)
    .map(() => "You've changed your position — what is your confidence in it now, from 1 to 5?");

  // Before the Reveal there is nothing to be oriented about, and what the
  // others have submitted is not the brief's to leak: who has answered is
  // already public, what they answered is not.
  if (decision.status === "SUBMIT") {
    const submitted = input.submittedCount;
    return {
      kind,
      since,
      generatedAt: now,
      summary:
        `Initial positions are still being collected — ${submitted} of ${input.participants.length} ` +
        `submitted. Everyone's position becomes visible at once, when the last one is in or the ` +
        `owner declares submissions complete.`,
      openCruxes: [],
      challengedAssumptions: [],
      questionsForYou
    };
  }

  const openCruxes = input.cruxes.filter((c) => c.status === "OPEN").map((c) => c.question);
  const challenged = input.assumptions.filter((a) => CHALLENGED.includes(a.status));

  return {
    kind,
    since,
    generatedAt: now,
    summary: since === null ? firstVisit(input, openCruxes.length) : returning(input, since),
    openCruxes,
    challengedAssumptions: (since === null
      ? challenged
      : challenged.filter((a) => a.updatedAt > since)
    ).map((a) => a.statement),
    questionsForYou
  };
}

/** Where the decision stands, for someone seeing it for the first time. */
function firstVisit(input: BriefInput, openCruxes: number): string {
  return [
    positionSentence(input),
    count(input.messages.length, "message")
      ? `${count(input.messages.length, "message")} so far.`
      : "Nobody has said anything yet.",
    count(openCruxes, "open crux", "open cruxes")
      ? `${count(openCruxes, "open crux", "open cruxes")}.`
      : "No crux is open."
  ].join(" ");
}

/** What has moved since this participant last opened the decision. */
function returning(input: BriefInput, since: number): string {
  const names = new Map(input.participants.map((p) => [p.id, p.displayName]));
  const moved = input.positions
    .filter((p) => p.updatedAt > since)
    .map((p) => names.get(p.participantId) ?? "Someone");
  const changes = [
    count(input.messages.filter((m) => m.createdAt > since).length, "new message"),
    moved.length ? `${list(moved)} changed position` : null,
    count(input.cruxes.filter((c) => c.createdAt > since).length, "new crux", "new cruxes"),
    count(
      input.cruxes.filter((c) => c.status === "RESOLVED" && c.updatedAt > since).length,
      "crux resolved",
      "cruxes resolved"
    ),
    count(
      input.assumptions.filter((a) => CHALLENGED.includes(a.status) && a.updatedAt > since).length,
      "assumption challenged",
      "assumptions challenged"
    ),
    count(input.actionItems.filter((a) => a.createdAt > since).length, "new action item")
  ].filter((c): c is string => c !== null);

  if (changes.length === 0) return `Nothing has changed since your last visit. ${positionSentence(input)}`;
  return `Since your last visit: ${list(changes)}. ${positionSentence(input)}`;
}

/** Who currently holds what — the one thing a brief always says. */
function positionSentence(input: BriefInput): string {
  const names = new Map(input.participants.map((p) => [p.id, p.displayName]));
  const labels = new Map(input.decision.options.map((o) => [o.id, o.label]));
  const held = new Map<string, string[]>();
  for (const position of input.positions) {
    if (!position.optionId) continue;
    const label = labels.get(position.optionId) ?? position.optionId;
    held.set(label, [...(held.get(label) ?? []), names.get(position.participantId) ?? "Someone"]);
  }

  const without = input.participants
    .filter((p) => !input.positions.some((o) => o.participantId === p.id && o.optionId))
    .map((p) => p.displayName);

  const clauses = [...held.entries()].map(([label, people]) => `${list(people)} → ${label}`);
  if (without.length) clauses.push(`${list(without)} → no position`);
  return clauses.length ? `Current positions: ${clauses.join("; ")}.` : "Nobody holds a position.";
}

function count(n: number, one: string, many = `${one}s`): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
