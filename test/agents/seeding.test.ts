import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import worker from "../../src/server/index.ts";
import { SCENARIO } from "../../scripts/seed.ts";
import { board, messages, positions, refusedWith, stubWorkflow, type Agent } from "./harness.ts";

/**
 * Creating a decision part-way through its life — M7's seeded scenario.
 *
 * The thing being demonstrated throughout is a negative: that what comes out
 * is an ordinary decision. There is no seeded flag to assert on, so these
 * check the state instead, table by table, against what the same decision
 * would look like if three people had lived it.
 */

const TOKEN = "operator-token-for-tests";

/** The Worker with an operator token configured, or without one. */
function deployment(seedToken: string | null = TOKEN) {
  return { ...env, SEED_TOKEN: seedToken ?? undefined } as unknown as Env;
}

function post(body: unknown, token?: string): Promise<Response> {
  return worker.fetch(
    new Request("https://example.com/admin/decisions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    }),
    deployment()
  );
}

type Created = { decisionId: string; links: { displayName: string; isOwner: boolean; url: string }[] };

describe("POST /admin/decisions", () => {
  it("creates a decision for the operator", async () => {
    const response = await post(SCENARIO, TOKEN);
    expect(response.status).toBe(200);

    const created = (await response.json()) as Created;
    expect(created.links.map((l) => l.displayName)).toEqual(["Ada", "Grace", "Alan"]);
    expect(created.links.filter((l) => l.isOwner)).toHaveLength(1);
    // Shown once, and each carries the credential that is the only way in.
    for (const link of created.links) {
      expect(link.url).toMatch(new RegExp(`^https://example.com/d/${created.decisionId}/p/.+`));
    }
  });

  it("refuses a request with no token", async () => {
    expect((await post(SCENARIO)).status).toBe(401);
  });

  it("refuses a request with the wrong token", async () => {
    expect((await post(SCENARIO, "nearly-the-operator-token")).status).toBe(401);
    expect((await post(SCENARIO, TOKEN.slice(0, -1))).status).toBe(401);
    expect((await post(SCENARIO, `${TOKEN}x`)).status).toBe(401);
  });

  it("refuses everything when no token is configured", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/admin/decisions", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(SCENARIO)
      }),
      deployment(null)
    );
    expect(response.status).toBe(503);
  });

  it("is the only administrative operation there is", async () => {
    const other = async (path: string, method = "POST") =>
      (
        await worker.fetch(
          new Request(`https://example.com${path}`, {
            method,
            headers: { Authorization: `Bearer ${TOKEN}` }
          }),
          deployment()
        )
      ).status;
    // No listing, no reads, no deletes — and the creation path itself is not a
    // GET. Everything else falls through to the SPA or to nothing.
    expect(await other("/admin/decisions", "GET")).not.toBe(200);
    expect(await other("/admin/decisions/some-id", "GET")).not.toBe(200);
    expect(await other("/admin/decisions/some-id", "DELETE")).not.toBe(200);
  });

  it("hands back links a browser can exchange for a session", async () => {
    const created = (await (await post(SCENARIO, TOKEN)).json()) as Created;
    const response = await worker.fetch(
      new Request(created.links[0]!.url, { redirect: "manual" }),
      deployment()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/d/${created.decisionId}`);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("rejects a body that is not a decision", async () => {
    expect((await post({ question: "no options" }, TOKEN)).status).toBe(400);
    expect((await post({ ...SCENARIO, options: ["only one"] }, TOKEN)).status).toBe(400);
  });
});

describe("a decision framed as already having a history", () => {
  async function seeded(input = SCENARIO) {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const scheduled = await stubWorkflow(agent);
    const framed = await agent.frameDecision(input);
    return { agent, framed, scheduled };
  }

  it("arrives in Discuss with the discussion already in it", async () => {
    const { agent, scheduled } = await seeded();
    const bootstrap = await agent.getFacilitatorContext();

    expect(bootstrap.decision.status).toBe("DISCUSS");
    expect(bootstrap.decision.revealedAt).not.toBeNull();
    expect(await messages(agent)).toHaveLength(SCENARIO.messages!.length);
    // The facilitator reads it exactly as it would any other discussion —
    // which is where the seeded scenario's facilitator state comes from.
    expect(scheduled.map((s) => s.params.type)).toEqual(["DISCUSSION"]);
  });

  it("backdates the discussion, oldest message first", async () => {
    const { agent } = await seeded();
    const thread = await messages(agent);
    const times = thread.map((m) => m.createdAt);

    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(thread[0]!.createdAt).toBeLessThan(Date.now() - 47 * 60 * 60_000);
    expect(thread.at(-1)!.createdAt).toBeLessThan(Date.now());
    // Framed before the discussion it is framed as having had.
    const decision = (await agent.getFacilitatorContext()).decision;
    expect(decision.createdAt).toBeLessThan(thread[0]!.createdAt);
  });

  it("orders the thread by the clock, not by the order it was given", async () => {
    const reversed = { ...SCENARIO, messages: [...SCENARIO.messages!].reverse() };
    const { agent } = await seeded(reversed);
    const bodies = (await messages(agent)).map((m) => m.body);

    expect(bodies).toEqual(SCENARIO.messages!.map((m) => m.body));
  });

  it("carries the submissions forward into disagreeing positions", async () => {
    const { agent, framed } = await seeded();
    const held = await positions(agent);
    const options = (await agent.getFacilitatorContext()).decision.options;

    expect(held).toHaveLength(2);
    expect(new Set(held.map((p) => p.optionId)).size).toBe(2);
    expect(held.every((p) => options.some((o) => o.id === p.optionId))).toBe(true);
    // The invited participant who never submitted holds no position and is
    // shown as present without one, exactly as after any forced Reveal.
    const alan = framed.find((p) => p.displayName === "Alan")!;
    expect(held.some((p) => p.participantId === alan.id)).toBe(false);
    const row = (await board(agent)).positions.find((p) => p.participantId === alan.id)!;
    expect(row).toMatchObject({ optionId: null, confidence: null, submitted: false });
  });

  it("frames a decision with no history in Submit, as always", async () => {
    const { agent, scheduled } = await seeded({
      question: SCENARIO.question,
      options: SCENARIO.options,
      participants: SCENARIO.participants
    });

    expect((await agent.getFacilitatorContext()).decision.status).toBe("SUBMIT");
    expect(await messages(agent)).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("refuses history that could not have happened", async () => {
    const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
    const broken = (input: Partial<typeof SCENARIO>) =>
      refusedWith(agent.frameDecision({ ...SCENARIO, ...input }));

    expect(await broken({ submissions: [{ participant: 9, option: 0, confidence: 3, reasons: [] }] })).toMatch(
      /no participant 9/
    );
    expect(await broken({ submissions: [{ participant: 0, option: 9, confidence: 3, reasons: [] }] })).toMatch(
      /no option 9/
    );
    expect(await broken({ submissions: [{ participant: 0, option: 0, confidence: 9, reasons: [] }] })).toMatch(
      /Confidence/
    );
    expect(
      await broken({
        submissions: [
          { participant: 0, option: 0, confidence: 3, reasons: [] },
          { participant: 0, option: 1, confidence: 3, reasons: [] }
        ]
      })
    ).toMatch(/more than one initial submission/);
    expect(await broken({ messages: [{ participant: 9, body: "hello", minutesAgo: 1 }] })).toMatch(
      /no participant 9/
    );
    expect(await broken({ messages: [{ participant: 0, body: "hello", minutesAgo: -1 }] })).toMatch(
      /negative number of minutes/
    );
    expect(await broken({ messages: [{ participant: 0, body: "   ", minutesAgo: 1 }] })).toBeTruthy();

    // And none of it was half-written: the decision is still unframed.
    const framed = await agent.frameDecision({
      question: "A decision that can still be framed here",
      options: ["Yes", "No"],
      participants: ["Ada"]
    });
    expect(framed).toHaveLength(1);
  });
});

describe("the seeded scenario", () => {
  it("is a disagreement the facilitator has something to work with", () => {
    const { participants, options, submissions, messages: thread } = SCENARIO;

    expect(submissions!.length).toBeGreaterThanOrEqual(2);
    expect(new Set(submissions!.map((s) => s.option)).size).toBeGreaterThan(1);
    expect(thread!.length).toBeGreaterThanOrEqual(6);
    expect(new Set(thread!.map((m) => m.participant)).size).toBeGreaterThan(1);
    // Every index names somebody, and somebody was invited who has not spoken.
    expect(submissions!.every((s) => participants[s.participant] && options[s.option])).toBe(true);
    expect(thread!.every((m) => participants[m.participant])).toBe(true);
    expect(participants.length).toBeGreaterThan(new Set(thread!.map((m) => m.participant)).size);
  });
});
