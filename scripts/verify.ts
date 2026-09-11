/**
 * Drives one participant through a running application, over the wire the
 * browser uses.
 *
 * This is the second half of an end-to-end check: a browser is one
 * participant, and this is another, in another "browser" entirely — its own
 * cookie jar, its own WebSocket, its own view of the decision. That is the
 * only way to watch a realtime update actually arrive somewhere it was not
 * caused, and the session cookie is named per decision, so two participants in
 * one decision cannot share a browser profile.
 *
 * It speaks the Agents SDK's RPC frames directly rather than importing the
 * React client, because the point is to exercise the server, not the client.
 *
 *   node scripts/verify.ts frame  "<question>" "<a>,<b>" "<option>,<option>"
 *   node scripts/verify.ts brief  <link>
 *   node scripts/verify.ts submit <link> <optionId> <confidence> "<reason>"
 *   node scripts/verify.ts say    <link> "<message>"        # posts, waits for
 *                                                           # the facilitator
 *   node scripts/verify.ts state  <link>
 *   node scripts/verify.ts watch  <link> <seconds>          # log state pushes
 *
 * A link is the participant URL printed by `frame`. Requires the application
 * to be running (`npm run dev`); `/d/new` exists only in development.
 */
import { sessionCookieName } from "../src/server/auth/sessions.ts";
import type { DecisionBootstrap, DecisionRealtimeState, StateBrief } from "../src/shared/types.ts";

const [command, ...args] = process.argv.slice(2);

/** One participant's session: the cookie a browser would have been handed. */
async function openLink(link: string): Promise<{ origin: string; decisionId: string; cookie: string }> {
  const url = new URL(link);
  const decisionId = url.pathname.split("/").filter(Boolean)[1]!;
  const response = await fetch(link, { redirect: "manual" });
  if (response.status !== 303) throw new Error(`the participant link returned ${response.status}`);

  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie?.startsWith(sessionCookieName(decisionId))) throw new Error("no session cookie");
  return { origin: url.origin, decisionId, cookie };
}

type Client = {
  call: <T>(method: string, args?: unknown[]) => Promise<T>;
  /** Every projection the Agent has pushed, in arrival order. */
  pushes: { at: number; state: DecisionRealtimeState }[];
  close: () => void;
};

/** Connects as one participant and speaks the Agent's RPC protocol. */
async function connect(link: string): Promise<Client> {
  const { origin, decisionId, cookie } = await openLink(link);
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/agents/decision-agent/${decisionId}`,
    // Undici's WebSocket takes headers; a browser would send the cookie itself.
    { headers: { cookie } } as unknown as string[]
  );

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const pushes: Client["pushes"] = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "cf_agent_state") {
      pushes.push({ at: Date.now(), state: message.state });
      return;
    }
    if (message.type !== "rpc") return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.success) call.resolve(message.result);
    else call.reject(new Error(message.error));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("close", (e) => reject(new Error(`connection closed: ${e.reason}`)), {
      once: true
    });
  });

  return {
    call: <T>(method: string, callArgs: unknown[] = []) =>
      new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        socket.send(JSON.stringify({ type: "rpc", id, method, args: callArgs }));
        setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30_000);
      }),
    pushes,
    close: () => socket.close()
  };
}

/**
 * Waits for the facilitator to finish thinking.
 *
 * Analysis is asynchronous by design, so there is no response to await — the
 * projection is how the application itself says the facilitator is busy, and
 * waiting on anything else would be waiting on a guess.
 */
async function settle(client: Client, timeoutMs = 180_000): Promise<DecisionRealtimeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = client.pushes.at(-1)?.state;
    if (state && state.facilitatorStatus !== "ANALYZING") {
      // One more beat: a follow-up analysis is scheduled after the one that
      // just finished, and stopping at the first idle would read a half-done
      // understanding.
      await new Promise((r) => setTimeout(r, 2000));
      const latest = client.pushes.at(-1)?.state ?? state;
      if (latest.facilitatorStatus !== "ANALYZING") return latest;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the facilitator never went idle");
}

/** The decision as a participant sees it, in a few lines. */
function render(bootstrap: DecisionBootstrap): string {
  const label = (id: string | null) =>
    id ? (bootstrap.decision.options.find((o) => o.id === id)?.label ?? id) : "no position";
  const names = new Map(bootstrap.participants.map((p) => [p.id, p.displayName]));
  const lines = [
    `status: ${bootstrap.decision.status}`,
    "positions:",
    ...bootstrap.board.positions.map(
      (p) =>
        `  ${p.displayName}: ${label(p.optionId)}` +
        (p.confidence === null ? " (no confidence)" : ` (confidence ${p.confidence}/5)`)
    ),
    `cruxes:${bootstrap.board.cruxes.length ? "" : " (none)"}`,
    ...bootstrap.board.cruxes.map((c) => `  [${c.status}] ${c.question}`),
    `action items:${bootstrap.board.actionItems.length ? "" : " (none)"}`,
    ...bootstrap.board.actionItems.map((a) => `  ${a.description}`),
    `messages (${bootstrap.messages.length}):`,
    ...bootstrap.messages.map((m) => {
      const author = m.author;
      const who =
        author.kind === "FACILITATOR"
          ? "FACILITATOR"
          : (names.get(author.participantId) ?? "someone");
      return `  [${m.seq}] ${who}: ${m.body}`;
    })
  ];
  return lines.join("\n");
}

function renderBrief(brief: StateBrief): string {
  return [
    `brief: ${brief.kind}${brief.since ? ` (since ${new Date(brief.since).toLocaleTimeString()})` : ""}`,
    `  ${brief.summary}`,
    ...brief.questionsForYou.map((q) => `  asked of you: ${q}`),
    ...brief.openCruxes.map((c) => `  open crux: ${c}`),
    ...brief.challengedAssumptions.map((a) => `  challenged: ${a}`)
  ].join("\n");
}

switch (command) {
  case "frame": {
    const [question, participants, options] = args;
    const response = await fetch("http://localhost:5173/d/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        options: options!.split(","),
        participants: participants!.split(",")
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const framed = (await response.json()) as {
      decisionId: string;
      links: { displayName: string; url: string }[];
    };
    console.log(framed.decisionId);
    for (const link of framed.links) console.log(`${link.displayName} ${link.url}`);
    break;
  }

  case "brief": {
    const client = await connect(args[0]!);
    console.log(renderBrief(await client.call<StateBrief>("getCurrentStateBrief")));
    client.close();
    break;
  }

  case "submit": {
    const [link, optionId, confidence, reason] = args;
    const client = await connect(link!);
    const bootstrap = await client.call<DecisionBootstrap>("submitInitialPosition", [
      { optionId, confidence: Number(confidence), reasons: [reason] }
    ]);
    console.log(render(bootstrap));
    client.close();
    break;
  }

  case "say": {
    const [link, body] = args;
    const client = await connect(link!);
    const before = await client.call<DecisionBootstrap>("getBootstrap");
    await client.call("postMessage", [body]);
    const settled = await settle(client);
    const after = await client.call<DecisionBootstrap>("getBootstrap");
    console.log(render(after));
    console.log(
      `\nfacilitator: ${
        after.messages.filter((m) => m.author.kind === "FACILITATOR").length -
        before.messages.filter((m) => m.author.kind === "FACILITATOR").length
      } new message(s); board version ${settled.boardVersion}; pushes received: ${client.pushes.length}`
    );
    client.close();
    break;
  }

  case "state": {
    const client = await connect(args[0]!);
    console.log(render(await client.call<DecisionBootstrap>("getBootstrap")));
    client.close();
    break;
  }

  case "watch": {
    const client = await connect(args[0]!);
    const seconds = Number(args[1] ?? 60);
    console.log(`watching for ${seconds}s — every line is a push from the Agent, unprompted`);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    for (const push of client.pushes) {
      console.log(
        `  +${((push.at - started) / 1000).toFixed(1)}s  messages=${push.state.messageCount} ` +
          `board=${push.state.boardVersion} positions=${push.state.positionsVersion} ` +
          `facilitator=${push.state.facilitatorStatus}`
      );
    }
    client.close();
    break;
  }

  default:
    console.error("usage: node scripts/verify.ts frame|brief|submit|say|state|watch …");
    process.exit(1);
}
