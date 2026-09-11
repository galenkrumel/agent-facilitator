import { useDecisionAgent, type DecisionConnection } from "../hooks/useDecisionAgent.ts";
import { Board } from "../components/Board.tsx";
import { ConnectionStatus } from "../components/ConnectionStatus.tsx";
import { CurrentStateBrief } from "../components/CurrentStateBrief.tsx";
import { Discussion } from "../components/Discussion.tsx";
import { OwnerControls } from "../components/OwnerControls.tsx";
import { SubmissionForm } from "../components/SubmissionForm.tsx";
import type { DecisionBootstrap, DecisionStatus, InitialSubmission } from "../../shared/types.ts";

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
  const connection = useDecisionAgent(decisionId);

  if (connection.error) {
    return (
      <Shell>
        <p className="text-red-700">{connection.error}</p>
      </Shell>
    );
  }
  if (!connection.bootstrap) {
    return (
      <Shell>
        <p className="text-neutral-500">Loading the decision…</p>
      </Shell>
    );
  }
  return <Decision connection={connection} bootstrap={connection.bootstrap} />;
}

function Decision({
  connection,
  bootstrap
}: {
  connection: DecisionConnection;
  bootstrap: DecisionBootstrap;
}) {
  const { decision, viewer, participants, permissions, submittedParticipantIds } = bootstrap;
  const submitted = new Set(submittedParticipantIds);
  const revealed = decision.status !== "SUBMIT";

  return (
    <Shell>
      <header>
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {STATUS_LABEL[decision.status]}
          </p>
          <ConnectionStatus status={connection.status} />
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
          {decision.question}
        </h1>
        {decision.context && (
          <p className="mt-3 whitespace-pre-wrap text-neutral-700">{decision.context}</p>
        )}
      </header>

      {connection.brief && <CurrentStateBrief brief={connection.brief} />}

      {!revealed && (
        <Section title="Options">
          <ul className="space-y-1">
            {decision.options.map((option) => (
              <li key={option.id} className="text-neutral-800">
                {option.label}
              </li>
            ))}
          </ul>
        </Section>
      )}

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
              {!revealed && (
                <span className="text-sm text-neutral-500">
                  {submitted.has(participant.id) ? "submitted" : "not yet submitted"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={revealed ? "Board" : "Your position"}>
        {revealed ? (
          <Board
            board={bootstrap.board}
            options={decision.options}
            submissions={bootstrap.submissions}
            viewerId={viewer.participantId}
          />
        ) : permissions.canSubmit ? (
          <SubmissionForm
            options={decision.options}
            busy={connection.busy}
            error={connection.actionError}
            onSubmit={connection.submitInitialPosition}
          />
        ) : (
          <div className="text-neutral-800">
            {bootstrap.ownSubmission && (
              <p>
                {labelOf(bootstrap, bootstrap.ownSubmission.optionId)}
                <span className="text-neutral-500">
                  {" "}
                  · confidence {bootstrap.ownSubmission.confidence}/5
                </span>
              </p>
            )}
            <Reasons submission={bootstrap.ownSubmission ?? undefined} />
            <p className="mt-2 text-sm text-neutral-500">
              Your position is in, and cannot be changed. It stays private until everyone has
              answered, or the owner declares submissions complete.
            </p>
          </div>
        )}
      </Section>

      {permissions.canDeclareSubmissionsComplete && (
        <Section title="Owner">
          <OwnerControls
            outstanding={participants.filter((p) => !submitted.has(p.id)).map((p) => p.displayName)}
            busy={connection.busy}
            error={connection.actionError}
            onDeclareComplete={connection.declareSubmissionsComplete}
          />
        </Section>
      )}

      {revealed && (
        <Section title="Discussion">
          <Discussion
            messages={bootstrap.messages}
            participants={participants}
            viewerId={viewer.participantId}
            canPost={permissions.canPostMessage}
            busy={connection.busy}
            error={connection.actionError}
            onPost={connection.postMessage}
          />
        </Section>
      )}
    </Shell>
  );
}

function Reasons({ submission }: { submission: InitialSubmission | undefined }) {
  if (!submission || submission.reasons.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
      {submission.reasons.map((reason, i) => (
        <li key={i}>{reason}</li>
      ))}
    </ul>
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
