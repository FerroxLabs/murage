// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words around a Delete: what else goes before it happens, and what could
// not be removed after it. Plain words, no paths to other conversations.

/** What the server reports it could not remove (server/conversation-deletion.ts). */
export interface DeletionLeftover { what: string; where: string }

export const BACKUPS_LINE = "Earlier backups still contain it until they expire.";

/** Lines a Delete confirmation adds under its own description. */
export function deletionConsequenceLines(savedFiles: number | null | undefined): string[] {
  const lines: string[] = [];
  if (savedFiles && savedFiles > 0) lines.push(`This also deletes ${savedFiles} saved ${savedFiles === 1 ? "file" : "files"}.`);
  lines.push(BACKUPS_LINE);
  return lines;
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
  return { title: "Deleted. A few things could not be removed:", items };
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
