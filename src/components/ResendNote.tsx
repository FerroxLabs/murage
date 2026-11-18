// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { t } from "@/lib/i18n";
import { resendNoteLabel } from "@/lib/tool-budget-copy";
import { roomRetryTarget } from "@/lib/room-member-retry";
import type { Action, Message } from "@/state/store";

/** D7: the server\x27s one line under a blocked rebuild (memory/dispatch.ts RESEND_OFFER_LINE): the message may already have started, so Murage
 * did not send it twice, and Send again sends it now. A notice, not a tool run: shown with Tool calls off. */
export function isResendNote(message: Pick<Message, "kind" | "memoryNote" | "tool">): boolean {
  return message.kind === "activity" && message.memoryNote === "resend" && Boolean(message.tool?.name);
}

/** The message a resend row is for: exactly the one the server recorded on the row (resendOf), in this conversation (and, in a chat or for a room
 * member, for this bot). Never "the nearest user row": a message sent while the refused turn ran sits above the row. Undefined when the row
 * names nothing, the message is not here, or it carries pictures (a resend carries words only, so the owner resends those from the composer). */
export function resendSource(messages: readonly Pick<Message, "id" | "role" | "text" | "attachments">[], note: Pick<Message, "resendOf">, scope: { threadId: string | undefined; botId?: string }): Pick<Message, "id" | "role" | "text" | "attachments"> | undefined {
  const of = note.resendOf;
  if (!of || !scope.threadId || of.threadId !== scope.threadId) return undefined;
  if (scope.botId !== undefined && of.botId !== scope.botId) return undefined;
  const source = messages.find((message) => message.id === of.messageId && message.role === "user");
  if (!source || !source.text?.trim() || (source.attachments?.length ?? 0) > 0) return undefined;
  return source;
}

/** The words the person sent for the refused turn, or undefined when there is nothing safe to send. */
export function resendWords(messages: readonly Pick<Message, "id" | "role" | "text" | "attachments">[], note: Pick<Message, "resendOf">, scope: { threadId: string | undefined; botId?: string }): string | undefined {
  return resendSource(messages, note, scope)?.text;
}

/** What Send again dispatches: the same words, a NEW send id (the refused attempt's id is spent), to the same conversation. */
export function resendAction(messages: readonly Pick<Message, "id" | "role" | "text" | "attachments">[], note: Pick<Message, "resendOf">, botId: string, threadId: string, mintSendId: () => string): Action | undefined {
  const text = resendWords(messages, note, { threadId, botId });
  return text === undefined ? undefined : { type: "send", botId, text, sendId: mintSendId(), threadId };
}

/** The room's Send again (D7): undefined when there is nothing to offer (no words to send, the member left, or the room is busy); otherwise a
 * function that builds the sendGroup action on each click: the same words to the same member, under a NEW send id each time. */
export function roomResendSender(transcript: readonly Message[], note: Message, opts: { memberIds: readonly string[]; roomBusy: boolean; groupId: string; threadId: string | undefined }, mintSendId: () => string): (() => Action) | undefined {
  const target = roomRetryTarget(transcript, note, { memberIds: opts.memberIds, roomBusy: opts.roomBusy });
  if (!target) return undefined;
  const words = resendWords(transcript, note, { threadId: opts.threadId, botId: target.responderId });
  if (words === undefined) return undefined;
  return () => ({ type: "sendGroup", groupId: opts.groupId, text: words, sendId: mintSendId(), threadId: opts.threadId, mode: "chat", responderId: target.responderId }) as Action;
}

/** L1: claims Send again once on the server BEFORE dispatching. Fail-conservative (L2): when the claim is refused or its answer is lost, nothing is
 * dispatched; the person can resend from the composer. */
export type ResendClaim = () => Promise<boolean>;

export function ResendNoteRow({ text, onSendAgain, claim, used }: { text: string; onSendAgain?: () => void; claim?: ResendClaim; used?: boolean }) {
  const [sent, setSent] = useState(false);
  const press = () => {
    setSent(true);
    if (!claim) { onSendAgain?.(); return; }
    void claim().then((claimed) => { if (claimed) onSendAgain?.(); }, () => { /* lost answer: nothing sent; the row stays spent */ });
  };
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="resend-note" className="flex max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink-secondary">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{resendNoteLabel(text, Boolean(onSendAgain))}</span>
        {onSendAgain && (
          <button type="button" data-testid="resend-note-send-again" disabled={sent || Boolean(used)}
            onClick={press}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-50">
            <RotateCcw size={12} aria-hidden="true" />{t("sendNotice.sendAgain")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The chat's Send again, as the chat draws it: the row, and on a click ONE dispatch of the original words under a fresh send id. */
export function ChatResendNote({ messages, note, botId, threadId, mintSendId, dispatch, claim }: { messages: readonly Message[]; note: Message; botId: string; threadId: string; mintSendId: () => string; dispatch: (action: Action) => void; claim?: ResendClaim }) {
  const hasWords = resendWords(messages, note, { threadId, botId }) !== undefined;
  return <ResendNoteRow text={note.tool?.name ?? ""} onSendAgain={hasWords ? () => { const again = resendAction(messages, note, botId, threadId, mintSendId); if (again) dispatch(again); } : undefined} claim={claim} used={note.resendUsed} />;
}

/** The room's Send again, as the room draws it: the row, and on a click ONE dispatch of the original words to the same member under a fresh send id. */
export function RoomResendNote({ transcript, note, memberIds, roomBusy, groupId, threadId, mintSendId, dispatch, claim }: { transcript: readonly Message[]; note: Message; memberIds: readonly string[]; roomBusy: boolean; groupId: string; threadId: string | undefined; mintSendId: () => string; dispatch: (action: Action) => void; claim?: ResendClaim }) {
  const send = roomResendSender(transcript, note, { memberIds, roomBusy, groupId, threadId }, mintSendId);
  return <ResendNoteRow text={note.tool?.name ?? ""} onSendAgain={send ? () => dispatch(send()) : undefined} claim={claim} used={note.resendUsed} />;
}
