// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 10.1 / AUDIT B1: the dispatch checks were guarded by `databaseStamp()`, which every write moves
// (the recall counter, the job claims, the receipts), so they never skipped. The authority epoch moves only
// for writes that can take something away from a bundle or a resumed session.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { database, transaction } from "../database.ts";
import { authorityMoved, authorityStamp, pinStamp } from "./authority-epoch.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { assertMemoryBundle, buildMemoryBundle } from "./bundle.ts";
import * as bundleReader from "./bundle.ts";
import { bindMemoryDisclosureSession, continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { flushMemoryCounters, recordMemoryRetrieval, resetMemoryCounters } from "./health.ts";
import { THREAD, accessFor, captureAndPublish, emptyBridge, freshDataDir } from "./testing/recall-fixture.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { FreshReplaySessionConfirmation } from "./fresh-replay-session.ts";
import { captureSendReplayProof } from "./replay-lineage.ts";
import { openTurnLineage, closeTurnLineage, writeLineage } from "./lineage-write.ts";
import { startFreshSession } from "./session-incarnation.ts";
import { noteSessionFrame } from "./session-proof-schema.ts";
import { initializeFreshSessionProof } from "./session-proof.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";

// MAIN RULING 1115-RECALL-R1 (GrokBuild)
// Producer owner: recall-fix-c. Consumer owner: recall-fix-c (epoch witnesses).
function startLiveSession(access: MemoryAccess) {
  for (const row of sql().prepare("SELECT id FROM messages WHERE thread_id=?").all(THREAD)) {
    writeLineage(sql(), { threadId: THREAD, messageId: String(row.id), author: "owner" }, {});
  }
  const turn = openTurnLineage(sql(), { threadId: THREAD, turnId: "fixture-live-turn" });
  const { key } = transaction(db => startFreshSession(db, THREAD, "engine", "session-1", turn));
  closeTurnLineage(turn);
  const confirmation = new FreshReplaySessionConfirmation(captureSendReplayProof(THREAD, []), "engine", () => assertMemoryAccess(access), { generation: access.generation });
  confirmation.sessionStarted("fixture-live-turn", key, true);
  confirmation.engineWritten(); confirmation.accepted("fixture-live-turn");
  noteSessionFrame(sql(), key, false);
  initializeFreshSessionProof(key, access, undefined, { fresh: true, confirmation });
  return confirmation;
}
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

beforeEach(() => { freshDataDir("active"); resetMemoryCounters(); resetSessionHolds(); });
afterEach(() => resetMemoryCounters());

const sql = () => database();

it("plain growth does not move the epoch: captures, jobs, receipts, the recall counter, a delivered receipt, a background binding", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const before = authorityStamp();
  expect(before).toMatch(/^a[0-9a-f]{8}u?\.\d+\.\d+:\d+$/);
  captureAndPublish("A second durable fact about the launch.");
  recordMemoryRetrieval(3); flushMemoryCounters(Date.now(), true);
  sql().prepare("INSERT INTO memory_scope_bindings VALUES('consolidation:x',(SELECT id FROM memory_scopes LIMIT 1),'system','consolidation-pending',0,'granted','{}')").run();
  sql().prepare("INSERT INTO memory_scope_bindings VALUES('extract-budget:2026-10-09',(SELECT id FROM memory_scopes LIMIT 1),'system','extract-budget',0,'granted','{}')").run();
  sql().prepare("UPDATE memory_scope_bindings SET intent='{\"a\":1}' WHERE id='consolidation:x'").run();
  const bundle = await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()});
  const receipt = new MemoryDispatchReceipt(bundle, access, "engine");
  receipt.sessionStarted("session-1"); receipt.accepted();
  expect(authorityStamp()).toBe(before);
  expect(authorityMoved(before)).toBe(false);
});

it("anything that can take something away moves it: archive, source retirement, tombstone, audience binding, policy, deletion epoch", () => {
  const { sourceId } = captureAndPublish("The launch review is on Friday.");
  const record = sql().prepare("SELECT id,version FROM memory_records LIMIT 1").get()!;
  const moved = (change: () => void) => { const before = authorityStamp(); change(); expect(authorityStamp()).not.toBe(before); };
  moved(() => archiveMemoryRecord(ownerMemoryTicket(), String(record.id), Number(record.version)));
  moved(() => sql().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(sourceId));
  moved(() => sql().prepare("INSERT INTO memory_tombstones VALUES('t1','source',?,NULL,NULL,1,'forgotten',1)").run(sourceId));
  moved(() => sql().prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:t',(SELECT id FROM memory_scopes LIMIT 1),'human-thread','t',1,'granted','{\"personId\":\"p\",\"bindingId\":\"b\",\"revision\":1}')").run());
  moved(() => sql().prepare("UPDATE memory_meta SET policy_revision=policy_revision+1").run());
  moved(() => sql().exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1"));
});

it("a receipt turning revoked or changing its contents moves it; turning delivered or binding a session does not", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const bundle = await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()});
  const receipt = new MemoryDispatchReceipt(bundle, access, "engine");
  const stamp = authorityStamp();
  bindMemoryDisclosureSession(bundle.bundleId, "s1");
  sql().prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=?").run(bundle.bundleId);
  expect(authorityStamp()).toBe(stamp);
  sql().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundle.bundleId);
  expect(authorityStamp()).not.toBe(stamp);
  void receipt;
});

it("a checkpoint archived with no newer version moves the stamp until one arrives; the roll writes both at once and moves nothing", () => {
  const first = captureAndPublish("Verified initial result.");
  refreshMemoryCheckpoint(first.jobId);
  const checkpoint = sql().prepare("SELECT id,version FROM memory_records WHERE kind='checkpoint'").get()!;
  const before = authorityStamp();
  sql().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(checkpoint.id, checkpoint.version);
  const archived = authorityStamp();
  expect(archived).not.toBe(before);
  const second = captureAndPublish("Verified later result.");
  refreshMemoryCheckpoint(second.jobId);
  expect(sql().prepare("SELECT count(*) n FROM memory_records WHERE kind='checkpoint' AND state='active'").get()!.n).toBe(1);
});

it("it is unknown inside a transaction, and an unknown stamp always counts as moved", () => {
  transaction(() => { expect(authorityStamp()).toBeUndefined(); });
  expect(authorityMoved(undefined)).toBe(true);
});

/** Count the statements a check runs, by their text. */
function countStatements(match: (text: string) => boolean) {
  const db = database(), real = db.prepare.bind(db);
  let n = 0;
  (db as unknown as { prepare: unknown }).prepare = (text: string) => { if (match(text)) n++; return real(text); };
  return { get n() { return n; }, restore: () => { (db as unknown as { prepare: unknown }).prepare = real; } };
}

// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Count executions and returned work; preparing an empty incremental tail is not a prefix scan.
function sessionScans() {
  const db = database(), prepare = db.prepare;
  const work = { prefixes: 0, tailRows: 0, tails: [] as Array<{ bound: number; rows: number }>, changes: [] as string[][] };
  db.prepare = function (text) {
    const statement = prepare.call(this, text);
    const disclosure = text.startsWith("SELECT rowid AS rid,bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,state,created_at FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?");
    const retired = text.startsWith("SELECT bundle_id,state,policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=?1");
    if (retired) throw new Error('Retired unbounded session opener');
    if (disclosure || text.startsWith('SELECT id FROM memory_session_change_log WHERE seq>?')) statement.all = new Proxy(statement.all, { apply(target, _receiver, args) {
      const rows = Reflect.apply(target, statement, args) as ReturnType<typeof statement.all>;
      if (disclosure) {
        const bound = Number(args[3]);
        if (!text.includes('AND rowid>?') || bound === 0) work.prefixes++;
        else { work.tailRows += rows.length; work.tails.push({ bound, rows: rows.length }); }
      } else work.changes.push(rows.map(row => String(row.id)));
      return rows;
    } });
    return statement;
  };
  return { work, restore: () => { db.prepare = prepare; } };
}

it("assertMemoryBundle rehydrates the bundle once per epoch, not once per call, and still catches a revocation", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const bundle = await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()});
  expect(bundle.recordVersions.length).toBeGreaterThan(0);
  const hydrated = countStatements(text => text.startsWith("SELECT * FROM memory_records WHERE id=? AND version=?"));
  try {
    assertMemoryBundle(bundle, access);
    const first = hydrated.n;
    expect(first).toBeGreaterThan(0);
    assertMemoryBundle(bundle, access); assertMemoryBundle(bundle, access);
    expect(hydrated.n).toBe(first);
    // growth elsewhere leaves it alone
    captureAndPublish("Something unrelated and new.");
    assertMemoryBundle(bundle, access);
    expect(hydrated.n).toBe(first);
    // a revocation does not
    const record = bundle.recordVersions[0];
    sql().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(record.id, record.version);
    expect(() => assertMemoryBundle(bundle, access)).toThrow(/MEMORY_CONTEXT_REVOKED|MEMORY_RECORD_UNAVAILABLE/);
    expect(hydrated.n).toBeGreaterThan(first);
  } finally { hydrated.restore(); }
});

it("a resumed session is checked in full at most once per epoch across the dispatch checks, and a revocation still ends it", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const first = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()}), access, "engine");
  const confirmation = startLiveSession(access);
  first.sessionStarted("session-1", true, confirmation); first.accepted();
  const second = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()}), access, "engine");
  expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", access)).toBe(false);
  // MAIN RULING 1115-RECALL-R7 (GrokBuild)
  const fullChecks = sessionScans();
  try {
    second.resumes("session-1", authorityStamp());
    second.assertCurrent(); second.assertCurrent(); second.assertCurrent();
    expect(fullChecks.work.prefixes).toBe(0);
    // a write that cannot take anything away does not bring the check back
    captureAndPublish("Another new fact.");
    second.assertCurrent();
    expect(fullChecks.work.prefixes).toBe(0);
    // one that can does, and it ends the session
    sql().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(first.bundle.bundleId);
    expect(() => second.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(fullChecks.work.prefixes).toBe(0);
    expect(fullChecks.work.changes).toEqual([[`receipt:${first.bundle.bundleId}`]]);
    expect(fullChecks.work.tailRows).toBe(0);
    expect(fullChecks.work.tails.length).toBeGreaterThan(0);
    expect(fullChecks.work.tails.every(page => page.bound > 0 && page.rows === 0)).toBe(true);
  } finally { fullChecks.restore(); }
});

it("a thread's checkpoint rolling to a new publication retains its exact old citation and authority stamp", () => {
  const first = captureAndPublish("Verified initial result.");
  refreshMemoryCheckpoint(first.jobId);
  // MAIN RULING 1115-RECALL-R3 (GrokBuild)
  const selected = sql().prepare("SELECT r.* FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version").get()!;
  const stamp = authorityStamp();
  const second = captureAndPublish("Verified later result.");
  refreshMemoryCheckpoint(second.jobId);
  expect(sql().prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(selected.id, selected.version)).toEqual(selected);
  expect(sql().prepare("SELECT count(*) n FROM memory_checkpoint_members").get()!.n).toBe(2);
  expect(sql().prepare("SELECT record_id FROM memory_checkpoint_heads").get()!.record_id).not.toBe(selected.id);
  expect(authorityStamp()).toBe(stamp);
});

it("the early continuation check is not repeated while nothing that could take a receipt away was written, and is when something was", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const first = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()}), access, "engine");
  const confirmation = startLiveSession(access);
  first.sessionStarted("session-1", true, confirmation); first.accepted();
  // MAIN RULING 1115-RECALL-R7 (GrokBuild): force the first cold prefix, retaining the live reader checkpoint.
  sql().prepare("UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance='engine' AND native_session='session-1'").run(THREAD);
  // MAIN RULING 1115-RECALL-R7 (GrokBuild)
  const fullChecks = sessionScans();
  try {
    expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", access)).toBe(false);
    expect(fullChecks.work.prefixes).toBe(1);
    // the turns that follow: more captures, a delivered receipt, the checkpoint rolling, counters
    for (let n = 0; n < 3; n++) {
      const next = captureAndPublish(`Another fact ${n}.`); refreshMemoryCheckpoint(next.jobId);
      expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", access)).toBe(false);
    }
    expect(fullChecks.work.prefixes).toBe(1);
    // the same reader under a new capability (every turn mints one) asks the same question: still answered
    expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", accessFor().access)).toBe(false);
    expect(fullChecks.work.prefixes).toBe(1);
    // a record the session was shown is archived: the check runs again and ends the session
    const cited = first.bundle.recordVersions[0];
    sql().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(cited.id, cited.version);
    expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", accessFor().access)).toBe(true);
    expect(fullChecks.work.prefixes).toBe(1);
    expect(fullChecks.work.changes).toEqual([[`record:${cited.id}`]]);
    expect(fullChecks.work.tailRows).toBe(0);
  } finally { fullChecks.restore(); }
});

it("a full session check looks at each record a session was shown once, however many receipts cite it", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const receiptsInSession = async (count: number) => {
    for (let n = 0; n < count; n++) new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()}), access, "engine").sessionStarted("session-1");
  };
  const hydrations = () => {
    resetSessionHolds();
    // MAIN RULING 1115-RECALL-R1 (GrokBuild)
    // Re-read the certified prefix for this full-check census, rather than just its incremental tail.
    sql().prepare("UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance='engine' AND native_session='session-1'").run(THREAD);
    const hydrated = vi.spyOn(bundleReader, "hydrateDisclosedMemoryRecord");
    try { expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, "engine", "session-1", access)).toBe(false); return hydrated.mock.calls.length; } finally { hydrated.mockRestore(); }
  };
  startLiveSession(access);
  await receiptsInSession(1);
  const one = hydrations();
  await receiptsInSession(5);
  expect(sql().prepare("SELECT count(*) n FROM memory_disclosures WHERE native_session='session-1'").get()!.n).toBe(6);
  expect(one).toBeGreaterThan(0);
  expect(hydrations()).toBe(one);
});

it("the pin stamp moves only when a pinned record is added, changed, pinned, unpinned or removed", () => {
  const { jobId } = captureAndPublish("The launch review is on Friday.");
  const record = sql().prepare("SELECT id,version FROM memory_records LIMIT 1").get()!;
  const stamp = pinStamp();
  expect(stamp).toMatch(/^p[0-9a-f]{8}\.\d+:\d+$/);
  captureAndPublish("Another fact."); refreshMemoryCheckpoint(jobId);
  sql().prepare("UPDATE memory_meta SET data_revision=data_revision+1").run();
  expect(pinStamp()).toBe(stamp);
  const moved = (change: () => void) => { const before = pinStamp(); change(); expect(pinStamp()).not.toBe(before); };
  moved(() => sql().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?").run(record.id, record.version));
  moved(() => sql().prepare("UPDATE memory_records SET text='changed' WHERE id=? AND version=?").run(record.id, record.version));
  moved(() => sql().prepare("UPDATE memory_records SET owner_pinned=0 WHERE id=? AND version=?").run(record.id, record.version));
  moved(() => sql().prepare("INSERT INTO memory_records VALUES('p-new',1,(SELECT scope_id FROM memory_records LIMIT 1),'fact','pinned text','owner-statement','active',1,0,NULL,NULL,0)").run());
  moved(() => sql().prepare("DELETE FROM memory_evidence WHERE record_id='p-new'").run() && sql().prepare("DELETE FROM memory_records WHERE id='p-new'").run());
  transaction(() => { expect(pinStamp()).toBeUndefined(); });
});

it("a bundle reads the owner's pins once while nothing about a pin changed, and sees a new pin at once", async () => {
  const { access } = accessFor();
  captureAndPublish("Report colour is charcoal.");
  // MAIN RULING 1115-RECALL-R2 (GrokBuild)
  const pinReads = countStatements(text => text.startsWith("SELECT id,version,scope_id FROM memory_records INDEXED BY memory_records_pinned WHERE owner_pinned=1 AND state='active'"));
  try {
    const first = await buildMemoryBundle("report", access, emptyBridge, {allowance: LineageAllowance.tool()});
    expect(first.pinned).toHaveLength(0);
    expect(pinReads.n).toBe(1);
    captureAndPublish("Another captured message."); await buildMemoryBundle("report", access, emptyBridge, {allowance: LineageAllowance.tool()}); await buildMemoryBundle("report", access, emptyBridge, {allowance: LineageAllowance.tool()});
    expect(pinReads.n).toBe(1);
    const record = sql().prepare("SELECT id,version FROM memory_records WHERE text LIKE '%charcoal%'").get()!;
    sql().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?").run(record.id, record.version);
    const pinned = await buildMemoryBundle("report", access, emptyBridge, {allowance: LineageAllowance.tool()});
    expect(pinReads.n).toBe(2);
    expect(pinned.pinned.map(row => row.id)).toContain(String(record.id));
  } finally { pinReads.restore(); }
});

// A conversation deletion is a durable scoped denial, not a new global access epoch.
it("two conversation deletes preserve B's prepared receipt, deny A even after restart, and fence background publication", async () => {
  const { captureThreadDeletion } = await import("./capture.ts");
  const { assertMemoryAccess, reconcileMemoryRoster } = await import("./policy.ts");
  const { learningDeletionEpoch, sourceDenied } = await import("./deny.ts");
  const { closeDatabase } = await import("../database.ts");
  const roster = { bots: [{ id: "bot", threadId: THREAD }, { id: "other", threadId: "other-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  const a = accessFor(roster).access, b = accessFor(roster, "other", "other-thread").access;
  const { sourceId } = captureAndPublish("Private words from A.");
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("hello", b, emptyBridge, { allowance: LineageAllowance.tool() }), b, "engine");
  const own = new MemoryDispatchReceipt(await buildMemoryBundle("private", a, emptyBridge, { allowance: LineageAllowance.tool() }), a, "engine");
  const clock = learningDeletionEpoch(sql());
  transaction(db => captureThreadDeletion(db, THREAD));
  expect(() => assertMemoryAccess(a)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => own.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(sourceDenied(sql(), sourceId)).toBe(true);
  expect(() => receipt.assertCurrent()).not.toThrow();
  expect(() => receipt.accepted()).not.toThrow();
  expect(learningDeletionEpoch(sql())).toBe(clock + 1);
  transaction(db => captureThreadDeletion(db, "another-deleted-thread"));
  expect(() => receipt.assertCurrent()).not.toThrow();
  expect(learningDeletionEpoch(sql())).toBe(clock + 2);
  transaction(db => captureThreadDeletion(db, THREAD)); // idempotent boot replay
  expect(learningDeletionEpoch(sql())).toBe(clock + 2);
  closeDatabase();
  expect(sourceDenied(sql(), sourceId)).toBe(true);
  expect(learningDeletionEpoch(sql())).toBe(clock + 2);
  expect(() => assertMemoryAccess(accessFor(roster).access)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => assertMemoryAccess(accessFor(roster, "other", "other-thread").access)).not.toThrow();
});

it("B still refuses a prepared frame that actually cites deleted A, including stale search hits after restart", async () => {
  const { captureThreadDeletion } = await import("./capture.ts");
  const { reconcileMemoryRoster } = await import("./policy.ts");
  const { closeDatabase } = await import("../database.ts");
  const roster = { bots: [{ id: "bot", threadId: THREAD, tasks: [{ threadId: "other-thread" }] }], groups: [] };
  reconcileMemoryRoster(roster);
  const { sourceId } = captureAndPublish("ZEBRA-PRIVATE launch date is Friday.");
  const row = sql().prepare("SELECT id,version FROM memory_records LIMIT 1").get()!;
  const bridge = { search: async () => ({ hits: [{ id: String(row.id), version: Number(row.version), score: 1, lexical: true }], vectorRows: 1, coverageComplete: true }) };
  const b = accessFor(roster, "bot", "other-thread").access;
  const bundle = await buildMemoryBundle("launch date", b, bridge, { allowance: LineageAllowance.tool() });
  expect(bundle.recordVersions.map(r => r.id)).toContain(String(row.id));
  const receipt = new MemoryDispatchReceipt(bundle, b, "engine");
  // A source-only lookup receipt must also refuse before cleanup changes source state.
  const { assertMemoryDisclosureCurrent } = await import("./disclosures.ts");
  sql().prepare("UPDATE memory_disclosures SET record_versions='[]',source_versions=? WHERE bundle_id=?").run(JSON.stringify([{ id: sourceId, revision: 1 }]), bundle.bundleId);
  expect(() => assertMemoryDisclosureCurrent(bundle.bundleId, b)).not.toThrow();
  const { INLINE_REVOCATION } = await import("./memory-revocation.ts");
  const ms = INLINE_REVOCATION.ms;
  try { INLINE_REVOCATION.ms = 0; transaction(db => captureThreadDeletion(db, THREAD)); }
  finally { INLINE_REVOCATION.ms = ms; }
  expect(sql().prepare("SELECT state FROM memory_sources WHERE id=?").get(sourceId)!.state).toBe("active");
  expect(() => assertMemoryDisclosureCurrent(bundle.bundleId, b)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => receipt.assertCurrent()).toThrow();
  closeDatabase();
  const after = await buildMemoryBundle("launch date", accessFor(roster, "bot", "other-thread").access, bridge, { allowance: LineageAllowance.tool() });
  expect(after.text).not.toContain("ZEBRA-PRIVATE");
  expect(after.recordVersions.map(r => r.id)).not.toContain(String(row.id));
});

// MAIN RULING 1115-RECALL-R7 (GrokBuild)
it('R7 accounts for a nonempty incremental tail and its real hydration', async () => {
  const { access } = accessFor();
  startLiveSession(access);
  const scans = sessionScans(), hydrated = vi.spyOn(bundleReader, 'hydrateDisclosedMemoryRecord');
  try {
    const first = new MemoryDispatchReceipt(await buildMemoryBundle('', access, emptyBridge, { allowance: LineageAllowance.tool() }), access, 'engine');
    first.sessionStarted('session-1'); first.accepted();
    expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, 'engine', 'session-1', access)).toBe(false);
    captureAndPublish('A later distinct fact.');
    for (const row of sql().prepare('SELECT id FROM messages WHERE thread_id=?').all(THREAD)) writeLineage(sql(), { threadId: THREAD, messageId: String(row.id), author: 'owner' }, {});
    const record = sql().prepare("SELECT id,version FROM memory_records WHERE kind='source'").get()!;
    const next = new MemoryDispatchReceipt(await buildMemoryBundle('later distinct', access, { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() }), access, 'engine');
    expect(next.bundle.recordVersions).toContainEqual({ id: record.id, version: record.version });
    next.sessionStarted('session-1'); next.accepted();
    hydrated.mockClear();
    const before = scans.work.tailRows;
    expect(continuationMemoryRevoked(LineageAllowance.tool(), THREAD, 'engine', 'session-1', access)).toBe(false);
    expect(scans.work.prefixes).toBe(1);
    expect(scans.work.tailRows - before).toBe(1);
    expect(hydrated.mock.calls.length).toBeGreaterThan(0);
  } finally { scans.restore(); hydrated.mockRestore(); }
});
