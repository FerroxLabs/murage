// Sends made mid-turn wait in the server's steer queue and stay off the
// transcript until drain (they must never become the active leaf). This is
// that queue made visible, in send order, each with its own Remove.
//
// It lives ON the composer rather than at the tail of the transcript: a
// queued line is something you typed and can still take back, not something
// the conversation has recorded. At the transcript tail it scrolled away
// from the control that cancels it.
//
// 1.0.15 COMPOSER-QUEUE-COMPACT: a queued line takes one line, not half the
// screen. Two or more waiting lines fold behind one count row; opened, each
// is one line with an ellipsis and its attachments as a small chip; a tap on
// a line shows all of it. The whole stack stays inside a
// quarter of the view with its own scroll, in the column's normal flow, so it
// never lays over the transcript or the approval panel. A refused line never
// folds: it is waiting for the person, not for a turn.
import { useEffect, useState } from "react";
import { Clock, FileText, Image as ImageIcon, ChevronDown, ChevronUp, TriangleAlert, X } from "lucide-react";
import {
  attachmentBasename,
  attachmentImageUrl,
  splitTranscriptAttachments,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { sendNoticeText } from "@/lib/send-notice";
import type { SendNoticeCode } from "../../shared/send-notice";
import { AttachedFileChips, AttachedImageGallery } from "./AttachmentPreview";
import { DesktopImg } from "./DesktopImg";

export interface QueuedComposerItem {
  queueId: string;
  text: string;
  sending?: boolean;
  /** The bot or room could not start this message: the words wait for "Send again" or "Dismiss". */
  refused?: { notice: SendNoticeCode };
}

/** Waiting for the next turn: what the count row counts and Inject now names. */
export const isWaitingQueued = (item: QueuedComposerItem): boolean => !item.sending && !item.refused;

export function QueuedComposerMessages({
  items,
  onCancel,
  onResend,
  phone = false,
  initialExpanded = false,
  initialOpenId = null,
}: {
  items: QueuedComposerItem[];
  onCancel: (queueId: string) => void;
  onResend?: (item: QueuedComposerItem) => void;
  /** The phone layout: the shorter count wording. */
  phone?: boolean;
  /** Where the fold starts (closed unless a caller restores it). */
  initialExpanded?: boolean;
  /** A line that starts opened in full. */
  initialOpenId?: string | null;
}) {
  if (!items.length) return null;
  const refused = items.filter((item) => item.refused);
  const sending = items.filter((item) => item.sending && !item.refused);
  const waiting = items.filter(isWaitingQueued);
  return (
    <div
      className="mb-2 flex max-h-[25dvh] w-full flex-col gap-1.5 overflow-y-auto overscroll-contain px-1"
      aria-label="Queued messages"
      data-queued-stack
    >
      {/* drawn inline, not as a child component: Send again stays reachable from this tree */}
      {refused.map((item) => refusedQueuedRow(item, onCancel, onResend))}
      {sending.map((item) => <QueuedComposerRow key={item.queueId} item={item} />)}
      {waiting.length > 0 && <WaitingQueued items={waiting} onCancel={onCancel} phone={phone} initialExpanded={initialExpanded} initialOpenId={initialOpenId} />}
    </div>
  );
}

/** Not sent: in full, with the reason, Send again and Dismiss, as before. */
function refusedQueuedRow(
  item: QueuedComposerItem,
  onCancel: (queueId: string) => void,
  onResend?: (item: QueuedComposerItem) => void,
) {
  // item.text is the composed prompt (attachment tags, pasted-text
  // wrappers). Show it the way the transcript bubble does: words as
  // words, images and files as chips, never a composed tag or its path.
  // The stored text itself is untouched; Send again and Inject use it.
  const { display, images, files } = splitTranscriptAttachments(item.text, { hidePasteWrappers: true });
  return (
    <div key={item.queueId} className="flex max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] flex-col items-end self-end">
      {images.length > 0 && <AttachedImageGallery paths={images} className="mb-1" />}
      {files.length > 0 && <AttachedFileChips files={files} className="mb-1" />}
      {display && (
        <div className="rounded-2xl rounded-br-md border border-dashed border-hairline/70 bg-panel/80 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-secondary shadow-sm">
          {display}
        </div>
      )}
      {item.refused && (
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
      )}
    </div>
  );
}

/** One waiting line, or two or more behind a count row that starts closed. */
function WaitingQueued({ items, onCancel, phone, initialExpanded, initialOpenId }: {
  items: QueuedComposerItem[];
  onCancel: (queueId: string) => void;
  phone: boolean;
  initialExpanded: boolean;
  initialOpenId: string | null;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const count = items.length;
  // The fold starts closed again once the queue has drained.
  useEffect(() => { if (count < 2) setExpanded(false); }, [count]);
  const rows = items.map((item) => (
    <QueuedComposerRow
      key={item.queueId}
      item={item}
      open={openId === item.queueId}
      onToggle={() => setOpenId((prev) => (prev === item.queueId ? null : item.queueId))}
      onCancel={onCancel}
      label={count === 1 && !phone}
    />
  ));
  if (count === 1) return <div className="rounded-xl border border-hairline/60 bg-panel/80">{rows}</div>;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <div className="rounded-xl border border-hairline/60 bg-panel/80" data-queued-group>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex min-h-8 w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] text-ink-secondary hover:text-ink"
      >
        <Clock size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(phone ? "composer.queue.countShort" : "composer.queue.count", { count })}
        </span>
        <span className="sr-only">{expanded ? t("composer.queue.hide") : t("composer.queue.show")}</span>
        <Chevron size={13} aria-hidden="true" className="shrink-0" />
      </button>
      {/* Folded rows are not rendered: the count row is the summary a screen reader hears. */}
      {expanded && (
        <>
          {rows}
          <div className="border-t border-hairline/40 px-3 py-1.5 text-[11px] text-ink-secondary/75">{t(phone ? "composer.queue.hintPhone" : "composer.queue.hint")}</div>
        </>
      )}
    </div>
  );
}

/** A small stand-in for what a line carries: the first image's thumbnail, else an icon. */
function AttachmentChip({ images, files }: { images: string[]; files: Array<{ name: string }> }) {
  if (!images.length && !files.length) return null;
  const src = images.length ? attachmentImageUrl(images[0]!) : null;
  const more = images.length + files.length - 1;
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-inset text-ink-secondary" aria-hidden="true">
      {src ? <DesktopImg src={src} alt="" className="size-full object-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : images.length ? <ImageIcon size={14} /> : <FileText size={14} />}
      {more > 0 && <span className="absolute bottom-0 right-0 rounded-tl bg-panel/90 px-0.5 text-[9px] leading-tight text-ink">+{more}</span>}
    </span>
  );
}

/** One queued line: one line with an ellipsis, or opened in full. */
export function QueuedComposerRow({ item, open = false, onToggle, onCancel, label = false }: {
  item: QueuedComposerItem;
  open?: boolean;
  onToggle?: () => void;
  onCancel?: (queueId: string) => void;
  /** A single waiting line on a wide screen says what it is in words. */
  label?: boolean;
}) {
  const { display, images, files } = splitTranscriptAttachments(item.text, { hidePasteWrappers: true });
  // A line that is only an attachment reads as the attachment's name.
  const summary = display || [...images.map(attachmentBasename), ...files.map((file) => file.name)].join(", ");
  const waiting = isWaitingQueued(item);
  // The chip is decorative; a screen reader hears how many things are attached.
  const attachedCount = images.length + files.length;
  return (
    <div className="flex flex-col border-t border-hairline/40 first:border-t-0" data-queued-row>
      <div className="flex min-h-9 items-center gap-2 py-1 pl-3 pr-1">
        {!open && <AttachmentChip images={images} files={files} />}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            title={open ? t("composer.queue.less") : t("composer.queue.full")}
            className={cn(
              "min-w-0 flex-1 text-left text-[14px] text-ink-secondary hover:text-ink",
              open ? "whitespace-pre-wrap break-words py-1 leading-relaxed" : "truncate",
            )}
          >
            <span className="sr-only">{open ? t("composer.queue.less") : t("composer.queue.full")}: </span>
            {summary}
            {attachedCount > 0 && display && <span className="sr-only"> ({t("composer.queue.attached", { count: attachedCount })})</span>}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink-secondary">
            {summary}
            {attachedCount > 0 && display && <span className="sr-only"> ({t("composer.queue.attached", { count: attachedCount })})</span>}
          </span>
        )}
        {item.sending ? (
          <span role="status" className="flex shrink-0 items-center gap-1 px-2 text-[11px] text-ink-secondary/75">
            <Clock size={11} aria-hidden="true" />
            {t("composer.queue.sending")}
          </span>
        ) : (
          <>
            {label && <span className="hidden shrink-0 text-[11px] text-ink-secondary/75 sm:inline">{t("composer.queue.one")}</span>}
            {!label && <span className="sr-only">{t("composer.queue.one")}</span>}
            {waiting && onCancel && (
              <button
                type="button"
                onClick={() => onCancel(item.queueId)}
                aria-label={t("composer.queue.removeLabel")}
                title={t("composer.queue.removeLabel")}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={13} strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col items-end gap-1 px-3 pb-2">
          {images.length > 0 && <AttachedImageGallery paths={images} className="mb-0" />}
          {files.length > 0 && <AttachedFileChips files={files} className="mb-0" />}
        </div>
      )}
    </div>
  );
}
