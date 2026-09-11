import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { Connection } from "agents";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";
import type { DecisionRealtimeState, Message } from "../../src/shared/types.ts";

/**
 * The discussion and its realtime projection, in the real Workers runtime.
 *
 * The claims under test are runtime claims: sequence numbers come from SQLite
 * and are never reused, concurrent messages are serialized by the Durable
 * Object rather than by anything this code does, and the projection is
 * published only once the transaction behind it has committed. A stand-in for
 * the runtime could only prove the stand-in behaves.
 */

type Agent = DurableObjectStub<DecisionAgent>;

const POSITION = { optionId: "opt-1", confidence: 4, reasons: ["The beta is stable"] };

/** Frames a decision and reveals it, so the discussion is open. */
async function discussing(participants = ["Ada", "Grace"]) {
  const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
  const framed = await agent.frameDecision({
    question: "Ship in February or slip to March?",
    context: "The beta has been out for three weeks.",
    options: ["Ship in February", "Slip to March"],
    participants
  });
  const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
  await stubWorkflow(agent);
  await agent.declareCompleteFor(id.Ada!);
  // The Reveal schedules an analysis, and that analysis holds the single
  // analysis slot until its Workflow reports back. Stand in for the Workflow
  // reporting an analysis with nothing to say, so the discussion below starts
  // from an idle facilitator rather than a coalescing one.
  await agent.applyAnalysis({
    analyzedThroughSeq: 0,
    assumptions: [],
    cruxes: [],
    conflicts: [],
    actionItems: [],
    positionChanges: [],
    intervention: null
  });
  return { agent, id };
}

/** Reads the transcript straight out of SQLite, bypassing any projection. */
function transcript(agent: Agent) {
  return runInDurableObject(agent, (instance) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    return [...sql.exec("SELECT seq, author_participant_id, body FROM messages ORDER BY seq")] as {
      seq: number;
      author_participant_id: string | null;
      body: string;
    }[];
  });
}

/**
 * The transcript as the bootstrap projects it — the same read a refreshing
 * browser performs, so what a reconnecting participant sees is what is tested.
 */
function readMessages(agent: Agent): Promise<Message[]> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as { messages(): Message[] }).messages()
  );
}

/** The realtime projection the Agent has last published to connected browsers. */
function projection(agent: Agent): Promise<DecisionRealtimeState> {
  return runInDurableObject(
    agent,
    (instance) => (instance as unknown as { state: DecisionRealtimeState }).state
  );
}

/**
 * Swaps the Workflow binding for a recorder, so "scheduled after commit" is
 * observed rather than simulated. Only the thing the Agent hands off to is
 * fake; the Agent itself keeps running in the real runtime.
 */
async function stubWorkflow(agent: Agent, behaviour: "ok" | "throw" = "ok") {
  const calls: { params: { type: string } }[] = [];
  await runInDurableObject(agent, (instance) => {
    const target = instance as unknown as { env: Record<string, unknown> };
    target.env = {
      ...target.env,
      FACILITATOR_WORKFLOW: {
        create: async (options: { params: { type: string } }) => {
          calls.push(options);
          if (behaviour === "throw") throw new Error("Workers AI is unavailable");
          return { id: "stub" };
        }
      }
    };
  });
  return calls;
}

/** See the note in decision-lifecycle.test.ts: `.rejects` breaks on DO RPC. */
async function refusedWith(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the Agent to refuse this call, but it resolved");
}

describe("posting a message", () => {
  it("appends to one shared thread in sequence order", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "I still think February holds.");
    await agent.postMessageFor(id.Grace!, "The crash reports say otherwise.");
    await agent.postMessageFor(id.Ada!, "Fair — which ones?");

    expect(await transcript(agent)).toEqual([
      { seq: 1, author_participant_id: id.Ada, body: "I still think February holds." },
      { seq: 2, author_participant_id: id.Grace, body: "The crash reports say otherwise." },
      { seq: 3, author_participant_id: id.Ada, body: "Fair — which ones?" }
    ]);
  });

  it("stores the message trimmed and otherwise exactly as written", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "  One point:\n\n  the beta is stable.  ");
    expect((await transcript(agent))[0]!.body).toBe("One point:\n\n  the beta is stable.");
  });

  it("refuses an empty message and leaves nothing behind", async () => {
    const { agent, id } = await discussing();
    expect(await refusedWith(agent.postMessageFor(id.Ada!, "   "))).toMatch(/cannot be empty/);
    expect(await transcript(agent)).toHaveLength(0);
  });

  it("refuses someone who is not a participant", async () => {
    const { agent } = await discussing();
    expect(await refusedWith(agent.postMessageFor(crypto.randomUUID(), "Hello."))).toMatch(
      /not a participant/
    );
    expect(await transcript(agent)).toHaveLength(0);
  });

  it("refuses a message before Reveal — there is nothing to discuss yet", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const [owner] = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });

    expect(await refusedWith(agent.postMessageFor(owner!.id, "Starting early."))).toMatch(
      /opens once initial positions are revealed/
    );
    expect(await transcript(agent)).toHaveLength(0);
  });
});

describe("the message / AI boundary", () => {
  it("schedules discussion analysis, and only after the message has committed", async () => {
    const { agent, id } = await discussing();
    const scheduled = await stubWorkflow(agent);

    expect(await refusedWith(agent.postMessageFor(id.Ada!, ""))).toMatch(/cannot be empty/);
    // A message that did not commit must not have scheduled AI work.
    expect(scheduled).toHaveLength(0);

    await agent.postMessageFor(id.Ada!, "I still think February holds.");
    expect(scheduled.map((c) => c.params.type)).toEqual(["DISCUSSION"]);
  });

  it("keeps the message when scheduling the analysis fails", async () => {
    const { agent, id } = await discussing();
    const scheduled = await stubWorkflow(agent, "throw");

    // The participant's message succeeds regardless of the AI path.
    await agent.postMessageFor(id.Ada!, "I still think February holds.");

    expect(scheduled).toHaveLength(1);
    expect(await transcript(agent)).toHaveLength(1);
    expect((await projection(agent)).messageCount).toBe(1);
  });
});

describe("the realtime projection", () => {
  it("is published at framing, before anyone has said anything", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });

    expect(await projection(agent)).toEqual({
      status: "SUBMIT",
      participantCount: 2,
      submittedCount: 0,
      messageCount: 0,
      messagesVersion: 0,
      positionsVersion: 0,
      boardVersion: 0,
      facilitatorStatus: "IDLE",
      lastActivityAt: null
    });
  });

  it("follows the decision through submission and Reveal", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
    await stubWorkflow(agent);

    await agent.submitFor(id.Ada!, POSITION);
    const submitting = await projection(agent);
    expect(submitting).toMatchObject({ status: "SUBMIT", submittedCount: 1, positionsVersion: 0 });

    await agent.submitFor(id.Grace!, { optionId: "opt-2", confidence: 2, reasons: [] });
    const revealed = await projection(agent);
    expect(revealed).toMatchObject({ status: "DISCUSS", submittedCount: 2 });
    // Reveal seeds the current positions, so their version moves off zero.
    expect(revealed.positionsVersion).toBeGreaterThan(0);
    expect(revealed.lastActivityAt).toBeGreaterThan(0);
  });

  it("moves its message version and count on every message", async () => {
    const { agent, id } = await discussing();
    const before = await projection(agent);

    await agent.postMessageFor(id.Ada!, "I still think February holds.");
    const after = await projection(agent);

    expect(after.messageCount).toBe(before.messageCount + 1);
    expect(after.messagesVersion).toBeGreaterThan(before.messagesVersion);
    expect(after.lastActivityAt).toBeGreaterThanOrEqual(before.lastActivityAt!);
  });

  it("carries no message content, option or confidence", async () => {
    const { agent, id } = await discussing(["Ada"]);
    await agent.postMessageFor(id.Ada!, "The crash reports are the whole argument.");

    // Whatever is added to the projection later, it must stay a set of counts:
    // a browser learns that something moved, then re-reads from the Agent.
    const serialized = JSON.stringify(await projection(agent));
    expect(serialized).not.toMatch(/crash reports/);
    expect(Object.values(await projection(agent)).every((v) => typeof v !== "object")).toBe(true);
  });

  it("refuses a projection pushed by a browser", async () => {
    const { agent } = await discussing();
    const message = await refusedWith(
      runInDurableObject(agent, (instance) => {
        const forged = { ...({} as DecisionRealtimeState), messageCount: 99 };
        (instance as unknown as DecisionAgent).validateStateChange(forged, {} as Connection);
      })
    );
    expect(message).toMatch(/read-only/);
  });
});

describe("concurrency", () => {
  it("gives simultaneous messages distinct sequence numbers", async () => {
    const { agent, id } = await discussing(["Ada", "Grace", "Katherine"]);

    await Promise.all([
      agent.postMessageFor(id.Ada!, "February."),
      agent.postMessageFor(id.Grace!, "March."),
      agent.postMessageFor(id.Katherine!, "I could go either way.")
    ]);

    const messages = await transcript(agent);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(new Set(messages.map((m) => m.author_participant_id)).size).toBe(3);
    expect((await projection(agent)).messageCount).toBe(3);
  });

  it("never reuses a sequence number a refused message touched", async () => {
    const { agent, id } = await discussing();
    await agent.postMessageFor(id.Ada!, "February.");
    await refusedWith(agent.postMessageFor(id.Ada!, ""));
    await agent.postMessageFor(id.Grace!, "March.");

    // Seq 2 was never handed out, but it is never handed out *again* either:
    // the canonical order of the transcript is stable either way.
    const seqs = (await transcript(agent)).map((m) => m.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
  });

  it("serializes a message against the Reveal that opens the discussion", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const framed = await agent.frameDecision({
      question: "Ship in February or slip to March?",
      options: ["Ship in February", "Slip to March"],
      participants: ["Ada", "Grace"]
    });
    const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
    await stubWorkflow(agent);

    // Both in flight at once. Whichever the Durable Object runs first defines
    // the boundary: a message can only exist on the DISCUSS side of it.
    const [message] = await Promise.allSettled([
      agent.postMessageFor(id.Ada!, "Getting ahead of myself."),
      agent.declareCompleteFor(id.Ada!)
    ]);

    const messages = await transcript(agent);
    expect(messages).toHaveLength(message.status === "fulfilled" ? 1 : 0);
    expect((await projection(agent)).status).toBe("DISCUSS");
  });
});

describe("reconstruction", () => {
  let agent: Agent;
  let id: Record<string, string>;

  beforeEach(async () => {
    ({ agent, id } = await discussing());
    await agent.postMessageFor(id.Ada!, "I still think February holds.");
    await agent.postMessageFor(id.Grace!, "The crash reports say otherwise.");
  });

  it("rebuilds the discussion in sequence order, attributed to its authors", async () => {
    // M4 writes facilitator messages; the transcript already carries them, and
    // a browser must be able to tell that voice from a participant's.
    await runInDurableObject(agent, (instance) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec(
        "INSERT INTO messages (author_participant_id, body, created_at) VALUES (?, ?, ?)",
        null,
        "Two of you disagree about what the crash reports show.",
        Date.now()
      );
    });

    const messages = await readMessages(agent);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages.map((m) => m.author)).toEqual([
      { kind: "PARTICIPANT", participantId: id.Ada },
      { kind: "PARTICIPANT", participantId: id.Grace },
      { kind: "FACILITATOR" }
    ]);
    expect(messages[2]!.body).toMatch(/crash reports/);
  });
});
