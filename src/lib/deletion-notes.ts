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
/** The title when every copy still owed waits for Murage's next update (its helper cannot load on this system): no promise of a finish. */
export const OWED_UPDATE_TITLE = "Deleted. Murage tries the rest again after its next update:";

/** One line of the owed note as the server sent it: what it covers, which engine it is, and whether it is a copy still owed.
 * `waitsForUpdate`: the helper cannot load on this system, so the copy is tried again only after Murage's next update. */
export interface OwedLine { text: string; tryAgain: boolean; covers: string[]; label?: string; waitsForUpdate?: true }
export interface OwedNote { title: string; items: string[]; retry: false; owed: true; ids: string[]; covers: string[]; lines: OwedLine[] }

/** The engine copies still owed after a Delete (the server's fixed sentences, one line per engine), kept with the ids of the lines and
 * the obligations they cover. 1.0.7 (Sean, 10-26): this is never a banner over a chat and never offers "Try again now": Murage retries
 * by itself, and the owner sees it only as one quiet line in Settings > Engines (owedSettingsLines). */
export function owedNote(notices: unknown): OwedNote | null {
  const list = (Array.isArray(notices) ? (notices as Array<{ id?: unknown; text?: unknown; tryAgain?: unknown; covers?: unknown; label?: unknown; waitsForUpdate?: unknown } | null>) : [])
    .filter((item): item is { id?: unknown; text: string; tryAgain?: unknown; covers?: unknown; label?: unknown; waitsForUpdate?: unknown } => Boolean(item) && typeof item!.text === "string" && item!.text !== "");
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const lines: OwedLine[] = list.map((item) => ({ text: item.text, tryAgain: item.tryAgain !== false, covers: strings(item.covers), ...(typeof item.label === "string" && item.label ? { label: item.label } : {}), ...(item.waitsForUpdate === true ? { waitsForUpdate: true as const } : {}) }));
  if (!lines.length) return null;
  const ids = list.map((item) => (typeof item.id === "string" ? item.id : "")).filter(Boolean);
  const owedLines = lines.filter((line) => line.tryAgain);
  const title = !owedLines.length ? "Deleted." : owedLines.every((line) => line.waitsForUpdate) ? OWED_UPDATE_TITLE : OWED_TITLE;
  return { title, items: lines.map((line) => line.text), retry: false, owed: true, ids, covers: [...new Set(lines.flatMap((line) => line.covers))], lines };
}

/** What a chat or room shows of the deletion note: a note a Delete just made, where the owner is. Never the owed list. */
export function chatDeletionNote<T extends { title: string; items: string[]; owed?: boolean }>(note: T | null | undefined): T | null {
  return note && !note.owed ? note : null;
}

const listOf = (names: readonly string[]): string => names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The quiet lines Settings > Engines shows while engine copies are still owed: one sentence for every copy still being removed (how
 * many deleted conversations, from which engines), then the server's own line for each engine whose copy waits for Murage's next update
 * (its helper cannot load on this system: "does this by itself" would not be true), then any line that says a copy is gone (a synced
 * folder's note). Empty when nothing is owed. */
export function owedSettingsLines(note: { owed?: boolean; lines?: OwedLine[] } | null | undefined): string[] {
  if (!note?.owed || !note.lines?.length) return [];
  const pending = note.lines.filter((line) => line.tryAgain && !line.waitsForUpdate);
  const out: string[] = [];
  if (pending.length) {
    const deletions = new Set(pending.flatMap((line) => line.covers.map((cover) => cover.slice(0, cover.lastIndexOf(":")))).filter(Boolean));
    const labels = [...new Set(pending.map((line) => line.label).filter((label): label is string => Boolean(label)))];
    const n = deletions.size;
    const what = n > 1 ? `${n.toLocaleString("en-US")} deleted conversations` : "a deleted conversation";
    out.push(labels.length
      ? `Murage is still removing ${what} from ${listOf(labels)}. It does this by itself, and nothing is needed from you.`
      : pending[0]!.text);
  }
  for (const line of note.lines) if (line.tryAgain && line.waitsForUpdate) out.push(line.text);
  for (const line of note.lines) if (!line.tryAgain) out.push(line.text);
  return out;
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
  // Files not removed yet (an engine the owner has open, a file in use) are not a line here: Murage finishes them by itself, and an
  // engine copy still owed is the quiet line in Settings > Engines (1.0.7, Sean 10-26: never a banner over the chat for it).
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
