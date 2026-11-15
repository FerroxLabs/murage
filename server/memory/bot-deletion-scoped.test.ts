// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { captureBotDeletion, captureThreadDeletion } from "./capture.ts";
import { learningDeletionEpoch } from "./deny.ts";
import { createRevocationJob, forgetJob, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { authorityParts, authorityStamp } from "./authority-epoch.ts";
import { stampFreshSession, WritetimeFixture } from "./testing/writetime-fixture.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => stopMemoryRevocation());
const empty = { search: async () => ({ hits: [], vectorRows: 0 }) };
function world() {
  const roster: MemoryRoster = { bots: ["a", "b", "c", "gone"].map(id => ({ id, threadId: `t-${id}`, section: "team" })), groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = (botId: string) => {
    const threadId = `t-${botId}`, generation = registry.begin(botId, threadId);
    const token = registry.mint({ botId, threadId, generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  return { access, roster };
}
it("S6.rePreparing: three held unrelated receipts survive idle bot deletion before acceptance and after cleanup", async () => {
  const w = world();
  const held = await Promise.all(["a", "b", "c"].map(async id => {
    const access = w.access(id);
    const bundle = await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() });
    const receipt = new MemoryDispatchReceipt(bundle, access, "claude");
    receipt.assertCurrent();
    return { access, receipt };
  }));
  const before = learningDeletionEpoch(database());
  const watermarks = () => database().prepare("SELECT key,value FROM memory_lineage_lsn_meta WHERE key IN ('policy_bump_lsn','epoch_bump_lsn') ORDER BY key").all();
  const foreground = watermarks();
  transaction(db => captureBotDeletion(db, "gone"));
  expect(learningDeletionEpoch(database())).toBeGreaterThan(before);
  expect(watermarks()).toEqual(foreground);
  for (const h of held) expect(() => h.receipt.assertCurrent()).not.toThrow();
  // A persisted old-format bot cleanup must not sweep unrelated receipts on restart either.
  transaction(db => createRevocationJob(db, forgetJob({ epoch: 999, cause: "bot-deletion", scopes: [], phases: ["all", "done"] })));
  runRevocationJobsNow(database());
  for (const [i, h] of held.entries()) {
    expect(() => assertMemoryAccess(h.access)).not.toThrow();
    h.receipt.sessionStarted(`session-${i}`);
    expect(() => h.receipt.accepted()).not.toThrow();
  }
});
it("deletion guards: deleted own and composite scopes refuse old access and dependent prepared receipts", async () => {
  const w = world(), access = w.access("gone"), scope = ensureScope("bot", "gone");
  const composite = ensureScope("bot", "gone#project:desk");
  database().prepare("INSERT INTO memory_records VALUES('private-record',1,?,'fact','private','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  const bundle = await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() });
  expect(bundle.recordVersions.map(r => r.id)).toContain("private-record");
  const receipt = new MemoryDispatchReceipt(bundle, access, "claude");
  transaction(db => captureBotDeletion(db, "gone"));
  expect(() => assertMemoryAccess(access)).toThrow();
  expect(() => assertMemoryAccess(access, scope)).toThrow();
  expect(() => receipt.assertCurrent()).toThrow();
  for (const id of [scope, composite]) expect(database().prepare("SELECT 1 FROM memory_deny WHERE kind='scope' AND id=?").get(id)).toBeTruthy();
  runRevocationJobsNow(database());
  expect(database().prepare("SELECT text FROM memory_records WHERE id='private-record'").get()!.text).toBe("");
  expect(() => receipt.accepted()).toThrow();
});
it("deletion guards: global policy and a deleted conversation still revoke old access", () => {
  const w = world(), a = w.access("a"), b = w.access("b");
  transaction(db => captureThreadDeletion(db, "t-a"));
  expect(() => assertMemoryAccess(a)).toThrow();
  expect(() => assertMemoryAccess(b)).not.toThrow();
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  expect(() => assertMemoryAccess(b)).toThrow("MEMORY_CONTEXT_REVOKED");
});

it("a peer receipt citing a deleted notebook refuses before cleanup, without revoking an unrelated receipt", async () => {
  const w = world(), scope = ensureScope("bot", "gone");
  database().prepare("INSERT INTO memory_scope_bindings VALUES('peer-grant',?,'bot','a',0,'granted','{}')").run(scope);
  database().prepare("INSERT INTO memory_records VALUES('shared-record',1,?,'fact','shared fact','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  const access = w.access("a");
  const bundle = await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() });
  expect(bundle.recordVersions.map(r => r.id)).toContain("shared-record");
  const receipt = new MemoryDispatchReceipt(bundle, access, "claude");
  transaction(db => captureBotDeletion(db, "gone"));
  expect(() => assertMemoryAccess(access)).not.toThrow();
  expect(() => receipt.assertCurrent()).toThrow();
  expect(() => receipt.accepted()).toThrow();
});

it.each([false, true])("S6.rePreparing: three unrelated resumed sessions over 1,024 receipts accept across bot deletion and cleanup (roster removal: %s)", async (removeRoster) => {
  const w = world(), db = database(), fixture = new WritetimeFixture(db);
  const gone = ensureScope("bot", "gone");
  // Exercise real cleanup writes, not just deletion of an empty notebook.
  fixture.source("gone-source", gone, { thread: "t-gone" }).record("gone-record", 1, gone, ["gone-source"]);
  const held = [];
  // Establish every reader's audience before warming any session.
  const readers = ["a", "b", "c"].map(id => ({ id, access: w.access(id) }));
  const hard = authorityParts()!.hard;
  for (const { id, access } of readers) {
    const session = `warm-${id}`;
    stampFreshSession(db, access.threadId, "claude", session);
    // Warm incrementally as normal turns do: no single check exceeds the cold bound.
    for (let page = 0; page < 3; page++) {
      transaction(() => {
        for (let n = 0; n < 400; n++) fixture.receipt(`${id}-${page}-${n}`, access.threadId, "claude", session);
      });
      expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", session, access)).toBe(false);
    }
    const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() }), access, "claude");
    receipt.resumes(session);
    receipt.sessionStarted(session);
    expect(() => receipt.assertCurrent()).not.toThrow();
    held.push(receipt);
  }
  expect(authorityParts()!.hard).toBe(hard);
  if (removeRoster) {
    const next = { ...w.roster, bots: w.roster.bots.filter(bot => bot.id !== "gone") };
    persistMemoryRoster(next, () => { w.roster.bots = next.bots; });
    for (const receipt of held) expect(() => receipt.accepted()).not.toThrow();
  }
  transaction(tx => captureBotDeletion(tx, "gone"));
  // Persist the deferred path even when the inline cleanup happens to finish within its time slice.
  transaction(tx => createRevocationJob(tx, forgetJob({ scopes: [gone], cause: "bot-deletion", phases: ["scope", "done"] })));
  for (const receipt of held) expect(() => receipt.accepted()).not.toThrow();
  runRevocationJobsNow(db);
  expect(db.prepare("SELECT text FROM memory_records WHERE id='gone-record'").get()!.text).toBe("");
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='gone-source'").get()!.state).toBe("deleted");
  for (const receipt of held) {
    expect(() => receipt.assertCurrent()).not.toThrow();
    expect(() => receipt.accepted()).not.toThrow();
  }
  // Losing a proof still fails closed at the cold bound; the regression must use warm holds.
  resetSessionHolds();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "t-a", "claude", "warm-a", held[0].access, why)).toBe(true);
  expect(why.reason).toBe("memory-changed (long-session)");
});

it.each(["record", "source", "evidence"])("a resumed peer session citing a deleted scope via %s refuses even when its new frame does not cite it", async (via) => {
  const w = world(), scope = ensureScope("bot", "gone"), db = database();
  db.prepare("INSERT INTO memory_scope_bindings VALUES('peer-grant',?,'bot','a',0,'granted','{}')").run(scope);
  const fixture = new WritetimeFixture(db);
  fixture.record("peer-record", 1, scope, [], { assertion: "owner-statement" });
  fixture.source("peer-source", scope, { thread: "t-gone" });
  const ownScope = ensureScope("bot", "a");
  fixture.record("evidence-record", 1, ownScope, ["peer-source"], { assertion: "owner-statement" });
  const access = w.access("a"), session = "peer-session";
  stampFreshSession(db, access.threadId, "claude", session);
  fixture.receipt("old-peer", access.threadId, "claude", session);
  db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE bundle_id='old-peer'").run(
    JSON.stringify(via === "source" ? [] : [{ id: via === "record" ? "peer-record" : "evidence-record", version: 1 }]),
    JSON.stringify(via === "source" ? [{ id: "peer-source", revision: 1 }] : []));
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", session, access)).toBe(false);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() }), access, "claude");
  expect(receipt.bundle.recordVersions).toEqual([]);
  receipt.resumes(session, authorityStamp());
  // The deletion's committed scope deny must suffice before cleanup can touch the old receipt or its citations.
  db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,0,0)").run(scope);
  expect(() => receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");
  transaction(tx => captureBotDeletion(tx, "gone"));
  expect(() => receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");
  runRevocationJobsNow(db);
  expect(() => receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");
});

it("scope cleanup keeps unknown tombstones and record ids spanning notebooks on the hard fallback", () => {
  world();
  const db = database(), fixture = new WritetimeFixture(db), scope = ensureScope("bot", "gone");
  fixture.record("moved-record", 1, scope).record("moved-record", 2, ensureScope("bot", "a"));
  transaction(tx => captureBotDeletion(tx, "gone"));
  const before = authorityParts()!;
  fixture.tombstone("record", "moved-record");
  const moved = authorityParts()!;
  expect(moved.hard).not.toBe(before.hard);
  fixture.tombstone("source", "missing-source");
  expect(authorityParts()!.hard).not.toBe(moved.hard);
});

it("only readable bot cleanup jobs confined to already denied scopes preserve hard authority", () => {
  world();
  const db = database(), scope = ensureScope("bot", "gone");
  const hard = authorityParts()!.hard;
  createRevocationJob(db, forgetJob({ scopes: [scope], cause: "bot-deletion" }));
  const undenied = authorityParts()!.hard;
  expect(undenied).not.toBe(hard);
  transaction(tx => captureBotDeletion(tx, "gone"));
  const denied = authorityParts()!.hard;
  const id = createRevocationJob(db, forgetJob({ scopes: [scope], cause: "bot-deletion" }))!;
  expect(authorityParts()!.hard).toBe(denied);
  db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.v',999) WHERE id=?").run(id);
  expect(authorityParts()!.hard).not.toBe(denied);
  const incomplete = createRevocationJob(db, forgetJob({ scopes: [scope], cause: "bot-deletion" }))!;
  const beforeIncomplete = authorityParts()!.hard;
  db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.v') WHERE id=?").run(incomplete);
  expect(authorityParts()!.hard).not.toBe(beforeIncomplete);
});
