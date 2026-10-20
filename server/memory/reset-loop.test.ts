// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.1.1: after one install-wide receipt revocation (a roster or settings
// change), persistent bot threads reset their engine session on nearly every
// turn ("memory continuation reset ... reason=memory-changed
// (receipt-already-revoked)"), each reset a cold engine start. One revoke must
// cost exactly one reset. These turns run the real pipeline (Store messages,
// settlement, capture jobs, checkpoint refresh, frame receipts) and make the
// same checks, in the same order, as a direct turn (index.ts): the early
// continuation check, the dispatch check, then the owner's direct replay.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked, filterDirectReplay, replayBudgetBytes, REPLAY_BUDGET_CAP_BYTES } from "./disclosures.ts";
import { revokeAllDisclosures } from "./revocation.ts";
import { lineageCacheCounts, lineageListingFallbacks, sessionLineageBad } from "./replay-lineage.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { isMurageVoice } from "../murage-voice.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

/** The owner forgets a reply: the owner action (forget.ts commits the revoke, DESIGN-WRITETIME 3), then the marker drains so the marks are exact. A raw
 * UPDATE of the source row is not an owner action and writes no mark. */
function forgetReply(threadId: string, messageId: string) {
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:${threadId}:${messageId}` });
  drainRevokeMarker(database());
}
const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
// (1.0.2: these run on the PRODUCTION lineage allowance. A turn's checks share the one allowance the server gives a turn's setup, as index.ts
// startTurn does; the turn function below runs inside it.)
// closeDatabase stops the WAL checkpointer without waiting: one alive when the data dir is rebuilt deletes the new file's -wal by path.
beforeEach(async () => { closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("reset-loop");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "reset-loop", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

/** Recall that finds the bot's latest captured replies, as a prompt like the last one does (the perf rig's turns): each
 * frame then cites the reply before it, whose receipt cited the one before that, the whole conversation long. */
const recallLatestReplies = (threadId: string) => ({ search: async () => {
  const rows = database().prepare(`SELECT r.id, r.version FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version
    JOIN memory_sources s ON s.id=e.source_id WHERE s.thread_id=? AND s.kind='text' AND s.speaker!='owner' AND r.kind='source' AND r.state='active' ORDER BY s.rowid DESC LIMIT 2`).all(threadId);
  return { hits: rows.map(row => ({ id: String(row.id), version: Number(row.version), score: 1, lexical: true })), vectorRows: rows.length, coverageComplete: true };
} });

/** `long`: the turn settles completed as the server's terminal event does (index.ts) and recall finds the latest replies,
 * so every frame cites the reply before it (a lineage as long as the conversation). */
function world(engine = "claude", { long = false }: { long?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: engine, model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Sable" });
  setMemoryMode("active");
  const threadId = bot.threadId;
  const roster = (): MemoryRoster => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin(bot.id, threadId);
    const token = registry.mint({ botId: bot.id, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
  };
  let session = "S-1", sessions = 1;
  const resets: string[] = [];
  /** One direct turn: the owner's line, the two continuation checks, the
   * replay, the frame receipt on the (possibly new) session and the reply. */
  const turn = (n: number) => turnWithin(n);
  const turnWithin = async (n: number) => {
    const allowance = LineageAllowance.turn();
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Tell me about item ${n} please.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
    const a = access();
    // index.ts: the early check (it persists what it finds, and logs nothing)
    const earlyWhy: { reason?: string } = {};
    const early = n > 1 && continuationMemoryRevoked(allowance, threadId, engine, session, a, earlyWhy);
    // the dispatch check, whose reason is the one the log line carries
    const why: { reason?: string } = {};
    const revoked = n > 1 && continuationMemoryRevoked(allowance, threadId, engine, session, a, why);
    if (early || revoked) { resets.push(`${earlyWhy.reason ?? "-"} | ${why.reason ?? "-"}`); session = `S-${++sessions}`; }
    filterDirectReplay(allowance, threadId, store.activePath(threadId) as never, a, new Set());
    const bundle = await buildMemoryBundle(`item ${n}`, a, long ? recallLatestReplies(threadId) : bridge, {allowance: allowance});
    const receipt = new MemoryDispatchReceipt(bundle, a, engine);
    receipt.sessionStarted(session); receipt.accepted();
    // index.ts writes the session's lineage row when the session starts or resumes (write-time privacy, DESIGN-WRITETIME 2.7)
    markSessionKnown(threadId, engine, session, bot.id);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Item ${n} is a blue widget with ${n} parts.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    if (long) recordMemorySettlement(threadId, `t${n}`, "completed");
    drain();
  };
  return { store, threadId, turn, resets, access, session: () => session };
}

/** What a roster or settings change does: a new policy revision and every receipt revoked. */
function installWideRevoke() {
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  revokeAllDisclosures(database(), "roster");
}

it("one install-wide revoke costs exactly one reset, then the new session holds for three more turns", async () => {
  const w = world();
  for (let n = 1; n <= 4; n++) await w.turn(n);
  expect(w.resets).toEqual([]);
  installWideRevoke();
  await w.turn(5);
  // the early check and the dispatch check agree on why
  expect(w.resets).toEqual(["writetime-watermark | writetime-watermark"]);
  for (let n = 6; n <= 8; n++) await w.turn(n);
  expect(w.resets).toHaveLength(1);
  expect(w.session()).toBe("S-2");
});

it("an ACP engine (Grok-like): an install-wide revoke over every saved record, then several owner turns, resets at most once", async () => {
  const w = world("grok");
  for (let n = 1; n <= 4; n++) await w.turn(n);
  installWideRevoke();
  for (let n = 5; n <= 10; n++) await w.turn(n);
  expect(w.resets).toHaveLength(1);
  expect(w.session()).toBe("S-2");
});

it("a second revoke later costs one more reset, never a loop", async () => {
  const w = world();
  for (let n = 1; n <= 3; n++) await w.turn(n);
  installWideRevoke();
  for (let n = 4; n <= 6; n++) await w.turn(n);
  installWideRevoke();
  for (let n = 7; n <= 9; n++) await w.turn(n);
  expect(w.resets).toHaveLength(2);
});

it("a content change after the reset still ends the new session: forgetting what its memory rests on", async () => {
  const w = world();
  for (let n = 1; n <= 3; n++) await w.turn(n);
  installWideRevoke();
  for (let n = 4; n <= 5; n++) await w.turn(n);
  expect(w.resets).toHaveLength(1);
  // the owner forgets the bot's first reply, which the new session's frame cites through the checkpoint
  // (the bot's own reply: the greeting before it is a Murage line, which never becomes a memory source, S6 rule 22)
  const first = w.store.activePath(w.threadId).find(m => m.role === "bot" && !isMurageVoice(m))!;
  forgetReply(w.threadId, first.id);
  await w.turn(6);
  expect(w.resets).toHaveLength(2);
});

it("the replay a reset turn carries on a long thread is bounded and quick to assemble (timed)", windowsPerfBudget(), () => {
  // 3,000 turns of about 1.5 KB a line (9 MB of history) in one engine
  // session, every reply linked to its turn's receipt, then an install-wide
  // revoke: the reset turn's replay as a direct owner turn assembles it.
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Sable" });
  setMemoryMode("active");
  const roster = (): MemoryRoster => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const registry = new InternalCapabilities();
  const a = () => { const generation = registry.begin(bot.id, bot.threadId); const token = registry.mint({ botId: bot.id, threadId: bot.threadId, generation, depth: 0, kind: "memory", skillAuthoring: false }); return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster); };
  const first = a();
  const filler = "x".repeat(1_500);
  const messages: Array<{ id: string; role: string; kind: string; text: string }> = [];
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,'delivered',?)");
  // 1.0.2: the lines are stored (the write-time layer judges stored lines; a line it never saw reads "checking" and is withheld)
  const stored: Array<{ id: string; role: string; kind: string; text: string }> = [];
  for (let turn = 0; turn < 3_000; turn++) {
    stored.push(store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `owner ${turn} ${filler}`, origin: "desktop" } as never) as never,
      store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `sable ${turn} ${filler}`, turnId: `t${turn}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never) as never);
  }
  database().exec("BEGIN");
  for (let turn = 0; turn < 3_000; turn++) {
    messages.push(stored[2 * turn], stored[2 * turn + 1]);
    insert.run(`R${turn}`, bot.threadId, "claude", "S-long", "[]", "[]", JSON.stringify([stored[2 * turn + 1].id]), first.policyRevision, first.deletionEpoch, turn);
  }
  database().exec("COMMIT");
  installWideRevoke();
  const started = performance.now();
  const { replayed, omitted } = filterDirectReplay(LineageAllowance.tool(), bot.threadId, messages, a(), new Set(), { maxBytes: replayBudgetBytes(200_000) });
  const ms = performance.now() - started;
  const bytes = replayed.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0);
  console.info(`reset replay: lines=${replayed.length} omitted=${omitted} bytes=${bytes} ms=${ms.toFixed(0)}`);
  expect(bytes).toBeLessThanOrEqual(REPLAY_BUDGET_CAP_BYTES);
  expect(replayed.at(-1)!.id).toBe(messages.at(-1)!.id);
  expect(replayed.filter(m => m.role === "bot").length).toBeGreaterThan(40);
  expect(ms).toBeLessThan(2_000);
});

/** 4,000 new active records in the conversation's scope, each owed to the word index (the perf rig's burst, seed.ts). */
function burst(threadId: string) {
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(threadId)!.id);
  const insert = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,?)");
  const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
  db.exec("BEGIN IMMEDIATE");
  for (let n = 0; n < 4000; n++) { insert.run(`burst-${n}`, scope, `MEMPROJ ${n}: a fact the index has not seen yet about the work.`, Date.now(), Date.now()); receipt.run(`burst-${n}`); }
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
}
/** What one index result writes back (worker-controller.ts writeReceipts): a batch of the waiting records marked indexed. */
function indexSome(count = 400) {
  database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='unavailable' WHERE rowid IN (SELECT rowid FROM memory_projection_receipts WHERE lexical_status='pending' LIMIT ?)").run(count);
}

// perf102 F2: every frame of a direct chat cites the replies before it (the thread checkpoint carries them), so the
// lineage behind one turn is as long as the conversation. Walked reply by reply inside one check, it ran past the depth
// bound at about 64 turns, and from then on the check that could not finish reset the engine session on every turn
// (9 of 10 turns in the rig's indexing scenario, reason=lineage), with nothing the conversation may see having changed.
it("a long direct chat while 4,000 new records wait for the index: past 64 turns of replies citing replies, at most one reset", async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 4; n++) await w.turn(n);
  burst(w.threadId);
  for (let n = 5; n <= 80; n++) { indexSome(); await w.turn(n); }
  expect(w.resets.length).toBeLessThanOrEqual(1);
  // and the replay still shows the conversation: nothing is withheld
  const { withheld } = filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set());
  expect([...withheld]).toEqual([]);
}, 300_000);

it("past that depth, a real withdrawal still resets the session and withholds what rests on it", async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 4; n++) await w.turn(n);
  burst(w.threadId);
  for (let n = 5; n <= 72; n++) { indexSome(); await w.turn(n); }
  const before = w.resets.length;
  expect(before).toBeLessThanOrEqual(1);
  const replies = w.store.activePath(w.threadId).filter(m => m.role === "bot");
  // the owner forgets the reply before last; the last reply's frame cites it through the thread checkpoint
  const forgotten = replies.at(-2)!, resting = replies.at(-1)!;
  forgetReply(w.threadId, forgotten.id);
  await w.turn(73);
  expect(w.resets.length).toBe(before + 1);
  const { withheld } = filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set());
  expect(withheld.has(resting.id)).toBe(true);
}, 300_000);

// perf/1.0.2-memory (long500): at turn 400 and later of one resumed session nothing is cheaper to withhold than at turn 10.
// The per-turn work was made flat, so these pin that a withdrawal is still seen by every check at that length.
it("at turn 420 of one session, forgetting an early reply still resets the session and withholds what rests on it", { tags: ["nightly"], timeout: 900_000 }, async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 420; n++) await w.turn(n);
  const before = w.resets.length;
  expect(before).toBeLessThanOrEqual(1);
  const replies = w.store.activePath(w.threadId).filter(m => m.role === "bot");
  const early = replies[3]!, latest = replies.at(-1)!;
  expect(filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set()).withheld.has(latest.id)).toBe(false);
  forgetReply(w.threadId, early.id);
  await w.turn(421);
  expect(w.resets.length).toBe(before + 1);
  const { withheld } = filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set());
  // every reply since cites the one before it, so the withdrawal reaches the last reply
  expect(withheld.has(latest.id)).toBe(true);
});

it("at turn 420 of one session, forgetting the reply before last still withholds the last one", { tags: ["nightly"], timeout: 900_000 }, async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 420; n++) await w.turn(n);
  const before = w.resets.length;
  const replies = w.store.activePath(w.threadId).filter(m => m.role === "bot");
  const forgotten = replies.at(-2)!, resting = replies.at(-1)!;
  forgetReply(w.threadId, forgotten.id);
  await w.turn(421);
  expect(w.resets.length).toBe(before + 1);
  const { withheld } = filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set());
  expect(withheld.has(resting.id)).toBe(true);
});

// perf/1.0.2-memory (mem fixer 2): the capture of a reply judges it inside the capture transaction, where the kept verdicts used to be
// out of reach as soon as the transaction had written its own outputs; the session listing then read every receipt of the session.
it("the capture of a reply inside its transaction judges only the receipts written since, never the whole session", async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 30; n++) await w.turn(n);
  const before = lineageListingFallbacks();
  for (let n = 31; n <= 140; n++) await w.turn(n);
  const after = lineageListingFallbacks();
  expect(after.inTransaction - before.inTransaction).toBe(0);
  expect(after.all - before.all).toBeLessThanOrEqual(2);
  // and what it keeps is still judged on content: forgetting an early reply withholds what rests on it
  const replies = w.store.activePath(w.threadId).filter(m => m.role === "bot");
  const early = replies[3]!, latest = replies.at(-1)!;
  forgetReply(w.threadId, early.id);
  await w.turn(141);
  expect(filterDirectReplay(LineageAllowance.tool(), w.threadId, w.store.activePath(w.threadId) as never, w.access(), new Set()).withheld.has(latest.id)).toBe(true);
}, 600_000);

it("the lineage check of a resumed session judges only the receipts written since, not every receipt of the session", async () => {
  const w = world("grok", { long: true });
  for (let n = 1; n <= 60; n++) await w.turn(n);
  const check = () => { const a = lineageCacheCounts(), bad = sessionLineageBad(LineageAllowance.tool(1_000_000_000), w.threadId, "grok", w.session(), null); const b = lineageCacheCounts(); return { bad, work: b.hits + b.misses - a.hits - a.misses }; };
  expect(check().bad).toBe(false);
  await w.turn(61);
  const next = check();
  expect(next.bad).toBe(false);
  // one turn adds a frame and a lookup companion at most; the session has sixty receipts
  expect(next.work).toBeLessThanOrEqual(8);
  expect(check().work).toBeLessThanOrEqual(2);
}, 600_000);
