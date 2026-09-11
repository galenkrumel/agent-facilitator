import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import {
  board,
  brief,
  discussing,
  messages,
  positions,
  projection,
  SILENT,
  stubWorkflow,
  type Agent
} from "./harness.ts";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";
import type { FacilitatorAnalysisResult } from "../../src/shared/types.ts";

/**
 * M5: what the facilitator does with what it understands.
 *
 * Every claim here is a Durable Object claim — a position moved inside the
 * analysis transaction, an intervention withheld on the strength of state
 * written moments earlier in that same transaction, a visit boundary recorded
 * by the read that used it. The model is stood in for deliberately: these
 * tests are about the rules the Agent applies to an analysis, and an analysis
 * that arrives by hand is the only way to say precisely what was understood.
 */

const facilitatorMessages = async (agent: Agent) =>
  (await messages(agent)).filter((m) => m.author.kind === "FACILITATOR").map((m) => m.body);

describe("position changes", () => {
  it("moves a current position when the participant said so", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Grace!, "I'm switching to March — 2 out of 5 on it.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      positionChanges: [
        { participantId: id.Grace!, optionId: "opt-2", confidence: 2, explicit: true }
      ]
    });

    expect(await positions(agent)).toContainEqual(
      expect.objectContaining({ participantId: id.Grace, optionId: "opt-2", confidence: 2 })
    );
  });

  it("refuses a change the facilitator only inferred", async () => {
    const { agent, id } = await discussing();
    const before = await positions(agent);
    await agent.postMessageFor(id.Grace!, "That crash data is more worrying than I thought.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      // Reasoning that has moved is not a position that has moved. The parser
      // drops this too; the Agent is where the rule has to hold.
      positionChanges: [
        { participantId: id.Grace!, optionId: "opt-2", confidence: 2, explicit: false }
      ]
    });

    expect(await positions(agent)).toEqual(before);
  });

  it("gives a participant with no position one, if they state it", async () => {
    // Participation is voluntary: someone who never submitted still takes part
    // in the discussion, and what they say there is their position.
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
    await stubWorkflow(agent);
    await agent.declareCompleteFor(id.Ada!);
    await agent.applyAnalysis(SILENT);
    expect(await positions(agent)).toEqual([]);

    await agent.postMessageFor(id.Grace!, "I never submitted, but I'm for March, confidence 3.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      positionChanges: [
        { participantId: id.Grace!, optionId: "opt-2", confidence: 3, explicit: true }
      ]
    });

    expect(await positions(agent)).toEqual([
      expect.objectContaining({ participantId: id.Grace, optionId: "opt-2", confidence: 3 })
    ]);
  });
});

describe("the confidence follow-up", () => {
  /** An explicit move to March, with no confidence attached to it. */
  const incomplete = (participantId: string): FacilitatorAnalysisResult => ({
    ...SILENT,
    analyzedThroughSeq: 1,
    positionChanges: [{ participantId, optionId: "opt-2", confidence: null, explicit: true }]
  });

  it("asks for the confidence a stated change did not carry", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Grace!, "Fine — I'm with March now.");
    await agent.applyAnalysis(incomplete(id.Grace!));

    // The position moved, and the confidence under the option she left did not
    // come with it: the decision says so rather than quietly implying it.
    expect(await positions(agent)).toContainEqual(
      expect.objectContaining({ participantId: id.Grace, optionId: "opt-2", confidence: null })
    );
    expect(await facilitatorMessages(agent)).toEqual([
      expect.stringMatching(/Grace.*how confident.*1 to 5/s)
    ]);
  });

  it("asks once, however many times it re-reads the same change", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Grace!, "Fine — I'm with March now.");
    await agent.applyAnalysis(incomplete(id.Grace!));
    await agent.postMessageFor(id.Ada!, "Noted.");
    await agent.applyAnalysis({ ...incomplete(id.Grace!), analyzedThroughSeq: 3 });

    expect(await facilitatorMessages(agent)).toHaveLength(1);
  });

  it("closes the question when they answer it", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Grace!, "Fine — I'm with March now.");
    await agent.applyAnalysis(incomplete(id.Grace!));
    await agent.postMessageFor(id.Grace!, "Call it a 3.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 4,
      // Answering is an explicit confidence change and nothing else — no
      // option is named, so the one she moved to stands.
      positionChanges: [
        { participantId: id.Grace!, optionId: null, confidence: 3, explicit: true }
      ]
    });

    expect(await positions(agent)).toContainEqual(
      expect.objectContaining({ participantId: id.Grace, optionId: "opt-2", confidence: 3 })
    );
    const state = await brief(agent, id.Grace!);
    expect(state.questionsForYou).toEqual([]);
  });
});

describe("intervention selectivity", () => {
  const ISSUE = "crash-report-severity";

  /** The facilitator's reading of the discussion, as one analysis. */
  const reading = (
    seq: number,
    status: "OPEN" | "CHALLENGED",
    intervention: { issueKey: string; message: string } | null
  ): FacilitatorAnalysisResult => ({
    ...SILENT,
    analyzedThroughSeq: seq,
    assumptions: [
      {
        participantId: null,
        statement: "The crash reports are not release-blocking",
        source: "INFERRED",
        status,
        firstSeenSeq: 1
      }
    ],
    cruxes: [{ question: "Are the crash reports release-blocking?", status: "OPEN" }],
    intervention
  });

  it("says nothing new about an issue nothing new has happened to", async () => {
    const { agent, id } = await discussing();

    // A: the issue is identified and raised.
    await agent.postMessageFor(id.Ada!, "The crash reports are noise from one device.");
    await agent.applyAnalysis(
      reading(1, "OPEN", { issueKey: ISSUE, message: "Are you assuming the crash reports are not release-blocking?" })
    );
    expect(await facilitatorMessages(agent)).toHaveLength(1);

    // B: the same ground, gone over again. The facilitator understands the
    // decision exactly as it did before, and words its intervention
    // differently — which is precisely what a repeat looks like in practice.
    await agent.postMessageFor(id.Grace!, "I still think those crashes matter.");
    await agent.applyAnalysis(
      reading(3, "OPEN", {
        issueKey: ISSUE,
        message: "Is the team taking for granted that the crash reports would not block a release?"
      })
    );
    expect(await facilitatorMessages(agent)).toHaveLength(1);

    // C: new evidence changes the issue underneath. Now it is worth saying.
    await agent.postMessageFor(id.Grace!, "Support pulled the numbers: it's four devices, not one.");
    await agent.applyAnalysis(
      reading(4, "CHALLENGED", {
        issueKey: ISSUE,
        message: "The four-device number cuts against that assumption — does it change anyone's position?"
      })
    );
    expect(await facilitatorMessages(agent)).toHaveLength(2);
  });

  it("is not fooled by the same issue arriving under a new key", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis(reading(1, "OPEN", { issueKey: ISSUE, message: "Are you assuming X?" }));
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis(
      reading(3, "OPEN", { issueKey: "crash-reports-again", message: "Are you assuming X?" })
    );

    expect(await facilitatorMessages(agent)).toHaveLength(1);
  });

  it("raises a genuinely different issue while an old one is held back", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis(reading(1, "OPEN", { issueKey: ISSUE, message: "Are you assuming X?" }));

    // Silence is about the issue, not about the facilitator: a different one,
    // on state that has moved, is still raised.
    await agent.postMessageFor(id.Grace!, "Also, nobody has asked what the rollback costs.");
    await agent.applyAnalysis({
      ...reading(3, "OPEN", { issueKey: "rollback-cost", message: "What would a rollback cost?" }),
      cruxes: [
        { question: "Are the crash reports release-blocking?", status: "OPEN" },
        { question: "What does a rollback cost?", status: "OPEN" }
      ]
    });

    expect(await facilitatorMessages(agent)).toHaveLength(2);
  });

  it("remembers what it has raised, so it can be told not to repeat it", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis(reading(1, "OPEN", { issueKey: ISSUE, message: "Are you assuming X?" }));

    const view = await runInDurableObject(agent, (instance) =>
      (instance as unknown as DecisionAgent).getFacilitatorContext()
    );
    expect(view.interventions).toEqual([
      expect.objectContaining({ issueKey: ISSUE, messageSeq: 2 })
    ]);
  });
});

describe("the board", () => {
  it("projects positions, cruxes and action items — and nothing else", async () => {
    const { agent, id } = await discussing(["Ada", "Grace", "Lin"]);
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      assumptions: [
        {
          participantId: id.Ada!,
          statement: "The beta is representative",
          source: "INFERRED",
          status: "OPEN",
          firstSeenSeq: 1
        }
      ],
      conflicts: [
        { description: "Ada and Grace read the data differently", participantIds: [id.Ada!], status: "OPEN" }
      ],
      cruxes: [{ question: "Are the crash reports release-blocking?", status: "OPEN" }],
      actionItems: [{ description: "Pull the crash breakdown", ownerParticipantId: id.Grace! }]
    });

    const view = await board(agent);
    expect(view.cruxes.map((c) => c.question)).toEqual([
      "Are the crash reports release-blocking?"
    ]);
    expect(view.actionItems[0]).toMatchObject({
      description: "Pull the crash breakdown",
      ownerParticipantId: id.Grace
    });
    // Assumptions and conflicts are the facilitator's own working model. The
    // board has no category for either, whatever the analysis found.
    expect(Object.keys(view)).toEqual(["positions", "cruxes", "actionItems"]);
  });

  it("lists every participant, including the one who never submitted", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
    await stubWorkflow(agent);
    await agent.submitFor(id.Ada!, { optionId: "opt-1", confidence: 4, reasons: ["Stable"] });
    await agent.declareCompleteFor(id.Ada!);
    await agent.applyAnalysis(SILENT);

    expect((await board(agent)).positions).toEqual([
      { participantId: id.Ada, displayName: "Ada", optionId: "opt-1", confidence: 4, submitted: true },
      { participantId: id.Grace, displayName: "Grace", optionId: null, confidence: null, submitted: false }
    ]);
  });

  it("moves the board version when the board changes, and not otherwise", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    const crux = { question: "Are the crash reports release-blocking?", status: "OPEN" as const };
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1, cruxes: [crux] });
    const first = (await projection(agent)).boardVersion;
    expect(first).toBeGreaterThan(0);

    // A re-analysis that understood the decision the same way leaves the board
    // where it is — otherwise every browser re-reads on every analysis.
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 2, cruxes: [crux] });
    expect((await projection(agent)).boardVersion).toBe(first);

    await agent.postMessageFor(id.Ada!, "Three.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 3,
      cruxes: [{ ...crux, status: "RESOLVED" }]
    });
    expect((await projection(agent)).boardVersion).toBeGreaterThan(first);
  });
});

describe("the current state brief", () => {
  it("orients a participant arriving for the first time", async () => {
    const { agent, id } = await discussing();
    const first = await brief(agent, id.Ada!);

    expect(first.kind).toBe("FIRST_VISIT");
    expect(first.since).toBeNull();
    expect(first.summary).toMatch(/Current positions/);
    expect(first.summary).toMatch(/Nobody has said anything yet/);
  });

  it("summarises what has changed since the last opening, not the last message", async () => {
    const { agent, id } = await discussing();
    await brief(agent, id.Ada!); // Ada opens the decision and reads it.

    await agent.postMessageFor(id.Grace!, "I'm with March now.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      cruxes: [{ question: "Are the crash reports release-blocking?", status: "OPEN" }],
      assumptions: [
        {
          participantId: id.Ada!,
          statement: "The beta is representative",
          source: "INFERRED",
          status: "CHALLENGED",
          firstSeenSeq: 1
        }
      ],
      positionChanges: [
        { participantId: id.Grace!, optionId: "opt-2", confidence: 2, explicit: true }
      ]
    });

    const second = await brief(agent, id.Ada!);
    expect(second.kind).toBe("RETURNING");
    expect(second.since).toBeLessThanOrEqual(second.generatedAt);
    expect(second.summary).toMatch(/1 new message/);
    expect(second.summary).toMatch(/Grace changed position/);
    expect(second.summary).toMatch(/1 new crux/);
    expect(second.summary).toMatch(/1 assumption challenged/);
    expect(second.openCruxes).toEqual(["Are the crash reports release-blocking?"]);
    expect(second.challengedAssumptions).toEqual(["The beta is representative"]);
  });

  it("says so plainly when nothing has happened since", async () => {
    const { agent, id } = await discussing();
    await brief(agent, id.Ada!);
    const again = await brief(agent, id.Ada!);

    expect(again.summary).toMatch(/^Nothing has changed since your last visit\./);
  });

  it("is per participant — one person reading it does not move anyone else's boundary", async () => {
    const { agent, id } = await discussing();
    await brief(agent, id.Ada!);
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1 });

    expect((await brief(agent, id.Ada!)).summary).toMatch(/1 new message/);
    expect((await brief(agent, id.Grace!)).kind).toBe("FIRST_VISIT");
  });

  it("carries the question the facilitator is waiting on from this participant", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Grace!, "Fine — I'm with March now.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      positionChanges: [
        { participantId: id.Grace!, optionId: "opt-2", confidence: null, explicit: true }
      ]
    });

    expect((await brief(agent, id.Grace!)).questionsForYou).toEqual([
      expect.stringMatching(/what is your confidence/i)
    ]);
    // Somebody else's open question is not this participant's business.
    expect((await brief(agent, id.Ada!)).questionsForYou).toEqual([]);
  });

  it("leaks nothing while initial positions are still private", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
    await stubWorkflow(agent);
    await agent.submitFor(id.Ada!, { optionId: "opt-1", confidence: 4, reasons: ["Stable"] });

    const state = await brief(agent, id.Grace!);
    // How many have answered is already public. What they answered is not, and
    // the brief is not a way around that.
    expect(state.summary).toMatch(/1 of 2/);
    expect(state.summary).not.toMatch(/February|opt-1|Ada chose/);
    expect(state.openCruxes).toEqual([]);
  });
});
