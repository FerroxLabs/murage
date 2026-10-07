import { useState } from "react";
import type { Message } from "../state/store";
import { claimExcerpts, HELD_QUEUE_OPEN } from "../../shared/chat-engine-notes";
import { EARLIER_CLAIM_TITLE, FLAGGED_REPLY_LINE } from "../../shared/reply-action-claims";

/** Under a reply whose described actions have no record: one quiet line, and the words it is about. */
export function ReplyActionNote({ text, check, onJump }: { text: string; check: NonNullable<Message["actionCheck"]>; onJump: (messageId: string) => void }) {
  const excerpts = claimExcerpts(text, check);
  const flagged = check.state === "flagged";
  if (!flagged && !excerpts.some((excerpt) => excerpt.state === "earlier")) return null;
  return (
    <div data-testid="reply-action-note" className="mt-1.5 text-[11.5px] text-ink-secondary">
      {flagged && <div role="note">{FLAGGED_REPLY_LINE}</div>}
      {excerpts.map((excerpt, i) => excerpt.state === "earlier" && excerpt.rowId ? (
        <button key={i} type="button" data-claim-state="earlier" title={EARLIER_CLAIM_TITLE}
          onClick={() => onJump(excerpt.rowId!)} className="mr-2 underline decoration-dotted underline-offset-2">{excerpt.text}</button>
      ) : (
        <span
          key={i}
          data-claim-state={excerpt.state}
          title={excerpt.state === "earlier" ? EARLIER_CLAIM_TITLE : undefined}
          className={excerpt.state === "flagged" ? "mr-2 underline decoration-warning decoration-2 underline-offset-2" : "mr-2 underline decoration-dotted underline-offset-2"}
        >
          {excerpt.text}
        </span>
      ))}
    </div>
  );
}

/** The thread's one line about items waiting for an engine that can act. */
export function HeldQueueRow({ text, count, items = [], onJump, onRetry, bots = [] }: { bots?: Array<{ id: string; name: string }>; onRetry?: (id: string, botId: string) => Promise<void>; text: string; count: number; items?: NonNullable<NonNullable<Message["murage"]>["held"]>["items"]; onJump: (messageId: string) => void }) {
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const label = text.replace(new RegExp(`\\s*${HELD_QUEUE_OPEN}$`), "");
  return (
    <details data-testid="held-queue-row" className="rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary">
      <summary>{label}{count > 0 && <span className="ml-2 text-accent">{HELD_QUEUE_OPEN}</span>}</summary>
      {error && <p role="alert">{error}</p>}
      {items.some(item => !item.botId && item.state === "recovery") && <select aria-label="Bot for continuation" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a bot</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>}
      {items.map(item => <div key={item.id} className="mt-2 whitespace-pre-wrap">
        <p>{item.text}</p>{item.error && <p>{item.error}</p>}
        {onRetry && item.state && item.state !== "ready" && <button type="button" disabled={pending || !(item.botId ?? selected)} className="mr-2 text-accent underline"
          onClick={async () => { setPending(true); setError(""); try { await onRetry(item.id, item.botId ?? selected); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } }}>
          {item.state === "recovery" ? "Authorize continuation" : "Retry continuation"}</button>}
        {item.rowId && <button type="button" className="text-accent underline" onClick={() => onJump(item.rowId!)}>Open original</button>}
      </div>)}
    </details>
  );
}

