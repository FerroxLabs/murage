// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 mem-strict: memory limits that refused or dropped work for reasons unrelated to what the work used. Each block drives the
// production entry the log line names and asserts the outcome (the call sent, the brief delivered, the recall waited for,
// learning admitted), plus the KEEP rows: a held row that really changed, a withdrawal, and the money ceiling still refuse.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { setObserveSink, resetObserveWindows } from "../observe.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { bumpAuthorityHard } from "./authority-epoch.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { forgetMemory } from "./forget.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { writeBotIdentity } from "./identity.ts";
import { learningGate, recordDigest, sampleLearningFence } from "./learning-send.ts";
import { LineageAllowance, TURN_LINEAGE_NODES } from "./lineage-allowance.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { RECALL_WAIT_MS, withRecallBudget } from "./recall-budget.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setObserveSink(undefined); closeDatabase(); });

// ------------------------------------------------------------------------------------------- learning send: own refs only
const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
function ownerRecord(text: string): string {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, text, Date.now(), Date.now());
  return id;
}
const claim = { text: "tea", quote: "tea", claimType: "owner-statement", speaker: "owner", outcome: "recorded" } as const;
/** The provider: records whether the grounding call left (the thing under test is the gate in front of it). */
function provider() {
  const sent: string[] = [];
  const extractor: TextOnlyExtractor = async () => "[]";
  extractor.ground = async (_input, _max, _signal, fence) => fence!.send(() => { sent.push("ground"); return '{"supported":true}'; });
  return { extractor, sent };
}
/** Grounds a claim the way authority.ts/routes.ts do: the fence sampled first, the held record named, `between` run before the send. */
async function groundOver(held: string | null, between: () => void) {
  const db = database();
  updateMemoryLearning(db, { callsPerMinute: 60 }, readMemoryLearning(db).revision);
  const at = sampleLearningFence();
  const refs = held ? { records: [{ id: held, version: 1, digest: recordDigest(db, held, 1) }] } : {};
  between();
  const { extractor, sent } = provider();
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const result = await groundMemoryClaim(claim, extractor, new AbortController().signal, undefined, learningGate("grounding", at, refs));
  return { result, sent, dropped: lines.filter(line => line.startsWith("[memory] learning call dropped before send")) };
}
const otherConnection = (sql: string) => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); try { db.exec(sql); } finally { db.close(); } };

describe("learning send gate: fenced on the call's own rows (554x reason=memory-changed purpose=grounding)", () => {
  it.each([
    ["an unrelated record is deleted on this connection", () => { const other = ownerRecord("zqother"); database().prepare("DELETE FROM memory_records WHERE id=?").run(other); }],
    ["an unrelated record is tombstoned", () => { const other = ownerRecord("zqother"); database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?, 'record', ?, NULL, NULL, 0, 'test', 0)").run(randomUUID(), other); }],
    ["another connection commits (PRAGMA data_version moves)", () => otherConnection("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)")],
    // r2 (ASTRA b81b38de77): a real Forget moves deletion_epoch AND policy_revision in one statement (forget.ts:53), which r1 counted as a withdrawal
    ["an unrelated record is Forgotten (forgetMemory)", () => { const other = ownerRecord("zqother"); forgetMemory(ownerMemoryTicket(), { kind: "record", id: other }); }],
    ["another connection Forgets (deletion_epoch and policy_revision in one statement)", () => otherConnection("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1")],
  ])("%s: the grounding call is sent", async (_name, between) => {
    const held = ownerRecord("zqheld");
    const { result, sent, dropped } = await groundOver(held, between);
    expect(sent).toEqual(["ground"]);
    expect(result.supported).toBe(true);
    expect(dropped).toEqual([]);
  });
  it.each([
    ["the held record is tombstoned", "held-row", (held: string) => database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?, 'record', ?, NULL, NULL, 0, 'test', 0)").run(randomUUID(), held)],
    ["the held record is rewritten in place", "held-row", (held: string) => { database().prepare("UPDATE memory_records SET text='zqchanged' WHERE id=?").run(held); otherConnection("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)"); }],
    ["the held record is deny-marked while something else moved", "held-row", (held: string) => { const other = ownerRecord("zqother"); database().prepare("DELETE FROM memory_records WHERE id=?").run(other); database().prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES('record',?,0,1)").run(held); }],
    ["a roster withdrawal (bumpAuthorityHard)", "withdrawal", () => bumpAuthorityHard(database())],
    ["the memory mode changes", "withdrawal", () => setMemoryMode("paused")],
    // r2 (OPUS b81b38de77 H1): the cross-connection withdrawal branch; (ASTRA b81b38de77) a revoke swapped for a grant at the same count and revision
    ["another connection bumps the policy revision with no deletion", "withdrawal", () => otherConnection("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1")],
    ["another connection pauses memory", "withdrawal", () => otherConnection("UPDATE memory_meta SET mode='paused' WHERE id=1")],
    ["another connection changes the learning settings", "withdrawal", () => otherConnection("UPDATE memory_learning_config SET revision=revision+1 WHERE id=1")],
    ["another connection swaps a granted binding for another at the same count and revision", "withdrawal", () => otherConnection(
      `DELETE FROM memory_scope_bindings WHERE id='zq-grant-a'; INSERT INTO memory_scope_bindings VALUES('zq-grant-b','${ensureScope("bot", "bot")}','room','zq-room-b',1,'granted','{}')`)],
  ] as const)("KEEP %s: dropped unsent, the log names cause=%s", async (_name, cause, change) => {
    const held = ownerRecord("zqheld");
    database().prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('zq-grant-a',?,'room','zq-room-a',1,'granted','{}')").run(ensureScope("bot", "bot"));
    const { result, sent, dropped } = await groundOver(held, () => change(held));
    expect(sent).toEqual([]);
    expect(result).toMatchObject({ supported: false, reason: "grounding-fenced" });
    expect(dropped).toEqual([`[memory] learning call dropped before send: reason=memory-changed purpose=grounding cause=${cause}`]);
  });
  it("KEEP a gate that names no rows keeps the global fence, and says so", async () => {
    ownerRecord("zqseed");
    const { sent, dropped } = await groundOver(null, () => { const other = ownerRecord("zqother"); database().prepare("DELETE FROM memory_records WHERE id=?").run(other); });
    expect(sent).toEqual([]);
    expect(dropped).toEqual(["[memory] learning call dropped before send: reason=memory-changed purpose=grounding cause=changed"]);
  });
});

// ------------------------------------------------------------------------------------------- continuity brief: no wall clock
describe("continuity brief: read without a wall-clock budget (178x stage=read cause=limit)", () => {
  const briefRoster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
  function access() {
    const registry = new InternalCapabilities(), generation = registry.begin("moss", "private");
    const token = registry.mint({ botId: "moss", threadId: "private", generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => briefRoster);
  }
  it("on a loaded box (every read takes 400 ms) the owner's brief is still delivered, and the 3000-node bound stays", async () => {
    reconcileMemoryRoster(briefRoster); resetObserveWindows();
    const lines: string[] = []; setObserveSink(line => { lines.push(line); });
    writeBotIdentity(ownerMemoryTicket(), { action: "identity-write", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 0, text: "Moss keeps the harbour log.", basis: "fiction", audience: "owner-private" }, briefRoster);
    // production defaults: the time budget is read from the environment when an allowance is made (lineage-allowance.ts defaultMs)
    const vitest = process.env.VITEST; delete process.env.VITEST;
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => (clock += 400));
    try {
      // the turn's own allowance as index.ts makes it, and no briefAllowance: bundle.ts takes briefBudget() as production does
      const bundle = await buildMemoryBundle("harbour", access(), { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.turn() });
      expect(bundle.text).toContain("Moss keeps the harbour log.");
      expect(lines.filter(line => line.includes("continuity brief left out"))).toEqual([]);
      const turn = LineageAllowance.turn();
      expect(turn.remaining).toBe(TURN_LINEAGE_NODES);
    } finally { if (vitest !== undefined) process.env.VITEST = vitest; }
  });
});

// ------------------------------------------------------------------------------------------- recall wait
describe("overlapped recall: waited for up to 3 s (101x reason=budget wait=300)", () => {
  it("a recall back in 1 s is used by dispatch (index.ts withRecallBudget(early, RECALL_WAIT_MS))", async () => {
    vi.useFakeTimers();
    const early = new Promise<string>(resolve => setTimeout(() => resolve("bundle"), 1000));
    const waited = withRecallBudget(early, RECALL_WAIT_MS);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await waited).toEqual({ value: "bundle" });
  });
  it("KEEP a recall slower than the wait is still skipped", async () => {
    vi.useFakeTimers();
    const waited = withRecallBudget(new Promise<string>(() => {}), RECALL_WAIT_MS);
    await vi.advanceTimersByTimeAsync(RECALL_WAIT_MS + 1);
    expect(await waited).toEqual({ skipped: "budget" });
  });
});
