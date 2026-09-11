import { MessageComposer } from "./MessageComposer.tsx";
import type { Message, Participant } from "../../shared/types.ts";

/**
 * The discussion: one thread, chronological, flat.
 *
 * No replies, no mentions, no editing — participants address each other by
 * name and correct themselves in a follow-up, exactly as they would in a
 * group chat. Ordering is the Agent's `seq`, never the browser's clock.
 */
export function Discussion({
  messages,
  participants,
  viewerId,
  canPost,
  busy,
  error,
  onPost
}: {
  messages: Message[];
  participants: Participant[];
  viewerId: string;
  canPost: boolean;
  busy: boolean;
  error: string | null;
  onPost: (body: string) => Promise<boolean>;
}) {
  const nameOf = new Map(participants.map((p) => [p.id, p.displayName]));

  return (
    <div>
      {messages.length === 0 ? (
        <p className="text-neutral-500">
          Nothing has been said yet. The positions above are everyone's starting point.
        </p>
      ) : (
        <ol className="space-y-4">
          {messages.map(({ seq, author, body, createdAt }) => {
            const facilitator = author.kind === "FACILITATOR";
            return (
              <li
                key={seq}
                // The facilitator is a visibly different voice in the room: it
                // is not a participant and holds no position.
                className={facilitator ? "border-l-2 border-neutral-300 pl-3" : undefined}
              >
                <p className="text-sm">
                  <span
                    className={`font-medium ${facilitator ? "text-neutral-500" : "text-neutral-900"}`}
                  >
                    {facilitator ? "Facilitator" : (nameOf.get(author.participantId) ?? "Someone")}
                  </span>
                  {!facilitator && author.participantId === viewerId && (
                    <span className="text-neutral-500"> (you)</span>
                  )}
                  <span className="ml-2 text-xs text-neutral-400">{time(createdAt)}</span>
                </p>
                <p
                  className={`whitespace-pre-wrap ${facilitator ? "text-neutral-600" : "text-neutral-800"}`}
                >
                  {body}
                </p>
              </li>
            );
          })}
        </ol>
      )}

      {canPost ? (
        <MessageComposer busy={busy} error={error} onPost={onPost} />
      ) : (
        <p className="mt-4 text-sm text-neutral-500">
          This decision is closed. The discussion is frozen.
        </p>
      )}
    </div>
  );
}

function time(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
