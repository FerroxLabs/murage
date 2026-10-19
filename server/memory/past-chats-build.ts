// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory on for installs upgraded from 1.0.1, and the past-chats build (1.0.3 lane 2, item 2.1, M1 and M2).
//
// The flip (M1): at the first 1.0.3 start of a file whose memory is off AND was never configured (the policy revision is still at its
// seed: every owner `configure` bumps it, settings.ts) AND that no 1.0.3 start has seen before (the last-run marker below, written at
// every start from 1.0.3 on), memory becomes active once. An owner who configured memory and then turned it off is never flipped; a
// later owner `off` is never overridden again. No version record is consulted.
//
// The build (M2): every conversation of the roster is listed in `memory_backfill_threads` (schema.ts, beside the key table), and each
// is read oldest first in bounded pages through the store's export reader; every message not yet in `memory_sources` goes through the
// ordinary capture path (capture.ts captureMessage: the same scope, exclusion and kind rules as a live message), which writes the
// sources, their versions and the ordinary `memory_jobs` rows the helper works through. One transaction per slice: the slice's
// sources and jobs and the thread row's `last_message_id`, so a restart resumes after the last message a slice committed. The
// counters the status shows come from that table.
import type { DatabaseSync } from "node:sqlite";
import { awaitWriterGate, transaction } from "../database.ts";
import { ownerFirst, type OwnerFirstGate } from "../owner-first.ts";
import { ioBudget } from "../io-budget.ts";
import type { Message } from "../store.ts";
import { branchOracle, threadKey } from "../branch-index.ts";
import { threadIsReady } from "../branch-fill.ts";
import { parentOf } from "./branch-change.ts";
import { captureMessage } from "./capture.ts";
import { memoryState } from "./repository.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { BACKFILL_THREADS_TABLE } from "./schema.ts";

/** The proof that a 1.0.3 (or later) start has seen this file: a system binding, written at every start. */
export const LAST_RUN_MARKER = "memory-last-run-version";
export function lastRunVersion(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(LAST_RUN_MARKER);
  if (!row) return null;
  try { const value = JSON.parse(String(row.intent)); return typeof value.version === "string" ? value.version : ""; } catch { return ""; }
}
export function noteLastRunVersion(db: DatabaseSync, version: string | null): void {
  const scope = ensureScope("workspace", memoryState().installationId);
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','last-run',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(LAST_RUN_MARKER, scope, JSON.stringify({ version: version ?? "", at: Date.now() }));
}
/** Whether this start flips memory on (the rule above). */
export function memoryUpgradeFlipDue(db: DatabaseSync): boolean {
  const meta = db.prepare("SELECT mode,policy_revision AS rev FROM memory_meta WHERE id=1").get();
  if (!meta || String(meta.mode) !== "off" || Number(meta.rev) !== 0) return false;
  return lastRunVersion(db) === null;
}
/** Flips memory on, once, in one transaction with the marker: true when it flipped. */
export function flipMemoryOnForUpgrade(version: string | null): boolean {
  return transaction(tx => {
    if (!memoryUpgradeFlipDue(tx)) { noteLastRunVersion(tx, version); return false; }
    tx.exec("UPDATE memory_meta SET mode='active',policy_revision=policy_revision+1,data_revision=data_revision+1 WHERE id=1");
    noteLastRunVersion(tx, version);
    return true;
  });
}

export interface PastChatsCounters { threads: number; threadsDone: number; messagesQueued: number; running: boolean }
/** The figures of the build, from its table: conversations listed and done, messages queued (each capped at 1,000 for the screen). */
export function pastChatsCounters(db: DatabaseSync): PastChatsCounters | null {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(BACKFILL_THREADS_TABLE)) return null;
  const row = db.prepare(`SELECT count(*) AS n,coalesce(sum(done),0) AS d,coalesce(sum(queued),0) AS q FROM ${BACKFILL_THREADS_TABLE}`).get();
  if (!row || Number(row.n) === 0) return null;
  return { threads: Number(row.n), threadsDone: Number(row.d), messagesQueued: Number(row.q), running: Number(row.d) < Number(row.n) };
}
/** Whether the build has conversations left. */
export function pastChatsOwed(db: DatabaseSync): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(BACKFILL_THREADS_TABLE)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${BACKFILL_THREADS_TABLE} WHERE done=0 LIMIT 1`).get());
}
/** Lists every conversation of the roster that is not listed yet (one short transaction; a thread is listed once). Returns how many were added. */
export function listPastChatThreads(roster: MemoryRoster): number {
  const threads = [...new Set([...roster.bots.flatMap(bot => [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]), ...roster.groups.flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])])];
  return transaction(tx => {
    const add = tx.prepare(`INSERT OR IGNORE INTO ${BACKFILL_THREADS_TABLE}(thread_id,last_message_id,listed,queued,done) VALUES(?,NULL,1,0,0)`);
    let added = 0;
    for (const threadId of threads) added += Number(add.run(threadId).changes);
    return added;
  });
}

export interface ExportReaderStore { branchExportReader(threadId: string): { next(budgetMs?: number): { messages: Message[]; done: boolean } } }
/** The reader of the conversation being built, kept across slices in this process (a restart reads the conversation again from its
 * start and skips to the last message a slice committed). `leaf` is the head the reader walks back from: every message it hands out
 * is that head or one of its ancestors. */
let open: { threadId: string; reader: ReturnType<ExportReaderStore["branchExportReader"]>; resumed: boolean; leaf: string | null } | null = null;
export const PAST_CHATS_SLICE_MS = 10;
/** How far back from the current head a reader's head is looked for on a thread whose branch index is not filled yet (new messages
 * appended since the reader opened). Past this the reader is treated as stale and opened again, which is only extra reading. */
export const PAST_CHATS_HEAD_WALK = 512;

/** The stored head of a thread, as the export reader starts from it (the head, else the newest row). */
function storedHead(db: DatabaseSync, threadId: string): string | null {
  const state = db.prepare("SELECT active_leaf_id AS leaf FROM thread_state WHERE thread_id=?").get(threadId);
  if (state?.leaf) return String(state.leaf);
  const newest = db.prepare("SELECT id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId);
  return newest ? String(newest.id) : null;
}

/** Whether `readerHead` is still on the thread's visible branch: the current head, or one of its ancestors (messages appended since
 * keep it there; a switch to another version, an edit or a regenerate leaves it off). Asked inside the capture transaction, so no
 * write can move the head between the answer and the capture. */
export function readerHeadOnBranch(db: DatabaseSync, threadId: string, readerHead: string | null): boolean {
  const head = storedHead(db, threadId);
  if (readerHead === head) return true;
  if (readerHead === null || head === null) return false;
  const rowid = (id: string) => db.prepare("SELECT rowid AS r FROM messages WHERE thread_id=? AND id=?").get(threadId, id)?.r;
  const readerRow = rowid(readerHead), headRow = rowid(head);
  if (readerRow === undefined || headRow === undefined) return false;
  const tk = threadIsReady(db, threadId) ? threadKey(db, threadId) : undefined;
  if (tk) return branchOracle(db, tk, Number(headRow))(Number(readerRow));
  // branch index not filled yet: a bounded walk up the parent links from the current head
  let at: string | null = head;
  for (let steps = 0; at !== null && steps < PAST_CHATS_HEAD_WALK; steps++) {
    at = parentOf(db, threadId, at);
    if (at === readerHead) return true;
  }
  return false;
}

/** One slice: the next page of the conversation being built, every message of it not captured yet queued through the capture path,
 * the thread row moved, in one transaction. `done` when no conversation is left. */
export function stepPastChatsBuild(db: DatabaseSync, store: ExportReaderStore, options: { budgetMs?: number } = {}): { done: boolean; queued: number; threadId?: string } {
  const budget = options.budgetMs ?? PAST_CHATS_SLICE_MS;
  const row = db.prepare(`SELECT thread_id AS id,last_message_id AS last FROM ${BACKFILL_THREADS_TABLE} WHERE done=0 ORDER BY thread_id LIMIT 1`).get();
  if (!row) { open = null; return { done: true, queued: 0 }; }
  const threadId = String(row.id);
  if (open?.threadId !== threadId) open = { threadId, leaf: storedHead(db, threadId), reader: store.branchExportReader(threadId), resumed: row.last === null };
  const current = open;
  const slice = current.reader.next(budget);
  let messages = slice.messages;
  if (!current.resumed) {
    // skip to just past the last message a slice committed (the reader restarted at the oldest message); until it is found every
    // message still goes through the `memory_sources` check below, so a last message deleted since never drops the rest of the thread
    const at = messages.findIndex(message => message.id === String(row.last));
    if (at >= 0) { messages = messages.slice(at + 1); current.resumed = true; }
  }
  const queued = transaction(tx => {
    // The branch may have changed since this reader opened (a switch between versions, an edit): its messages may then be on the
    // abandoned branch, and capture would record them as active. Checked here, in the capture's own transaction: a stale reader
    // captures nothing and moves nothing, and the next slice opens a fresh reader on the branch as it is now.
    if (!readerHeadOnBranch(tx, threadId, current.leaf)) return null;
    const known = tx.prepare("SELECT 1 FROM memory_sources WHERE id=?");
    let n = 0;
    for (const message of messages) {
      if (known.get(`message:${threadId}:${message.id}`)) continue;
      captureMessage(tx, threadId, message);
      n++;
    }
    const last = messages.at(-1)?.id ?? (slice.messages.at(-1)?.id ?? null);
    if (slice.done) tx.prepare(`UPDATE ${BACKFILL_THREADS_TABLE} SET done=1,queued=queued+?,last_message_id=coalesce(?,last_message_id) WHERE thread_id=?`).run(n, last, threadId);
    else if (last !== null) tx.prepare(`UPDATE ${BACKFILL_THREADS_TABLE} SET queued=queued+?,last_message_id=? WHERE thread_id=?`).run(n, last, threadId);
    return n;
  });
  if (queued === null) { open = null; return { done: false, queued: 0, threadId }; }
  if (slice.done) open = null;
  return { done: false, queued, threadId };
}

/** Runs the whole build now (tests, and a caller with the time). */
export function runPastChatsBuildNow(db: DatabaseSync, store: ExportReaderStore, roster: MemoryRoster): number {
  listPastChatThreads(roster);
  let queued = 0;
  for (;;) { const step = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY }); if (step.done) return queued; queued += step.queued; }
}

export interface PastChatsBuildOptions { busy?: () => boolean; gate?: Pick<OwnerFirstGate, "admit"> | null; admit?: () => Promise<void>; pauseMs?: number; busyPollMs?: number; onDone?: () => void; onError?: (error: Error) => void }
/** The build in the background: a slice at a time on a real timer, waiting while the owner is in a turn or typing and while a writer
 * hold is in force. Never throws. */
export function startPastChatsBuild(db: DatabaseSync, store: ExportReaderStore, roster: () => MemoryRoster, options: PastChatsBuildOptions = {}): { stop(): void; done: Promise<boolean> } {
  const pause = Math.max(1, options.pauseMs ?? 5), busyPoll = Math.max(1, options.busyPollMs ?? 250);
  const gate = options.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : options.gate;
  const admit = options.admit ?? awaitWriterGate;
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, finish!: (built: boolean) => void;
  const done = new Promise<boolean>(resolve => { finish = resolve; });
  const end = (built: boolean) => { stopped = true; if (timer) clearTimeout(timer); timer = null; finish(built); };
  const later = (ms: number) => { if (!stopped) { timer = setTimeout(() => { void tick(); }, ms); timer.unref?.(); } };
  const tick = async () => {
    timer = null;
    if (stopped) return;
    if (options.busy?.()) { later(busyPoll); return; }
    const admission = gate?.admit("owner-search-backfill");
    if (admission && !admission.admitted) { later(admission.retryInMs); return; }
    try { await admit(); } catch { /* a gate that fails holds nothing back */ }
    if (stopped) return;
    if ((db as { isTransaction?: boolean }).isTransaction) { later(pause); return; }
    try {
      const step = ioBudget.withSource("past-chats-build", () => stepPastChatsBuild(db, store));
      if (step.done) { try { options.onDone?.(); } catch { /* reporting never stops anything */ } end(true); return; }
    } catch (error) {
      try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* as above */ }
      end(false); return;
    }
    later(pause);
  };
  try { listPastChatThreads(roster()); } catch (error) { try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* as above */ } end(false); return { stop() {}, done }; }
  later(0);
  return { stop() { end(false); }, done };
}
