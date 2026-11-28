// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane deep1022-withheld-fable owns this witness and the runner's source rule it pins (memory-revocation.ts tick under
// ioBudget.withoutSource); worker-controller.ts owns the worker's slices and their sources; io-budget.ts owns the background byte gate
// (instrumentDatabase beforeWrite); consolidate.ts owns the supersede and its revoke; revoke-budget.ts owns the runner's own pace.
//
// 1.0.22 release gate, root cause A on the production path, nothing named by the test: no deferCurrentSlice, no wakeIfStarted, no
// commitRevoke here. The wake is the one a memory worker makes in production:
//   the helper's capture result arrives (MemoryWorkerController.receiveWorkerMessage, the child's "message" handler)
//   -> the publication slice (later: ioBudget.withSource("memory-worker"), publishMemoryWork under "memory-capture")
//   -> the checkpoint refresh -> completedSource -> onCompletedSource under ioBudget.withSource("memory-worker") (worker-controller.ts)
//   -> consolidateCompletedMemorySource (the function index.ts passes as that hook) supersedes an earlier memory
//   -> revokeRecordDisclosures -> commitRevoke (the all-chat '*' windows) -> wakeIfStarted, inside the worker's io-budget store.
// Background load is real too: other background slices write through the same instrumented connection until the gate itself refuses a
// one-row write (the 12 MB background minute is spent). On base the runner woken by that worker runs as "memory-worker": every write
// of its walk meets the gate (io-budget.ts beforeWrite -> refusalRetry), the field line "[memory] revocation job: BG_DEFERRED; trying
// again" repeats, the receipt flips of the worker's commit stay queued, and while one is queued no revoke advances (revoke-marker.ts): the
// windows of every later Forget stay open and every chat reads checking. The runner has its own pace ledger and is nobody's background
// slice: it drains the queue whatever the background minute holds.
//
// Stand-ins, none of them the thing under test: the helper process is an object (its one message is the real captureWork result of the
// leased job), the extractor is a fixture engine reply, and the runner's `admit` hook (production: index.ts passes awaitWriterGate) is
// held while the load is written, as a writer hold does.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { isBgDeferred } from '../bg-admission.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { consolidateCompletedMemorySource, consolidateMemorySource } from './consolidate.ts';
import type { TextOnlyExtractor } from './extract.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { memoryRevocationIdle, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from './memory-revocation.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { noteReceiptOutput } from './receipt-outputs.ts';
import { resetRevokeWriteBudget } from './revoke-budget.ts';
import { MemoryWorkerController } from './worker-controller.ts';

const DEFERRED_LINE = '[memory] revocation job: BG_DEFERRED; trying again';
let controller: MemoryWorkerController | null = null;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetMemoryRevocationStats(); resetRevokeWriteBudget();
  reconcileMemoryRoster({ bots: [{ id: 'bot', threadId: 'thread' }], groups: [] });
});
afterEach(async () => {
  stopMemoryRevocation();
  if (controller) { (controller as unknown as { child: unknown }).child = null; await controller.stop(); controller = null; }
  vi.restoreAllMocks(); closeDatabase(); await stopWalMaintenance(); resetRevokeWriteBudget();
});

const pendingRows = () => Number(database().prepare("SELECT (SELECT count(*) FROM memory_deny_pending) + (SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n);
const queuedFlips = () => Number(database().prepare('SELECT count(*) AS n FROM memory_receipt_flips').get()!.n);
const unfinishedRevokes = () => Number(database().prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')").get()!.n);
async function settle(ms: number, done: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) await new Promise(resolve => setTimeout(resolve, 20));
  return done();
}
const FIRST = 'I prefer long answers.', SECOND = 'Correction: I now prefer short answers.';
/** The engine's reply to the learning call (a fixture engine): one owner statement about the same subject; `update` names a correction. */
function extractor(quote: string, update = false): TextOnlyExtractor {
  const fn: TextOnlyExtractor = async () => JSON.stringify([{ text: quote, quote, claimType: 'owner-statement', subject: 'owner', predicate: 'answer-length', update, startByte: 0, endByte: Buffer.byteLength(quote) }]);
  fn.ground = async () => '{"supported":true}';
  return fn;
}
const ownerLine = (id: string, text: string) => captureSource(database(), { id, threadId: 'thread', origin: { kind: 'attended' }, kind: 'text', speaker: 'owner', outcome: 'recorded', text });
/** One background write through the gate, as another worker slice makes it. True when the gate let it commit. */
function backgroundWrite(bytes: number): boolean {
  try { ioBudget.withSource('memory-worker', () => { database().prepare('INSERT INTO w1022_background_load(b) VALUES(zeroblob(?))').run(bytes); }); return true; }
  catch (error) { if (isBgDeferred(error)) return false; throw error; }
}
/** Background load: slices write until the gate refuses even a one-row write. Returns the bytes the gate admitted. */
function spendBackgroundMinute(): number {
  let size = 512 * 1024, admitted = 0;
  for (let i = 0; i < 2_000; i++) {
    if (backgroundWrite(size)) { admitted += size; continue; }
    if (size === 1) break;
    size = Math.max(1, size >> 2);
  }
  return admitted;
}

it('W-WORKER-SLICE the revoke work committed by a real memory worker slice (a consolidation that supersedes a memory three chats were shown) is drained by the runner while the background minute is spent: no BG_DEFERRED retry, no flip, window or revoke left', async () => {
  const db = database();
  await stopWalMaintenance();
  db.exec('CREATE TABLE IF NOT EXISTS w1022_background_load(id INTEGER PRIMARY KEY, b BLOB)');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // the start at listen (index.ts: wakeMemoryRevocation(database, { admit: awaitWriterGate, busy })): nothing queued, the runner idles
  let hold: Promise<void> = Promise.resolve();
  wakeMemoryRevocation(() => database(), { retryMs: 5, pauseMs: 5, busy: () => false, admit: () => hold });
  // the memory the owner's later line corrects: learned from an earlier line (setup, no worker: nothing is left for the runner)
  ownerLine('fixture-source-1', FIRST);
  const firstWork = claimMemoryJob('fixture-setup')!;
  publishMemoryWork(firstWork, 'fixture-setup', captureWork(firstWork));
  await consolidateMemorySource(firstWork.id, extractor(FIRST), new AbortController().signal);
  const prior = db.prepare("SELECT id FROM memory_records WHERE id LIKE 'candidate:%' AND state='active'").get()!;
  expect(prior?.id).toBeTruthy();
  // history: that memory was shown to three earlier turns of other chats (their delivered receipts cite it and have output lines). A
  // receipt that ends is a queued flip, and no revoke advances before the runner has drained it (revoke-marker.ts): this is what leaves
  // the supersede's revoke to the runner instead of the committer's own inline walk.
  const lsn = Number(db.prepare('SELECT next FROM memory_lsn WHERE id=1').get()!.next);
  for (const n of [1, 2, 3]) {
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fixture-driver',?,?,'[]','[]',0,0,0,'delivered',0)")
      .run(`fixture-receipt-${n}`, `fixture-chat-${n}`, `fixture-session-${n}`, JSON.stringify([{ id: String(prior.id), version: 1 }]));
    noteReceiptOutput(db, `fixture-receipt-${n}`, `fixture-chat-${n}`, lsn + n);
  }
  await settle(10_000, () => pendingRows() === 0);
  await memoryRevocationIdle();
  expect(pendingRows()).toBe(0);
  warn.mockClear();

  // a writer hold begins (the runner's admission waits on it), the owner's correcting line is stored, and the real worker takes it
  let release!: () => void;
  hold = new Promise<void>(resolve => { release = resolve; });
  ownerLine('fixture-source-2', SECOND);
  controller = new MemoryWorkerController({ onCompletedSource: (jobId, signal) => consolidateCompletedMemorySource(jobId, extractor(SECOND, true), signal) });
  const state = controller as unknown as { owner: string; child: unknown; ready: boolean; work: NonNullable<ReturnType<typeof claimMemoryJob>> | null; receiveWorkerMessage(child: unknown, message: unknown): void };
  const helper = { kill() {}, on() {}, send() {}, connected: true };
  state.child = helper; state.ready = true;
  const work = ioBudget.withSource('memory-capture', () => claimMemoryJob(state.owner))!; // the lease, as the controller's tick takes it
  expect(work?.sourceId).toBe('fixture-source-2');
  state.work = work;
  // the helper's reply: the real entry of a worker message. Everything after it is the controller's own slices.
  state.receiveWorkerMessage(helper, { type: 'result', result: captureWork(work) });
  const superseded = await settle(20_000, () => db.prepare('SELECT state FROM memory_records WHERE id=?').get(String(prior.id))?.state === 'superseded');
  const trace = () => JSON.stringify({ flips: db.prepare('SELECT count(*) AS n FROM memory_receipt_flips').get()!.n, receipts: db.prepare('SELECT state,count(*) AS n FROM memory_disclosures GROUP BY state').all(), revokes: db.prepare('SELECT kind,phase,state FROM memory_revoke_jobs').all(), job: db.prepare('SELECT status FROM memory_jobs WHERE id=?').get(work.id), records: db.prepare('SELECT state,count(*) AS n FROM memory_records GROUP BY state').all(), warns: warn.mock.calls.map(call => String(call[0]).slice(0, 160)).slice(0, 8) });
  expect(superseded, trace()).toBe(true);
  // the worker's commit left work only the runner does: the three receipts that were shown the superseded memory ended, and their flips
  // are queued (while one is queued no revoke advances, the owner's next Forget included: its windows would hold every chat at checking)
  const flipsAtCommit = queuedFlips();
  expect(flipsAtCommit, trace()).toBe(3);
  // background load while the hold lasts: the gate's own refusal of a one-row background write is the proof the minute is spent
  const minute = () => Math.floor(Date.now() / 60_000); // the background minute is a wall-clock bucket (io-budget.ts)
  const admittedBytes = spendBackgroundMinute();
  const spentIn = minute();
  expect(admittedBytes).toBeGreaterThan(1024 * 1024);
  expect(backgroundWrite(1)).toBe(false);
  expect(queuedFlips()).toBe(flipsAtCommit);
  release(); // the hold ends: the runner drains the flips and walks the receipts' revokes
  await settle(15_000, () => queuedFlips() === 0 && pendingRows() === 0 && unfinishedRevokes() === 0);
  const deferred = warn.mock.calls.map(call => String(call[0])).filter(line => line === DEFERRED_LINE);
  // base: the runner woken by the worker's commit is "memory-worker"; the spent background minute refuses each write of its walk
  expect({ flips: queuedFlips(), windows: pendingRows(), unfinishedRevokes: unfinishedRevokes(), deferredRetries: deferred.length, backgroundStillRefused: minute() !== spentIn || !backgroundWrite(1) }, trace())
    .toEqual({ flips: 0, windows: 0, unfinishedRevokes: 0, deferredRetries: 0, backgroundStillRefused: true });
}, 90_000);
