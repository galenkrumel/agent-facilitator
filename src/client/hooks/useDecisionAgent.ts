import { useCallback, useEffect, useState } from "react";
import { useAgent } from "agents/react";
import type { DecisionAgent } from "../../server/agents/decision.ts";
import type { InitialSubmissionInput } from "../../server/domain/submissions.ts";
import type {
  ClosingAdvisory,
  DecisionBootstrap,
  DecisionRealtimeState,
  StateBrief
} from "../../shared/types.ts";

/** The session cookie was missing or expired — the participant link is stale. */
const UNAUTHENTICATED = 4401;

/** What the browser can say about its live connection to the decision. */
export type ConnectionStatus = "CONNECTING" | "ONLINE" | "OFFLINE";

export type DecisionConnection = {
  bootstrap: DecisionBootstrap | null;
  /** Read once, on opening: reading it is what records the visit. */
  brief: StateBrief | null;
  /** What the owner is warned about before closing. Null for everyone else. */
  advisory: ClosingAdvisory | null;
  status: ConnectionStatus;
  /** Set when the decision cannot be shown at all. */
  error: string | null;
  /** Why the last action was refused. Cleared when another is attempted. */
  actionError: string | null;
  busy: boolean;
  /** Each resolves true when the Agent accepted the action. */
  submitInitialPosition: (input: InitialSubmissionInput) => Promise<boolean>;
  declareSubmissionsComplete: () => Promise<boolean>;
  postMessage: (body: string) => Promise<boolean>;
  closeDecision: (outcomeOptionId: string) => Promise<boolean>;
};

/**
 * Connects to the decision's Agent and reads authoritative state from it.
 *
 * Authentication rides on the session cookie the participant link set, so the
 * connection either opens as a known participant or the Agent closes it.
 *
 * Nothing about the decision is cached client-side. The Agent synchronises a
 * small projection — counts and versions, no content — and every move in it
 * sends this hook back to the Agent for the real state. So a live browser, a
 * refreshed one and a reconnecting one all arrive at the decision by the same
 * path, and none of them can drift from what the Agent committed.
 */
export function useDecisionAgent(decisionId: string): DecisionConnection {
  const [bootstrap, setBootstrap] = useState<DecisionBootstrap | null>(null);
  const [brief, setBrief] = useState<StateBrief | null>(null);
  const [advisory, setAdvisory] = useState<ClosingAdvisory | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("CONNECTING");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agent = useAgent<DecisionAgent, DecisionRealtimeState>({
    agent: "DecisionAgent",
    name: decisionId,
    // Retrying an unauthenticated connection would just fail identically.
    shouldReconnectOnClose: (event) => event.code !== UNAUTHENTICATED,
    onOpen: () => setStatus("ONLINE"),
    onClose: (event) => {
      setStatus(event.code === UNAUTHENTICATED ? "OFFLINE" : "CONNECTING");
      if (event.code === UNAUTHENTICATED) {
        setError("This decision is not open to you — open your participant link again.");
      }
    }
  });

  // The projection, as a value that changes exactly when the decision does.
  // Comparing it rather than a timestamp means a reconnect that finds nothing
  // new costs nothing, while one that missed a message re-reads immediately.
  const version = JSON.stringify(agent.state ?? null);

  useEffect(() => {
    // Also the first read: the effect runs before any projection has arrived,
    // so the decision loads even if the Agent never broadcasts.
    agent.stub
      .getBootstrap()
      .then(setBootstrap)
      .catch((e: unknown) =>
        setError((prev) => prev ?? (e instanceof Error ? e.message : String(e)))
      );
  }, [agent, version]);

  // Deliberately not keyed on `version`: the brief is the state of the
  // decision at the moment this participant opened it, and fetching it is what
  // moves their "last visit" boundary. One read per opening.
  useEffect(() => {
    agent.stub
      .getCurrentStateBrief()
      .then(setBrief)
      // A brief that cannot be read is not worth an error page — the decision
      // itself is right below it, and is the thing the participant came for.
      .catch((e: unknown) => console.error("could not read the current state brief", e));
  }, [agent]);

  // The owner's pre-close warning, re-read whenever the decision moves: it
  // describes what is still open right now, and an owner deciding whether to
  // close should not be reading a list from several messages ago. Unlike the
  // brief, reading it records nothing, so there is no boundary to disturb.
  const canClose = bootstrap?.permissions.canClose ?? false;
  useEffect(() => {
    if (!canClose) return;
    agent.stub
      .getClosingAdvisory()
      .then(setAdvisory)
      // The close control is right underneath, and it is the thing the owner
      // came for. A warning that cannot be read is not worth blocking it.
      .catch((e: unknown) => console.error("could not read the closing advisory", e));
  }, [agent, canClose, version]);

  /**
   * Runs one Agent mutation. A rejection is the Agent refusing the action —
   * already submitted, already revealed, not the owner — and is shown in place
   * rather than replacing the decision with an error page.
   */
  const run = useCallback(async (action: () => Promise<DecisionBootstrap>) => {
    setActionError(null);
    setBusy(true);
    try {
      setBootstrap(await action());
      return true;
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    bootstrap,
    brief,
    advisory,
    status,
    error,
    actionError,
    busy,
    submitInitialPosition: (input) => run(() => agent.stub.submitInitialPosition(input)),
    declareSubmissionsComplete: () => run(() => agent.stub.declareSubmissionsComplete()),
    postMessage: (body) => run(() => agent.stub.postMessage(body)),
    closeDecision: (outcomeOptionId) => run(() => agent.stub.closeDecision(outcomeOptionId))
  };
}
