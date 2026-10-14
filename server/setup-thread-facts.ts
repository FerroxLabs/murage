// SPDX-License-Identifier: AGPL-3.0-or-later
// What the setup checklist needs from one conversation, read by index.
//
// GET /api/setup is polled every few seconds by the first-run card, and the
// Chief can hold hundreds of task conversations. Reading each one whole to
// learn two facts (has an engine answered here, and is a provider refusal
// newer than that answer) was hundreds of full transcript loads per poll. The
// facts are a few indexed rows per conversation, and they only
// change when that conversation is written, so they are kept until it is.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inboxProjectionPosition, inboxProjectionReady, threadFillName } from "./inbox.ts";
import type { SetupThreadFacts } from "./setup.ts";

// Both read the setup_marks rows of one conversation (server/inbox.ts keeps
// them in the writer's own transaction, one row per settled reply or provider
// refusal), each through an index that leads with the conversation: a seek,
// whatever the length of the history. Only the settled replies and refusals
// are rows, so even a conversation that has none costs one probe.
const ANSWER_SQL = `SELECT
  (SELECT at FROM setup_marks WHERE thread_id=?1 AND kind='reply' ORDER BY at DESC LIMIT 1) AS answered_at,
  (SELECT 1 FROM setup_marks WHERE thread_id=?1 AND kind='reply' AND solid=1 LIMIT 1) AS answered`;
/** A refusal counts only when it is newer than the newest settled reply. */
const REFUSAL_SQL = `SELECT at, http_status, provider FROM setup_marks WHERE thread_id=? AND kind='refusal' AND at>? ORDER BY at DESC, source_row DESC LIMIT 1`;
/** A row of this conversation the fill has not projected yet: after its cursor, up to the high-water rowid (messages_thread, one seek). */
const UNPROJECTED_SQL = `SELECT 1 FROM messages WHERE thread_id=? AND rowid>? AND rowid<=? LIMIT 1`;
/** A row of this conversation the fill passed over because the slice budget could not admit it: a worker projects it. */
const DEFERRED_SQL = `SELECT 1 FROM inbox_fill_deferred WHERE thread_id=? LIMIT 1`;
/** The per-conversation completion marker the fill writes when it finishes a conversation ahead of the rest. */
const COMPLETED_SQL = `SELECT done FROM inbox_projection_state WHERE name=?`;
export const SETUP_FACT_STATEMENTS = { answer: ANSWER_SQL, refusal: REFUSAL_SQL, unprojected: UNPROJECTED_SQL, deferred: DEFERRED_SQL };

/** The facts of one conversation, straight from the database.
 *
 *  A PARTIAL FILL IS NEVER TREATED AS THE TRUTH. Once the Inbox projection's
 *  first fill is done every conversation's marks are complete. Until then a
 *  conversation's marks are the ones the fill has reached plus the ones written
 *  since the upgrade, so a refusal can be present whose recovery is not. The
 *  facts are KNOWN when the fill is done, or when NO row of the conversation
 *  waits unprojected: none between the fill's cursor and the high-water rowid
 *  (rows above it are projected by the triggers as they are written), and none
 *  passed over for the worker. That is exact under every write path: an
 *  INSERT OR REPLACE gives a row a new rowid but leaves its recovery where it
 *  was, still unprojected; an in-place UPDATE keeps its rowid and the trigger
 *  re-projects it; a delete leaves the range. Two seeks, whatever the length
 *  of the history. Otherwise the facts are UNKNOWN: `known: false`, no refusal. */
export function readSetupThreadFacts(db: DatabaseSync, threadId: string, statements = prepared(db)): SetupThreadFacts {
  // ONE SNAPSHOT. The answer, the refusal and the completeness check are read inside one read transaction, so a
  // worker that projects a deferred recovery between them cannot make the facts KNOWN around an obsolete refusal:
  // either every read sees the world before the drain (UNKNOWN) or every read sees it after (the recovery).
  // A caller that is already inside a transaction (the writer's own connection) already has one snapshot.
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try { return readFacts(db, threadId, statements); }
  finally { if (own) { try { db.exec("COMMIT"); } catch { /* nothing to end */ } } }
}

function readFacts(db: DatabaseSync, threadId: string, statements: Prepared): SetupThreadFacts {
  const answer = statements.answer.get(threadId) as { answered_at: number | null; answered: number | null } | undefined;
  const answeredAt = typeof answer?.answered_at === "number" ? answer.answered_at : -1;
  const refusal = statements.refusal.get(threadId, answeredAt) as { at: number; http_status: unknown; provider: unknown } | undefined;
  const facts: SetupThreadFacts = {
    answered: answer?.answered === 1,
    answeredAt,
    refusal: refusal ? { at: refusal.at, refusal: { httpStatus: refusal.http_status as number, ...(typeof refusal.provider === "string" && refusal.provider ? { provider: refusal.provider } : {}) } } : null,
  };
  if (inboxProjectionReady(db)) return facts;
  // A conversation the fill completed ahead of the rest (the Chief's) is exact by one primary-key probe.
  if ((statements.completed.get(threadFillName(threadId)) as { done: number } | undefined)?.done === 1) return facts;
  const position = inboxProjectionPosition(db);
  if (position && statements.unprojected.get(threadId, position.cursor, position.high) === undefined && statements.deferred.get(threadId) === undefined) return facts;
  return { ...facts, refusal: null, known: false };
}

interface Prepared { answer: StatementSync; refusal: StatementSync; unprojected: StatementSync; deferred: StatementSync; completed: StatementSync }
const statementCache = new WeakMap<DatabaseSync, Prepared>();
function prepared(db: DatabaseSync): Prepared {
  let held = statementCache.get(db);
  if (!held) { held = { answer: db.prepare(ANSWER_SQL), refusal: db.prepare(REFUSAL_SQL), unprojected: db.prepare(UNPROJECTED_SQL), deferred: db.prepare(DEFERRED_SQL), completed: db.prepare(COMPLETED_SQL) }; statementCache.set(db, held); }
  return held;
}

/** Facts per conversation, kept until that conversation is written. The
 *  message writers (message-db.ts) call `touch` inside every write, so a poll
 *  that finds nothing changed reads nothing. */
export class SetupThreadFactsCache {
  private readonly held = new Map<string, { stamp: number; facts: SetupThreadFacts }>();
  private readonly stamps = new Map<string, number>();
  private clock = 0;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  touch(threadId: string): void { this.stamps.set(threadId, ++this.clock); }
  forget(threadId: string): void { this.stamps.set(threadId, ++this.clock); this.held.delete(threadId); }
  facts(threadId: string): SetupThreadFacts {
    const stamp = this.stamps.get(threadId) ?? 0;
    const hit = this.held.get(threadId);
    if (hit && hit.stamp === stamp) return hit.facts;
    const facts = readSetupThreadFacts(this.db, threadId);
    // While the first fill is still reading an old history the rows are
    // partial: whatever was answered is not kept (known or not), so the next
    // poll after the fill reads the complete ones.
    if (inboxProjectionReady(this.db)) this.held.set(threadId, { stamp, facts });
    return facts;
  }
}
