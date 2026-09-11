import { useState } from "react";
import { MAX_MESSAGE_LENGTH } from "../../server/domain/messages.ts";

/**
 * The composer for the one shared thread.
 *
 * Messages are immutable and there is no editing or deletion, so the only
 * correction available is another message — which is why the box is cleared
 * only once the Agent has actually accepted what was in it.
 */
export function MessageComposer({
  busy,
  error,
  onPost
}: {
  busy: boolean;
  error: string | null;
  onPost: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const ready = body.trim().length > 0 && body.trim().length <= MAX_MESSAGE_LENGTH;

  async function post() {
    if (!ready || busy) return;
    if (await onPost(body)) setBody("");
  }

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <textarea
        value={body}
        rows={3}
        placeholder="Say something to the group…"
        className="w-full rounded border border-neutral-300 px-3 py-2 text-neutral-900"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a new line. A discussion message is
          // usually a sentence, and the long ones can still be written.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void post();
          }
        }}
      />
      {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={!ready || busy}
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:bg-neutral-300"
        >
          {busy ? "Sending…" : "Send"}
        </button>
        <span className="text-xs text-neutral-500">
          Enter to send, Shift+Enter for a new line. Messages cannot be edited or deleted.
        </span>
      </div>
    </form>
  );
}
