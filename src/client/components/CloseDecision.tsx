import { useState } from "react";
import type { ClosingAdvisory, DecisionOption } from "../../shared/types.ts";

/**
 * The owner declares the outcome and closes the decision.
 *
 * The advisory above the control is the facilitator's last word and it is
 * advice: it lists what the discussion is leaving open, and then the owner
 * closes anyway if that is what they judge. There is no override to click, no
 * confirmation that escalates with the number of warnings, and no ordering of
 * the options that hints at one — the outcome belongs to the person
 * accountable for it, and the facilitator's job ends at telling them what is
 * still unresolved.
 *
 * An explicit selection with no default, for the same reason: a pre-selected
 * option is a recommendation made by the layout.
 */
export function CloseDecision({
  options,
  advisory,
  busy,
  error,
  onClose
}: {
  options: DecisionOption[];
  advisory: ClosingAdvisory | null;
  busy: boolean;
  error: string | null;
  onClose: (outcomeOptionId: string) => void;
}) {
  const [outcomeOptionId, setOutcomeOptionId] = useState<string | null>(null);

  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
      {advisory && <Advisory advisory={advisory} />}

      <fieldset>
        <legend className="text-sm font-medium text-neutral-900">
          What did the team decide?
        </legend>
        <div className="mt-2 space-y-1">
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-neutral-800">
              <input
                type="radio"
                name="outcome"
                value={option.id}
                checked={outcomeOptionId === option.id}
                onChange={() => setOutcomeOptionId(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <button
        type="button"
        disabled={busy || outcomeOptionId === null}
        onClick={() => outcomeOptionId && onClose(outcomeOptionId)}
        className="mt-3 rounded border border-neutral-900 px-4 py-2 text-sm text-neutral-900 disabled:border-neutral-300 disabled:text-neutral-400"
      >
        {busy ? "Closing…" : "Close the decision"}
      </button>
      <p className="mt-2 text-xs text-neutral-500">
        This ends the decision. The discussion is frozen, positions can no longer change, and it
        cannot be reopened. The facilitator will write a closing memo afterwards.
      </p>
    </div>
  );
}

/**
 * What the discussion is leaving behind. Every list is composed from state the
 * facilitator already holds, so it says nothing that has not already been in
 * front of the team as a crux or a question — it is gathered here, once,
 * because closing is the moment it matters.
 */
function Advisory({ advisory }: { advisory: ClosingAdvisory }) {
  const sections: { title: string; items: string[] }[] = [
    { title: "Still unresolved", items: advisory.unresolvedCruxes.map((c) => c.question) },
    {
      title: "Unresolved disagreement",
      items: advisory.unresolvedConflicts.map((c) => c.description)
    },
    {
      title: "Assumptions the discussion challenged",
      items: advisory.challengedAssumptions.map((a) => a.statement)
    }
  ].filter((s) => s.items.length > 0);

  const dissent = advisory.dissentingPositions;
  if (sections.length === 0 && dissent.length === 0) {
    return (
      <p className="mb-4 text-sm text-neutral-600">
        Nothing is left open: the team has converged and the facilitator has no unresolved cruxes,
        conflicts or challenged assumptions on record.
      </p>
    );
  }

  return (
    <div className="mb-4 space-y-3">
      <p className="text-sm text-neutral-700">
        Before you close, what the discussion is leaving open. This is for your information — none
        of it prevents closing.
      </p>
      {dissent.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            The team has not converged
          </h4>
          <p className="text-sm text-neutral-800">
            {dissent.map((p) => p.displayName).join(", ")} do not all hold the same position.
          </p>
        </div>
      )}
      {sections.map((section) => (
        <div key={section.title}>
          <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {section.title}
          </h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-neutral-800">
            {section.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
