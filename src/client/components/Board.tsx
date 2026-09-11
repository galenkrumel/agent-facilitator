import type { BoardView, DecisionOption, InitialSubmission } from "../../shared/types.ts";

/**
 * The board: current positions, cruxes, action items.
 *
 * Exactly the three the requirements name. Assumptions and conflicts are the
 * facilitator's own working model and stay off it — participants meet those as
 * questions in the discussion, not as a list of what they are presumed to
 * believe. Nothing here is editable: the board is a projection of the
 * decision, and the way to change it is to say something.
 */
export function Board({
  board,
  options,
  submissions,
  viewerId
}: {
  board: BoardView;
  options: DecisionOption[];
  submissions: InitialSubmission[];
  viewerId: string;
}) {
  const label = (optionId: string) => options.find((o) => o.id === optionId)?.label ?? optionId;
  const reasons = new Map(submissions.map((s) => [s.participantId, s.reasons]));

  return (
    <div className="space-y-8">
      <div>
        <h3 className="mb-2 text-sm font-medium text-neutral-900">Current positions</h3>
        <ul className="space-y-4">
          {board.positions.map((position) => (
            <li key={position.participantId}>
              <p className="text-neutral-900">
                <span className="font-medium">{position.displayName}</span>
                {position.participantId === viewerId && " (you)"}
                {" — "}
                {position.optionId ? (
                  <>
                    {label(position.optionId)}
                    {position.confidence !== null ? (
                      <span className="text-neutral-500"> · confidence {position.confidence}/5</span>
                    ) : (
                      <span className="text-neutral-500"> · confidence not given yet</span>
                    )}
                  </>
                ) : (
                  <span className="text-neutral-500">
                    {position.submitted ? "no position" : "no position submitted"}
                  </span>
                )}
              </p>
              {/* The reasons they started from. Historical context now: the
                  position above is what the decision is made of. */}
              {(reasons.get(position.participantId) ?? []).length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
                  {reasons.get(position.participantId)!.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-neutral-900">Cruxes</h3>
        {board.cruxes.length === 0 ? (
          <p className="text-neutral-500">
            The facilitator has not identified anything that separates the positions yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {board.cruxes.map((crux) => (
              <li key={crux.id} className="text-neutral-800">
                {crux.question}
                {crux.status === "RESOLVED" && (
                  <span className="ml-2 text-xs uppercase tracking-wide text-neutral-500">
                    resolved
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-neutral-900">Action items</h3>
        {board.actionItems.length === 0 ? (
          <p className="text-neutral-500">Nobody has committed to anything yet.</p>
        ) : (
          <ul className="space-y-1">
            {board.actionItems.map((item) => (
              <li key={item.id} className="text-neutral-800">
                {item.description}
                {item.ownerParticipantId && (
                  <span className="text-neutral-500">
                    {" — "}
                    {board.positions.find((p) => p.participantId === item.ownerParticipantId)
                      ?.displayName ?? "someone"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
