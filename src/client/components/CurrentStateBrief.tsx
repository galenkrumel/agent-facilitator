import type { StateBrief } from "../../shared/types.ts";

/**
 * Orientation on opening the decision.
 *
 * Read once, when the decision is opened, and then left alone — it describes
 * the moment of arrival, and re-fetching it as the discussion moves would both
 * reset the "since your last visit" boundary and make the page argue with
 * itself. Anything that happens while the participant is reading arrives in
 * the discussion below, where it belongs.
 */
export function CurrentStateBrief({ brief }: { brief: StateBrief }) {
  return (
    <section className="mt-6 rounded-md border border-neutral-200 bg-neutral-50 p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {brief.kind === "FIRST_VISIT" ? "Where this decision stands" : "Since your last visit"}
      </h2>
      <p className="mt-2 text-neutral-800">{brief.summary}</p>

      {brief.questionsForYou.length > 0 && (
        <Group title="The facilitator has asked you">
          {brief.questionsForYou.map((question, i) => (
            <li key={i}>{question}</li>
          ))}
        </Group>
      )}

      {brief.openCruxes.length > 0 && (
        <Group title="Open cruxes">
          {brief.openCruxes.map((crux, i) => (
            <li key={i}>{crux}</li>
          ))}
        </Group>
      )}

      {brief.challengedAssumptions.length > 0 && (
        <Group title="Assumptions the discussion has challenged">
          {brief.challengedAssumptions.map((assumption, i) => (
            <li key={i}>{assumption}</li>
          ))}
        </Group>
      )}
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">{children}</ul>
    </div>
  );
}
