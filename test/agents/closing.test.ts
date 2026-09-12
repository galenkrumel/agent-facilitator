import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import {
  advisory,
  board,
  closingMemo,
  context,
  discussing,
  memo,
  messages,
  positions,
  projection,
  refusedWith,
  SILENT,
  stubWorkflow,
  type Agent
} from "./harness.ts";
import { DEFAULT_TEAM_ID, type TeamAgent } from "../../src/server/agents/team.ts";
import type { ClosedDecisionRecord, FacilitatorAnalysisResult } from "../../src/shared/types.ts";

/**
 * M6: the end of the lifecycle, in the real Workers runtime.
 *
 * Every claim here is a claim about a transaction or about committed order —
 * that a decision cannot be CLOSED without the outcome its owner declared,
 * that a message racing a close either lands before it or is refused, that a
 * memo written once cannot be written again. None of those can be demonstrated
 * by a stand-in for the runtime, so they are demonstrated in it.
 *
 * The Workflow is doubled, as it is everywhere else: the closing memo arrives
 * by hand, because these tests are about what the Agent does with one rather
 * than about what the model puts in it.
 */

const OTHER = "opt-2";
const SHIP = "opt-1";

/** Reads the decision row straight out of SQLite, bypassing every projection. */
function decisionRow(agent: Agent) {
  return runInDurableObject(agent, (instance) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const [row] = [...sql.exec("SELECT status, closed_at, outcome_option_id FROM decisions")];
    return row as { status: string; closed_at: number | null; outcome_option_id: string | null };
  });
}

/** A decision closed on "Ship in February", with the closing run stubbed out. */
async function closed(outcomeOptionId = SHIP) {
  const fixture = await discussing();
  const scheduled = await stubWorkflow(fixture.agent);
  await fixture.agent.closeFor(fixture.id.Ada!, outcomeOptionId);
  return { ...fixture, scheduled };
}

function team(): Promise<DurableObjectStub<TeamAgent>> {
  return getAgentByName(env.TeamAgent, DEFAULT_TEAM_ID) as Promise<DurableObjectStub<TeamAgent>>;
}

// ---------------------------------------------------------------------------

describe("closing the decision", () => {
  it("moves DISCUSS → CLOSED with the outcome the owner declared", async () => {
    const { agent } = await closed();

    const row = await decisionRow(agent);
    expect(row.status).toBe("CLOSED");
    expect(row.outcome_option_id).toBe(SHIP);
    expect(row.closed_at).toBeGreaterThan(0);
  });

  /**
   * The invariant the whole transaction exists for. The status and the outcome
   * move in one statement, so there is no instant — not even inside the
   * transaction — at which one exists without the other.
   */
  it("never leaves a decision CLOSED with no outcome", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);

    expect(await refusedWith(agent.closeFor(id.Ada!, "opt-nonexistent"))).toMatch(
      /must be one of this decision's options/
    );
    expect((await decisionRow(agent)).status).toBe("DISCUSS");
    expect((await decisionRow(agent)).outcome_option_id).toBeNull();
  });

  it("refuses an outcome that is not one of the options", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    expect(await refusedWith(agent.closeFor(id.Ada!, ""))).toMatch(/must be one of/);
  });

  it("accepts Other as an outcome, because it is one of the options", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    await agent.closeFor(id.Ada!, "other");
    expect((await decisionRow(agent)).outcome_option_id).toBe("other");
  });

  it("refuses anyone but the owner", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);

    expect(await refusedWith(agent.closeFor(id.Grace!, SHIP))).toMatch(/Only the owner/);
    expect((await decisionRow(agent)).status).toBe("DISCUSS");
  });

  it("refuses a close before the reveal", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });

    expect(await refusedWith(agent.closeFor(framed[0]!.id, SHIP))).toMatch(
      /until its initial positions are revealed/
    );
  });

  /** Exactly one close succeeds; the second observes CLOSED and fails. */
  it("refuses a second close", async () => {
    const { agent, id } = await closed();

    expect(await refusedWith(agent.closeFor(id.Ada!, OTHER))).toMatch(/already closed/);
    // And the outcome is still the first one, not the second.
    expect((await decisionRow(agent)).outcome_option_id).toBe(SHIP);
  });

  /**
   * There is no reopen operation, and no combination of the ones there are
   * amounts to one: every lifecycle entrance is refused and the decision is
   * still closed, on the same outcome, afterwards.
   */
  it("cannot be reopened", async () => {
    const { agent, id } = await closed();

    await refusedWith(agent.declareCompleteFor(id.Ada!));
    await refusedWith(agent.closeFor(id.Ada!, OTHER));
    await refusedWith(agent.postMessageFor(id.Ada!, "Actually, let's keep talking."));
    await refusedWith(agent.submitFor(id.Grace!, { optionId: OTHER, confidence: 3, reasons: [] }));

    const row = await decisionRow(agent);
    expect(row.status).toBe("CLOSED");
    expect(row.outcome_option_id).toBe(SHIP);
  });

  it("schedules the closing synthesis, and only after the close has committed", async () => {
    const { scheduled, agent } = await closed();

    expect(scheduled.map((c) => c.params.type)).toEqual(["CLOSING"]);
    // Whatever the Workflow does next, the decision is already closed.
    expect((await decisionRow(agent)).status).toBe("CLOSED");
  });

  /** AI failing must never cost the team a closure they already performed. */
  it("stays closed when the closing Workflow cannot even be scheduled", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent, "throw");
    await agent.closeFor(id.Ada!, SHIP);

    expect((await decisionRow(agent)).status).toBe("CLOSED");
    expect((await decisionRow(agent)).outcome_option_id).toBe(SHIP);
    expect((await closingMemo(agent))?.status).toBe("FAILED");
  });
});

describe("a closed decision", () => {
  it("refuses new messages", async () => {
    const { agent, id } = await closed();
    expect(await refusedWith(agent.postMessageFor(id.Grace!, "One more thing."))).toMatch(
      /closed — the discussion is frozen/
    );
  });

  it("refuses a late initial submission", async () => {
    const { agent, id } = await closed();
    expect(
      await refusedWith(agent.submitFor(id.Grace!, { optionId: SHIP, confidence: 3, reasons: [] }))
    ).toMatch(/Initial submissions are closed/);
  });

  it("refuses a second reveal", async () => {
    const { agent, id } = await closed();
    expect(await refusedWith(agent.declareCompleteFor(id.Ada!))).toMatch(/already been revealed/);
  });

  it("still shows the question, positions, cruxes and action items", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    // A message claims the analysis slot; an analysis with no run in flight is
    // a duplicate and is refused, which is what `applyAnalysis` is for.
    await agent.postMessageFor(id.Grace!, "Where are we on the crash numbers?");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 0,
      cruxes: [{ question: "Is the crash rate representative?", status: "OPEN" }],
      actionItems: [{ description: "Ada to pull the crash numbers", ownerParticipantId: id.Ada! }]
    });
    await agent.closeFor(id.Ada!, SHIP);

    const view = await board(agent);
    expect(view.cruxes.map((c) => c.question)).toEqual(["Is the crash rate representative?"]);
    expect(view.actionItems).toHaveLength(1);
    expect(view.positions).toHaveLength(2);
  });

  it("gives nobody permission to change anything", async () => {
    const { agent, id } = await closed();
    const permissions = await runInDurableObject(agent, (instance) => {
      const target = instance as unknown as { viewerId(): string; getBootstrap(): unknown };
      target.viewerId = () => id.Ada!;
      return (target.getBootstrap() as { permissions: Record<string, boolean> }).permissions;
    });

    expect(Object.values(permissions).every((allowed) => allowed === false)).toBe(true);
  });
});

describe("the message/close race", () => {
  /**
   * Committed order decides, and the Durable Object's single thread is what
   * establishes it. A message that commits first is in the discussion the memo
   * will describe; one that arrives afterwards is refused. There is no lock.
   */
  it("includes a message that committed before the close", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);

    await agent.postMessageFor(id.Grace!, "The crash rate is still climbing.");
    await agent.closeFor(id.Ada!, SHIP);

    const said = (await messages(agent)).map((m) => m.body);
    expect(said).toContain("The crash rate is still climbing.");
    // And the closing synthesis reads exactly that discussion.
    expect((await context(agent)).messages.map((m) => m.body)).toContain(
      "The crash rate is still climbing."
    );
  });

  it("refuses a message that arrives after the close committed", async () => {
    const { agent, id } = await closed();
    const before = (await messages(agent)).length;

    await refusedWith(agent.postMessageFor(id.Grace!, "Too late."));
    expect((await messages(agent)).length).toBe(before);
  });
});

describe("an analysis still in flight when the decision closes", () => {
  /** A fresh analysis, with something to say and someone to move. */
  const loud = (id: Record<string, string>): FacilitatorAnalysisResult => ({
    ...SILENT,
    analyzedThroughSeq: 99,
    cruxes: [{ question: "Should this have been asked?", status: "OPEN" }],
    positionChanges: [{ participantId: id.Grace!, optionId: OTHER, confidence: 1, explicit: true }],
    intervention: { issueKey: "too-late", message: "Are you both weighing the same crash data?" }
  });

  it("lands nothing at all once the decision is closed", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    // A run claims the slot, the owner closes, and only then does it report.
    await agent.postMessageFor(id.Grace!, "Still thinking about it.");
    const positionsBefore = await positions(agent);
    const messagesBefore = (await messages(agent)).length;

    await agent.closeFor(id.Ada!, SHIP);
    expect(await agent.applyAnalysis(loud(id))).toBe(false);

    expect((await board(agent)).cruxes).toEqual([]);
    expect(await positions(agent)).toEqual(positionsBefore);
    expect((await messages(agent)).length).toBe(messagesBefore);
  });

  it("releases the analysis slot rather than holding it forever", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "Still thinking about it.");
    await agent.closeFor(id.Ada!, SHIP);
    await agent.applyAnalysis(loud(id));

    expect((await projection(agent)).facilitatorStatus).toBe("IDLE");
  });

  it("schedules no follow-up analysis after a failure on a closed decision", async () => {
    const { agent, id } = await discussing();
    const scheduled = await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "One.");
    await agent.postMessageFor(id.Grace!, "Two."); // coalesced: sets analysis_pending
    await agent.closeFor(id.Ada!, SHIP);
    scheduled.length = 0;

    await agent.failAnalysis("Workers AI is unavailable");
    expect(scheduled).toEqual([]);
  });
});

describe("the closing memo", () => {
  it("is pending from the moment the decision closes", async () => {
    const { agent } = await closed();
    const record = await closingMemo(agent);

    expect(record?.status).toBe("PENDING");
    expect(record?.memo).toBeNull();
    expect(record?.requestedAt).toBeGreaterThan(0);
  });

  it("is committed by the Workflow and survives a re-read", async () => {
    const { agent } = await closed();
    expect(await agent.applyClosingMemo(memo(SHIP, { reasoning: "The crash data carried it." }))).toBe(
      true
    );

    const record = await closingMemo(agent);
    expect(record?.status).toBe("READY");
    expect(record?.memo?.reasoning).toBe("The crash data carried it.");
    expect(record?.completedAt).toBeGreaterThan(0);
  });

  /** Written once. A retried or resumed Workflow finds it already there. */
  it("is immutable: a second memo cannot replace the first", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP, { reasoning: "The first one." }));

    expect(await agent.applyClosingMemo(memo(SHIP, { reasoning: "A later one." }))).toBe(false);
    expect((await closingMemo(agent))?.memo?.reasoning).toBe("The first one.");
  });

  it("cannot be demoted to a failure by a straggler", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP));
    await agent.failClosingMemo("a duplicate run gave up");

    const record = await closingMemo(agent);
    expect(record?.status).toBe("READY");
    expect(record?.failure).toBeNull();
  });

  /**
   * The one thing that must never be true. The memo carries the outcome only
   * so this can be checked; it is copied from the decision upstream, so a memo
   * disagreeing about it is a memo about some other state entirely.
   */
  it("cannot change the declared outcome", async () => {
    const { agent } = await closed();
    expect(await refusedWith(agent.applyClosingMemo(memo(OTHER)))).toMatch(
      /cannot change the declared outcome/
    );

    expect((await decisionRow(agent)).outcome_option_id).toBe(SHIP);
    expect((await closingMemo(agent))?.status).toBe("PENDING");
  });

  it("records an honest failure rather than fabricating content", async () => {
    const { agent } = await closed();
    await agent.failClosingMemo("the model returned no JSON object");

    const record = await closingMemo(agent);
    expect(record?.status).toBe("FAILED");
    expect(record?.memo).toBeNull();
    expect(record?.failure).toMatch(/no JSON object/);
    // The outcome is untouched: the memo is a record of the decision, not part of it.
    expect((await decisionRow(agent)).outcome_option_id).toBe(SHIP);
  });

  it("can still be written after a failure, if a later run succeeds", async () => {
    const { agent } = await closed();
    await agent.failClosingMemo("Workers AI is unavailable");
    expect(await agent.applyClosingMemo(memo(SHIP))).toBe(true);

    expect((await closingMemo(agent))?.status).toBe("READY");
    expect((await closingMemo(agent))?.failure).toBeNull();
  });

  it("is not offered before the decision is closed", async () => {
    const { agent } = await discussing();
    expect(await closingMemo(agent)).toBeNull();
    expect(await agent.applyClosingMemo(memo(SHIP))).toBe(false);
  });
});

describe("the realtime projection", () => {
  it("says CLOSED and PENDING the moment the owner closes", async () => {
    const { agent } = await closed();
    const state = await projection(agent);

    expect(state.status).toBe("CLOSED");
    expect(state.closingMemoStatus).toBe("PENDING");
  });

  it("moves to READY when the memo lands, which is what sends a browser back", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP));
    expect((await projection(agent)).closingMemoStatus).toBe("READY");
  });

  it("moves to FAILED when the synthesis gives up", async () => {
    const { agent } = await closed();
    await agent.failClosingMemo("the model returned no JSON object");
    expect((await projection(agent)).closingMemoStatus).toBe("FAILED");
  });

  it("carries no memo status at all while the decision is open", async () => {
    const { agent } = await discussing();
    expect((await projection(agent)).closingMemoStatus).toBeNull();
  });

  /** The signal, never the content: the memo is read authoritatively. */
  it("never carries the memo itself", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP, { reasoning: "A sentence that must not be broadcast." }));

    expect(JSON.stringify(await projection(agent))).not.toContain("must not be broadcast");
  });
});

describe("the closing advisory", () => {
  it("tells the owner what the discussion is leaving open", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "I don't think that crash rate is representative.");
    await agent.applyAnalysis({
      ...SILENT,
      cruxes: [{ question: "Is the crash rate representative?", status: "OPEN" }],
      conflicts: [
        { description: "Ada and Grace price the delay differently", participantIds: [], status: "OPEN" }
      ],
      assumptions: [
        {
          participantId: id.Grace!,
          statement: "March is free",
          source: "INFERRED",
          status: "CHALLENGED",
          firstSeenSeq: 1
        }
      ]
    });

    const warning = await advisory(agent, id.Ada!);
    expect(warning.unresolvedCruxes.map((c) => c.question)).toEqual([
      "Is the crash rate representative?"
    ]);
    expect(warning.unresolvedConflicts).toHaveLength(1);
    expect(warning.challengedAssumptions.map((a) => a.statement)).toEqual(["March is free"]);
    // Both submitted the same option in the fixture, so the team has converged.
    expect(warning.dissentingPositions).toEqual([]);
  });

  it("is owner-only", async () => {
    const { agent, id } = await discussing();
    expect(await refusedWith(advisory(agent, id.Grace!))).toMatch(/Only the owner/);
  });

  /** Advisory means advisory: none of it can stand between an owner and a close. */
  it("does not prevent, delay or alter a close", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "Nobody has answered this.");
    await agent.applyAnalysis({
      ...SILENT,
      cruxes: [{ question: "Nobody answered this", status: "OPEN" }]
    });

    await agent.closeFor(id.Ada!, SHIP);
    expect((await decisionRow(agent)).status).toBe("CLOSED");
    expect((await decisionRow(agent)).outcome_option_id).toBe(SHIP);
  });
});

describe("team history", () => {
  /** What the Workflow's last step hands the Team Agent, once the memo is in. */
  async function record(agent: Agent): Promise<ClosedDecisionRecord | null> {
    return agent.getClosedDecisionRecord();
  }

  it("is offered only once the memo is committed", async () => {
    const { agent } = await closed();
    expect(await record(agent)).toBeNull();

    await agent.applyClosingMemo(memo(SHIP));
    expect(await record(agent)).not.toBeNull();
  });

  it("is never offered for a failed synthesis", async () => {
    const { agent } = await closed();
    await agent.failClosingMemo("Workers AI is unavailable");
    expect(await record(agent)).toBeNull();
  });

  it("carries the outcome by label, the memo, and nothing invented", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP, { reasoning: "The crash data carried it." }));

    const entry = (await record(agent))!;
    expect(entry.outcome).toBe("Ship in February");
    expect(entry.question).toBe("Ship in February or slip to March?");
    expect(entry.memo.reasoning).toBe("The crash data carried it.");
    expect(entry.closedAt).toBeGreaterThan(0);
  });

  /**
   * Derived from authoritative facilitator state rather than from the memo:
   * the memo is the model's account of the decision, and what the team carries
   * forward should not be.
   */
  it("carries the challenged and refuted assumptions as its learnings", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "March isn't free — Sam is out for two weeks.");
    await agent.applyAnalysis({
      ...SILENT,
      assumptions: [
        { participantId: id.Grace!, statement: "March is free", source: "INFERRED", status: "REFUTED", firstSeenSeq: 1 },
        { participantId: id.Ada!, statement: "the beta is stable", source: "EXPLICIT", status: "CHALLENGED", firstSeenSeq: 1 },
        { participantId: null, statement: "nobody disputed this", source: "INFERRED", status: "OPEN", firstSeenSeq: 1 }
      ]
    });
    await agent.closeFor(id.Ada!, SHIP);
    await agent.applyClosingMemo(memo(SHIP));

    expect((await record(agent))!.significantLearnings.sort()).toEqual([
      "March is free",
      "the beta is stable"
    ]);
  });

  it("is stored in the Team Agent, and storing it twice stores it once", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP, { reasoning: "The first and only version." }));
    const entry = (await record(agent))!;

    const store = await team();
    await store.storeClosedDecision(entry);
    // A replayed Workflow step, with a memo that somehow differs: the first wins.
    await store.storeClosedDecision({ ...entry, outcome: "Slip to March" });

    const stored = await store.getClosedDecision(entry.decisionId);
    expect(stored?.outcome).toBe("Ship in February");
    expect(stored?.memo.reasoning).toBe("The first and only version.");
    expect(stored?.significantLearnings).toEqual([]);
  });

  it("returns nothing for a decision that was never closed", async () => {
    const store = await team();
    expect(await store.getClosedDecision(crypto.randomUUID())).toBeNull();
  });

  /**
   * The Decision Agent stays authoritative and the Team Agent is an archive:
   * closing does not itself write history, and nothing reaches the Team Agent
   * until the Workflow's last step puts it there.
   */
  it("holds nothing until the Workflow stores it", async () => {
    const { agent } = await closed();
    await agent.applyClosingMemo(memo(SHIP));
    const entry = (await record(agent))!;

    const store = await team();
    expect(await store.getClosedDecision(entry.decisionId)).toBeNull();
    await store.storeClosedDecision(entry);
    expect(await store.getClosedDecision(entry.decisionId)).not.toBeNull();
  });
});
