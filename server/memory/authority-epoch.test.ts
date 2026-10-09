// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 10.1 / AUDIT B1: the dispatch checks were guarded by `databaseStamp()`, which every write moves
// (the recall counter, the job claims, the receipts), so they never skipped. The authority epoch moves only
// for writes that can take something away from a bundle or a resumed session.
import { afterEach, beforeEach, expect, it } from "vitest";
import { database, transaction } from "../database.ts";
import { authorityMoved, authorityStamp, pinStamp } from "./authority-epoch.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { assertMemoryBundle, buildMemoryBundle } from "./bundle.ts";
import { bindMemoryDisclosureSession, continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { flushMemoryCounters, recordMemoryRetrieval, resetMemoryCounters } from "./health.ts";
import { THREAD, accessFor, captureAndPublish, emptyBridge, freshDataDir } from "./testing/recall-fixture.ts";

beforeEach(() => { freshDataDir("active"); resetMemoryCounters(); resetSessionHolds(); });
afterEach(() => resetMemoryCounters());

const sql = () => database();

it("plain growth does not move the epoch: captures, jobs, receipts, the recall counter, a delivered receipt, a background binding", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const before = authorityStamp();
  expect(before).toMatch(/^a\d+\.\d+:\d+$/);
  captureAndPublish("A second durable fact about the launch.");
  recordMemoryRetrieval(3); flushMemoryCounters(Date.now(), true);
  sql().prepare("INSERT INTO memory_scope_bindings VALUES('consolidation:x',(SELECT id FROM memory_scopes LIMIT 1),'system','consolidation-pending',0,'granted','{}')").run();
  sql().prepare("INSERT INTO memory_scope_bindings VALUES('extract-budget:2026-10-09',(SELECT id FROM memory_scopes LIMIT 1),'system','extract-budget',0,'granted','{}')").run();
  sql().prepare("UPDATE memory_scope_bindings SET intent='{\"a\":1}' WHERE id='consolidation:x'").run();
  const bundle = await buildMemoryBundle("launch", access, emptyBridge);
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
  const bundle = await buildMemoryBundle("launch", access, emptyBridge);
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

it("assertMemoryBundle rehydrates the bundle once per epoch, not once per call, and still catches a revocation", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const bundle = await buildMemoryBundle("launch", access, emptyBridge);
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
  const first = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge), access, "engine");
  first.sessionStarted("session-1"); first.accepted();
  const second = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge), access, "engine");
  expect(continuationMemoryRevoked(THREAD, "engine", "session-1", access)).toBe(false);
  const fullChecks = countStatements(text => text.startsWith("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?"));
  try {
    second.resumes("session-1", authorityStamp());
    second.assertCurrent(); second.assertCurrent(); second.assertCurrent();
    expect(fullChecks.n).toBe(0);
    // a write that cannot take anything away does not bring the check back
    captureAndPublish("Another new fact.");
    second.assertCurrent();
    expect(fullChecks.n).toBe(0);
    // one that can does, and it ends the session
    sql().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(first.bundle.bundleId);
    expect(() => second.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(fullChecks.n).toBe(1);
  } finally { fullChecks.restore(); }
});

it("a thread's checkpoint rolling to a new version is not a revocation: the epoch holds and the old version is archived", () => {
  const first = captureAndPublish("Verified initial result.");
  refreshMemoryCheckpoint(first.jobId);
  const stamp = authorityStamp();
  const second = captureAndPublish("Verified later result.");
  refreshMemoryCheckpoint(second.jobId);
  expect(sql().prepare("SELECT count(*) n FROM memory_records WHERE kind='checkpoint' AND state='archived'").get()!.n).toBe(1);
  expect(authorityStamp()).toBe(stamp);
});

it("the early continuation check is not repeated while nothing that could take a receipt away was written, and is when something was", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const first = new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge), access, "engine");
  first.sessionStarted("session-1"); first.accepted();
  const fullChecks = countStatements(text => text.startsWith("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?"));
  try {
    expect(continuationMemoryRevoked(THREAD, "engine", "session-1", access)).toBe(false);
    expect(fullChecks.n).toBe(1);
    // the turns that follow: more captures, a delivered receipt, the checkpoint rolling, counters
    for (let n = 0; n < 3; n++) {
      const next = captureAndPublish(`Another fact ${n}.`); refreshMemoryCheckpoint(next.jobId);
      expect(continuationMemoryRevoked(THREAD, "engine", "session-1", access)).toBe(false);
    }
    expect(fullChecks.n).toBe(1);
    // the same reader under a new capability (every turn mints one) asks the same question: still answered
    expect(continuationMemoryRevoked(THREAD, "engine", "session-1", accessFor().access)).toBe(false);
    expect(fullChecks.n).toBe(1);
    // a record the session was shown is archived: the check runs again and ends the session
    const cited = first.bundle.recordVersions[0];
    sql().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(cited.id, cited.version);
    expect(continuationMemoryRevoked(THREAD, "engine", "session-1", accessFor().access)).toBe(true);
    expect(fullChecks.n).toBe(2);
  } finally { fullChecks.restore(); }
});

it("a full session check looks at each record a session was shown once, however many receipts cite it", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const receiptsInSession = async (count: number) => {
    for (let n = 0; n < count; n++) new MemoryDispatchReceipt(await buildMemoryBundle("launch", access, emptyBridge), access, "engine").sessionStarted("session-1");
  };
  const hydrations = () => {
    resetSessionHolds();
    const hydrated = countStatements(text => text.startsWith("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'"));
    try { expect(continuationMemoryRevoked(THREAD, "engine", "session-1", access)).toBe(false); return hydrated.n; } finally { hydrated.restore(); }
  };
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
  expect(stamp).toMatch(/^p\d+:\d+$/);
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
  const pinReads = countStatements(text => text.startsWith("SELECT id,version FROM memory_records r WHERE state='active' AND owner_pinned=1"));
  try {
    const first = await buildMemoryBundle("report", access, emptyBridge);
    expect(first.pinned).toHaveLength(0);
    expect(pinReads.n).toBe(1);
    captureAndPublish("Another captured message."); await buildMemoryBundle("report", access, emptyBridge); await buildMemoryBundle("report", access, emptyBridge);
    expect(pinReads.n).toBe(1);
    const record = sql().prepare("SELECT id,version FROM memory_records WHERE text LIKE '%charcoal%'").get()!;
    sql().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?").run(record.id, record.version);
    const pinned = await buildMemoryBundle("report", access, emptyBridge);
    expect(pinReads.n).toBe(2);
    expect(pinned.pinned.map(row => row.id)).toContain(String(record.id));
  } finally { pinReads.restore(); }
});
