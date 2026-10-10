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
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
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

const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("reset-loop");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "reset-loop", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

function world() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
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
  const turn = async (n: number) => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Tell me about item ${n} please.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
    const a = access();
    // index.ts: the early check (it persists what it finds, and logs nothing)
    const earlyWhy: { reason?: string } = {};
    const early = n > 1 && continuationMemoryRevoked(threadId, "claude", session, a, earlyWhy);
    // the dispatch check, whose reason is the one the log line carries
    const why: { reason?: string } = {};
    const revoked = n > 1 && continuationMemoryRevoked(threadId, "claude", session, a, why);
    if (early || revoked) { resets.push(`${earlyWhy.reason ?? "-"} | ${why.reason ?? "-"}`); session = `S-${++sessions}`; }
    filterDirectReplay(threadId, store.activePath(threadId) as never, a, new Set());
    const bundle = await buildMemoryBundle(`item ${n}`, a, bridge);
    const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
    receipt.sessionStarted(session); receipt.accepted();
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Item ${n} is a blue widget with ${n} parts.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    drain();
  };
  return { store, threadId, turn, resets, session: () => session };
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
  expect(w.resets).toEqual(["memory-changed (receipt-already-revoked) | memory-changed (receipt-already-revoked)"]);
  for (let n = 6; n <= 8; n++) await w.turn(n);
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
  const first = w.store.activePath(w.threadId).find(m => m.role === "bot")!;
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE message_id=?").run(first.id);
  await w.turn(6);
  expect(w.resets).toHaveLength(2);
});

it("the replay a reset turn carries on a long thread is bounded and quick to assemble (timed)", () => {
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
  database().exec("BEGIN");
  for (let turn = 0; turn < 3_000; turn++) {
    messages.push({ id: `o${turn}`, role: "user", kind: "text", text: `owner ${turn} ${filler}` }, { id: `r${turn}`, role: "bot", kind: "text", text: `sable ${turn} ${filler}` });
    insert.run(`R${turn}`, bot.threadId, "claude", "S-long", "[]", "[]", JSON.stringify([`r${turn}`]), first.policyRevision, first.deletionEpoch, turn);
  }
  database().exec("COMMIT");
  installWideRevoke();
  const started = performance.now();
  const { replayed, omitted } = filterDirectReplay(bot.threadId, messages, a(), new Set(), { maxBytes: replayBudgetBytes(200_000) });
  const ms = performance.now() - started;
  const bytes = replayed.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0);
  console.info(`reset replay: lines=${replayed.length} omitted=${omitted} bytes=${bytes} ms=${ms.toFixed(0)}`);
  expect(bytes).toBeLessThanOrEqual(REPLAY_BUDGET_CAP_BYTES);
  expect(replayed.at(-1)!.id).toBe("r2999");
  expect(replayed.filter(m => m.role === "bot").length).toBeGreaterThan(40);
  expect(ms).toBeLessThan(2_000);
});
