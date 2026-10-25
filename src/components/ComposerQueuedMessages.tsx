// Sends made mid-turn wait in the server's steer queue and stay off the
// transcript until drain (they must never become the active leaf). This is
// that queue made visible, in send order, each with its own cancel.
//
// It lives ON the composer rather than at the tail of the transcript: a
// queued line is something you typed and can still take back, not something
// the conversation has recorded. At the transcript tail it scrolled away
// from the control that cancels it.
import { Clock, TriangleAlert, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { sendNoticeText } from "@/lib/send-notice";
import type { SendNoticeCode } from "../../shared/send-notice";

export interface QueuedComposerItem {
  queueId: string;
  text: string;
  sending?: boolean;
  /** The bot or room could not start this message: the words wait for "Send again" or "Dismiss". */
  refused?: { notice: SendNoticeCode };
}

export function QueuedComposerMessages({
  items,
  onCancel,
  onResend,
}: {
  items: QueuedComposerItem[];
  onCancel: (queueId: string) => void;
  onResend?: (item: QueuedComposerItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-col items-end gap-1.5 px-1" aria-label="Queued messages">
      {items.map((item) => (
        <div key={item.queueId} className="flex max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] flex-col items-end">
          <div className="rounded-2xl rounded-br-md border border-dashed border-hairline/70 bg-panel/80 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-secondary shadow-sm">
            {item.text}
          </div>
          {item.refused ? (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-ink-secondary/75" data-testid="refused-send">
              <TriangleAlert size={11} aria-hidden="true" />
              <span role="status" title={sendNoticeText(item.refused.notice)}>{t("sendNotice.refusedLabel")}</span>
              <span className="max-w-[28rem]">{sendNoticeText(item.refused.notice)}</span>
              {onResend && (
                <button type="button" onClick={() => onResend(item)} className="rounded px-1.5 py-0.5 text-accent-text hover:bg-raised">
                  {t("sendNotice.sendAgain")}
                </button>
              )}
              <button type="button" onClick={() => onCancel(item.queueId)} className="rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink">
                {t("sendNotice.dismiss")}
              </button>
            </div>
          ) : (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-secondary/75">
            <Clock size={11} aria-hidden="true" />
            {item.sending ? (
              <span role="status">Sending</span>
            ) : (
              <>
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
              </>
            )}
          </div>
          )}
        </div>
      ))}
    </div>
  );
}
