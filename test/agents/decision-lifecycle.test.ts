import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";

/**
 * The Decision Agent's lifecycle, exercised in the real Workers runtime against
 * a real Durable Object and its real SQLite.
 *
 * The point of running here rather than against a stand-in is that the claims
 * being made — the submission transaction is atomic, Reveal cannot half-happen,
 * concurrent calls are serialized, the Workflow is scheduled only after commit —
 * are claims about the runtime. A fake would only prove the fake behaves.
 *
 * The Workflow itself is the one thing doubled: M2 establishes the scheduling
 * boundary, and M4 supplies the model behind it.
 */

type Agent = DurableObjectStub<DecisionAgent>;

/** Frames a fresh decision. First participant is the owner. */
async function frame(participants = ["Ada", "Grace"]) {
  const agent = await getAgentByName(env.DecisionAgent, crypto.randomUUID());
  const framed = await agent.frameDecision({
    question: "Ship in February or slip to March?",
    context: "The beta has been out for three weeks.",
    options: ["Ship in February", "Slip to March"],
    participants
  });
  const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
  return { agent: agent as Agent, id };
}

/** Reads straight out of the Durable Object's SQLite, bypassing any projection. */
function read(agent: Agent) {
  return runInDurableObject(agent, (instance) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const all = (q: string) => [...sql.exec(q)] as Record<string, unknown>[];
    const [decision] = all("SELECT status, revealed_at FROM decisions");
    return {
      status: decision!.status as string,
      revealedAt: decision!.revealed_at as number | null,
      submissions: all("SELECT * FROM initial_submissions ORDER BY participant_id"),
      positions: all("SELECT * FROM current_positions ORDER BY participant_id")
    };
  });
}

/**
 * Swaps the Workflow binding for a recorder. The Agent keeps running in the
 * real runtime; only the thing it hands off to is fake, so "scheduled after
 * commit" is still being observed rather than simulated.
 */
async function recordScheduling(agent: Agent, behaviour: "ok" | "throw" = "ok") {
  const calls: unknown[] = [];
  await runInDurableObject(agent, (instance) => {
    const target = instance as unknown as { env: Record<string, unknown> };
    target.env = {
      ...target.env,
      FACILITATOR_WORKFLOW: {
        create: async (options: unknown) => {
          calls.push(options);
          if (behaviour === "throw") throw new Error("Workers AI is unavailable");
          return { id: "stub" };
        }
      }
    };
  });
  return calls;
}

/**
 * Awaits a call the Agent is expected to refuse, and returns its message.
 *
 * Deliberately not `expect(...).rejects`: a Durable Object RPC call returns
 * workerd's own pipelining thenable rather than a plain promise, and that
 * matcher leaves it with an unhandled rejection that fails the whole run.
 */
async function refusedWith(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the Agent to refuse this call, but it resolved");
}

const POSITION = { optionId: "opt-1", confidence: 4, reasons: ["The beta is stable"] };

describe("initial submissions", () => {
  it("records a valid submission and keeps the decision in SUBMIT", async () => {
    const { agent, id } = await frame();
    await agent.submitFor(id.Ada!, POSITION);

    const state = await read(agent);
    expect(state.status).toBe("SUBMIT");
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]).toMatchObject({
      participant_id: id.Ada,
      option_id: "opt-1",
      confidence: 4
    });
    expect(JSON.parse(state.submissions[0]!.reasons as string)).toEqual(["The beta is stable"]);
    // Nothing becomes a current position before Reveal.
    expect(state.positions).toHaveLength(0);
  });

  it("rejects a second submission from the same participant", async () => {
    const { agent, id } = await frame();
    await agent.submitFor(id.Ada!, POSITION);
    expect(await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, optionId: "opt-2" }))).toMatch(
      /already submitted/
    );
    expect((await read(agent)).submissions).toHaveLength(1);
  });

  it("holds the one-submission invariant in the schema, not just the application", async () => {
    const { agent, id } = await frame();
    await agent.submitFor(id.Ada!, POSITION);

    // Bypassing every application check: the primary key must still refuse.
    const message = await refusedWith(
      runInDurableObject(agent, (instance) => {
        const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
        sql.exec(
          "INSERT INTO initial_submissions (participant_id, option_id, confidence, reasons, submitted_at) VALUES (?, ?, ?, ?, ?)",
          id.Ada,
          "opt-2",
          1,
          "[]",
          Date.now()
        );
      })
    );
    expect(message).toMatch(/UNIQUE constraint failed/);
  });

  it("rejects an unknown option, a bad confidence, and a fourth reason", async () => {
    const { agent, id } = await frame();
    expect(await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, optionId: "opt-9" }))).toMatch(
      /not one of/
    );
    expect(await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, confidence: 0 }))).toMatch(/1 to 5/);
    expect(await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, confidence: 2.5 }))).toMatch(/1 to 5/);
    expect(
      await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, reasons: ["a", "b", "c", "d"] }))
    ).toMatch(/at most 3/);
    // A rejected submission leaves nothing behind.
    expect((await read(agent)).submissions).toHaveLength(0);
  });

  it("rejects a submission from someone who is not a participant", async () => {
    const { agent } = await frame();
    expect(await refusedWith(agent.submitFor(crypto.randomUUID(), POSITION))).toMatch(
      /not a participant/
    );
  });
});

describe("automatic Reveal", () => {
  it("reveals atomically when the last invited participant submits", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent);

    await agent.submitFor(id.Ada!, POSITION);
    expect((await read(agent)).status).toBe("SUBMIT");
    expect(scheduled).toHaveLength(0);

    await agent.submitFor(id.Grace!, { optionId: "opt-2", confidence: 2, reasons: [] });

    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    expect(state.revealedAt).toBeGreaterThan(0);
    // The final submission and the transition landed together.
    expect(state.submissions).toHaveLength(2);
    expect(state.positions).toHaveLength(2);
    expect(scheduled).toHaveLength(1);
  });

  it("carries each submitted position forward as the current position", async () => {
    const { agent, id } = await frame();
    await recordScheduling(agent);
    await agent.submitFor(id.Ada!, POSITION);
    await agent.submitFor(id.Grace!, { optionId: "opt-2", confidence: 2, reasons: [] });

    const { positions } = await read(agent);
    const byParticipant = Object.fromEntries(positions.map((p) => [p.participant_id, p]));
    expect(byParticipant[id.Ada!]).toMatchObject({ option_id: "opt-1", confidence: 4 });
    expect(byParticipant[id.Grace!]).toMatchObject({ option_id: "opt-2", confidence: 2 });
  });
});

describe("owner-forced Reveal", () => {
  it("reveals even though someone never submitted, and leaves them without a position", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent);
    await agent.submitFor(id.Ada!, POSITION);

    await agent.declareCompleteFor(id.Ada!);

    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]!.participant_id).toBe(id.Ada);
    // Grace never submitted: no submission, and no current position to hold.
    expect(state.submissions.map((s) => s.participant_id)).not.toContain(id.Grace);
    expect(scheduled).toHaveLength(1);
  });

  it("reveals a decision nobody submitted to", async () => {
    const { agent, id } = await frame();
    await recordScheduling(agent);
    await agent.declareCompleteFor(id.Ada!);

    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    expect(state.positions).toHaveLength(0);
  });

  it("refuses a participant who is not the owner", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent);
    expect(await refusedWith(agent.declareCompleteFor(id.Grace!))).toMatch(/Only the owner/);
    expect((await read(agent)).status).toBe("SUBMIT");
    expect(scheduled).toHaveLength(0);
  });

  it("refuses once the decision has already been revealed", async () => {
    const { agent, id } = await frame();
    await recordScheduling(agent);
    await agent.declareCompleteFor(id.Ada!);
    expect(await refusedWith(agent.declareCompleteFor(id.Ada!))).toMatch(/already been revealed/);
  });
});

describe("after Reveal", () => {
  let agent: Agent;
  let id: Record<string, string>;

  beforeEach(async () => {
    ({ agent, id } = await frame());
    await recordScheduling(agent);
    await agent.submitFor(id.Ada!, POSITION);
    await agent.declareCompleteFor(id.Ada!);
  });

  it("accepts no new initial submission, including from a non-submitter", async () => {
    expect(await refusedWith(agent.submitFor(id.Grace!, POSITION))).toMatch(/closed/);
    expect((await read(agent)).submissions).toHaveLength(1);
  });

  it("leaves the existing submission immutable", async () => {
    const before = await read(agent);
    expect(await refusedWith(agent.submitFor(id.Ada!, { ...POSITION, optionId: "opt-2" }))).toMatch(
      /closed/
    );
    expect((await read(agent)).submissions).toEqual(before.submissions);
  });

  it("keeps a non-submitter as a participant, so they can still take part", async () => {
    const participants = await runInDurableObject(agent, (instance) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      return [...sql.exec("SELECT id FROM participants")].map((r) => r.id);
    });
    expect(participants).toContain(id.Grace);
  });
});

describe("concurrency", () => {
  it("serializes the last submission against an owner force-reveal", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent);
    await agent.submitFor(id.Ada!, POSITION);

    // Both in flight at once. Whichever the Durable Object runs first defines
    // the Reveal boundary; the other must find the decision already past SUBMIT.
    const results = await Promise.allSettled([
      agent.submitFor(id.Grace!, { optionId: "opt-2", confidence: 2, reasons: [] }),
      agent.declareCompleteFor(id.Ada!)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    // Never a mixture: either Grace got in before Reveal or she did not.
    const graceSubmitted = results[0]!.status === "fulfilled";
    expect(state.submissions).toHaveLength(graceSubmitted ? 2 : 1);
    expect(state.positions).toHaveLength(graceSubmitted ? 2 : 1);
    // Exactly one Reveal happened, so exactly one analysis was scheduled.
    expect(scheduled).toHaveLength(1);
  });

  it("admits exactly one of two simultaneous submissions from one participant", async () => {
    const { agent, id } = await frame(["Ada", "Grace", "Katherine"]);
    const results = await Promise.allSettled([
      agent.submitFor(id.Ada!, POSITION),
      agent.submitFor(id.Ada!, { ...POSITION, optionId: "opt-2" })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await read(agent)).submissions).toHaveLength(1);
  });

  it("reveals once when every participant submits simultaneously", async () => {
    const { agent, id } = await frame(["Ada", "Grace", "Katherine"]);
    const scheduled = await recordScheduling(agent);

    await Promise.all([
      agent.submitFor(id.Ada!, POSITION),
      agent.submitFor(id.Grace!, { optionId: "opt-2", confidence: 2, reasons: [] }),
      agent.submitFor(id.Katherine!, { optionId: "other", confidence: 1, reasons: [] })
    ]);

    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    expect(state.positions).toHaveLength(3);
    expect(scheduled).toHaveLength(1);
  });
});

describe("the Reveal / AI boundary", () => {
  it("rolls the whole Reveal back when the transaction fails, and schedules nothing", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent);
    await agent.submitFor(id.Ada!, POSITION);

    // Plant a current position for Ada. Reveal updates the status first and then
    // inserts positions, so the primary key collision forces a failure *after*
    // the status change — exactly the partially-transitioned decision that must
    // never survive.
    await runInDurableObject(agent, (instance) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec(
        "INSERT INTO current_positions (participant_id, option_id, confidence, updated_at) VALUES (?, ?, ?, ?)",
        id.Ada,
        "opt-2",
        1,
        Date.now()
      );
    });

    expect(await refusedWith(agent.declareCompleteFor(id.Ada!))).toMatch(/UNIQUE constraint failed/);

    const state = await read(agent);
    expect(state.status).toBe("SUBMIT");
    expect(state.revealedAt).toBeNull();
    // A Reveal that did not commit must not have scheduled AI work.
    expect(scheduled).toHaveLength(0);
  });

  it("keeps the decision in DISCUSS when scheduling the analysis fails", async () => {
    const { agent, id } = await frame();
    const scheduled = await recordScheduling(agent, "throw");
    await agent.submitFor(id.Ada!, POSITION);

    // The participant's operation succeeds regardless of the AI path.
    await agent.declareCompleteFor(id.Ada!);

    expect(scheduled).toHaveLength(1);
    const state = await read(agent);
    expect(state.status).toBe("DISCUSS");
    expect(state.positions).toHaveLength(1);
  });
});
