import type { ConnectionStatus as Status } from "../hooks/useDecisionAgent.ts";

/**
 * Whether what is on screen is still live.
 *
 * Worth showing because the discussion updates itself: a participant who
 * cannot see that the connection has dropped would read a stale transcript as
 * a quiet one.
 */
export function ConnectionStatus({ status }: { status: Status }) {
  const live = status === "ONLINE";
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-500">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {live ? "Live" : status === "CONNECTING" ? "Reconnecting…" : "Not connected"}
    </span>
  );
}
