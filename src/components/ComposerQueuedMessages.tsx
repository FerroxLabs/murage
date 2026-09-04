// Sends made mid-turn wait in the server's steer queue and stay off the
// transcript until drain (they must never become the active leaf). This is
// that queue made visible, in send order, each with its own cancel.
//
// It lives ON the composer rather than at the tail of the transcript: a
// queued line is something you typed and can still take back, not something
// the conversation has recorded. At the transcript tail it scrolled away
// from the control that cancels it.
import { Clock, X } from "lucide-react";

export function QueuedComposerMessages({
  items,
  onCancel,
}: {
  items: Array<{ queueId: string; text: string }>;
  onCancel: (queueId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-col items-end gap-1.5 px-1" aria-label="Queued messages">
      {items.map((item) => (
        <div key={item.queueId} className="flex max-w-[min(42rem,86%)] flex-col items-end">
          <div className="rounded-2xl rounded-br-md border border-dashed border-hairline/70 bg-panel/80 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-secondary shadow-sm">
            {item.text}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-secondary/75">
            <Clock size={11} aria-hidden="true" />
            <span>Queued for the next turn</span>
            <button
              type="button"
              onClick={() => onCancel(item.queueId)}
              aria-label="Cancel queued message"
              title="Cancel queued message"
              className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
