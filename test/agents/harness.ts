import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";
import type {
  BoardView,
  CurrentPosition,
  DecisionRealtimeState,
  FacilitatorAnalysisResult,
  FacilitatorContext,
  Message,
  StateBrief
} from "../../src/shared/types.ts";

/**
 * Shared scaffolding for the facilitator suites, which all need the same
 * thing: a real Durable Object holding a revealed decision, with the Workflow
 * replaced by a recorder so analyses can be handed in deliberately.
 *
 * The Agent is the thing under test — nothing here stands in for SQLite, the
 * transaction, or the runtime.
 */
export type Agent = DurableObjectStub<DecisionAgent>;

/** An analysis that found nothing and has nothing to say. */
export const SILENT: FacilitatorAnalysisResult = {
  analyzedThroughSeq: 0,
  assumptions: [],
  cruxes: [],
  conflicts: [],
  actionItems: [],
  positionChanges: [],
  intervention: null
};

/** Frames a decision, reveals it, and settles the Reveal analysis. */
export async function discussing(participants = ["Ada", "Grace"]) {
  const agent = (await getAgentByName(env.DecisionAgent, crypto.randomUUID())) as Agent;
  const framed = await agent.frameDecision({
    question: "Ship in February or slip to March?",
    options: ["Ship in February", "Slip to March"],
    participants
  });
  const id = Object.fromEntries(framed.map((p) => [p.displayName, p.id]));
  const scheduled = await stubWorkflow(agent);
  await agent.declareCompleteFor(id.Ada!);
  await agent.applyAnalysis(SILENT);
  scheduled.length = 0;
  return { agent, id, scheduled };
}

/** Records what the Agent hands to the Workflow, instead of running one. */
export async function stubWorkflow(agent: Agent, behaviour: "ok" | "throw" = "ok") {
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

export function projection(agent: Agent): Promise<DecisionRealtimeState> {
  return runInDurableObject(
    agent,
    (instance) => (instance as unknown as { state: DecisionRealtimeState }).state
  );
}

export function messages(agent: Agent): Promise<Message[]> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as { messages(): Message[] }).messages()
  );
}

export function context(agent: Agent): Promise<FacilitatorContext> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as DecisionAgent).getFacilitatorContext()
  );
}

export function board(agent: Agent): Promise<BoardView> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as { board(): BoardView }).board()
  );
}

export function positions(agent: Agent): Promise<CurrentPosition[]> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as { positions(): CurrentPosition[] }).positions()
  );
}

/**
 * Reads the brief as one participant, which also records their visit.
 *
 * `getCurrentStateBrief` is `@callable()` and reads the viewer from the
 * connection, so driving it directly means saying who is asking — the same
 * shape the lifecycle tests use for the transactional core.
 */
export function brief(agent: Agent, participantId: string): Promise<StateBrief> {
  return runInDurableObject(agent, (instance) => {
    const target = instance as unknown as { viewerId(): string; getCurrentStateBrief(): StateBrief };
    const original = target.viewerId;
    target.viewerId = () => participantId;
    try {
      return target.getCurrentStateBrief();
    } finally {
      target.viewerId = original;
    }
  });
}

/** See decision-lifecycle.test.ts: `.rejects` breaks on Durable Object RPC. */
export async function refusedWith(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the Agent to refuse this call, but it resolved");
}
