/**
 * Owner-only Reveal. Participation is voluntary and there are no deadlines, so
 * the owner is the one who decides the team has had enough opportunity — a
 * participant who never submits must not be able to hold the decision up.
 *
 * This is a normal participant link with owner capabilities; there is no
 * separate owner credential.
 */
export function OwnerControls({
  outstanding,
  busy,
  error,
  onDeclareComplete
}: {
  /** Display names of participants who have not submitted yet. */
  outstanding: string[];
  busy: boolean;
  error: string | null;
  onDeclareComplete: () => void;
}) {
  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
      <p className="text-sm text-neutral-700">
        {outstanding.length === 0
          ? "Everyone has submitted."
          : `Still to submit: ${outstanding.join(", ")}.`}
      </p>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={onDeclareComplete}
        className="mt-3 rounded border border-neutral-900 px-4 py-2 text-sm text-neutral-900 disabled:border-neutral-300 disabled:text-neutral-400"
      >
        {busy ? "Revealing…" : "Declare submissions complete"}
      </button>
      <p className="mt-2 text-xs text-neutral-500">
        This reveals every submitted position and opens the discussion. Anyone who has not
        submitted can still take part, without an initial position.
      </p>
    </div>
  );
}
