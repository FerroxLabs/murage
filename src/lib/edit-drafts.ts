// SPDX-License-Identifier: AGPL-3.0-or-later
/** The words of message edits the server has not acknowledged yet, one per message. ONE edit per message is in flight at a time: while it is
 *  saving that message's editor cannot submit again, so two submissions never race for the same draft. Each submission carries its own sendId;
 *  an answer for a sendId that is no longer the message's draft (superseded, cancelled) is ignored. A different message's edit keeps its own
 *  draft. Drafts live in `editDraftStore`, per bot, outside any view: switching bots never clears them, so a bot's edit that failed while the
 *  person was elsewhere is waiting in its editor, with its error, when they come back. */
export type EditDraft = { text: string; sendId: string; saving: boolean; error?: string };
export type EditDrafts = Readonly<Record<string, EditDraft>>;

/** A new submission: null while the message already has an edit saving (it is blocked until that one settles). Words unchanged since the
 *  last submission (a resubmit after a failure, a timeout or Cancel) keep that submission's sendId, so the server answers a repeat of an edit it
 *  already forked with that fork; changed words take `freshSendId` (the server refuses one sendId for two different texts). */
export function beginEdit(drafts: EditDrafts, messageId: string, text: string, freshSendId: string): EditDrafts | null {
  const draft = drafts[messageId];
  if (draft?.saving) return null;
  const sendId = draft && draft.text === text ? draft.sendId : freshSendId;
  return { ...drafts, [messageId]: { text, sendId, saving: true } };
}

/** The person typed in an open editor: their words are kept in the store, not only in the textarea, so leaving the conversation (or the view)
 *  and coming back reopens the editor with what they had typed. Nothing is sent. A draft that is saving is left alone (its words are the
 *  submission in flight). Changed words take `freshSendId`: the server refuses one sendId for two different texts, and these words have not
 *  been sent under the old one. */
export function typeEdit(drafts: EditDrafts, messageId: string, text: string, freshSendId: string): EditDrafts {
  const draft = drafts[messageId];
  if (draft?.saving || draft?.text === text) return drafts;
  return { ...drafts, [messageId]: { text, sendId: freshSendId, saving: false } };
}

/** An edit whose words are the message's own words changes nothing: it is closed like Cancel instead of forking the conversation and
 *  rerunning the bot on the same text. */
export function editChangesNothing(sourceText: string | undefined, text: string): boolean {
  return sourceText !== undefined && sourceText.trim() === text.trim();
}

function without(drafts: EditDrafts, messageId: string): EditDrafts {
  const rest: Record<string, EditDraft> = { ...drafts };
  delete rest[messageId];
  return rest;
}

const owns = (drafts: EditDrafts, messageId: string, sendId: string) => drafts[messageId]?.sendId === sendId;

/** The server acknowledged the edit: its draft is done. */
export function editSent(drafts: EditDrafts, messageId: string, sendId: string): EditDrafts {
  if (!owns(drafts, messageId, sendId)) return drafts;
  return without(drafts, messageId);
}

/** The edit failed or ran out of time: THAT submission's words and sendId stay, editable again, with the reason to show. */
export function editFailed(drafts: EditDrafts, messageId: string, sendId: string, error?: string): EditDrafts {
  if (!owns(drafts, messageId, sendId)) return drafts;
  const { text } = drafts[messageId]!;
  return { ...drafts, [messageId]: error === undefined ? { text, sendId, saving: false } : { text, sendId, saving: false, error } };
}

/** Cancel while the edit is saving: the editor stops waiting and is editable again, keeping the words and the sendId (a resubmit of the
 *  same words is the same edit to the server). */
export function stopSaving(drafts: EditDrafts, messageId: string): EditDrafts {
  const draft = drafts[messageId];
  if (!draft?.saving) return drafts;
  return { ...drafts, [messageId]: { text: draft.text, sendId: draft.sendId, saving: false } };
}

/** The person closed the editor: a draft that is not saving is dropped; one still saving stays until its answer. */
export function discardEdit(drafts: EditDrafts, messageId: string): EditDrafts {
  const draft = drafts[messageId];
  if (!draft || draft.saving) return drafts;
  return without(drafts, messageId);
}

const NO_DRAFTS: EditDrafts = Object.freeze({});

/** Edit drafts per bot, kept for the life of the window (not of a view). `get` returns the same object until that bot's drafts change, so
 *  it is a stable snapshot for useSyncExternalStore. */
export function createEditDraftStore() {
  let byBot: Readonly<Record<string, EditDrafts>> = {};
  const listeners = new Set<() => void>();
  return {
    get(botId: string): EditDrafts { return byBot[botId] ?? NO_DRAFTS; },
    update(botId: string, next: (drafts: EditDrafts) => EditDrafts): void {
      const before = byBot[botId] ?? NO_DRAFTS;
      const after = next(before);
      if (after === before) return;
      byBot = { ...byBot, [botId]: after };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const editDraftStore = createEditDraftStore();
