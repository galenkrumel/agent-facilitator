import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { DecisionAgent } from "../../src/server/agents/decision.ts";
import type {
  BoardView,
  ClosingAdvisory,
  ClosingMemo,
  ClosingMemoRecord,
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

export function closingMemo(agent: Agent): Promise<ClosingMemoRecord | null> {
  return runInDurableObject(agent, (instance) =>
    (instance as unknown as { closingMemoRecord(): ClosingMemoRecord | null }).closingMemoRecord()
  );
}

/** A memo the model might plausibly have produced, around a given outcome. */
export function memo(outcomeOptionId: string, overrides: Partial<ClosingMemo> = {}): ClosingMemo {
  return {
    outcomeOptionId,
    reasoning: "The team weighed the crash data against the cost of slipping.",
    refutedAssumptions: [],
    unresolvedIssues: [],
    dissent: [],
    actionItems: [],
    ...overrides
  };
}

/**
 * Reads the advisory as one participant. Owner-only, and `getClosingAdvisory`
 * reads the viewer from the connection, so the caller says who is asking —
 * the same shape `brief` uses below.
 */
export function advisory(agent: Agent, participantId: string): Promise<ClosingAdvisory> {
  return asViewer(agent, participantId, (target) => target.getClosingAdvisory());
}

/**
 * Reads the brief as one participant, which also records their visit.
 *
 * `getCurrentStateBrief` is `@callable()` and reads the viewer from the
 * connection, so driving it directly means saying who is asking — the same
 * shape the lifecycle tests use for the transactional core.
 */
export function brief(agent: Agent, participantId: string): Promise<StateBrief> {
  return asViewer(agent, participantId, (target) => target.getCurrentStateBrief());
}

/**
 * Runs one `@callable()` as a named participant, without a real connection.
 *
 * Structurally typed rather than as `DecisionAgent`: `viewerId` is private
 * there, and intersecting a class with its own private member collapses the
 * type to `never`.
 */
type Viewing = {
  viewerId(): string;
  getCurrentStateBrief(): StateBrief;
  getClosingAdvisory(): ClosingAdvisory;
};

function asViewer<T>(
  agent: Agent,
  participantId: string,
  read: (target: Viewing) => T
): Promise<T> {
  return runInDurableObject(agent, (instance) => {
    const target = instance as unknown as Viewing;
    const original = target.viewerId;
    target.viewerId = () => participantId;
    try {
      return read(target);
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
