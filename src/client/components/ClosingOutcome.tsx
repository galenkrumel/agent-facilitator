import type { ClosingMemoRecord, DecisionOption } from "../../shared/types.ts";

/**
 * The closed decision: the outcome the owner declared, and the memo written
 * around it.
 *
 * The outcome is rendered from the decision itself and never from the memo, so
 * what is shown here is the owner's declaration whatever the synthesis did or
 * did not manage to produce. A memo that is still being written says so, and
 * one that failed says that — a closed decision with an honest gap in its
 * record is better than one with a plausible invention in it.
 */
export function ClosingOutcome({
  outcomeOptionId,
  options,
  record
}: {
  outcomeOptionId: string | null;
  options: DecisionOption[];
  record: ClosingMemoRecord | null;
}) {
  const outcome = options.find((o) => o.id === outcomeOptionId);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-1 text-sm font-medium text-neutral-900">Outcome</h3>
        <p className="text-lg text-neutral-900">{outcome?.label ?? "(not recorded)"}</p>
        <p className="mt-1 text-xs text-neutral-500">Declared by the owner.</p>
      </div>

      {record?.status === "PENDING" && (
        <p className="text-neutral-500">The facilitator is writing the closing memo…</p>
      )}

      {record?.status === "FAILED" && (
        <p className="text-neutral-600">
          The closing memo could not be written. The outcome above is unaffected — it is what the
          owner declared, and the discussion below is the full record of how the team got there.
        </p>
      )}

      {record?.memo && (
        <>
          <MemoSection title="Reasoning">
            <p className="whitespace-pre-wrap text-neutral-800">{record.memo.reasoning}</p>
          </MemoSection>
          <MemoList title="Assumptions the discussion refuted" items={record.memo.refutedAssumptions} />
          <MemoList title="Left unresolved" items={record.memo.unresolvedIssues} />
          <MemoList title="Dissent at closing" items={record.memo.dissent} />
          <MemoList title="Action items" items={record.memo.actionItems} />
        </>
      )}
    </div>
  );
}

function MemoList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <MemoSection title={title}>
      <ul className="list-disc space-y-0.5 pl-5 text-neutral-800">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </MemoSection>
  );
}

function MemoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium text-neutral-900">{title}</h3>
      {children}
    </div>
  );
}
