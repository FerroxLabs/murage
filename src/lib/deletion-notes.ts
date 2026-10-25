// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words around a Delete: what else goes before it happens, and what could
// not be removed after it. Plain words, no paths to other conversations.

/** What the server reports it could not remove (server/conversation-deletion.ts). */
export interface DeletionLeftover { what: string; where: string }

export const BACKUPS_LINE = "Earlier backups still contain it until they expire.";
/** Said once, whatever engine a conversation used: what Murage removes from the coding engines' files, what it does when an engine is
 * using one, and what it does not reach. The same words are in the docs (Features, Chat and teams). */
export const ENGINE_FILES_LINE = "When you delete a conversation, Murage removes its words from the coding engines' files on this computer. If an engine is using one of those files, Murage leaves that file alone, tells you, and finishes later. Murage never changes another conversation's words. Copies in backups or in an engine's online account are not removed by Murage.";

const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Lines a Delete confirmation adds under its own description: the messages
 * and saved files that go, counted, then the backups line. */
export function deletionConsequenceLines(savedFiles: number | null | undefined, messages?: number | null, engines?: readonly string[]): string[] {
  const lines: string[] = [];
  const files = savedFiles && savedFiles > 0 ? counted(savedFiles, "saved file", "saved files") : "";
  if (messages && messages > 0) lines.push(`That is ${counted(messages, "message", "messages")}${files ? ` and ${files}` : ""}.`);
  else if (files) lines.push(`This also deletes ${files}.`);
  lines.push(BACKUPS_LINE);
  if (engines?.length) lines.push(ENGINE_FILES_LINE);
  return lines;
}

/** The title over the lines for engine copies still owed: short, and it says Murage does the rest by itself. */
export const OWED_TITLE = "Deleted. Murage finishes the rest by itself:";

/** The note for engine copies that are still owed (the server's fixed sentences, one line per engine). It keeps the ids of the lines
 * and the obligations they cover, so Dismiss names exactly what was shown (a newer deletion is never dismissed with it). "Try again
 * now" shows while any copy is still owed. */
export function owedNote(notices: unknown): { title: string; items: string[]; retry: boolean; owed: true; ids: string[]; covers: string[] } | null {
  const list = (Array.isArray(notices) ? (notices as Array<{ id?: unknown; text?: unknown; tryAgain?: unknown; covers?: unknown } | null>) : [])
    .filter((item): item is { id?: unknown; text: string; tryAgain?: unknown; covers?: unknown } => Boolean(item) && typeof item!.text === "string" && item!.text !== "");
  const items = list.map((item) => item.text);
  const pending = list.some((item) => item.tryAgain !== false);
  const ids = list.map((item) => (typeof item.id === "string" ? item.id : "")).filter(Boolean);
  const covers = [...new Set(list.flatMap((item) => (Array.isArray(item.covers) ? item.covers.filter((cover): cover is string => typeof cover === "string") : [])))];
  return items.length ? { title: pending ? OWED_TITLE : "Deleted.", items, retry: pending, owed: true, ids, covers } : null;
}

/** The one short line that answers "Try again now" (the server's `result`). An answer without one (an older server) still says it ran. */
export function retryResultLine(result: unknown): string {
  const answer = result as { line?: unknown; finished?: unknown; unchanged?: unknown } | null | undefined;
  if (answer && typeof answer.line === "string" && answer.line) return answer.line;
  if (answer && answer.unchanged === true) return "Nothing changed yet. Murage keeps trying by itself.";
  return "Tried again just now.";
}

/** The note shown after a Delete, or null when everything was removed. */
export function deletionNote(response: { leftovers?: unknown; failed?: unknown } | null | undefined): { title: string; items: string[] } | null {
  const leftovers = Array.isArray(response?.leftovers)
    ? (response!.leftovers as unknown[]).filter((item): item is DeletionLeftover =>
      Boolean(item) && typeof (item as DeletionLeftover).what === "string" && typeof (item as DeletionLeftover).where === "string")
    : [];
  const items = leftovers.map((item) => `${item.what}, in ${item.where}.`);
  if (Array.isArray(response?.failed) && response!.failed.length) items.push("A few files could not be removed yet. Murage tries again the next time it starts.");
  if (!items.length) return null;
  return { title: "Deleted. Murage will finish removing these when it can:", items };
}

/** The one sentence shown when a Delete of a conversation fails. The server's
 * own text never reaches the person: it was internal wording ("a bot keeps at
 * least one task"), so only the status decides what is said. */
export function deletionErrorSentence(error: unknown): string {
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : 0;
  if (status === 409) return "This conversation is still working. Stop it first, then delete it.";
  if (status === 404) return "That conversation is already gone.";
  return "That conversation could not be deleted. Try again in a moment.";
}

/** What a dismiss tells the window: a note the server does not keep goes at once; an owed note goes only through the server's answer. */
export type DismissAction = { type: "deletionNote"; note: null } | { type: "deletionOwed"; notices: unknown; rev?: unknown; answer: true };

/** The owner dismissed the banner. An owed note is never cleared here: the server marks the lines this note showed (`covers`) and answers
 * with what is owed now, which the window applies even under the revision its own broadcast already carried. A deletion that became
 * owed while the request ran is not one of the covers, so it stays on the banner. A failed request throws and the note stays. */
export async function dismissDeletionNote(
  shown: { owed?: boolean; covers?: string[] } | null | undefined,
  post: (covers: string[]) => Promise<{ notices?: unknown; rev?: unknown } | null | undefined>,
  dispatch: (action: DismissAction) => void,
): Promise<void> {
  if (!shown?.owed) { dispatch({ type: "deletionNote", note: null }); return; }
  const response = await post(shown.covers ?? []);
  dispatch({ type: "deletionOwed", notices: response?.notices, rev: response?.rev, answer: true });
}
