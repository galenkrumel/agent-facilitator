import { useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { DecisionAgent } from "../../server/agents/decision.ts";
import type { DecisionBootstrap } from "../../shared/types.ts";

/** The session cookie was missing or expired — the participant link is stale. */
const UNAUTHENTICATED = 4401;

export type DecisionConnection = {
  bootstrap: DecisionBootstrap | null;
  /** Set when the decision cannot be shown at all. */
  error: string | null;
};

/**
 * Connects to the decision's Agent and reads authoritative state from it.
 *
 * Authentication rides on the session cookie the participant link set, so the
 * connection either opens as a known participant or the Agent closes it.
 * Nothing about the decision is cached client-side: a refresh re-reads it.
 */
export function useDecisionAgent(decisionId: string): DecisionConnection {
  const [bootstrap, setBootstrap] = useState<DecisionBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return { bootstrap, error };
}
