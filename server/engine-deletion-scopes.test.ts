// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 phase 2 (design "Phase 2 r3", R3.6): Murage's private Codex and Grok scopes are found from their own markers, held through every
// instance of their engine, gated without looking at the owner's interactive engines (only a process whose arguments name the scope,
// and the scope's own locks, count), and recovered only once held. Each test fails on 3a4610373 unless it is marked a guard.
// The new exports are read through the module namespace, so on a build that lacks them each test fails on its own assertion.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import * as closed from "./engine-closed.ts";
import * as deletion from "./conversation-deletion.ts";
import { ConversationDeletions, type DeletionEngineHome } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { configureRedo, listRedo, writeRedo } from "./engine-redo.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { canaryHits } from "./testing/engine-history-fixtures.ts";
import { buildScope, OID, TID, type ScopeFixture } from "./testing/engine-scope-fixture.ts";
import { DATA_DIR } from "./config.ts";
import { GENERATION_PREFIX, SCOPE_MARKER, scopedCliHomeRoot, scopeId } from "./drivers/scoped-cli-home.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-scopes-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let fake: FakeExclusion | null = null;
afterEach(() => { fake?.restore(); fake = null; configure(null); delete process.env.MURAGE_TEST_EXTRA_PROCESSES; delete (engineHistoryTestHooks as Record<string, unknown>).createWorker; });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };

const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const OTHER_BOT = "0d6a3c22-5b1e-4c55-9e0f-6b8f1a2c3d4e";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const OTHER_THREAD = "9b0e3c1a-0000-4000-8000-000000000001";

type Closed = typeof closed & {
  configureScopes?: (dir: string | null) => void;
  privateScopeHome?: (engine: string, home: string, native?: string | null) => boolean;
};
const api = closed as Closed;
const configure = (dir: string | null) => api.configureScopes?.(dir);
/** A fake pid that is never this test process or its parent: engineState skips its own pid, so a fake engine that drew the worker's
 * pid (9000-9899 is a real worker pid range on CI runners) would be ignored and a scope it names would read closed. */
const fakePid = (): number => { let pid: number; do pid = 9000 + (++counter % 900); while (pid === process.pid || pid === process.ppid); return pid; };
const foreign = (name: string, argv: string[] = [name]) => ({ ...proc(`/usr/local/bin/${name}`, argv, fakePid()) });

/** A data folder with one bot conversation (THREAD) and another of the same bot (OTHER_THREAD), and the owner's own ~/.codex. */
function world(engine: "codex" | "grok" = "codex", extra: Record<string, unknown> = {}) {
  const root = fresh("w");
  const data = join(root, "data"), native = join(data, "native");
  const folder = join(data, "workspaces", BOT, "threads", THREAD), otherFolder = join(data, "workspaces", BOT, "threads", OTHER_THREAD);
  mkdirSync(folder, { recursive: true });
  mkdirSync(otherFolder, { recursive: true });
  writeFileSync(join(folder, "notes.md"), "x");
  const owner = join(root, "home", engine === "codex" ? ".codex" : ".grok");
  mkdirSync(owner, { recursive: true });
  const scope = buildScope(native, engine, BOT, owner, folder, otherFolder, extra);
  return { root, data, native, folder, otherFolder, owner, scope };
}

function sqlIds(file: string): string[] {
  const db = new DatabaseSync(file);
  try { return (db.prepare("SELECT id FROM threads ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id); } finally { db.close(); }
}

function expectScopeClean(scope: ScopeFixture) {
  for (const file of scope.gone) expect(existsSync(file), `${file} is still there`).toBe(false);
  expect(canaryHits(scope.home, [scope.canary]), "the deleted conversation's words are still in the scope").toEqual([]);
  expect(scope.checkBystander(), "the other conversation of the same bot was touched").toEqual([]);
  if (scope.engine === "codex") expect(sqlIds(join(scope.home, "state_1.sqlite"))).toEqual([OID]);
}

describe("structure: the private-scope rule follows the driver's layout", () => {
  it("the same scope folder, id hash, marker name and generation prefix as drivers/scoped-cli-home.ts", () => {
    const shape = closed as unknown as { scopeRootOf?: (native: string, engine: string) => string; scopeIdOf?: (realHome: string, botId?: string) => string };
    for (const engine of ["codex", "grok"]) expect(shape.scopeRootOf?.(join(DATA_DIR, "native"), engine)).toBe(scopedCliHomeRoot(engine));
    expect(shape.scopeIdOf?.("/home/someone/.codex", BOT)).toBe(scopeId("/home/someone/.codex", BOT));
    expect(SCOPE_MARKER).toBe(".murage-scope.json");
    expect(GENERATION_PREFIX).toBe("login-g");
  });
});

describe("T1-T4, T11: the private gate", () => {
  beforeEach(() => { fake = useFakeExclusion("posix"); });

  it("T1: a foreign codex (its arguments do not name the scope) leaves the scope closed; the same list leaves ~/.codex open", () => {
    const w = world();
    configure(w.native);
    fake!.processes.push(foreign("codex", ["codex", "resume", "--last"]));
    expect(closed.engineState("codex", w.scope.home).state).toBe("closed");
    expect(closed.engineState("codex", w.owner).state).toBe("open");
  });

  it("T2: a codex whose arguments name the scope (or a path under it) opens it; another scope's path does not", () => {
    const w = world();
    configure(w.native);
    const other = join(w.native, "codex-scope", "abcdef0123456789");
    fake!.processes = [foreign("codex", ["codex", "--cd", other]), foreign("codex", ["codex", `${w.scope.home}x`])];
    expect(closed.engineState("codex", w.scope.home).state).toBe("closed");
    fake!.processes = [foreign("codex", ["codex", "exec", "-C", join(w.scope.home, "sessions")])];
    expect(closed.engineState("codex", w.scope.home)).toMatchObject({ state: "open", via: "process" });
    fake!.processes = [foreign("codex", ["codex", `--config=home=${w.scope.home}`])];
    expect(closed.engineState("codex", w.scope.home).state).toBe("open");
  });

  it("T2: Windows: the scope named in mixed case with backslashes opens it", () => {
    const w = world();
    fake!.restore();
    fake = useFakeExclusion("win32");
    configure(w.native);
    fake.processes = [foreign("codex", ["codex.exe", w.scope.home.toUpperCase().replace(/\//g, "\\")])];
    expect(closed.engineState("codex", w.scope.home).state).toBe("open");
    fake.processes = [foreign("codex", ["codex.exe", "C:\\Users\\someone\\.codex"])];
    expect(closed.engineState("codex", w.scope.home).state).toBe("closed");
  });

  it("T3: an engine process whose arguments cannot be read makes the scope unknown, never closed", () => {
    const w = world();
    configure(w.native);
    fake!.processes = [{ ...foreign("codex"), argv: null }];
    expect(closed.engineState("codex", w.scope.home).state).toBe("unknown");
  });

  it("T4: a bad marker, a mismatched id, a non-empty subdir, a linked root or a login generation is not private: the machine-wide rule applies", () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => string]> = [
      ["no marker", (w) => { writeFileSync(join(w.scope.home, ".murage-scope.json"), "{"); return w.scope.home; }],
      ["marker for another bot", (w) => { writeFileSync(join(w.scope.home, ".murage-scope.json"), JSON.stringify({ realHome: w.owner, botId: OTHER_BOT })); return w.scope.home; }],
      ["a relative realHome", (w) => { writeFileSync(join(w.scope.home, ".murage-scope.json"), JSON.stringify({ realHome: "home/.codex", botId: BOT })); return w.scope.home; }],
      ["a subdir", (w) => { writeFileSync(join(w.scope.home, ".murage-scope.json"), JSON.stringify({ realHome: w.owner, botId: BOT, subdir: ".codex" })); return w.scope.home; }],
      ["a login generation", (w) => { mkdirSync(join(w.scope.home, "login-g1")); return w.scope.home; }],
      ["a generation pointer", (w) => { writeFileSync(join(w.scope.home, ".murage-scope.json"), JSON.stringify({ realHome: w.owner, botId: BOT, generation: 1 })); return w.scope.home; }],
      ["a link to the scope", (w) => { const link = join(w.native, "codex-scope", "0123456789abcdef"); symlinkSync(w.scope.home, link); return link; }],
    ];
    for (const [name, make] of cases) {
      const w = world();
      configure(w.native);
      const home = make(w);
      fake!.processes = [foreign("codex")];
      expect(api.privateScopeHome?.("codex", home) ?? false, name).toBe(false);
      expect(closed.engineState("codex", home).state, name).toBe("open");
    }
    // and the valid one is private
    const w = world();
    configure(w.native);
    expect(api.privateScopeHome?.("codex", w.scope.home)).toBe(true);
  });

  it("T4: a scope lock held by any process opens the scope (the engine's own locks still count)", () => {
    const w = world();
    configure(w.native);
    const lock = join(w.scope.home, "thread-writer-locks", `${TID}.lock`);
    writeFileSync(lock, "");
    const release = fake!.keepLock(lock);
    expect(closed.engineState("codex", w.scope.home)).toMatchObject({ state: "open", via: "lock" });
    release();
    expect(closed.engineState("codex", w.scope.home).state).toBe("closed");
  });

  it("T11 guard: the owner's ~/.claude with a foreign claude stays open (no per-session inference)", () => {
    const home = fresh("claude-home");
    configure(fresh("native"));
    fake!.processes = [foreign("claude")];
    expect(closed.engineState("claude", home).state).toBe("open");
  });
});

describe("T8: a scope is removed in one attempt while a foreign codex runs; the other conversation of the bot stays", () => {
  it("rollout, history row, session index row, shell snapshot and SQLite rows of this conversation only", () => {
    fake = useFakeExclusion("posix");
    for (const engine of ["codex", "grok"] as const) {
      const w = world(engine);
      configure(w.native);
      fake.processes = [foreign(engine === "codex" ? "codex" : "grok")];
      const result = removeEngineHistoryFiles([{ engine, home: w.scope.home }], [w.folder], [], {});
      expect(result.failed, engine).toEqual([]);
      expectScopeClean(w.scope);
      // the owner's home with the same process list is not touched
      expect(planEngineHistory({ kind: "plan", homes: [{ engine, home: w.owner }], folders: [w.folder], memoryFolders: [], sessions: {} }).homeReasons?.[homeKey(engine, w.owner)]).toBe("engine-open");
    }
  });

  it("T12 guard: a crash after the SQLite delete and before its checkpoint: the next plan of the scope still checkpoints", () => {
    fake = useFakeExclusion("posix");
    const w = world();
    configure(w.native);
    const homes: DeletionEngineHome[] = [{ engine: "codex", home: w.scope.home }];
    const planned = planEngineHistory({ kind: "plan", homes, folders: [w.folder], memoryFolders: [], sessions: {} });
    const key = homeKey("codex", w.scope.home);
    const steps = planned.plans![key]!.steps;
    const at = steps.findIndex((step) => step.k === "checkpoint");
    expect(at).toBeGreaterThan(0);
    expect(() => executeEnginePlans(planned.plans!, undefined, { beforeStep: (_key, index) => { if (index === at) throw new Error("crash"); } })).toThrow("crash");
    const again = planEngineHistory({ kind: "plan", homes, folders: [w.folder], memoryFolders: [], sessions: {}, known: planned.discovery });
    expect(again.plans![key]!.steps.some((step) => step.k === "checkpoint" && step.cls === "content")).toBe(true);
  });
});

/** A deletion service over `w.data`, with a hold that records the homes it was asked for. */
function service(w: ReturnType<typeof world>, hold?: (homes: DeletionEngineHome[]) => DeletionEngineHome[]) {
  const db = new DatabaseSync(join(w.data, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const asked: DeletionEngineHome[][] = [];
  const deletions = new ConversationDeletions({
    dataDir: w.data, database: () => db, retryDelaysMs: [], staleQuietMs: 10,
    holdHomes: async (homes) => { asked.push(homes); return { release: () => {}, skipped: hold?.(homes) ?? [] }; },
  });
  return { deletions, asked };
}
const scopeHomes = (homes: readonly DeletionEngineHome[]) => homes.filter((home) => home.home.includes(`${"native"}`) && /-scope/.test(home.home)).map((home) => `${home.engine}:${home.home}`).sort();

/** The deletion's off-thread work, run on this thread (so the fake exclusion layer below is the one it sees). */
class InlineWorker extends EventEmitter {
  threadId = 7;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
/** Foreign engines (the owner's own, in a terminal) run for the whole deletion, whose environment cannot be read. On every platform:
 * MURAGE_TEST_EXTRA_PROCESSES reaches only the stand-in addon, which Windows does not load (it lacks the Windows calls), so there the
 * real addon would answer and these processes would not exist. */
const foreignRunning = (...names: string[]) => {
  engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
  fake = useFakeExclusion("posix");
  for (const name of names) fake.processes.push(foreign(name));
};

describe("T5-T7, T9, T10: the deletion service", () => {
  it("T5: the bot's Codex and Grok scopes (a Grok routed home too) are planned from their markers, saved in the record, and removed while a foreign codex and grok run; the owner's ~/.codex waits", async () => {
    const w = world("codex");
    const grokOwner = join(w.root, "home", ".grok");
    const routed = join(w.data, "native", "grok-provider-context", "f".repeat(64), "flux");
    const grok = buildScope(w.native, "grok", BOT, routed, w.folder, w.otherFolder);
    buildScope(w.native, "codex", OTHER_BOT, w.owner, join(w.data, "workspaces", OTHER_BOT, "threads", THREAD), w.otherFolder);
    foreignRunning("codex", "grok");
    const { deletions, asked } = service(w);
    // the instance environment names other homes (the owner's own), never a scope
    const report = await deletions.finish(deletions.begin({ threadIds: [THREAD], engineHomes: [{ engine: "codex", home: w.owner }, { engine: "grok", home: grokOwner }] }));
    expect(scopeHomes(asked.flat()), "the scopes were not held").toEqual([`codex:${w.scope.home}`, `grok:${grok.home}`].sort());
    expectScopeClean(w.scope);
    expectScopeClean(grok);
    // the owner's homes wait for the owner's engines; the record keeps the scopes it found
    expect(report.failed).toEqual(expect.arrayContaining([w.owner]));
    expect(scopeHomes(deletions.pending()[0]!.engineHomes)).toEqual([`codex:${w.scope.home}`, `grok:${grok.home}`].sort());
  });

  it("T6: a record written by 1.0.3 (no scope homes) gains the scopes on its first attempt", async () => {
    const w = world("codex");
    const { deletions, asked } = service(w);
    const entry = deletions.begin({ threadIds: [THREAD] });
    // exactly what 1.0.3 saved: no scope among the homes
    expect(entry.engineHomes).toEqual([]);
    const restarted = service(w);
    expect(await restarted.deletions.reconcile(() => false, () => {})).toBe(1);
    expect(scopeHomes(restarted.asked.flat())).toEqual([`codex:${w.scope.home}`]);
    expectScopeClean(w.scope);
    expect(restarted.deletions.pending()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("T7: a scope is held through every instance of its engine, an owner home through its own; a busy instance skips the scope", async () => {
    const w = world("codex");
    const helper = (deletion as unknown as { instancesForHomes?: (homes: DeletionEngineHome[], instances: Array<{ instanceId: string; engine: string; homes: DeletionEngineHome[] }>, native: string) => { ids: string[]; byHome: Map<string, string[]> } }).instancesForHomes;
    expect(typeof helper, "instancesForHomes is missing").toBe("function");
    const instances = [
      { instanceId: "codex-a", engine: "codex", homes: [{ engine: "codex" as const, home: w.owner }] },
      { instanceId: "codex-b", engine: "codex", homes: [{ engine: "codex" as const, home: join(w.root, "elsewhere") }] },
      { instanceId: "claude", engine: "claude", homes: [{ engine: "claude" as const, home: join(w.root, ".claude") }] },
    ];
    const mapped = helper!([{ engine: "codex", home: w.scope.home }, { engine: "codex", home: w.owner }], instances, w.native);
    expect(mapped.ids.sort()).toEqual(["codex-a", "codex-b"]);
    expect(mapped.byHome.get(homeKey("codex", w.scope.home))!.sort()).toEqual(["codex-a", "codex-b"]);
    expect(mapped.byHome.get(homeKey("codex", w.owner))).toEqual(["codex-a"]);
    // busy: the service skips the scope, touches nothing in it, and says it was in use (never "open")
    const before = readFileSync(w.scope.gone[0]!, "utf8");
    const { deletions } = service(w, (homes) => homes.filter((home) => home.home === w.scope.home));
    const report = await deletions.finish(deletions.begin({ threadIds: [THREAD] }));
    expect(report.failed).toContain(w.scope.home);
    expect(readFileSync(w.scope.gone[0]!, "utf8")).toBe(before);
  });

  it("T9: a scope with a login generation gets a leftover line, every file of it stays, and it is not owed", async () => {
    const w = world("codex");
    mkdirSync(join(w.scope.home, "login-g1"));
    const before = readFileSync(w.scope.gone[0]!, "utf8");
    const { deletions, asked } = service(w);
    const report = await deletions.finish(deletions.begin({ threadIds: [THREAD] }));
    expect(report.leftovers).toContainEqual({ what: "Codex's own copy of this conversation", where: "Murage's private Codex folder for this bot" });
    expect(readFileSync(w.scope.gone[0]!, "utf8")).toBe(before);
    expect(scopeHomes(asked.flat())).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(deletions.pending()).toEqual([]);
  });

  it("T9: a scope that gains a login generation after it was saved leaves the record with the leftover line", async () => {
    const w = world("codex");
    foreignRunning("codex");
    const owner = { engine: "codex" as const, home: w.owner };
    const { deletions } = service(w);
    const entry = deletions.begin({ threadIds: [THREAD], engineHomes: [owner] });
    await deletions.finish(entry);
    expect(scopeHomes(deletions.pending()[0]!.engineHomes)).toEqual([`codex:${w.scope.home}`]);
    // the scope was cleaned; it now splits its login, and another conversation writes in it
    mkdirSync(join(w.scope.home, "login-g1"));
    writeFileSync(join(w.scope.home, "sessions", "2026", "10", "20", "rollout-new.jsonl"), "x");
    const again = await deletions.finish(deletions.pending()[0]!);
    expect(again.leftovers).toContainEqual({ what: "Codex's own copy of this conversation", where: "Murage's private Codex folder for this bot" });
    expect(scopeHomes(deletions.pending()[0]!.engineHomes)).toEqual([]);
    expect(existsSync(join(w.scope.home, "sessions", "2026", "10", "20", "rollout-new.jsonl"))).toBe(true);
  });

  it("T10: a scope's journal is not recovered at start; it is recovered inside the attempt once the scope is held", async () => {
    const w = world("codex");
    const redo = join(w.data, "engine-redo");
    configureRedo(redo);
    let id: string;
    try { id = writeRedo({ path: join(w.scope.home, "gone.jsonl"), dev: "1", ino: "2", engine: "codex", home: w.scope.home, how: "lock", format: "codex-history", rows: [] }); } finally { configureRedo(undefined); }
    const ids = () => { configureRedo(redo); try { return listRedo().map((rec) => rec.id); } finally { configureRedo(undefined); } };
    foreignRunning("codex");
    const { deletions } = service(w);
    deletions.begin({ threadIds: [THREAD] });
    // the start: the scope's instance is busy, so its hold is refused
    const busy = service(w, (homes) => homes.filter((home) => home.home === w.scope.home));
    await busy.deletions.reconcile(() => false, () => {});
    expect(ids(), "the scope's journal was finished before the scope was held").toContain(id);
    // the next attempt holds it
    const free = service(w);
    await free.deletions.finish(free.deletions.pending()[0]!);
    expect(ids()).not.toContain(id);
    expectScopeClean(w.scope);
  });
});
