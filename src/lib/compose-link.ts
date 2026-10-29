// 1.0.9 share and ask S41. What a compose link and the "Ask again" chip do: PREFILL the composer and focus it. The owner taps Send.
//
// Nothing here can send: the module holds no store and no send action, only a draft setter and a focus call. The words come from a message the
// page already holds (or a queued chip), never from the fragment. They leave the phone line's attachment tags behind, and nothing of the line's
// `via` or id travels into the draft, so the owner's next send is an ordinary owner turn.
import { FOCUS_COMPOSER_EVENT } from "@/lib/composer-focus";
import { withoutAttachmentTagLines } from "@/lib/composer-attachments";
import { readComposerDraft, setComposerDraftText } from "@/lib/drafts";
import type { DeepLinkTarget } from "@/lib/deep-link";

export interface ComposeIo {
  readDraft(draftId: string): string;
  setDraft(draftId: string, text: string): void;
  focus(botId?: string): void;
}

export const composeIo: ComposeIo = {
  readDraft: (draftId) => readComposerDraft(draftId).text,
  setDraft: (draftId, text) => void setComposerDraftText(draftId, text),
  // After the chat for that bot has rendered, as the tray's "New message" does.
  focus: (botId) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT, { detail: botId ? { botId } : {} }))));
  },
};

/** A user line that came through the phone (a share or an ask). */
export const isPhoneLine = (message: { via?: unknown }): boolean => message.via !== undefined && message.via !== null;

/** A phone line cannot be edited, regenerated or retried: the server refuses an edit of one (409), and Ask again is the owner's path. */
export const canEditLine = (message: { via?: unknown }): boolean => !isPhoneLine(message);

/** The words Ask again offers: the line's text without its attachment tag lines. */
export function askAgainText(text: string): string {
  return withoutAttachmentTagLines(text).trim();
}

interface HeldMessage { id: string; queueId?: string; role: string; kind: string; text?: string }
interface Owner { id: string; threadId: string; messages?: HeldMessage[]; tasks?: Array<{ threadId: string }> }
export interface ComposeState {
  bots: Owner[];
  groups: Owner[];
  pendingQueued?: Record<string, Array<{ queueId: string; text: string }>>;
}

/** Puts `text` in the draft: an empty draft takes it; words already typed stay, with it after a blank line; the same words twice change nothing. */
function prefill(draftId: string, text: string, io: ComposeIo): void {
  if (!text) return;
  const existing = io.readDraft(draftId);
  if (!existing.trim()) io.setDraft(draftId, text);
  else if (!existing.includes(text)) io.setDraft(draftId, `${existing.replace(/\s+$/, "")}\n\n${text}`);
}

/** Ask again on a phone line already on screen: this chat's draft gets its words, and the composer takes focus. */
export function askAgainFromLine(line: { text?: string }, chat: { botId: string; threadId: string }, io: ComposeIo = composeIo): void {
  prefill(`bot:${chat.botId}:${chat.threadId}`, askAgainText(line.text ?? ""), io);
  io.focus(chat.botId);
}

/** The owner's words behind an `again` id, from what the page holds: a user text message by id (or queue id), or a queued chip by queue id. */
function heldText(owner: Owner, state: ComposeState, threadId: string, again: string): string | undefined {
  const message = owner.messages?.find((m) => (m.id === again || m.queueId === again) && m.role === "user" && m.kind === "text");
  if (message?.text) return message.text;
  return state.pendingQueued?.[threadId]?.find((entry) => entry.queueId === again)?.text;
}

/** Applies a compose link after it opened its chat. False when no chat on this device owns the thread (nothing is touched then). */
export function applyComposeLink(target: DeepLinkTarget, state: ComposeState, io: ComposeIo = composeIo): boolean {
  if (!target.compose) return false;
  const botOwner = target.botId ? state.bots.find((bot) => bot.id === target.botId) : undefined;
  const threadId = target.threadId ?? botOwner?.threadId;
  if (!threadId) return false;
  const bot = botOwner ?? state.bots.find((b) => b.threadId === threadId || b.tasks?.some((task) => task.threadId === threadId));
  const group = bot ? undefined : state.groups.find((g) => g.threadId === threadId || g.tasks?.some((task) => task.threadId === threadId));
  const owner = bot ?? group;
  if (!owner) return false;
  const draftId = bot ? `bot:${bot.id}:${threadId}` : `group:${owner.id}:${threadId}`;
  if (target.again) {
    const text = heldText(owner, state, threadId, target.again);
    if (text) prefill(draftId, askAgainText(text), io);
  }
  io.focus(bot?.id);
  return true;
}
