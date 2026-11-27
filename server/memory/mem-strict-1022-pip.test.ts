// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 mem-strict r2: the continuity leg of the 554x row ('learning call dropped before send: reason=memory-changed purpose=continuity').
// Driven through runPipReflect, the production entry of a Pip reflection: the snapshot is read, the gate is built over the shown rows, and
// the engine stub releases its request through that gate the way every driver does (headless-text-only.ts: the physical write goes through
// transport.gate). The change lands once the request is built, at the first send-time admission check, so the read itself never sees it.
// An unrelated change (a tombstone, a deny, a real Forget, another connection's commit) never drops the send; a change to a shown row or a
// withdrawal still does. Synthetic fixture text only; no process and no network.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarker, INLINE_REVOCATION, memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, runRevocationJobsNow, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget, REVOKE_PACE_COMMIT } from "./revoke-budget.ts";
import { pipFenceHooks } from "./pip-admission.ts";
import { pipReadHooks, readReflectState, resetPipPendingScans, runPipReflect, type ReflectBot, type ReflectDeps } from "./pip-reflect.ts";
import type { IsolationReport, TextOnlyTurnInput, TextOnlyTurnResult } from "./pip-transport.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";

const T0 = 1_760_000_000_000, MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never); resetPipPendingScans();
});
afterEach(() => { runnerFault = undefined; stopMemoryRevocation(); setMemoryCaptureRoster(null); pipReadHooks.between = undefined; pipFenceHooks.step = undefined; vi.restoreAllMocks(); closeDatabase(); });

const done = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100");
const sourceIdOf = (id: string) => `message:private:${id}`;
function seedConversation() {
  ["Alpha note.", "Bravo note.", "Charlie note."].forEach((text, i) => {
    captureStoredMessage(database(), "private", { id: `o${i + 1}`, at: T0 + i * MIN, role: "user", kind: "text", text, origin: "desktop" } as never); done();
    captureStoredMessage(database(), "private", { id: `b${i + 1}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never); done();
  });
}
const iso: IsolationReport = { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn" };
const empty = { proposals: [], stance: [], episode: null };
const validated = (): TextOnlyTurnResult => ({ text: JSON.stringify(empty), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: empty } });

/** The engine: its one physical write is released through the call's learning gate, as the drivers do; `sent` holds what left. */
function rig(beforeSend?: () => Promise<void>, onBots?: () => void) {
  const bot: ReflectBot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true } };
  const sent: TextOnlyTurnInput[] = [], causes: Array<string | undefined> = [];
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => { onBots?.(); return [bot]; }, memoryMode: () => "active",
    resolveRoute: async () => ({
      fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model",
      textOnlyTurn: async input => {
        const gate = input.transport?.gate;
        if (!gate) throw new Error("no gate");
        if (beforeSend) await beforeSend();
        // r7: the Pip path logs no drop line, so the gate's fixed-word refusal cause (learning-send.ts) is kept for the assertion message
        try { return await gate.send(() => { sent.push(input); return validated(); }); } finally { causes.push(gate.cause); }
      },
    }),
  };
  return { deps, sent, causes };
}
/** Runs `change` once: at the first send-time admission check after the request is built (the family is "requested"), outside any transaction. */
function atSend(change: () => void) {
  let fired = false;
  pipFenceHooks.step = step => {
    if (fired || step !== "bot" || database().isTransaction) return;
    if (readReflectState(database(), "moss").run?.families.lived?.state !== "requested") return;
    fired = true; change();
  };
  return () => fired;
}
async function reflectAcross(change: () => void) {
  seedConversation();
  const { deps, sent } = rig();
  const fired = atSend(change);
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
  return { outcome, sent, fired: fired(), dropped: lines.filter(line => line.startsWith("[memory] learning call dropped before send")) };
}
const otherConnection = (sql: string, ...params: Array<string | number>) => {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { if (params.length) db.prepare(sql).run(...params); else db.exec(sql); } finally { db.close(); }
};
function unrelatedRecord(): string {
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','zq unrelated note','owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, Date.now(), Date.now());
  return id;
}

/** A real Forget whose inline revocation slice has no time left (memory-revocation.ts startRevocationJob): its commit writes the job row. */
function forgetOverBudget(id: string) {
  const ms = INLINE_REVOCATION.ms;
  INLINE_REVOCATION.ms = 0;
  try { forgetMemory(ownerMemoryTicket(), { kind: "record", id }); } finally { INLINE_REVOCATION.ms = ms; }
  if (!database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()) throw new Error("fixture: no revocation job row");
}
/** r6: the PRODUCTION runner (wakeMemoryRevocation's tick, memory-revocation.ts stepJobRow) runs every job row to its end. 100 Pip stances
 * of another bot's scope (the pip phase spends one row per stance, a slice gets at most 64) make the job outlast one slice, as a loaded machine's
 * jobs do, so the runner rewrites the row in place (stepJobRow's UPDATE) before its last slice removes it; the fixture fails unless it did. */
const STANCES = 100;
function seedOtherStances() {
  const insert = database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-stance',1,'granted','{}')"), scope = ensureScope("bot", "zq-other");
  for (let i = 0; i < STANCES; i++) insert.run(`pip-stance:zq-other-${String(i).padStart(3, "0")}`, scope);
}
/** r7: a fixture fault inside the engine's await would read as "nothing sent"; it is kept here and asserted on its own, ahead of the outcome. */
let runnerFault: string | undefined;
async function runnerFinishesInSlices() {
  // the write pace (revoke-budget.ts, a per-minute ledger kept across tests in this file) starts empty, so the runner is never held a minute;
  // its per-commit row cap (REVOKE_PACE_COMMIT, "tests may change it") is 16 input rows, so every job step of a Forget (each phase spends one
  // row or more) takes several slices, as on a loaded machine, and the runner rewrites the row in place between them on every run
  resetMemoryRevocationStats(); resetRevokeWriteBudget();
  const cap = REVOKE_PACE_COMMIT.rows;
  REVOKE_PACE_COMMIT.rows = 16;
  try { wakeMemoryRevocation(() => database(), { pauseMs: 0, busyPauseMs: 0, retryMs: 1 }); await memoryRevocationIdle(); }
  finally { stopMemoryRevocation(); REVOKE_PACE_COMMIT.rows = cap; }
  const left = !!database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get();
  if (left || !(memoryRevocationStats.maxJobBytes > 0)) runnerFault = `fixture: ${left ? "job row left" : "the runner never rewrote the job row in place"} ${JSON.stringify(memoryRevocationStats)}`;
}
/** r6: like reflectAcross, but the change runs while the engine awaits (after the read and the request are built, before the gate releases the
 * physical write), as any driver awaits its I/O; `before` runs ahead of the reflection (its read samples the gate). */
async function reflectAwaiting(during: () => Promise<void>, before?: () => void) {
  seedConversation();
  before?.();
  let fired = false;
  const { deps, sent, causes } = rig(async () => { fired = true; await during(); });
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
  return { outcome, sent, fired, causes, dropped: lines.filter(line => line.startsWith("[memory] learning call dropped before send")) };
}
const tombstone = (kind: "record" | "source", id: string) => database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?, ?, ?, NULL, NULL, 0, 'test', 0)").run(randomUUID(), kind, id);

describe("Pip continuity send: an unrelated memory change never drops it (554x reason=memory-changed purpose=continuity)", () => {
  it.each([
    ["an unrelated record is tombstoned on this connection", (other: string) => { tombstone("record", other); }],
    // r5: the marker is drained before the send, so the row does not depend on whether the 8 ms inline revocation budget ran out (under load
    // it does, and the job row was then read as a withdrawal: 12/480 refusals at ef63a67ecc, cause=withdrawal); see the over-budget row below
    ["an unrelated record is Forgotten (forgetMemory: deletion_epoch and policy_revision move with its tombstone)", (other: string) => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: other }); drainRevokeMarker(database()); }],
    // r5: the Forget's inline revocation budget (INLINE_REVOCATION, 8 ms) runs out, as it does on a loaded machine, so its commit writes the
    // job row (memory_scope_bindings subject memory-revocation); the runner then finishes the job and removes the row. Neither is a withdrawal.
    ["an unrelated record is Forgotten over the inline budget and the runner finishes its job (the job row is written, then removed)", (other: string) => { forgetOverBudget(other); drainRevokeMarker(database()); }],
    ["an unrelated thread is denied", () => { database().exec("INSERT INTO memory_deny VALUES('thread','zq-gone-thread',1,0)"); }],
    ["another connection commits an unrelated write (PRAGMA data_version moves)", () => otherConnection("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)")],
    ["another connection Forgets an unrelated record (deletion_epoch and policy_revision in one statement, plus its tombstone)", (other: string) => otherConnection(
      `UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1; INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('${randomUUID()}','record','${other}',NULL,NULL,0,'owner-forget',0)`)],
  ] as const)("%s: the reflection request is sent, nothing is logged as dropped", async (_name, change) => {
    const other = unrelatedRecord();
    const { sent, fired, dropped } = await reflectAcross(() => change(other));
    expect(fired).toBe(true);
    expect(dropped).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Alpha note.");
  });
  // r6/r7 (OPUS cb88b8fe82 H2): the runner's bounded-slice rewrite of the job row (memory-revocation.ts stepJobRow UPDATE) is a row change,
  // never a withdrawal (learning-send.ts bindings_job_u). The withdrawal stamp leg is not witnessed here (see the r7 note below).
  it.each([
    ["an unrelated record is Forgotten over the inline budget and the runner finishes its job in bounded slices (the row is rewritten in place)", async (other: string) => {
      forgetOverBudget(other); await runnerFinishesInSlices();
    }],
    // r7: the other connection commits once the runner is idle (a commit made while it runs held it past the test's 45 s, fix7.log); the
    // send still sees PRAGMA data_version moved, so the gate takes its data-version branch (withdrawal counter, then stamp, then held rows)
    ["the same, then another connection commits an unrelated write (PRAGMA data_version moves: the gate takes its data-version branch)", async (other: string) => {
      forgetOverBudget(other); await runnerFinishesInSlices(); otherConnection("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)");
    }],
  ] as const)("%s: the reflection request is sent, nothing is logged as dropped", async (_name, during) => {
    const other = unrelatedRecord();
    const { sent, fired, dropped, causes } = await reflectAwaiting(() => during(other), seedOtherStances);
    expect(fired).toBe(true);
    expect(runnerFault).toBeUndefined();
    expect(dropped).toEqual([]);
    expect(sent, `gate cause=${causes.join(",")}`).toHaveLength(1);
    expect(sent[0]!.text).toContain("Alpha note.");
  });
  // r8 (ASTRA f443268f73 learning-send.ts:176/:306, MAIN: the job is removed by another connection between the stamp sample and the read).
  // The roster read (deps.bots) is the seam, at two points of the production attempt (pip-reflect.ts attemptFamily): its settings check,
  // before the learning fence is sampled, where an unrelated Forget runs over its inline budget (so the job row is in the sampled stamp);
  // then the admission stamp, after the fence sample and before the snapshot is read, where ANOTHER connection (a second process on the
  // same store) runs the production job runner (memory-revocation.ts runRevocationJobsNow) to its end in its own commit. No trigger on the
  // call's connection sees that commit, so the send-time gate takes its data-version branch and compares the withdrawal stamp
  // (learning-send.ts withdrawalStamp). The read itself sees no job (a pending job holds reads "checking": r7 base6.log, KEEP below).
  const JOB_ROW = "SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'";
  const calledFrom = (callee: string) => new RegExp(`at ${callee} [^\\n]*\\n[^\\n]*at attemptFamily `).test(String(new Error().stack));
  function jobAcrossSample(otherCommit: (db: DatabaseSync) => void, before?: () => void, ownAfter?: () => void) {
    const seen = { forget: false, pendingAtSample: false, other: false };
    const onBots = () => {
      if (!seen.forget && calledFrom("settingsCurrent")) { seen.forget = true; before?.(); forgetOverBudget(unrelatedRecord()); return; }
      if (seen.forget && !seen.other && calledFrom("admissionStamp")) {
        seen.other = true; seen.pendingAtSample = !!database().prepare(JOB_ROW).get();
        const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
        try { db.exec("BEGIN IMMEDIATE"); otherCommit(db); db.exec("COMMIT"); }
        catch (error) { try { db.exec("ROLLBACK"); } catch { /* not open */ } runnerFault = `fixture: other connection ${String(error)}`; }
        finally { db.close(); }
        ownAfter?.();
        if (database().prepare(JOB_ROW).get()) runnerFault = "fixture: job row left after the other connection's commit";
      }
    };
    return { seen, onBots };
  }
  async function reflectJobAcrossSample(otherCommit: (db: DatabaseSync) => void, before?: () => void, ownAfter?: () => void) {
    seedConversation();
    const { seen, onBots } = jobAcrossSample(otherCommit, before, ownAfter);
    const { deps, sent, causes } = rig(undefined, onBots);
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
    return { outcome, sent, causes, seen, dropped: lines.filter(line => line.startsWith("[memory] learning call dropped before send")) };
  }
  it("an unrelated Forget's job is pending at the fence sample and another connection's runner ends it before the read: the reflection request is sent", async () => {
    const { sent, causes, seen, dropped } = await reflectJobAcrossSample(db => { runRevocationJobsNow(db); });
    expect(runnerFault).toBeUndefined();
    expect(seen).toEqual({ forget: true, pendingAtSample: true, other: true });
    expect(dropped).toEqual([]);
    expect(sent, `gate cause=${causes.join(",")}`).toHaveLength(1);
    expect(sent[0]!.text).toContain("Alpha note.");
  });
  // r8 W1b (ASTRA ad68999f25, MAIN "W1b must commit before cleanup"): the other connection commits an unrelated write while the job is
  // still pending (before any cleanup), then the call's OWN connection runs the production job runner to its end (its triggers move the
  // epoch only), all between the fence sample and the read. The send still sees PRAGMA data_version moved and compares the stamp.
  it("W1b: another connection commits an unrelated write while the job is still pending, then this connection's runner cleans it up before the read: the reflection request is sent", async () => {
    const pendingAtForeign: boolean[] = [];
    const { sent, causes, seen, dropped } = await reflectJobAcrossSample(db => {
      pendingAtForeign.push(!!db.prepare(JOB_ROW).get());
      db.exec("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)");
    }, undefined, () => { const db = database(); db.exec("BEGIN IMMEDIATE"); try { runRevocationJobsNow(db); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); runnerFault = `fixture: own runner ${String(error)}`; } });
    expect(runnerFault).toBeUndefined();
    expect({ seen, pendingAtForeign }).toEqual({ seen: { forget: true, pendingAtSample: true, other: true }, pendingAtForeign: [true] });
    expect(dropped).toEqual([]);
    expect(sent, `gate cause=${causes.join(",")}`).toHaveLength(1);
  });
  // r8 KEEP (lane Medium: a row moved out of the job subject still withdraws, from another connection too): the stamp leaves out only rows
  // whose CURRENT subject is the job's, so the job row turned into a grant (a new grant line) or a grant removed with the job still refuses
  // the send as a withdrawal. (A grant turned into a job row leaves a pending job, which holds the read "checking": KEEP below.)
  it.each([
    ["the runner ends the job and a granted binding is removed in the same commit", (db: DatabaseSync) => { runRevocationJobsNow(db); db.exec("DELETE FROM memory_scope_bindings WHERE id='zq-grant-a'"); }],
    // a system binding that is not the job's (here a fixture subject, as no quiet list names it) is a withdrawal like any other
    ["the runner ends the job and a non-job system binding is rewritten in the same commit", (db: DatabaseSync) => { runRevocationJobsNow(db); db.exec("UPDATE memory_scope_bindings SET intent='{\"zq\":1}' WHERE id='zq-system-row'"); }],
    ["the job row is moved out of the job subject (turned into a grant)", (db: DatabaseSync) => { db.exec("UPDATE memory_scope_bindings SET subject_type='room',subject_id='zq-room-b' WHERE subject_type='system' AND subject_id='memory-revocation'"); }],
  ] as const)("KEEP another connection, between the fence sample and the read: %s: nothing is sent (cause=withdrawal)", async (_name, otherCommit) => {
    const grant = () => {
      const scope = ensureScope("bot", "moss");
      database().prepare("INSERT INTO memory_scope_bindings VALUES('zq-grant-a',?,'room','zq-room-a',1,'granted','{}')").run(scope);
      database().prepare("INSERT INTO memory_scope_bindings VALUES('zq-system-row',?,'system','zq-system-subject',1,'granted','{}')").run(scope);
    };
    const { sent, causes, seen, dropped, outcome } = await reflectJobAcrossSample(otherCommit, grant);
    expect({ seen, runnerFault }).toEqual({ seen: { forget: true, pendingAtSample: true, other: true }, runnerFault: undefined });
    expect(sent).toEqual([]);
    expect({ causes, dropped, outcome }).toMatchObject({ dropped: ["[memory] learning call dropped before send: reason=memory-changed purpose=continuity cause=withdrawal"] });
  });
  it.each([
    ["a shown source is tombstoned", () => { tombstone("source", sourceIdOf("o1")); }],
    ["a shown source is Forgotten (forgetMemory)", () => { forgetMemory(ownerMemoryTicket(), { kind: "source", id: sourceIdOf("o2") }); }],
    ["another connection retires a shown source", () => otherConnection("UPDATE memory_sources SET state='retired' WHERE id=?", sourceIdOf("o3"))],
    ["another connection bumps the policy revision with no deletion (a withdrawal)", () => otherConnection("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1")],
    ["another connection pauses memory (a withdrawal)", () => otherConnection("UPDATE memory_meta SET mode='paused' WHERE id=1")],
    ["another connection swaps a granted binding for another at the same count and revision (a withdrawal)", () => otherConnection(
      `DELETE FROM memory_scope_bindings WHERE id='zq-grant-a'; INSERT INTO memory_scope_bindings VALUES('zq-grant-b','${ensureScope("bot", "moss")}','room','zq-room-b',1,'granted','{}')`)],
    ["another connection rewrites a shown source in place at the same revision (a scrub)", () => otherConnection("UPDATE memory_source_versions SET payload=json_set(payload,'$.scrubbed',1) WHERE source_id=?", sourceIdOf("o2"))],
    // r5: fail closed while an unrelated Forget's revocation is still pending (its window holds every read "checking" until the marker
    // resolves it, DESIGN-WRITETIME); the call is refused as a read move and retried, never sent past an open window
    ["an unrelated record is Forgotten over the inline budget and its revocation is still pending (held rows read checking)", () => { forgetOverBudget(unrelatedRecord()); }],
  ] as const)("KEEP %s: nothing is sent", async (_name, change) => {
    database().prepare("INSERT INTO memory_scope_bindings VALUES('zq-grant-a',?,'room','zq-room-a',1,'granted','{}')").run(ensureScope("bot", "moss"));
    const { sent, fired } = await reflectAcross(change);
    expect(fired).toBe(true);
    expect(sent).toEqual([]);
  });
});
