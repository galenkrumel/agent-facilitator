import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { DecisionAgent } from "../../server/agents/decision.ts";
import type { InitialSubmissionInput } from "../../server/domain/submissions.ts";
import type { DecisionBootstrap } from "../../shared/types.ts";

/** The session cookie was missing or expired — the participant link is stale. */
const UNAUTHENTICATED = 4401;

export type DecisionConnection = {
  bootstrap: DecisionBootstrap | null;
  /** Set when the decision cannot be shown at all. */
  error: string | null;
  /** Why the last action was refused. Cleared when another is attempted. */
  actionError: string | null;
  busy: boolean;
  submitInitialPosition: (input: InitialSubmissionInput) => void;
  declareSubmissionsComplete: () => void;
};

/**
 * Connects to the decision's Agent and reads authoritative state from it.
 *
 * Authentication rides on the session cookie the participant link set, so the
 * connection either opens as a known participant or the Agent closes it.
 * Nothing about the decision is cached client-side: a refresh re-reads it, and
 * every action answers with the state the Agent has just committed rather than
 * anything this hook predicted. Other participants' changes arrive on refresh
 * until M3 adds realtime.
 */
export function useDecisionAgent(decisionId: string): DecisionConnection {
  const [bootstrap, setBootstrap] = useState<DecisionBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetched = useRef(false);

  const agent = useAgent<DecisionAgent, unknown>({
    agent: "DecisionAgent",
    name: decisionId,
    // Retrying an unauthenticated connection would just fail identically.
    shouldReconnectOnClose: (event) => event.code !== UNAUTHENTICATED,
    onClose: (event) => {
      if (event.code === UNAUTHENTICATED) {
        setError("This decision is not open to you — open your participant link again.");
      }
    }
  });

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    // The call is buffered until the socket opens; if the Agent rejects the
    // connection instead, it rejects and `onClose` has the better message.
    agent.stub
      .getBootstrap()
      .then(setBootstrap)
      .catch((e: unknown) => setError((prev) => prev ?? (e instanceof Error ? e.message : String(e))));
  }, [agent, decisionId]);

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
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    bootstrap,
    error,
    actionError,
    busy,
    submitInitialPosition: (input) => void run(() => agent.stub.submitInitialPosition(input)),
    declareSubmissionsComplete: () => void run(() => agent.stub.declareSubmissionsComplete())
  };
}
