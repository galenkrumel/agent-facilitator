import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import {
  context,
  discussing,
  messages,
  projection,
  refusedWith,
  SILENT,
  stubWorkflow,
  type Agent
} from "./harness.ts";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";

/**
 * The facilitator boundary, in the real Workers runtime.
 *
 * What is under test here is not the model — that is `npm run eval` — but the
 * rules around it: only one analysis at a time, results applied only when they
 * are current, and nothing the model can return that damages the decision or
 * blocks a participant. All of it is Durable Object behaviour, so none of it
 * can be demonstrated against a stand-in for the runtime.
 *
 * M5's own rules — position changes, the intervention gate, the board and the
 * brief — are in intelligence.test.ts.
 */


describe("the facilitator's view of the decision", () => {
  it("carries the discussion, the positions and its own working model", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "The crash reports are the whole argument.");

    const view = await context(agent);
    expect(view.decision.status).toBe("DISCUSS");
    expect(view.participants.map((p) => p.displayName)).toEqual(["Ada", "Grace"]);
    expect(view.messages.map((m) => m.body)).toEqual(["The crash reports are the whole argument."]);
    expect(view.meta.analysisRunning).toBe(true);
  });

  it("is blind to initial submissions until the Reveal", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    await stubWorkflow(agent);
    await agent.submitFor(framed[0]!.id, { optionId: "opt-1", confidence: 4, reasons: ["Stable"] });

    // The facilitator sees submissions when participants do, and not before.
    expect((await context(agent)).submissions).toEqual([]);
    await agent.declareCompleteFor(framed[0]!.id);
    expect((await context(agent)).submissions).toHaveLength(1);
  });
});

describe("coalescing", () => {
  it("runs one analysis at a time and queues what arrives during it", async () => {
    const { agent, id, scheduled } = await discussing();

    await agent.postMessageFor(id.Ada!, "One.");
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.postMessageFor(id.Ada!, "Three.");

    // Three messages, one analysis: the other two are folded into what the
    // running one will be followed by.
    expect(scheduled.map((c) => c.params.type)).toEqual(["DISCUSSION"]);
    expect((await context(agent)).meta.analysisPending).toBe(true);
  });

  it("picks the queued messages up when the running analysis finishes", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.postMessageFor(id.Grace!, "Two.");

    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1 });

    expect(scheduled.map((c) => c.params.type)).toEqual(["DISCUSSION", "DISCUSSION"]);
    expect((await context(agent)).meta.analysisPending).toBe(false);
  });

  it("does not queue a follow-up when nothing arrived during the analysis", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1 });

    expect(scheduled).toHaveLength(1);
    expect((await projection(agent)).facilitatorStatus).toBe("IDLE");
  });

  it("takes the slot back from an analysis that never reported", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    expect(scheduled).toHaveLength(1);

    // A Workflow that died between steps would otherwise hold the slot for the
    // life of the decision, and the facilitator would never speak again.
    await runInDurableObject(agent, (instance) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec("UPDATE facilitator_meta SET analysis_running = ? WHERE id = 1", Date.now() - 3_600_000);
    });

    await agent.postMessageFor(id.Grace!, "Two.");
    expect(scheduled).toHaveLength(2);
  });
});

describe("stale and duplicate results", () => {
  it("ignores a result that arrives with no analysis in flight", async () => {
    const { agent } = await discussing();
    // The Reveal analysis has already reported. A second report of it — a
    // retried Workflow step — must not be applied again.
    expect(await agent.applyAnalysis({ ...SILENT, intervention: { issueKey: "again", message: "Hello again." } })).toBe(false);
    expect(await messages(agent)).toHaveLength(0);
  });

  it("ignores a result that analyzed less than the last one applied", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 2,
      cruxes: [{ question: "Which crash reports?", status: "OPEN" }]
    });

    // A slow run that only saw the first message reports late. Applying it
    // would roll the facilitator's understanding backwards.
    await agent.postMessageFor(id.Ada!, "Three.");
    expect(await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1 })).toBe(false);
    expect((await context(agent)).cruxes.map((c) => c.question)).toEqual(["Which crash reports?"]);
  });

  it("releases the slot even when the result it refused was stale", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1 });
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 0 });

    // Refused, but finished: the next message still gets an analysis.
    await agent.postMessageFor(id.Ada!, "Three.");
    expect(scheduled).toHaveLength(3);
  });
});

describe("applying an analysis", () => {
  it("stores what it understood and posts what it chose to say", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "February still holds.");
    await agent.applyAnalysis({
      analyzedThroughSeq: 1,
      assumptions: [
        {
          participantId: id.Ada!,
          statement: "The crash reports are not release-blocking",
          source: "INFERRED",
          status: "OPEN",
          firstSeenSeq: 1
        }
      ],
      cruxes: [{ question: "Are the crash reports release-blocking?", status: "OPEN" }],
      conflicts: [
        { description: "Ada and Grace read the crash reports differently", participantIds: [id.Ada!, id.Grace!], status: "OPEN" }
      ],
      actionItems: [{ description: "Pull the crash report breakdown", ownerParticipantId: id.Grace! }],
      positionChanges: [],
      intervention: { issueKey: "crash-reports", message: "Are you assuming the crash reports are not release-blocking, Ada?" }
    });

    const view = await context(agent);
    expect(view.assumptions[0]!.statement).toMatch(/release-blocking/);
    expect(view.cruxes).toHaveLength(1);
    expect(view.conflicts[0]!.participantIds).toEqual([id.Ada, id.Grace]);
    expect(view.actionItems[0]!.ownerParticipantId).toBe(id.Grace);

    const thread = await messages(agent);
    expect(thread[1]).toMatchObject({ author: { kind: "FACILITATOR" } });
    expect(thread[1]!.body).toMatch(/Are you assuming/);
  });

  it("does not schedule analysis of its own message", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "February still holds.");
    scheduled.length = 0;

    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1, intervention: { issueKey: "a-question", message: "A question." } });

    // The facilitator answering itself forever is the failure this prevents.
    expect(scheduled).toHaveLength(0);
    expect((await context(agent)).meta.lastAnalyzedSeq).toBe(2);
  });

  it("will not say the same thing twice in a row", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1, intervention: { issueKey: "assuming-x", message: "Are you assuming X?" } });
    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 3, intervention: { issueKey: "assuming-x", message: "Are you assuming X?" } });

    expect((await messages(agent)).filter((m) => m.author.kind === "FACILITATOR")).toHaveLength(1);
  });

  it("replaces its working model rather than accumulating near-duplicates", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    const crux = { question: "Are the crash reports release-blocking?", status: "OPEN" as const };
    await agent.applyAnalysis({ ...SILENT, analyzedThroughSeq: 1, cruxes: [crux] });
    const first = (await context(agent)).cruxes[0]!;

    await agent.postMessageFor(id.Grace!, "Two.");
    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 2,
      cruxes: [crux, { question: "Can the release slip a week?", status: "OPEN" }]
    });

    const after = await context(agent);
    expect(after.cruxes).toHaveLength(2);
    // The crux that is still the same crux keeps its identity and its age.
    expect(after.cruxes[0]).toMatchObject({ id: first.id, createdAt: first.createdAt });
  });

  it("moves the board version, so a browser knows to re-read", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    expect((await projection(agent)).boardVersion).toBe(0);

    await agent.applyAnalysis({
      ...SILENT,
      analyzedThroughSeq: 1,
      cruxes: [{ question: "Are the crash reports release-blocking?", status: "OPEN" }]
    });
    expect((await projection(agent)).boardVersion).toBeGreaterThan(0);
  });
});

describe("AI failure", () => {
  it("leaves the decision untouched when the analysis references someone invented", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "February still holds.");

    const message = await refusedWith(
      agent.applyAnalysis({
        ...SILENT,
        analyzedThroughSeq: 1,
        assumptions: [
          {
            participantId: crypto.randomUUID(),
            statement: "Invented",
            source: "INFERRED",
            status: "OPEN",
            firstSeenSeq: 1
          }
        ],
        cruxes: [{ question: "Would have been stored", status: "OPEN" }],
        intervention: { issueKey: "would-have", message: "Would have been posted" }
      })
    );

    expect(message).toMatch(/unknown participant/);
    // The whole application rolled back: no crux, no message, no half-applied
    // analysis. Malformed AI output cannot corrupt the decision.
    const view = await context(agent);
    expect(view.cruxes).toEqual([]);
    expect(view.assumptions).toEqual([]);
    expect(await messages(agent)).toHaveLength(1);
  });

  it("records the failure, frees the slot and leaves the discussion open", async () => {
    const { agent, id, scheduled } = await discussing();
    await agent.postMessageFor(id.Ada!, "One.");
    await agent.failAnalysis("the model returned no JSON object");

    expect((await projection(agent)).facilitatorStatus).toBe("ERROR");
    // A participant cannot tell the difference where it matters: the next
    // message commits, and gets an analysis of its own.
    await agent.postMessageFor(id.Grace!, "Two.");
    expect(await messages(agent)).toHaveLength(2);
    expect(scheduled).toHaveLength(2);
    expect((await projection(agent)).facilitatorStatus).toBe("ANALYZING");
  });

  it("keeps the message when the Workflow cannot even be started", async () => {
    const { agent, id } = await discussing();
    await stubWorkflow(agent, "throw");

    await agent.postMessageFor(id.Ada!, "One.");

    expect(await messages(agent)).toHaveLength(1);
    const state = await projection(agent);
    expect(state.messageCount).toBe(1);
    expect(state.facilitatorStatus).toBe("ERROR");
  });

  it("still analyzes the next message after a failure", async () => {
    const { agent, id } = await discussing();
    const failing = await stubWorkflow(agent, "throw");
    await agent.postMessageFor(id.Ada!, "One.");
    expect(failing).toHaveLength(1);

    const scheduled = await stubWorkflow(agent);
    await agent.postMessageFor(id.Grace!, "Two.");
    expect(scheduled).toHaveLength(1);
  });
});
