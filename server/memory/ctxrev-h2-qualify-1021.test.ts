// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// CTXREV H2 A-4 (arbiter row A-4, Astra NO): the owner-turn recovery (send-fence.ts settleHeldContext from lineage-write.ts
// proposeTurnParents) was qualified only on one fresh in-process store. These witnesses run the same recovery on the profile states the
// field reported: a fresh profile through two turns, a profile reopened from disk (restart or upgrade-in-place: the schema steps run again
// on an existing file), and a profile already affected by the 1.0.20 outage (receipts revoked install-wide before the turn, and a revoke
// marker still undrained when the turn starts). Flux/HTTP non-worsening is the openai-chat-retained suite run on both v1.0.20 and this
// branch (DONE.md); the HTTP pre-submission refusal (dispatch.ts:238) is unchanged and is NOT claimed fixed here.
// Owners: lane cause1-r3-1021e owns these witnesses; ctxrev-h2-retained owns the recovery; canary owners own packaged-build field rows.
// Real store, real lineage writer, real receipt revoke, real send fence and the real consuming response gate; nothing under test is mocked.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { bindConsumingTurn, emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { doorReader } from "../bot-read.ts";
import { refsLookup } from "./deny-read.ts";
import { addTurnParents, checkedOpenTurns, closeTurnLineage, currentLsn, openTurnLineage, refuseRetainedTurn } from "./lineage-write.ts";
import type { LineageReader, LineageRef, LineageVerdict } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { revokeAllDisclosures } from "./revocation.ts";
import { replyHiddenFromBots } from "./revoke-commit.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";

const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const newStore = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

/** A delivered memory receipt for the thread, as the recall door writes it. */
function deliverReceipt(threadId: string, bundleId: string): void {
  const db = database();
  const meta = db.prepare("SELECT policy_revision AS p, deletion_epoch AS e FROM memory_meta WHERE id=1").get() as { p: number; e: number };
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,'[]','[]','[]',?,?,?,?,?)")
    .run(bundleId, threadId, "fixture", meta.p, meta.e, 10, "delivered", Date.now());
}
/** One owner turn whose prompt is with the engine: it holds a fresh receipt and its thread's prefix. */
function ownerTurn(store: Store, threadId: string, botId: string, turnId: string, keep: (verdict?: LineageVerdict) => boolean) {
  const earlier = store.appendMessage(threadId, { role: "bot", kind: "text", text: `Earlier answer before ${turnId}.` });
  const db = database();
  deliverReceipt(threadId, `bundle-${turnId}`);
  const turn = openTurnLineage(db, { threadId, turnId });
  const refused: LineageVerdict[] = [];
  prepareRetainedFence(turn, OWNER, verdict => { refused.push(verdict); }, db, keep);
  const receipt: LineageRef = { kind: "receipt", bundleId: `bundle-${turnId}`, lsn: currentLsn(db), scopeIds: [] };
  addTurnParents(turn, [receipt, { kind: "prefix", threadId, held: null, shown: [earlier.id], content: true }]);
  expect(() => assertRetainedFence(turn, db)).not.toThrow();
  const binding = bindConsumingTurn({
    identity: { botId, threadId, dispatchGeneration: turnId, lineageTurnIds: [turnId], adapterLeaseId: turnId },
    turn, db, isCurrent: () => true, onLedgerRefused: verdict => { for (const member of checkedOpenTurns(turn)) refuseRetainedTurn(member, verdict); },
  });
  const reply = () => {
    const write = vi.fn(() => "written");
    emitConsumingTurnResponse(binding, registerConsumingDescriptor("native:openai:tool-append", "native"), { bytes: 8, refs: [], write });
    return write;
  };
  return { db, turn, refused, receipt, reply };
}
const kinds = (turn: { parents: readonly LineageRef[] }) => turn.parents.map(ref => ref.kind).sort();

it("Q1 fresh profile: the first owner turn survives an install-wide receipt revoke and the next turn on the same thread runs clean", () => {
  const store = newStore();
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const keep = vi.fn(() => true);
  const first = ownerTurn(store, bot.threadId, bot.id, "turn-q1-a", keep);
  try {
    revokeAllDisclosures(first.db, "roster"); drainRevokeMarker(first.db);
    expect(refsLookup(first.db, [first.receipt], OWNER)).toEqual({ state: "withheld", reason: "deny-memory" });
    // v1.0.20: MEMORY_CONTEXT_REVOKED, the turn is sealed and the owner sees the refusal card
    expect(first.reply()).toHaveBeenCalledTimes(1);
    expect(first.refused).toEqual([]);
    expect(kinds(first.turn)).toEqual(["prefix"]);
    // cause1 r6 (Astra BLOCK a8537e2ff1, recovery row): the reply this recovery lets the turn store is one v1.0.20 refused; it is kept for
    // the owner only, so it carries the hide mark every non-owner reader checks (RED with send-fence.ts keepOwnerTurn `noReplay = true` off)
    const kept = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Your locker combination is 31-07-44.", turnId: "turn-q1-a" });
    expect(replyHiddenFromBots(first.db, bot.threadId, kept.id)).toBe(true);
    expect(refsLookup(first.db, [{ kind: "line", threadId: bot.threadId, messageId: kept.id }], doorReader()).state).toBe("withheld");
  } finally { closeTurnLineage(first.turn); }
  const second = ownerTurn(store, bot.threadId, bot.id, "turn-q1-b", keep);
  try {
    expect(second.reply()).toHaveBeenCalledTimes(1);
    expect(second.refused).toEqual([]);
    expect(kinds(second.turn)).toEqual(["prefix", "receipt"]);
    // guard: the next turn ran clean, its reply is no kept reply and stays readable
    const clean = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "The weekly report goes out on Mondays.", turnId: "turn-q1-b" });
    expect(replyHiddenFromBots(second.db, bot.threadId, clean.id)).toBe(false);
  } finally { closeTurnLineage(second.turn); }
});

it("Q2 profile reopened from disk (restart or upgrade-in-place): the recovery runs on the reopened file", () => {
  const before = newStore();
  const bot = before.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  before.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Please draft the weekly summary." });
  deliverReceipt(bot.threadId, "bundle-before-restart");
  // the process stops; the next start opens the same file and runs the schema steps again
  closeMessageDb(); closeDatabase();
  const store = newStore();
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id='bundle-before-restart'").get()).toEqual({ state: "delivered" });
  const t = ownerTurn(store, bot.threadId, bot.id, "turn-q2", () => true);
  try {
    revokeAllDisclosures(t.db, "import"); drainRevokeMarker(t.db);
    expect(t.reply()).toHaveBeenCalledTimes(1);
    expect(t.refused).toEqual([]);
    expect(kinds(t.turn)).toEqual(["prefix"]);
  } finally { closeTurnLineage(t.turn); }
});

it("Q3 profile already affected by the outage: earlier receipts revoked install-wide and a revoke marker still undrained when the turn starts", () => {
  const store = newStore();
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  // what 1.0.20 left behind: several install-wide revokes (cause=roster|import), receipts all revoked
  deliverReceipt(bot.threadId, "bundle-old-1"); deliverReceipt(bot.threadId, "bundle-old-2");
  revokeAllDisclosures(database(), "roster"); drainRevokeMarker(database());
  revokeAllDisclosures(database(), "import");
  closeMessageDb(); closeDatabase();
  const reopened = newStore();
  expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()).toEqual({ n: 2 });
  const t = ownerTurn(reopened, bot.threadId, bot.id, "turn-q3", () => true);
  try {
    // the turn's own fresh receipt is flipped by the next install-wide revoke while the turn runs; the old marker drains with it
    revokeAllDisclosures(t.db, "roster"); drainRevokeMarker(t.db);
    expect(t.reply()).toHaveBeenCalledTimes(1);
    expect(t.refused).toEqual([]);
    expect(kinds(t.turn)).toEqual(["prefix"]);
    expect(t.reply()).toHaveBeenCalledTimes(1);
  } finally { closeTurnLineage(t.turn); }
});

// 1.0.21 cause1 r2 (ASTRA BLOCK cc23a2e93e, MAIN ruling (a)): a held receipt that is malformed fails closed whatever else it reads as. Before,
// receiptVerdict answered "revoked" (withheld deny-memory) before it validated, and contentReceiptVerdict answered a missing record before it
// reached a later malformed entry; the owner keep rule (CTXREV H2 settleHeldContext) then dropped the receipt and the turn kept writing. RED
// on cc23a2e93e and with deny-read.ts receiptVerdict's malformedReceiptRow check off; the keep guard alone is witnessed by Q5.
it.each(["revoked", "withheld"])("Q4 cause1 r2: a %s receipt that is also malformed refuses the owner turn instead of being dropped", shape => {
  const store = newStore();
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const t = ownerTurn(store, bot.threadId, bot.id, `turn-q4-${shape}`, () => true);
  try {
    if (shape === "revoked") {
      revokeAllDisclosures(t.db, "roster"); drainRevokeMarker(t.db);
      t.db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE bundle_id=?").run(t.receipt.kind === "receipt" ? t.receipt.bundleId : "");
    } else {
      t.db.prepare(`UPDATE memory_disclosures SET record_versions='[{"id":"fixture-gone","version":1},{"id":"fixture-bad","version":0}]' WHERE bundle_id=?`)
        .run(t.receipt.kind === "receipt" ? t.receipt.bundleId : "");
    }
    expect(refsLookup(t.db, [t.receipt], OWNER)).toEqual({ state: "checking", reason: "lookup-error" });
    let written = 0;
    try { written = t.reply().mock.calls.length; } catch { written = 0; }
    expect(written).toBe(0);
    expect(t.refused.length).toBeGreaterThan(0);
    expect(kinds(t.turn)).toContain("receipt");
  } finally { closeTurnLineage(t.turn); }
});
// The 1.0.20 revokekeep path (a release that re-checks only what the turn holds, send-fence.ts keepOwnerTurn without a proposal): a valid
// revoked receipt is still dropped and the turn continues (Sean's ruling, the guard row); the same receipt made malformed refuses. RED with
// send-fence.ts keepOwnerTurn's malformedHeldReceipt guard off.
it.each(["valid", "malformed"])("Q5 cause1 r2: revokekeep with no proposal keeps a %s revoked receipt's turn only when the receipt is valid", shape => {
  const store = newStore();
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const t = ownerTurn(store, bot.threadId, bot.id, `turn-q5-${shape}`, () => true);
  try {
    revokeAllDisclosures(t.db, "roster"); drainRevokeMarker(t.db);
    if (shape === "malformed") t.db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE bundle_id=?").run(t.receipt.kind === "receipt" ? t.receipt.bundleId : "");
    if (shape === "valid") {
      expect(() => assertRetainedFence(t.turn, t.db)).not.toThrow();
      expect(t.refused).toEqual([]);
      expect(kinds(t.turn)).toEqual(["prefix"]);
    } else {
      expect(() => assertRetainedFence(t.turn, t.db)).toThrow();
      expect(t.refused.length).toBeGreaterThan(0);
      expect(kinds(t.turn)).toContain("receipt");
    }
  } finally { closeTurnLineage(t.turn); }
});
// 1.0.21 cause1 defer (ASTRA BLOCK dc8bbebef2): the owner turn's A-5 pending continue. The held prefix reads pending ahead of a malformed held
// receipt, so the combined verdict is checking:pending; the turn is refused as lookup-error (no pending wait, no rebuild from the same input)
// and never continued. RED on dc8bbebef2 (the refusal read pending) and with send-fence.ts checkRetainedFence's malformedHeldReceipt refusal
// off (A-5 continues the turn).
it("Q6 cause1 defer: an owner turn whose pending held prefix hides a malformed receipt is refused as lookup-error, never continued", () => {
  const store = newStore();
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const earlier = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Earlier answer before turn-q6." });
  const db = database();
  deliverReceipt(bot.threadId, "bundle-turn-q6");
  const turn = openTurnLineage(db, { threadId: bot.threadId, turnId: "turn-q6" });
  const refused: LineageVerdict[] = [];
  const keep = vi.fn(() => true);
  prepareRetainedFence(turn, OWNER, verdict => { refused.push(verdict); }, db, keep);
  try {
    const prefix: LineageRef = { kind: "prefix", threadId: bot.threadId, held: currentLsn(db), shown: [earlier.id], content: true };
    const receipt: LineageRef = { kind: "receipt", bundleId: "bundle-turn-q6", lsn: currentLsn(db), scopeIds: [] };
    addTurnParents(turn, [prefix, receipt]);
    expect(() => assertRetainedFence(turn, db)).not.toThrow();
    db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE bundle_id='bundle-turn-q6'").run();
    db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(bot.threadId, 1, 1);
    expect(refsLookup(db, [prefix, receipt], OWNER)).toEqual({ state: "checking", reason: "pending" });
    let thrown: unknown;
    try { assertRetainedFence(turn, db); } catch (error) { thrown = error; }
    expect((thrown as { fence?: LineageVerdict } | undefined)?.fence).toEqual({ state: "checking", reason: "lookup-error" });
    expect(refused).toEqual([{ state: "checking", reason: "lookup-error" }]);
    expect(keep).not.toHaveBeenCalled();
    expect(kinds(turn)).toEqual(["prefix", "receipt"]);
  } finally { closeTurnLineage(turn); }
});
