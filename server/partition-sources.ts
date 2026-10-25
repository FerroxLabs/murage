import { continuationResults, roomRequest, type RoomRequest } from "./room-requests.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "./store.ts";
import { projectRequestSourceMessages } from "./project-envelope.ts";
import type { DatabaseSync } from "node:sqlite";
import { copyFieldsChanged } from "./message-copy-fields.ts";
import { authorizeWork, executionStore, requestSourceThread, sameThreadPartition } from "./execution-audience.ts";

/** The most sources one partition check follows (citations and copied ancestors together); past it nothing is established. */
export const PARTITION_SOURCES_MAX = 500;
/** The most primary-key seeks one partition check spends finding bare citations in the threads it knows of. */
export const PARTITION_SEEKS_MAX = 8_192;
type SourceRow = { thread_id: string; id: string; json: string };
// every read is by the messages primary key (thread_id, id), a whole batch per statement: bare ids in the threads named, then each copy level
const SEEK_IN_THREADS = "SELECT m.thread_id AS thread_id, m.id AS id, m.json AS json FROM json_each(?) t CROSS JOIN json_each(?) i CROSS JOIN messages m ON m.thread_id = t.value AND m.id = i.value";
const SEEK_PAIRS = "SELECT m.thread_id AS thread_id, m.id AS id, m.json AS json FROM json_each(?) k CROSS JOIN messages m ON m.thread_id = json_extract(k.value, '$[0]') AND m.id = json_extract(k.value, '$[1]')";
// a bare id found in none of the threads the check knows of (a card or request source in another of the bot's threads): one statement for all
// of them. Without an index leading on id this reads the table; LINEAGE-COMBINED.md asks the schema lane for messages(id).
const SEEK_ANYWHERE = "SELECT m.thread_id AS thread_id, m.id AS id, m.json AS json FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))";

/** A citation and all copied ancestors must belong to the consuming turn. Bare ids are sought by primary key in the consuming thread and in
 * `within.threads` (the threads the caller knows the sources lie in); with `within.only`, an id in none of them is not established. Copied ancestors
 * name their thread, so each is one primary-key seek, a whole chain level per statement. The work is bounded by PARTITION_SOURCES_MAX sources
 * and PARTITION_SEEKS_MAX seeks, whatever the history; past either bound the answer is no. */
export function partitionSourcesAllowed(db: DatabaseSync, botId: string, threadId: string, messageIds: readonly string[], within?: { readonly threads: Iterable<string>; readonly only?: boolean }): boolean {
  return partitionSourcesVerdict(db, botId, threadId, messageIds, within) === "shown";
}
/** The same check in three states (REPLY-WITHHELD-CONTRACT R1): "withheld" for a source outside the partition or one that is not stored (a copy's
 * originals, a hand-off's "Messaged" row and the conversation it was handed over from count as sources, all the way up), "checking" for a
 * check past its bounds or one that threw (nothing is established either way, and nothing is withdrawn for it). */
export function partitionSourcesVerdict(db: DatabaseSync, botId: string, threadId: string, messageIds: readonly string[], within?: { readonly threads: Iterable<string>; readonly only?: boolean }): "shown" | "withheld" | "checking" {
  const bot = executionStore()?.bot(botId);
  if (!bot || bot.partitionedAt === undefined) return "shown";
  const bare = [...new Set(messageIds)];
  if (!bare.length) return "shown";
  if (bare.length > PARTITION_SOURCES_MAX) return "checking";
  const threads = [...new Set([threadId, ...(within?.threads ?? [])])];
  if (bare.length * threads.length > PARTITION_SEEKS_MAX) return "checking";
  try {
    let rows = db.prepare(SEEK_IN_THREADS).all(JSON.stringify(threads), JSON.stringify(bare)) as SourceRow[];
    const located = new Set(rows.map(row => String(row.id)));
    const missing = bare.filter(id => !located.has(id));
    if (missing.length) {
      if (within?.only) return "withheld";
      const elsewhere = db.prepare(SEEK_ANYWHERE).all(JSON.stringify(missing)) as SourceRow[];
      for (const row of elsewhere) located.add(String(row.id));
      if (missing.some(id => !located.has(id))) return "withheld";
      rows = [...rows, ...elsewhere];
    }
    const seen = new Set<string>();
    while (rows.length) {
      const next: Array<[string, string]> = [];
      for (const row of rows) {
        const key = `${row.thread_id}\u0000${row.id}`;
        if (seen.has(key)) continue;
        if (seen.size >= PARTITION_SOURCES_MAX) return "checking";
        seen.add(key);
        if (!sameThreadPartition(bot, threadId, String(row.thread_id))) return "withheld";
        // every link a row carries is judged (copyOf, handoffOf, handoffFrom): each must resolve to a source in this partition, or the row is
        // withheld. A link that is present but malformed, or names a source that is not stored, does not resolve.
        const stored = JSON.parse(String(row.json)) as Record<string, unknown>;
        if (!stored || typeof stored !== "object") return "withheld";
        const copy = stored.copyOf as { threadId?: unknown; messageIds?: unknown } | null | undefined;
        if (copy !== undefined && copy !== null) {
          if (typeof copy !== "object" || typeof copy.threadId !== "string" || !sameThreadPartition(bot, threadId, copy.threadId) || !Array.isArray(copy.messageIds)) return "withheld";
          for (const id of copy.messageIds as unknown[]) {
            if (typeof id !== "string") return "withheld";
            if (!seen.has(`${copy.threadId}\u0000${id}`)) next.push([copy.threadId, id]);
          }
        }
        // a hand-off by its "Messaged" row is a one-source link, judged like a copy: stored, in this partition, and walked further
        const handoff = stored.handoffOf as { threadId?: unknown; messageId?: unknown } | null | undefined;
        if (handoff !== undefined && handoff !== null) {
          if (typeof handoff !== "object" || typeof handoff.threadId !== "string" || typeof handoff.messageId !== "string"
            || !sameThreadPartition(bot, threadId, handoff.threadId)) return "withheld";
          if (!seen.has(`${handoff.threadId}\u0000${handoff.messageId}`)) next.push([handoff.threadId, handoff.messageId]);
        }
        // a hand-off saved with only the conversation that handed it over (a legacy or sourceMessageId-less hand-off, handoff-dispatch.ts) rests on
        // that whole conversation: it is shown only when that conversation is in this partition. Any value under the key that is not a
        // conversation id is withheld, a key with null included.
        if (Object.hasOwn(stored, "handoffFrom")) {
          const from = stored.handoffFrom;
          if (typeof from !== "string" || !from || !sameThreadPartition(bot, threadId, from)) return "withheld";
        }
      }
      if (!next.length) break;
      if (seen.size + next.length > PARTITION_SOURCES_MAX) return "checking";
      const level = db.prepare(SEEK_PAIRS).all(JSON.stringify(next)) as SourceRow[];
      const got = new Set(level.map(row => `${row.thread_id}\u0000${row.id}`));
      if (next.some(([thread, id]) => !got.has(`${thread}\u0000${id}`))) return "withheld";
      rows = level;
    }
    return "shown";
  } catch { return "checking"; }
}

export function requestReturnsTo(db: DatabaseSync, requestId: string, threadId: string): boolean {
  return requestSourceThread(requestId, db) === threadId;
}

/** Every original a copy stands on, and every original those were copied from, is still stored and parses; a chain past the limits is not
 * established. This is the copy chain's only judge (LINEAGE-DESIGN-S6 15a): the reader door (bot-read.ts) judges each source by its lineage
 * verdicts (denyLookup), so the owner's note, a mirror of committed verdicts, is never the judge.
 * The verdict is kept until a stored message is deleted, or has its copy link or its withheld mark changed (a counter only those writes move,
 * and the database's own version for another connection's commits), so a turn reads only the copies it has not judged since the last such
 * change, never the whole history again. Inside a transaction nothing is kept: what it reads may roll back.
 * The same check for many copies in one operation: the memo's stamp is read once, when the check is made, not once per copy. */
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

/** A row that carries a link (copyOf, handoffOf or handoffFrom) is shown to a bot reading `threadId` only when the whole chain resolves inside
 * its partition (partitionSourcesVerdict "shown"); a row with no link is not judged here. Not for the bot's own conversation's replay: the
 * assignee of a hand-off still reads the prompt it was handed (transcriptRowCheck keeps that rule). */
export function linkedRowShown(db: DatabaseSync, botId: string, threadId: string, message: Pick<Message, "id" | "copyOf" | "handoffOf" | "handoffFrom">): boolean {
  if (message.copyOf === undefined && message.handoffOf === undefined && message.handoffFrom === undefined) return true;
  return partitionSourcesVerdict(db, botId, threadId, [message.id]) === "shown";
}

/** The rule every transcript row a bot reads passes, for one operation (the copy memo's stamp is read once, here). Its caller is the reader
 * door (bot-read.ts), which reads every transcript a bot is given and passes the one chain check its operation uses. */
export function transcriptRowCheck(db: DatabaseSync, botId: string, threadId: string, present = copyChainCheck(db)): (message: Message) => boolean {
  // one operation: a request's sources are judged once however many of its activity rows the window holds
  const requests = new Map<string, boolean>();
  return message => {
    if (message.copyOf && !present(message.copyOf)) return false;
    if (message.copyOf && !partitionSourcesAllowed(db, botId, threadId, [message.id])) return false;
    if (message.kind !== "activity" || !message.requestId) return true;
    let allowed = requests.get(message.requestId);
    if (allowed === undefined) requests.set(message.requestId, allowed = partitionSourcesAllowed(db, botId, threadId, projectRequestSourceMessages(db, message.requestId)));
    return allowed;
  };
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
