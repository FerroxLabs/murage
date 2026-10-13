import { continuationResults, roomRequest, type RoomRequest } from "./room-requests.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "./store.ts";
import { projectRequestSourceMessages } from "./project-envelope.ts";
import type { DatabaseSync } from "node:sqlite";
import { copyFieldsChanged } from "./message-copy-fields.ts";
import { authorizeWork, executionStore, requestSourceThread, sameThreadPartition } from "./execution-audience.ts";

/** A citation and all copied ancestors must belong to the consuming turn. */
export function partitionSourcesAllowed(db: DatabaseSync, botId: string, threadId: string, messageIds: readonly string[]): boolean {
  const bot = executionStore()?.bot(botId);
  if (!bot || bot.partitionedAt === undefined) return true;
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return true;
    if (seen.size >= 500) return false;
    seen.add(id);
    const row = db.prepare("SELECT thread_id,json FROM messages WHERE id=?").get(id);
    if (!row || !sameThreadPartition(bot, threadId, String(row.thread_id))) return false;
    try {
      const copy = JSON.parse(String(row.json)).copyOf;
      return !copy || typeof copy.threadId === "string" && sameThreadPartition(bot, threadId, copy.threadId) && Array.isArray(copy.messageIds) && copy.messageIds.every((id: unknown) => typeof id === "string" && visit(id));
    } catch { return false; }
  };
  return messageIds.every(visit);
}

export function requestReturnsTo(db: DatabaseSync, requestId: string, threadId: string): boolean {
  return requestSourceThread(requestId, db) === threadId;
}

/** Every original a copy stands on, and every original those were copied from, is still stored and not withheld from bots. A copy whose original
 * was deleted is not shown to any bot, in any memory mode, partitioned or not. A chain past the limits is not established.
 * The verdict is kept until a stored message is deleted, or has its copy link or its withheld mark changed (a counter only those writes move,
 * and the database's own version for another connection's commits), so a turn reads only the copies it has not judged since the last such
 * change, never the whole history again. Inside a transaction nothing is kept: what it reads may roll back. */
export function copyChainPresent(db: DatabaseSync, copy: { threadId: string; messageIds: readonly string[] }): boolean {
  return copyChainCheck(db)(copy);
}

/** The same check for many copies in one operation: the memo's stamp is read once, when the check is made, not once per copy. */
export function copyChainCheck(db: DatabaseSync): (copy: { threadId: string; messageIds: readonly string[] }) => boolean {
  const memo = chainMemo(db);
  return copy => {
    const key = memo ? `${copy.threadId}\u0000${copy.messageIds.join("\u0000")}` : "";
    const known = memo?.verdicts.get(key);
    if (known !== undefined) return known;
    const verdict = readChain(db, copy);
    if (memo) {
      // full: the verdict judged longest ago goes, never the whole memo (which would make the next turn read every copy again)
      if (memo.verdicts.size >= CHAIN_MEMO_MAX) memo.verdicts.delete(memo.verdicts.keys().next().value as string);
      memo.verdicts.set(key, verdict);
    }
    return verdict;
  };
}

const CHAIN_MEMO_MAX = 50_000;
const CHAIN_EPOCH = `
CREATE TEMP TABLE IF NOT EXISTS copy_chain_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.copy_chain_epoch VALUES(1,0);
CREATE TEMP TRIGGER IF NOT EXISTS copy_chain_d AFTER DELETE ON main.messages BEGIN UPDATE copy_chain_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS copy_chain_u AFTER UPDATE ON main.messages WHEN ${copyFieldsChanged("OLD.json", "NEW.json")}
 BEGIN UPDATE copy_chain_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS copy_chain_r BEFORE INSERT ON main.messages WHEN EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND ${copyFieldsChanged("o.json", "NEW.json")})
 BEGIN UPDATE copy_chain_epoch SET n=n+1; END;
`;
const chainMemos = new WeakMap<DatabaseSync, { installed: boolean; stamp: string; verdicts: Map<string, boolean> }>();
function chainMemo(db: DatabaseSync): { verdicts: Map<string, boolean> } | undefined {
  let memo = chainMemos.get(db);
  if (!memo) {
    if (db.isTransaction) return undefined;
    try { db.exec(CHAIN_EPOCH); } catch { return undefined; }
    memo = { installed: true, stamp: "", verdicts: new Map() };
    chainMemos.set(db, memo);
  }
  if (db.isTransaction) return undefined;
  let stamp: string;
  try {
    const row = db.prepare("SELECT (SELECT n FROM temp.copy_chain_epoch) AS n, (SELECT data_version FROM pragma_data_version) AS version").get() as { n: number; version: number } | undefined;
    if (!row) return undefined;
    stamp = `${row.n}:${row.version}`;
  } catch { return undefined; }
  if (stamp !== memo.stamp) { memo.verdicts.clear(); memo.stamp = stamp; }
  return memo;
}

function readChain(db: DatabaseSync, copy: { threadId: string; messageIds: readonly string[] }): boolean {
  const seen = new Set<string>();
  let level: Array<{ threadId: string; messageIds: readonly string[] }> = [copy];
  for (let depth = 0; level.length; depth += 1) {
    if (depth > 8) return false;
    const next: Array<{ threadId: string; messageIds: readonly string[] }> = [];
    for (const group of level) for (const id of group.messageIds) {
      const key = `${group.threadId}\u0000${id}`;
      if (seen.has(key)) continue;
      if (seen.size >= 64) return false;
      seen.add(key);
      const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(group.threadId, id);
      if (!row) return false;
      try {
        const stored = JSON.parse(String(row.json));
        if (stored.withheldFromBots !== undefined && stored.withheldFromBots !== false) return false;
        const further = stored.copyOf;
        if (further) {
          if (typeof further.threadId !== "string" || !Array.isArray(further.messageIds) || !further.messageIds.every((m: unknown) => typeof m === "string")) return false;
          next.push({ threadId: further.threadId, messageIds: further.messageIds });
        }
      } catch { return false; }
    }
    level = next;
  }
  return true;
}

/** The rule every transcript row a bot reads passes, for one operation (the copy memo's stamp is read once, here). */
function transcriptRowCheck(db: DatabaseSync, botId: string, threadId: string): (message: Message) => boolean {
  const present = copyChainCheck(db);
  return message => {
    if (message.copyOf && !present(message.copyOf)) return false;
    if (message.copyOf && !partitionSourcesAllowed(db, botId, threadId, [message.id])) return false;
    return message.kind !== "activity" || !message.requestId || partitionSourcesAllowed(db, botId, threadId, projectRequestSourceMessages(db, message.requestId));
  };
}

export function partitionTranscriptMessages(db: DatabaseSync, botId: string, threadId: string, messages: readonly Message[]): Message[] {
  return messages.filter(transcriptRowCheck(db, botId, threadId));
}

/** The newest rows of a transcript a bot may read, judged from the newest back and only until `full` says the prompt has what it can carry:
 * a turn's work grows with its window, never with the conversation's history. `full` is told of each row kept, newest first. `older`: the
 * rows before the window, not judged (a prompt never shows them; it may count them). */
export function partitionTranscriptWindow(db: DatabaseSync, botId: string, threadId: string, messages: readonly Message[], full: (kept: Message) => boolean, examinedCap = TRANSCRIPT_EXAMINED_ROWS): { window: Message[]; olderRows: number; readonly older: Message[] } {
  const allowed = transcriptRowCheck(db, botId, threadId);
  const kept: Message[] = [];
  let index = messages.length - 1, examined = 0;
  // Every row looked at counts toward the cap, kept or refused: a history of rows the bot may not read is not walked to its start.
  for (; index >= 0 && examined < examinedCap; index -= 1) {
    const message = messages[index]!;
    examined += 1;
    if (!allowed(message)) continue;
    kept.push(message);
    if (full(message)) { index -= 1; break; }
  }
  const end = index + 1;
  // the rows before the window are not copied or walked unless a caller asks for them
  return { window: kept.reverse(), olderRows: end, get older() { return messages.slice(0, end); } };
}

/** The most rows one transcript window looks at, kept or refused. */
export const TRANSCRIPT_EXAMINED_ROWS = 1200;
/** The same for a room member's window (thirty lines, so a smaller cap). */
export const ROOM_TRANSCRIPT_EXAMINED_ROWS = 600;

/** The most rows a direct turn's transcript judges, whatever the engine's budget: ten times the replay's 40-line floor. A budget that can carry
 * more short lines than that raises the cap (`directTranscriptRows`), so the byte budget decides how far back a replay reaches, not the row count. */
export const DIRECT_TRANSCRIPT_WINDOW_ROWS = 400;
/** The shortest line the cap plans for: a replay of lines this short fills the budget at the cap. */
const DIRECT_TRANSCRIPT_MIN_LINE_BYTES = 128;
export function directTranscriptRows(maxBytes: number): number {
  return Math.max(DIRECT_TRANSCRIPT_WINDOW_ROWS, Math.ceil(maxBytes * 2 / DIRECT_TRANSCRIPT_MIN_LINE_BYTES));
}
/** Never more text than twice the most a replay carries (a withheld line is shorter than the reply it stands for, so the window keeps room for
 * older lines to move up), and never more rows than the budget can use. */
export function directTranscriptWindowFull(maxBytes: number, rows = directTranscriptRows(maxBytes)): (kept: Message) => boolean {
  let count = 0, bytes = 0;
  return kept => {
    count += 1;
    if (kept.kind === "text" && kept.text) bytes += Buffer.byteLength(kept.text);
    return count >= rows || bytes > maxBytes * 2;
  };
}

/** Recheck each result's requesting thread before exposing text or outcome notes. */
export function continuationResultsForThread(db: DatabaseSync, wake: RoomRequest, threadId: string) {
  return continuationResults(wake).filter(result => {
    if (!requestReturnsTo(db, result.requestId, threadId)) return false;
    const source = roomRequest(db, result.requestId);
    if (!source?.toBotId) return false;
    return authorizeWork({ edge: "deliver", requestId: source.id, fromBotId: source.toBotId, destinationThreadId: threadId }).ok;
  });
}
