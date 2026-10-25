// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The lines a voice call speaks from are judged by the same write-time lookup the typed door uses: a line the owner forgot, or one that
// still reads "checking", is left out of the snapshot (forget keeps the stored words, so the stored branch alone is not the answer).
import type { DatabaseSync } from "node:sqlite";
import { denyLookup } from "../memory/deny-read.ts";
import { lineAuthor } from "../message-db.ts";
import type { Message } from "../store.ts";

/** `rows` without the text lines the lookup does not show. Chips and rows with no text pass; a lookup that fails leaves every text line out. */
export function voiceRowsShown(db: DatabaseSync, threadId: string, rows: readonly Message[]): Message[] {
  const judged = rows.filter(row => row.kind === "text" && typeof row.text === "string" && row.text.trim());
  if (!judged.length) return [...rows];
  let verdicts: ReturnType<typeof denyLookup>;
  try { verdicts = denyLookup(db, { threadId, lines: judged.map(row => ({ messageId: row.id, author: lineAuthor(row) })) }, { audience: null }); }
  catch { return rows.filter(row => !judged.includes(row)); }
  return rows.filter(row => !judged.includes(row) || verdicts.get(row.id)?.state === "shown");
}
