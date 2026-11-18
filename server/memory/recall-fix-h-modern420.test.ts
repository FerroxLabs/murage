// Producer owners: recall-prod-y (retained proof), recall-prod-x (publication); consumer owner: recall-fix-h (C20).
import { strict as assert } from 'node:assert';
import { assertMemoryAccess, type MemoryAccess } from './policy.ts';
import { FreshReplaySessionConfirmation } from './fresh-replay-session.ts';
import { captureSendReplayProof } from './replay-lineage.ts';
import { closeTurnLineage, openTurnLineage } from './lineage-write.ts';
import { startFreshSession } from './session-incarnation.ts';
import { initializeFreshSessionProof } from './session-proof.ts';
import { noteSessionFrame } from './session-proof-schema.ts';
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
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
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked, filterDirectReplay } from "./disclosures.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
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
    const confirmation = startLiveSession(a, engine, session);
    receipt.sessionStarted(session, Boolean(confirmation), confirmation); receipt.accepted();
    // index.ts writes the session's lineage row when the session starts or resumes (write-time privacy, DESIGN-WRITETIME 2.7)

    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Item ${n} is a blue widget with ${n} parts.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    if (long) recordMemorySettlement(threadId, `t${n}`, "completed");
    drain();
  };
  return { store, threadId, turn, resets, access, session: () => session };
}

function startLiveSession(access: MemoryAccess, instance: string, session: string, bindFrame?: () => void) {
  const db = database(), threadId = access.threadId;
  if (db.prepare('SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?').get(threadId, instance, session)) return;
  const turnId = `fixture-start:${session}`;
  const turn = openTurnLineage(db, { threadId, turnId });
  let key;
  try {
    const started = transaction(tx => startFreshSession(tx, threadId, instance, session, turn));
    assert.equal(started.recorded, true, 'Fixture live session must record its native start');
    key = started.key;
  }
  finally { closeTurnLineage(turn); }
  const confirmation = new FreshReplaySessionConfirmation(captureSendReplayProof(threadId, []), instance, () => assertMemoryAccess(access), { generation: access.generation });
  confirmation.sessionStarted(turnId, key, true);
  confirmation.engineWritten(); confirmation.accepted(turnId);
  assert.equal(confirmation.firstFrameSessionCurrent(key, access.generation), true, 'Fixture live session must confirm this generation');
  noteSessionFrame(db, key, false);
  initializeFreshSessionProof(key, access, bindFrame, { fresh: true, confirmation });
  return confirmation;
}

it("at turn 420 of one session, forgetting an early reply still resets the session and withholds what rests on it", { tags: ["nightly"], timeout: 900_000 }, async () => {
  const w = world("grok", { long: true });
  await expect((async () => { for (let n = 1; n <= 420; n++) await w.turn(n); })(), 'all 420 modern turns must remain available').resolves.toBeUndefined();
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
