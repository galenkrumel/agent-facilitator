import { useState } from "react";
import { MAX_REASONS, type InitialSubmissionInput } from "../../server/domain/submissions.ts";
import type { DecisionOption } from "../../shared/types.ts";

const CONFIDENCE_LEVELS = [1, 2, 3, 4, 5] as const;

/**
 * The private initial position: one option, a confidence, up to three reasons.
 *
 * Nothing here is visible to anyone else until Reveal — the form deliberately
 * shows no hint of what others have chosen, and the Agent is the authority on
 * that, not this component.
 */
export function SubmissionForm({
  options,
  busy,
  error,
  onSubmit
}: {
  options: DecisionOption[];
  busy: boolean;
  error: string | null;
  onSubmit: (input: InitialSubmissionInput) => void;
}) {
  const [optionId, setOptionId] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [reasons, setReasons] = useState<string[]>(Array(MAX_REASONS).fill(""));

  // The Agent validates all of this again; this only avoids a pointless round trip.
  const ready = optionId !== null && confidence !== null;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        onSubmit({ optionId: optionId!, confidence: confidence!, reasons });
      }}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-neutral-900">Your position</legend>
        <div className="space-y-1">
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-neutral-800">
              <input
                type="radio"
                name="option"
                value={option.id}
                checked={optionId === option.id}
                onChange={() => setOptionId(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-neutral-900">
          How confident are you?
        </legend>
        <div className="flex gap-2">
          {CONFIDENCE_LEVELS.map((level) => (
            <label
              key={level}
              className={`cursor-pointer rounded border px-3 py-1 text-sm ${
                confidence === level
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 text-neutral-700"
              }`}
            >
              <input
                type="radio"
                name="confidence"
                value={level}
                className="sr-only"
                checked={confidence === level}
                onChange={() => setConfidence(level)}
              />
              {level}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-neutral-500">1 = very unsure, 5 = very confident.</p>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-neutral-900">
          Why? <span className="font-normal text-neutral-500">(up to {MAX_REASONS}, optional)</span>
        </legend>
        <div className="space-y-2">
          {reasons.map((reason, i) => (
            <input
              key={i}
              type="text"
              value={reason}
              placeholder={`Reason ${i + 1}`}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-neutral-900"
              onChange={(e) =>
                setReasons((prev) => prev.map((r, j) => (j === i ? e.target.value : r)))
              }
            />
          ))}
        </div>
      </fieldset>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={!ready || busy}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:bg-neutral-300"
      >
        {busy ? "Submitting…" : "Submit my position"}
      </button>
      <p className="text-xs text-neutral-500">
        Initial positions stay private until Reveal, and cannot be changed afterwards.
      </p>
    </form>
  );
}
