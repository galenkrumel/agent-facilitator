import { useDecisionAgent } from "../hooks/useDecisionAgent.ts";
import type { DecisionBootstrap, DecisionStatus } from "../../shared/types.ts";

/** Participant links land on `/d/:decisionId` once the session is established. */
export function decisionIdFromPath(pathname: string): string | null {
  const [root, decisionId] = pathname.split("/").filter(Boolean);
  return root === "d" && decisionId ? decisionId : null;
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
  SUBMIT: "Collecting initial positions",
  DISCUSS: "In discussion",
  CLOSED: "Closed"
};

export function App() {
  const decisionId = decisionIdFromPath(window.location.pathname);
  if (!decisionId) {
    return (
      <Shell>
        <p className="text-neutral-600">Open a decision through your participant link.</p>
      </Shell>
    );
  }
  return <DecisionView decisionId={decisionId} />;
}

function DecisionView({ decisionId }: { decisionId: string }) {
  const { bootstrap, error } = useDecisionAgent(decisionId);

  if (error) {
    return (
      <Shell>
        <p className="text-red-700">{error}</p>
      </Shell>
    );
  }
  if (!bootstrap) {
    return (
      <Shell>
        <p className="text-neutral-500">Loading the decision…</p>
      </Shell>
    );
  }
  return <Decision bootstrap={bootstrap} />;
}

function Decision({ bootstrap }: { bootstrap: DecisionBootstrap }) {
  const { decision, viewer, participants, submittedParticipantIds } = bootstrap;
  const submitted = new Set(submittedParticipantIds);

  return (
    <Shell>
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {STATUS_LABEL[decision.status]}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
          {decision.question}
        </h1>
        {decision.context && (
          <p className="mt-3 whitespace-pre-wrap text-neutral-700">{decision.context}</p>
        )}
      </header>

      <Section title="Options">
        <ul className="space-y-1">
          {decision.options.map((option) => (
            <li key={option.id} className="text-neutral-800">
              {option.label}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Participants">
        <ul className="space-y-1">
          {participants.map((participant) => (
            <li key={participant.id} className="flex justify-between gap-4 text-neutral-800">
              <span>
                {participant.displayName}
                {participant.id === viewer.participantId && " (you)"}
                {participant.isOwner && (
                  <span className="ml-2 text-xs uppercase tracking-wide text-neutral-500">owner</span>
                )}
              </span>
              {/* Who has submitted is public during Submit; what they submitted is not. */}
              <span className="text-sm text-neutral-500">
                {submitted.has(participant.id) ? "submitted" : "not yet submitted"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Your position">
        {bootstrap.ownSubmission ? (
          <p className="text-neutral-800">
            {labelOf(bootstrap, bootstrap.ownSubmission.optionId)} · confidence{" "}
            {bootstrap.ownSubmission.confidence}/5
          </p>
        ) : (
          <p className="text-neutral-500">You have not submitted an initial position.</p>
        )}
      </Section>
    </Shell>
  );
}

function labelOf(bootstrap: DecisionBootstrap, optionId: string): string {
  return bootstrap.decision.options.find((o) => o.id === optionId)?.label ?? optionId;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl p-8">{children}</main>;
}
