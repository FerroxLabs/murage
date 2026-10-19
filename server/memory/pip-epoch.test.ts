// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN r3 section 4: the admission stamp. Every input of admission moves it (T2, by raw writes to each table and column, so a
// writer that reaches a table is covered), every writer path that changes what may be sent discards the read across it (T3), publication
// re-reads its persisted window by identity (T5), the trace day writes nothing from a moved read (T6), a read that keeps moving is bounded
// (T8), an audience change mid-read sends nothing (T9), a deny already in force is refused at admission and a source with no thread moves
// nothing (T11). Synthetic fixture text only; the engine is a stub function, no process and no network.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { captureBranchChange, captureMessage, captureThreadDeletion } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setMemoryMode } from "./repository.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { writeBotIdentity, deletePipRecord } from "./identity.ts";
import { forgetMemory } from "./forget.ts";
import { endSourceWork } from "./memory-revocation.ts";
import { applyMemoryTombstones } from "./restore.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { listEpisodes } from "./pip-episodes.ts";
import {
  STAMP_STEPS, admissibleOwnerSources, admissibleOwnerSourcesSliced, admissionStamp, compareAdmitted, hasAdmissibleAfter, type AdmittedSource, ensureAdmissionEpochs, hasAdmissibleAfterSliced, ownerSourceStillAdmissible, pipFenceHooks, readShownSliced, stampMoved,
} from "./pip-admission.ts";
import {
  COOLDOWN_MS, READ_MOVE_BUDGET, maybeTraceEpisodeSliced, mutateReflect, pipPendingScanStats, pipReadHooks, pipReflectPending, readReflectState, readSnapshotSliced,
  resetPipPendingScans, runPipReflect, setReflectExcluded, type ReflectBot, type ReflectDeps,
} from "./pip-reflect.ts";
import { RUN_BOUND_MS, type IsolationReport, type TextOnlyTurnInput, type TextOnlyTurnResult } from "./pip-transport.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const T0 = 1_760_000_000_000;
const MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [{ threadId: "task-1" }] as Array<{ threadId: string }> }, { id: "other", threadId: "other-thread" }], groups: [] as never[] };
const ticket = ownerMemoryTicket();

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  resetPipPendingScans();
});
afterEach(() => { setMemoryCaptureRoster(null); pipReadHooks.between = undefined; pipFenceHooks.step = undefined; });

// ------------------------------------------------------------- fixtures ----

const done = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100");
const sourceIdOf = (id: string, thread = "private") => `message:${thread}:${id}`;
function owner(id: string, at: number, text: string, thread = "private") {
  captureMessage(database(), thread, { id, at, role: "user", kind: "text", text, origin: "desktop" } as never); done();
  return sourceIdOf(id, thread);
}
function reply(id: string, at: number, thread = "private") {
  captureMessage(database(), thread, { id, at, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never); done();
}
const TEXTS = ["Alpha note.", "Bravo note.", "Charlie note."];
function seedConversation(texts = TEXTS, thread = "private", from = T0) {
  return texts.map((text, i) => { const id = owner(`o${i + 1}`, from + i * MIN, text, thread); reply(`b${i + 1}`, from + i * MIN + 1000, thread); return id; });
}
const iso: IsolationReport = { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn" };
const empty = { proposals: [], stance: [], episode: null };
const validated = (): TextOnlyTurnResult => ({ text: JSON.stringify(empty), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: empty } });

interface Rig { deps: ReflectDeps; bot: ReflectBot; calls: TextOnlyTurnInput[]; clock: { now: number }; mode: { value: string } }
function rig(threadIds = ["private"]): Rig {
  const bot: ReflectBot = { id: "moss", name: "Moss", threadIds, continuity: true, options: { reflect: true } };
  const calls: TextOnlyTurnInput[] = [], clock = { now: T0 + 60 * MIN }, mode = { value: "active" };
  const deps: ReflectDeps = {
    now: () => clock.now, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => mode.value,
    resolveRoute: async () => ({ fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model", textOnlyTurn: async input => { calls.push(input); return validated(); } }),
  };
  return { deps, bot, calls, clock, mode };
}
const run = (r: Rig) => runPipReflect(r.deps, undefined, new AbortController().signal);
const state = () => readReflectState(database(), "moss");
const family = () => state().run?.families.lived;
const scopeOf = (botId: string) => String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(botId)!.id);
/** Runs `write` once, at the first hand-back of a read made while the run's family is in `phase`. */
function during(phase: "pending" | "validated", write: () => void | Promise<void>): { fired: () => boolean } {
  let fired = false;
  pipReadHooks.between = async () => { if (fired || family()?.state !== phase) return; fired = true; await write(); };
  return { fired: () => fired };
}
const epochs = () => {
  const db = database();
  ensureAdmissionEpochs(db);
  const global = Number(db.prepare("SELECT global FROM temp.memory_admission_epoch WHERE id=1").get()!.global);
  const threads = Object.fromEntries(db.prepare("SELECT thread_id,epoch FROM temp.memory_thread_admission").all().map(row => [String(row.thread_id), Number(row.epoch)]));
  return { global, threads };
};
/** Which counters `write` moved: the global one, and the threads whose epoch changed. */
function movedBy(write: () => void): { global: boolean; threads: string[] } {
  const before = epochs();
  write();
  const after = epochs();
  return { global: after.global !== before.global, threads: Object.keys({ ...before.threads, ...after.threads }).filter(t => before.threads[t] !== after.threads[t]).sort() };
}

// --------------------------------------------------------------- T2 ----

describe("T2: a raw write to every admission input moves the stamp, in the right scope", () => {
  const thread = (...threads: string[]) => ({ global: false, threads: threads.sort() });
  const global = { global: true, threads: [] as string[] };
  const none = { global: false, threads: [] as string[] };
  const cases: Array<[string, (src: string) => void, { global: boolean; threads: string[] }]> = [
    ["source state", src => { database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(src); }, thread("private")],
    ["source revision", src => { database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(src); }, thread("private")],
    ["source speaker", src => { database().prepare("UPDATE memory_sources SET speaker='person:x' WHERE id=?").run(src); }, thread("private")],
    ["source outcome", src => { database().prepare("UPDATE memory_sources SET outcome='failed' WHERE id=?").run(src); }, thread("private")],
    ["source kind", src => { database().prepare("UPDATE memory_sources SET kind='turn' WHERE id=?").run(src); }, thread("private")],
    ["source thread moved", src => { database().prepare("UPDATE memory_sources SET thread_id='other-thread' WHERE id=?").run(src); }, thread("private", "other-thread")],
    ["source scope (r3: sources keep their stored scope)", src => { database().prepare("UPDATE memory_sources SET scope_id=? WHERE id=?").run(ensureScope("conversation", "elsewhere"), src); }, thread("private")],
    ["source unchanged", src => { database().prepare("UPDATE memory_sources SET state=state,revision=revision,scope_id=scope_id WHERE id=?").run(src); }, none],
    ["source insert", () => { database().prepare("INSERT INTO memory_sources VALUES('extra',?,'private','m-extra',NULL,1,'h','text','owner','captured',NULL,'active')").run(ensureScope("conversation", "private")); }, thread("private")],
    ["source delete", () => {
      database().prepare("INSERT INTO memory_sources VALUES('gone',?,'private','m-gone',NULL,1,'h','text','owner','captured',NULL,'active')").run(ensureScope("conversation", "private"));
      const before = epochs().threads.private;
      database().exec("DELETE FROM memory_sources WHERE id='gone'");
      expect(epochs().threads.private).toBe(before + 1);
    }, thread("private")],
    ["version insert", src => { database().prepare("INSERT INTO memory_source_versions SELECT source_id,revision+1,content_hash,payload,created_at FROM memory_source_versions WHERE source_id=?").run(src); }, thread("private")],
    ["version payload (origin merge)", src => { database().prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','unproven') WHERE source_id=?").run(src); }, thread("private")],
    ["version payload unchanged (r3 no-op)", src => { database().prepare("UPDATE memory_source_versions SET payload=payload WHERE source_id=?").run(src); }, none],
    ["capture job no longer complete", src => { database().prepare("UPDATE memory_jobs SET status='pending' WHERE source_id=? AND stage='capture'").run(src); }, thread("private")],
    ["capture job complete again", src => { database().prepare("UPDATE memory_jobs SET status='complete' WHERE source_id=? AND stage='capture'").run(src); }, none],
    ["source tombstone", src => { database().prepare("INSERT INTO memory_tombstones VALUES('t1','source',?,1,NULL,0,'test',0)").run(src); }, global],
    ["record tombstone", () => { database().exec("INSERT INTO memory_tombstones VALUES('t2','record','some-record',NULL,NULL,0,'test',0)"); }, global],
    ["memory_meta policy_revision", () => { database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1"); }, global],
    ["memory_meta deletion_epoch", () => { database().exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1"); }, global],
    ["memory_meta mode", () => { database().exec("UPDATE memory_meta SET mode='paused'"); }, global],
    ["memory_meta data_revision (not an input)", () => { database().exec("UPDATE memory_meta SET data_revision=data_revision+1"); }, none],
    ["learning settings", () => { database().exec("UPDATE memory_learning_config SET settings=json_set(settings,'$.botsPaused',json('[\"moss\"]'))"); }, global],
    ["learning settings unchanged", () => { database().exec("UPDATE memory_learning_config SET settings=settings"); }, none],
    ["deny row", () => { database().exec("INSERT INTO memory_deny VALUES('thread','gone-thread',1,0)"); }, global],
    ["reflect binding (PIP's own state, digested in process)", () => { mutateReflect("moss", s => { s.cooldownUntil = 1; }); }, none],
  ];
  for (const [subject_type, subject_id] of [["system", "owner-settings"], ["source-origin", "x"], ["human-binding", "x"], ["human-thread", "x"], ["bot", "x"], ["room", "x"]] as const) {
    cases.push([`binding ${subject_type}/${subject_id} insert`, () => { database().prepare("INSERT INTO memory_scope_bindings VALUES('b1',?,?,?,0,'granted','{}')").run(ensureScope("bot", "moss"), subject_type, subject_id); }, global]);
    cases.push([`binding ${subject_type}/${subject_id} update`, () => {
      database().prepare("INSERT INTO memory_scope_bindings VALUES('b1',?,?,?,0,'granted','{}')").run(ensureScope("bot", "moss"), subject_type, subject_id);
      const before = epochs().global;
      database().exec("UPDATE memory_scope_bindings SET intent='{\"a\":1}' WHERE id='b1'");
      expect(epochs().global).toBe(before + 1);
      // the same value again moves nothing (r3 no-op guard)
      database().exec("UPDATE memory_scope_bindings SET intent='{\"a\":1}' WHERE id='b1'");
      expect(epochs().global).toBe(before + 1);
    }, global]);
    cases.push([`binding ${subject_type}/${subject_id} delete`, () => {
      database().prepare("INSERT INTO memory_scope_bindings VALUES('b1',?,?,?,0,'granted','{}')").run(ensureScope("bot", "moss"), subject_type, subject_id);
      const before = epochs().global;
      database().exec("DELETE FROM memory_scope_bindings WHERE id='b1'");
      expect(epochs().global).toBe(before + 1);
    }, global]);
  }
  it.each(cases)("%s", (_name, write, expected) => {
    const [src] = seedConversation();
    const r = rig(["private", "other-thread"]);
    const db = database();
    const stamp = admissionStamp(db, r.deps, "moss", ["private", "other-thread"]);
    const moved = movedBy(() => write(src));
    expect(moved).toEqual(expected);
    // the stamp agrees with the counters (a moved counter is "moved", or "off" where the write also switched admission off)
    const answer = stampMoved(db, r.deps, "moss", stamp);
    if (expected.global || expected.threads.length) expect(answer).not.toBe("none"); else expect(answer).toBe("none");
  });

  it("a commit by another connection moves the stamp (data_version)", async () => {
    seedConversation();
    const r = rig(), db = database();
    const stamp = admissionStamp(db, r.deps, "moss", ["private"]);
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { other.exec("UPDATE memory_meta SET data_revision=data_revision+1"); } finally { other.close(); }
    expect(stampMoved(db, r.deps, "moss", stamp)).toBe("moved");
  });

  // Astra pip-build High: a commit by another connection inside the fence (after data_version was sampled) once answered "none".
  // data_version is now the fence's last statement: a deny committed at every interleaving point of stampMoved answers "moved".
  it.each(STAMP_STEPS)("a deny committed by another connection after the fence's %s step answers moved", async at => {
    seedConversation();
    const r = rig(), db = database();
    const stamp = admissionStamp(db, r.deps, "moss", ["private"]);
    expect(stampMoved(db, r.deps, "moss", stamp)).toBe("none");
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      let fired: string | undefined;
      pipFenceHooks.step = step => { if (step !== at || fired) return; fired = step; other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0); };
      expect(stampMoved(db, r.deps, "moss", stamp)).toBe("moved");
      expect(fired).toBe(at);
      // and stays moved once the hook is gone: the stamp is spent, never re-admitted
      pipFenceHooks.step = undefined;
      expect(stampMoved(db, r.deps, "moss", stamp)).toBe("moved");
    } finally { pipFenceHooks.step = undefined; other.close(); }
  });
});

// --------------------------------------------------------------- T3 ----

describe("T3: a writer between two pages of the attempt's snapshot: nothing affected is sent, the read is discarded, no attempt is charged", () => {
  const moved = async (r: Rig, outcome: Awaited<ReturnType<typeof run>>) => {
    expect(outcome).toMatchObject({ status: "uncertain", reason: "read-moved" });
    expect(r.calls).toHaveLength(0);
    expect(family()).toMatchObject({ state: "pending", attempt: 1, readMoves: 1 });
    expect(family()?.transport).toBeUndefined();
  };
  const off = (r: Rig, outcome: Awaited<ReturnType<typeof run>>) => {
    expect(outcome).toMatchObject({ status: "refused", reason: "off" });
    expect(r.calls).toHaveLength(0);
    expect(state().refusals[0]).toMatchObject({ state: "refused:off" });
  };
  const sentTexts = (r: Rig) => r.calls.map(c => c.text).join("\n");

  it("forgetMemory on a copied source", async () => {
    const [first] = seedConversation(); const r = rig();
    const hook = during("pending", () => { forgetMemory(ticket, { kind: "source", id: first }); });
    await moved(r, await run(r)); expect(hook.fired()).toBe(true);
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(sentTexts(r)).not.toContain(TEXTS[0]);
    expect(sentTexts(r)).toContain(TEXTS[1]);
  });
  it("settings configure excludedThreadIds", async () => {
    seedConversation(); const r = rig();
    during("pending", async () => { await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: ["private"] }, ticket, roster as never); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls).toHaveLength(0);
  });
  it("a branch change retiring the copied sources (no version insert)", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { captureBranchChange(database(), "private", null); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls).toHaveLength(0);
  });
  it("the revocation runner ending one source alone (no policy bump)", async () => {
    const [first] = seedConversation(); const r = rig();
    const policy = () => Number(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision);
    let before = 0;
    during("pending", () => { before = policy(); database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(first); endSourceWork(database(), [{ id: first, rev: 1 }]); });
    await moved(r, await run(r));
    expect(policy()).toBe(before);
    pipReadHooks.between = undefined;
    await run(r);
    expect(sentTexts(r)).not.toContain(TEXTS[0]);
  });
  it("capture-job completion of a source not yet learnable", async () => {
    seedConversation(); const r = rig();
    const late = owner("o9", T0 + 5 * MIN, "Delta note."); reply("b9", T0 + 5 * MIN + 1000);
    database().prepare("UPDATE memory_jobs SET status='pending' WHERE source_id=?").run(late);
    during("pending", () => { database().prepare("UPDATE memory_jobs SET status='complete' WHERE source_id=?").run(late); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    // the next read sees it, admitted now
    expect(sentTexts(r)).toContain("Delta note.");
  });
  it("captureMessage of the same message re-originating it (capture.ts metadata merge)", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { captureMessage(database(), "private", { id: "o1", at: T0, role: "user", kind: "text", text: TEXTS[0], origin: "unproven" } as never); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    expect(sentTexts(r)).not.toContain(TEXTS[0]);
  });
  it("the bot's learning paused", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { const db = database(); updateMemoryLearning(db, { botsPaused: ["moss"] }, readMemoryLearning(db).revision); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls).toHaveLength(0);
  });
  it("deletePipRecord of a current commitment: its text never rides in `current`", async () => {
    seedConversation(); const r = rig();
    const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "k", expectedVersion: 0, text: "I will keep the lantern lit", basis: "owner-fact", audience: "owner-private" }, roster as never);
    during("pending", () => { deletePipRecord(target.id, scopeOf("moss"), 1); });
    await moved(r, await run(r));
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(sentTexts(r)).not.toContain("lantern");
  });
  it("Continuity switched off", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { r.bot.continuity = false; });
    off(r, await run(r));
  });
  it("continuityOptions edited", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { r.bot.options = { reflect: true, catchUp: true } as never; r.bot.settingsGeneration = 1; });
    off(r, await run(r));
  });
  it("memory paused", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { r.mode.value = "paused"; });
    off(r, await run(r));
  });
  it("the thread excluded from reflection (setReflectExcluded)", async () => {
    seedConversation(); const r = rig();
    during("pending", () => { setReflectExcluded("moss", "private", true); });
    off(r, await run(r));
  });
  it("a human-thread binding on a sibling task of the bot", async () => {
    seedConversation(); const r = rig(["private", "task-1"]);
    during("pending", () => {
      database().prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:task-1',?,'human-thread','task-1',1,'granted',?)").run(ensureScope("conversation", "task-1"), JSON.stringify({ personId: "person-x", bindingId: "binding-x", revision: 1 }));
    });
    await moved(r, await run(r));
  });
});

// --------------------------------------------------------------- T5 ----

describe("T5: publication re-reads the request's window by identity", () => {
  it("a shown source retired while the publication read yields: read-moved, then the re-read drops it and the family re-snapshots", async () => {
    const [first] = seedConversation(); const r = rig();
    during("validated", () => { database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first); });
    // r7: the move found the stored result's window no longer admitted, so the result is cleared there and then, never kept as validated
    expect(await run(r)).toMatchObject({ status: "uncertain", reason: "result-revoked" });
    expect(family()).toMatchObject({ state: "pending", attempt: 2, readMoves: 1, reason: "result-revoked" });
    expect(family()?.result).toBeUndefined();
    expect(family()?.shown?.map(([id]) => id)).toContain(first);
    pipReadHooks.between = undefined;
    const outcome = await run(r);
    // the re-read no longer holds it: re-snapshot, a second request without it, then applied
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].text).toContain(TEXTS[0]);
    expect(r.calls[1].text).not.toContain(TEXTS[0]);
    expect(outcome.status).toBe("applied");
  });
  it("a reactivate with no capture moves the thread's stamp and the next read includes the skipped source", async () => {
    const [first] = seedConversation(); const r = rig(), db = database();
    db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first);
    const read1 = await readSnapshotSliced(db, "moss", "private", undefined, [], async () => {});
    expect(read1.snap!.sources.map(s => s.sourceId)).not.toContain(first);
    const stamp = admissionStamp(db, r.deps, "moss", ["private"], { reflect: true });
    db.prepare("UPDATE memory_sources SET state='active' WHERE id=?").run(first);
    expect(stampMoved(db, r.deps, "moss", stamp)).toBe("moved");
    const read2 = await readSnapshotSliced(db, "moss", "private", undefined, [], async () => {});
    expect(read2.snap!.sources.map(s => s.sourceId)).toContain(first);
  });
  it("memo: {private: many, task-1: few}; a reactivate in task-1 alone changes the key and the scan reports pending", () => {
    const r = rig(["private", "task-1"]);
    // private: many epoch moves, nothing pending (its newest is the owner's)
    for (let i = 0; i < 5; i++) owner(`p${i}`, T0 + i * 1000, `Private ${i}.`);
    // task-1: one settled exchange, retired (a branch the owner left)
    owner("t1", T0, "Task note.", "task-1"); reply("tb1", T0 + 1000, "task-1");
    database().exec("UPDATE memory_sources SET state='retired' WHERE thread_id='task-1'");
    expect(pipReflectPending(r.deps)).toBeUndefined();
    const scans = pipPendingScanStats.scans;
    expect(pipReflectPending(r.deps)).toBeUndefined();
    expect(pipPendingScanStats.scans).toBe(scans);
    // no data_revision, no new message: only the thread epoch of task-1 moves
    database().exec("UPDATE memory_sources SET state='active' WHERE thread_id='task-1'");
    expect(pipReflectPending(r.deps)).toBe("moss");
    expect(pipPendingScanStats.scans).toBe(scans + 1);
  });
  it("a deny on one shown source's stored scope (the thread's scope unchanged): the re-read drops it", async () => {
    const ids = seedConversation(), db = database();
    const elsewhere = ensureScope("conversation", "captured-elsewhere");
    db.prepare("UPDATE memory_sources SET scope_id=? WHERE id=?").run(elsewhere, ids[1]);
    const shown = ids.map(id => [id, 1] as const);
    expect((await readShownSliced(db, "moss", "private", shown, [], async () => {})).rows.map(s => s.sourceId)).toEqual(ids);
    db.prepare("INSERT INTO memory_deny VALUES('scope',?,1,0)").run(elsewhere);
    expect((await readShownSliced(db, "moss", "private", shown, [], async () => {})).rows.map(s => s.sourceId)).toEqual([ids[0], ids[2]]);
    // claim confirm refuses it on its stored scope too
    expect(ownerSourceStillAdmissible(db, "moss", ids[1], 1)).toBe(false);
    expect(ownerSourceStillAdmissible(db, "moss", ids[0], 1)).toBe(true);
  });
  it("the same deny landing during publication: read-moved, then the family re-snapshots without it", async () => {
    const ids = seedConversation(), db = database(), r = rig();
    const elsewhere = ensureScope("conversation", "captured-elsewhere");
    db.prepare("UPDATE memory_sources SET scope_id=? WHERE id=?").run(elsewhere, ids[1]);
    during("validated", () => { database().prepare("INSERT INTO memory_deny VALUES('scope',?,1,0)").run(elsewhere); });
    expect(await run(r)).toMatchObject({ reason: "result-revoked" });
    expect(family()?.result).toBeUndefined();
    pipReadHooks.between = undefined;
    expect((await run(r)).status).toBe("applied");
    expect(r.calls[1].text).not.toContain(TEXTS[1]);
  });
});

// --------------------------------------------------------------- T6 ----

describe("T6: the trace day writes nothing from a moved read, then the next pass writes it without what was removed", () => {
  const DAY = new Date(2026, 9, 5, 9).getTime();
  const seedDay = () => {
    const ids: string[] = [];
    // 50 exchanges: more than one page, so the day read hands back between pages
    for (let i = 0; i < 50; i++) { ids.push(owner(`d${i}`, DAY + i * MIN, `Day note ${i}.`)); reply(`r${i}`, DAY + i * MIN + 1000); }
    return ids;
  };
  const cases: Array<[string, (r: Rig, ids: string[]) => void | Promise<void>, number]> = [
    ["a turn forgotten", (_r, ids) => { forgetMemory(ticket, { kind: "source", id: ids[0] }); }, 49],
    ["the thread excluded from memory", async () => { await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: ["private"] }, ticket, roster as never); }, 0],
    ["memory paused", r => { r.mode.value = "paused"; }, -1],
    ["a turn retired by a branch", (_r, ids) => { database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(ids[3]); }, 49],
    ["the bot's learning paused", () => { const db = database(); updateMemoryLearning(db, { botsPaused: ["moss"] }, readMemoryLearning(db).revision); }, 0],
  ];
  it.each(cases)("%s", async (_name, write, after) => {
    const ids = seedDay(), r = rig();
    r.clock.now = new Date(2026, 9, 7, 12).getTime();
    let fired = false;
    // the earliest read first (a hand-back before the thread, one between its two pages), then the day read: the write lands in the day read
    let betweens = 0;
    const between = async () => { betweens++; if (fired || betweens < 4) return; fired = true; await write(r, ids); };
    expect(await maybeTraceEpisodeSliced(r.deps, r.bot, between)).toBe(false);
    expect(fired).toBe(true);
    expect(listEpisodes(database(), "moss")).toHaveLength(0);
    expect(state().lastTraceDay).toBeUndefined();
    if (after < 0) { r.mode.value = "active"; after = 50; }
    const wrote = await maybeTraceEpisodeSliced(r.deps, r.bot, async () => {});
    const episodes = listEpisodes(database(), "moss");
    if (after === 0) { expect(episodes).toHaveLength(0); return; }
    expect(wrote).toBe(true);
    expect(episodes[0].text).toContain(`${after} messages`);
  });
});

// --------------------------------------------------------------- T8 ----

describe("T8: the read-move budget", () => {
  it("a thread moved on every page: pending three times with the attempt unchanged, then refused unstable with the cooldown", async () => {
    seedConversation(); const r = rig();
    let n = 0;
    // a payload touch on a bot reply: the thread's epoch moves, nothing about admission changes
    pipReadHooks.between = () => { if (!state().run) return; database().prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.touch',?) WHERE source_id=?").run(++n, sourceIdOf("b1")); };
    for (let move = 1; move <= READ_MOVE_BUDGET; move++) {
      expect(await run(r)).toMatchObject({ status: "uncertain", reason: "read-moved" });
      expect(family()).toMatchObject({ state: "pending", attempt: 1, readMoves: move });
    }
    const outcome = await run(r);
    expect(outcome).toMatchObject({ status: "refused", reason: "unstable" });
    expect(r.calls).toHaveLength(0);
    expect(state().run).toBeUndefined();
    expect(state().refusals[0]).toMatchObject({ state: "refused:unstable", reason: "read-moved" });
    expect(state().cooldownUntil).toBe(r.clock.now + COOLDOWN_MS);
  });
  it("a run whose first attempt keeps moving is refused run-bound once its deadline passes", async () => {
    seedConversation(); const r = rig();
    pipReadHooks.between = () => { if (!state().run) return; database().prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.touch',?) WHERE source_id=?").run(Math.random(), sourceIdOf("b1")); };
    expect(await run(r)).toMatchObject({ reason: "read-moved" });
    expect(state().run?.deadlineAt).toBe(r.clock.now + RUN_BOUND_MS);
    r.clock.now += RUN_BOUND_MS + 1;
    expect(await run(r)).toMatchObject({ status: "refused", reason: "unstable" });
    expect(state().refusals[0]).toMatchObject({ state: "refused:unstable", reason: "run-bound" });
    expect(r.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------- T9 ----

it("T9: the thread's audience changes from the owner to a contact during the read: nothing from it is sent or written", async () => {
  seedConversation(); const r = rig();
  during("pending", () => {
    database().prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:private',?,'human-thread','private',1,'granted',?)").run(ensureScope("conversation", "private"), JSON.stringify({ personId: "person-x", bindingId: "binding-x", revision: 1 }));
  });
  expect(await run(r)).toMatchObject({ reason: "read-moved" });
  pipReadHooks.between = undefined;
  await run(r);
  expect(r.calls).toHaveLength(0);
  expect(listEpisodes(database(), "moss")).toHaveLength(0);
});

// -------------------------------------------------------------- T11 ----

describe("T11: denies in force, and sources with no thread", () => {
  it("a deleted conversation, before the revocation runner: no sliced reader admits it, the pending check is false, claim confirm refuses", async () => {
    const ids = seedConversation(), db = database();
    expect((await admissibleOwnerSourcesSliced(db, "moss", { threadId: "private" }, async () => {})).length).toBe(3);
    captureThreadDeletion(db, "private");
    // the window before the revocation runner flips the rows: the deny row is committed, the sources still read active
    db.exec("UPDATE memory_sources SET state='active' WHERE thread_id='private'");
    expect(db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id='private'").get()).toBeTruthy();
    expect(await admissibleOwnerSourcesSliced(db, "moss", { threadId: "private" }, async () => {})).toEqual([]);
    expect(await hasAdmissibleAfterSliced(db, "moss", { threadId: "private" }, async () => {})).toBe(false);
    expect((await readSnapshotSliced(db, "moss", "private", undefined, [], async () => {})).snap?.sources ?? []).toEqual([]);
    expect(ownerSourceStillAdmissible(db, "moss", ids[0], 1)).toBe(false);
  });
  it("an import's NULL-thread sources and a restore over them move no epoch and abort nothing", () => {
    seedConversation();
    const db = database(), scope = ensureScope("bot", "moss");
    const moved = movedBy(() => {
      db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,?,?,'legacy-import','import','imported',NULL,'active')").run("import:a", scope, 1, "hash-a");
      db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run("import:a", 1, "hash-a", JSON.stringify({ text: "Imported." }), 1);
      db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='import:a'").run(JSON.stringify({ text: "Imported again." }));
    });
    expect(moved).toEqual({ global: false, threads: [] });
    db.prepare("INSERT INTO memory_tombstones VALUES('t-import','source','import:a',NULL,NULL,0,'test',0)").run();
    // restore's own pass flips the NULL-thread source: no thread row, nothing aborted
    const restored = movedBy(() => { applyMemoryTombstones(db); });
    expect(restored.threads).toEqual([]);
    expect(db.prepare("SELECT state FROM memory_sources WHERE id='import:a'").get()!.state).toBe("deleted");
    expect(db.prepare("SELECT count(*) AS n FROM temp.memory_thread_admission WHERE thread_id IS NULL").get()!.n).toBe(0);
  });
});

// ------------------------------------------------------- 3.10 / 3.12 ----

describe("the order of admitted sources and their time", () => {
  it("3.10: the order is total and deterministic: occurredAt, then message id, then rowid, then id, whatever order they arrive in", async () => {
    const at = T0;
    const base = { kind: "owner" as const, revision: 1, threadId: "private", text: "x", occurredAt: at };
    const rows: AdmittedSource[] = [
      { ...base, sourceId: "d", messageId: "m2", pos: 1 }, { ...base, sourceId: "c", messageId: "m1", pos: 9 },
      { ...base, sourceId: "b", messageId: "m1", pos: 4 }, { ...base, sourceId: "a", messageId: "m1", pos: 4 }, { ...base, sourceId: "e", messageId: "m0", occurredAt: at + 1, pos: 0 },
    ];
    const want = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 6; i++) {
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      expect(shuffled.sort(compareAdmitted).map(r => r.sourceId)).toEqual(want);
    }
    // through the readers: equal times order by message id, the paged and one-statement lists agree
    for (const id of ["z", "y", "x"]) owner(id, T0, `Same time ${id}.`);
    reply("rr", T0 + 1000);
    const db = database();
    const paged = await admissibleOwnerSourcesSliced(db, "moss", { threadId: "private" }, async () => {});
    expect(paged.map(s => s.messageId)).toEqual(["x", "y", "z"]);
    expect(admissibleOwnerSources(db, "moss", { threadId: "private" }).map(s => s.sourceId)).toEqual(paged.map(s => s.sourceId));
  });
  it("3.12: a malformed occurredAt is unknown, never epoch 0: the source is not admitted and does not sort first", async () => {
    const ids = seedConversation(), db = database();
    db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.occurredAt','soon') WHERE source_id=?").run(ids[1]);
    db.prepare("UPDATE memory_source_versions SET payload=json_remove(payload,'$.occurredAt') WHERE source_id=?").run(ids[2]);
    const listed = await admissibleOwnerSourcesSliced(db, "moss", { threadId: "private" }, async () => {});
    expect(listed.map(s => s.sourceId)).toEqual([ids[0]]);
    expect(listed.every(s => s.occurredAt > 0)).toBe(true);
    // the pending checks skip it too: after the one dated source nothing is admissible
    const q = { threadId: "private", afterAt: T0, afterMessageId: "o1" };
    expect(hasAdmissibleAfter(db, "moss", q)).toBe(false);
    expect(await hasAdmissibleAfterSliced(db, "moss", q, async () => {})).toBe(false);
  });
});

// ------------------------------------------- Astra pip-build Highs ----

describe("the `current` rows pass source admission (Astra pip-build H1)", () => {
  const sentTexts = (r: Rig) => r.calls.map(c => c.text).join("\n");
  /** An observed-style commitment resting on one owner source (one evidence handle). */
  const grounded = (sourceId: string) => {
    const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "k", expectedVersion: 0, text: "I will keep the lantern lit", basis: "owner-fact", audience: "owner-private" }, roster as never);
    database().prepare("INSERT INTO memory_evidence VALUES(?,?,?,1,0,11)").run(target.id, target.version, sourceId);
    return target;
  };
  // the source is ended the way the revocation runner ends one (a forget's cascade already takes the record with it)
  const retire = (sourceId: string) => { database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(sourceId); };
  it("a row whose evidence source was retired before the run never rides in `current`", async () => {
    const [first] = seedConversation(); const r = rig();
    grounded(first);
    retire(first);
    expect(await run(r)).toMatchObject({ status: "applied" });
    expect(r.calls.length).toBeGreaterThan(0);
    expect(sentTexts(r)).not.toContain("lantern");
  });
  it("a row whose evidence source is retired mid-run: the read moves and no request ever carries it", async () => {
    const [, second] = seedConversation(); const r = rig();
    grounded(second);
    let fired = false;
    pipReadHooks.between = () => { if (fired || family()?.state !== "pending") return; fired = true; retire(second); };
    expect(await run(r)).toMatchObject({ status: "uncertain", reason: "read-moved" });
    expect(r.calls).toHaveLength(0);
    pipReadHooks.between = undefined;
    expect(await run(r)).toMatchObject({ status: "applied" });
    expect(r.calls.length).toBeGreaterThan(0);
    expect(sentTexts(r)).not.toContain("lantern");
  });
  it("a row whose evidence rests in another of the bot's threads: a retire there moves the run's stamp (covered thread)", async () => {
    seedConversation(); const [task] = seedConversation(["Delta note."], "task-1", T0 + 10 * MIN); const r = rig(["private", "task-1"]);
    grounded(task);
    let fired = false;
    pipReadHooks.between = () => { if (fired || family()?.state !== "pending") return; fired = true; retire(task); };
    expect(await run(r)).toMatchObject({ status: "uncertain", reason: "read-moved" });
    expect(r.calls).toHaveLength(0);
    pipReadHooks.between = undefined;
    await run(r);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(sentTexts(r)).not.toContain("lantern");
  });
});

describe("a deletion during the model call is never undone by publication (Astra pip-build H2)", () => {
  it("a current commitment deleted while the model runs: nothing of the result is written, the family re-snapshots without the row", async () => {
    const ids = seedConversation(); const r = rig();
    const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "k", expectedVersion: 0, text: "I will keep the lantern lit", basis: "owner-fact", audience: "owner-private" }, roster as never);
    const lived = { proposals: [], stance: [], episode: { text: "The owner left three short notes today and asked once more that the lantern stay lit through the night.", sourceIds: ids } };
    r.deps.resolveRoute = async () => ({ fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model", textOnlyTurn: async input => {
      r.calls.push(input);
      // the owner deletes the row while the model runs; the model's answer (shaped by the row) quotes it
      if (r.calls.length === 1) { deletePipRecord(target.id, scopeOf("moss"), target.version); return { text: JSON.stringify(lived), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: lived } }; }
      return validated();
    } });
    const outcome = await run(r);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].text).toContain("lantern");
    expect(r.calls[1].text).not.toContain("lantern");
    expect(outcome.status).toBe("applied");
    // the row stays deleted and its words were written nowhere (no episode, no proposal, no new version)
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").all(target.id).map(x => x.state)).toEqual(["deleted"]);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active' AND text LIKE '%lantern%'").get()!.n)).toBe(0);
  });
  it("a shown row edited to a newer version while the evidence of the shown version is retired in a sibling thread: nothing of the result is written (r2: no newer-version shortcut)", async () => {
    seedConversation(); const [task] = seedConversation(["Delta note."], "task-1", T0 + 10 * MIN); const r = rig(["private", "task-1"]);
    const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "k", expectedVersion: 0, text: "I will keep the lantern lit", basis: "owner-fact", audience: "owner-private" }, roster as never);
    database().prepare("INSERT INTO memory_evidence VALUES(?,?,?,1,0,11)").run(target.id, target.version, task);
    const lived = { proposals: [], stance: [], episode: { text: "The owner left three short notes today and asked once more that the lantern stay lit through the night.", sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
    r.deps.resolveRoute = async () => ({ fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model", textOnlyTurn: async input => {
      r.calls.push(input);
      if (r.calls.length === 1) {
        // while the model runs: the owner edits the row (v2 active, v1 superseded) and the runner retires v1's evidence in task-1
        writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "k", expectedVersion: 1, text: "I will keep the beacon lit", basis: "owner-fact", audience: "owner-private" }, roster as never);
        database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(task);
        return { text: JSON.stringify(lived), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: lived } };
      }
      return validated();
    } });
    const outcome = await run(r);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].text).toContain("lantern");
    expect(r.calls[1].text).not.toContain("lantern");
    expect(r.calls[1].text).toContain("beacon");
    expect(outcome.status).toBe("applied");
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active' AND text LIKE '%lantern%'").get()!.n)).toBe(0);
  });
});
