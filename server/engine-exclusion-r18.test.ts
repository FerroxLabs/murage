// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Removing a deleted conversation's copies from the coding engines' files: the r17 review's findings, each closed by a test that
// reproduced it. The governing rule they share: whenever Murage is not certain it holds exclusion and has complete, current
// evidence, it changes NOTHING and the home stays pending (engine-open). It never merges two files, never replaces a name, never
// removes a folder recursively and never falls back to a weaker destructive operation.
// The exclusion is modelled here (testing/engine-exclusion-fake.ts); engine-exclusion.test.ts runs the same flows against the real
// addon and real second processes.
import { EventEmitter } from "node:events";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { forgetExclusionAddon, heldFileOf, loadExclusionAddon, overrideAllowed, type ExclusionAddon, type NativeHandle } from "./engine-exclusion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles as removeRaw, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { legacyRejoin, asExclusive, buildFixture, canaryHits, ENGINES, walDatabase, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const removeEngineHistoryFiles = legacyRejoin(removeRaw);
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r18-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const run = (fx: Fixture, planned = planEngineHistory(job(fx))) => executeEnginePlans(structuredClone(planned.plans!));
const whole = (fx: Fixture, planned = planEngineHistory(job(fx))) => removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
const ASIDE = ".murage-deleting";
const claudeProject = (fx: Fixture) => join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
const claudeHistory = (fx: Fixture) => join(fx.homes[0]!.home, "history.jsonl");
/** an exclusive-class file (no lock protocol): Codex's session index */
const codexIndex = (fx: Fixture) => join(fx.homes[0]!.home, "session_index.jsonl");
const fresh = dump({ sessionId: "sess-new", project: "/other", display: "written-by-another-engine" });
const count = (text: string, part: string) => text.split(part).length - 1;
/** Runs `work` with a member of a layer replaced, and puts it back. */
function patched<T extends object, K extends keyof T>(layer: T, name: K, replacement: T[K], work: () => void): void {
  const real = layer[name];
  layer[name] = replacement;
  try { work(); } finally { layer[name] = real; }
}

// ── 1: nothing is merged, replaced or repaired ───────────────────────────────────────────────────────────────────────────

describe("r17-1: when exclusion fails or a name is taken, both files stay exactly as they are and the home is pending", () => {
  it("a holder keeps the old inode busy while another engine makes the name anew: nothing is copied or unlinked, and a late append through the held descriptor is still reachable", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const planned = asExclusive(planEngineHistory(job(fx)));
    const held = openSync(history, "a"); // the engine's own descriptor on the old inode
    const release = (): void => {}; // (an engine holding it is now an engine running: see the r19 tests)
    const realOpeners = exclOps.lock;
    let ran!: ReturnType<typeof run>;
    // while the old file is checked, another engine makes the name again
    // (only when the history itself is being checked: it is aside and its name is free)
    const checkingHistory = () => existsSync(`${history}${ASIDE}`) && !existsSync(history);
    patched(exclOps, "lock", ((files: Parameters<typeof realOpeners>[0]) => { if (checkingHistory()) writeFileSync(history, fresh); return realOpeners(files); }) as typeof realOpeners, () => { ran = run(fx, planned); });
    expect(ran.homeReasons[key(fx)]).toBe("aside"); // the engine started a new file while the old one was set aside
    expect(readFileSync(history, "utf8")).toBe(fresh); // the new file is exactly what that engine wrote
    expect(readFileSync(`${history}${ASIDE}`, "utf8")).not.toContain(C("kimi")); // the old one was cleared under exclusion; the new file was not touched
    writeSync(held, dump({ sessionId: "sess-late", project: "/other", display: "late-bystander" }));
    expect(readFileSync(`${history}${ASIDE}`, "utf8")).toContain("late-bystander"); // the held descriptor still reaches a file with a name
    closeSync(held);
    release();
  });

  it("the new file ends in an unfinished row: the cleared rows are not appended into it, and a replay changes nothing", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const planned = asExclusive(planEngineHistory(job(fx)));
    const partial = '{"sessionId":"sess-new","project":"/other","display":"unfinis';
    const realOpeners = exclOps.lock;
    let ran!: ReturnType<typeof run>;
    const checkingHistory = () => existsSync(`${history}${ASIDE}`) && !existsSync(history);
    patched(exclOps, "lock", ((files: Parameters<typeof realOpeners>[0]) => { const answer = realOpeners(files); if (checkingHistory()) writeFileSync(history, partial); return answer; }) as typeof realOpeners, () => { ran = run(fx, planned); });
    expect(ran.homeReasons[key(fx)]).toBe("aside");
    expect(ran.staleHomes).toEqual([]);
    expect(readFileSync(history, "utf8")).toBe(partial); // no row was joined onto the unfinished one by the step that was cut short
    const aside = readFileSync(`${history}${ASIDE}`, "utf8");
    expect(aside).not.toContain(C("kimi")); // the private words were cleared under exclusion
    expect(aside).toContain(B("kimi"));
    // a replay of the old plan sees a file that is not the one planned (nothing is written)
    expect(run(fx, planned).staleHomes).toEqual([key(fx)]);
    // the next plan joins the two (REJOIN): the engine's newer rows follow the old ones, the file has its name, nothing is lost or doubled
    const replay = run(fx, legacyRejoin(planEngineHistory)(job(fx, { known: planned.discovery })));
    expect(replay.failed).toEqual([]);
    expect(existsSync(`${history}${ASIDE}`)).toBe(false);
    expect(existsSync(`${history}.murage-rejoining`)).toBe(false);
    const joined = readFileSync(history, "utf8");
    expect(joined.startsWith(aside)).toBe(true);
    expect(joined.endsWith(partial)).toBe(true);
    expect(count(joined, B("kimi"))).toBe(1);
    expect(joined).not.toContain(C("kimi"));
  });

  it("an interruption between the link back and the unlink leaves one file with two names: a replay sees ONE file, drops the extra name, and appends nothing", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const aside = `${history}${ASIDE}`;
    const first = asExclusive(planEngineHistory(job(fx)));
    const size = lstatSync(history).size;
    let crashed = false;
    patched(mutOps, "unlink", ((path: string) => { if (!crashed && path === aside) { crashed = true; throw new Error("crash between the link and the unlink"); } unlinkSync(path); }) as typeof mutOps.unlink, () => { expect(run(fx, first).failed.length).toBeGreaterThan(0); });
    expect(crashed).toBe(true);
    expect(lstatSync(history).ino).toBe(lstatSync(aside).ino); // two names, one inode
    for (let again = 0; again < 3; again++) {
      const replay = run(fx, planEngineHistory(job(fx, { known: first.discovery })));
      expect(replay.failed).toEqual([]);
      expect(existsSync(aside)).toBe(false);
      const text = readFileSync(history, "utf8");
      expect(lstatSync(history).size).toBe(size); // not one byte longer: no self-append, however many replays
      expect(count(text, B("kimi"))).toBe(1);
      expect(text).not.toContain(C("kimi"));
    }
  });

  it("a leftover aside is recovered only when its name is free; when another file has the name, neither is touched", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const aside = `${history}${ASIDE}`;
    const first = asExclusive(planEngineHistory(job(fx)));
    patched(mutOps, "link", (() => { throw new Error("crash before the file goes back"); }) as typeof mutOps.link, () => { run(fx, first); });
    expect(existsSync(history)).toBe(false);
    expect(existsSync(aside)).toBe(true);
    // 1) held, with the name free: nothing changes
    const asideBefore = readFileSync(aside);
    const release = fake.openEngine("kimi");
    const whileOpen = planEngineHistory(job(fx, { known: first.discovery }));
    expect(whileOpen.homeReasons?.[key(fx)]).toBe("engine-open"); // an open engine's home is not even read
    expect(run(fx, whileOpen).failed).toEqual([]);
    expect(readFileSync(aside).equals(asideBefore)).toBe(true);
    expect(existsSync(history)).toBe(false);
    release();
    // 2) another engine makes the name: the two are joined (REJOIN), the old rows first, and nothing the engine wrote is lost
    writeFileSync(history, fresh);
    const replay = run(fx, planEngineHistory(job(fx, { known: first.discovery })));
    expect(replay.failed).toEqual([]);
    const joined = readFileSync(history, "utf8");
    expect(joined).toContain("written-by-another-engine");
    expect(joined).toContain(B("kimi"));
    expect(joined).not.toContain(C("kimi"));
    expect(existsSync(aside)).toBe(false);
  });
});

// ── 5: no replacing fallback ─────────────────────────────────────────────────────────────────────────────────────────────

describe("r17-5: with no hard links the file goes back only by an atomic no-replace rename", () => {
  const noLinks = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };

  it("a file made by another engine at the very moment of the rename is never replaced", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const planned = asExclusive(planEngineHistory(job(fx)));
    fake.beforeRename = (from, to) => { if (from.endsWith(ASIDE)) writeFileSync(to, fresh); };
    let ran!: ReturnType<typeof run>;
    patched(mutOps, "link", noLinks as unknown as typeof mutOps.link, () => { ran = run(fx, planned); });
    expect(ran.homeReasons[key(fx)]).toBe("aside");
    expect(readFileSync(history, "utf8")).toBe(fresh); // not one byte of it was replaced
    expect(readFileSync(`${history}${ASIDE}`, "utf8")).toContain(B("kimi")); // and the other file is kept
  });

  it("where no-replace is not possible the file stays aside and the home is pending (no replacing rename is tried)", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const planned = asExclusive(planEngineHistory(job(fx)));
    const real = exclOps.renameNoReplace;
    const seen: string[] = [];
    let ran!: ReturnType<typeof run>;
    patched(exclOps, "renameNoReplace", ((from: string, to: string) => { seen.push(from); return from.endsWith(ASIDE) ? "unsupported" : real(from, to); }) as typeof real, () => {
      patched(mutOps, "link", noLinks as unknown as typeof mutOps.link, () => { ran = run(fx, planned); });
    });
    expect(seen.some((from) => from.endsWith(ASIDE))).toBe(true);
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(existsSync(history)).toBe(false);
    expect(readFileSync(`${history}${ASIDE}`, "utf8")).not.toContain(C("kimi"));
  });

  it("where a file cannot be moved aside without risk nothing at all is moved", () => {
    const fx = buildFixture("kimi", scratch);
    const history = codexIndex(fx);
    const before = readFileSync(history);
    const planned = asExclusive(planEngineHistory(job(fx)));
    let ran!: ReturnType<typeof run>;
    patched(exclOps, "renameNoReplace", (() => "unsupported") as typeof exclOps.renameNoReplace, () => { ran = run(fx, planned); });
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(readFileSync(history).equals(before)).toBe(true);
    expect(existsSync(`${history}${ASIDE}`)).toBe(false);
  });
});

// ── 2: recovery names are discovered ─────────────────────────────────────────────────────────────────────────────────────

describe("r17-2: a file left aside by an interrupted removal is found, owned and removed", () => {
  const crashAfter = (match: (from: string) => boolean, work: () => void) => {
    const real = exclOps.renameNoReplace;
    patched(exclOps, "renameNoReplace", ((from: string, to: string) => { const answer = real(from, to); if (match(from)) throw new Error("crash right after the rename"); return answer; }) as typeof real, work);
  };

  it("a Codex rollout interrupted right after its rename is removed by the replay (it was reported finished with the rollout still there)", () => {
    const fx = buildFixture("codex", scratch);
    const sessions = join(fx.homes[0]!.home, "sessions", "2026", "10", "11");
    const rollout = readdirSync(sessions).find((name) => name.startsWith("rollout-2026-10-11T10-00-00"))!;
    const planned = planEngineHistory(job(fx));
    crashAfter((from) => from.endsWith(rollout), () => { run(fx, planned); });
    expect(existsSync(join(sessions, `${rollout}${ASIDE}`))).toBe(true);
    expect(existsSync(join(sessions, rollout))).toBe(false);
    const replay = whole(fx, planned);
    expect(replay.failed).toEqual([]);
    expect(existsSync(join(sessions, `${rollout}${ASIDE}`))).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("a Claude paste interrupted right after its rename is removed by the replay, though its original name is gone", () => {
    const fx = buildFixture("claude", scratch);
    const paste = join(fx.homes[0]!.home, "paste-cache", "ab12cd34ef56ab12.txt");
    const planned = planEngineHistory(job(fx));
    crashAfter((from) => from === paste, () => { run(fx, planned); });
    expect(existsSync(`${paste}${ASIDE}`)).toBe(true);
    expect(existsSync(paste)).toBe(false);
    const replay = whole(fx, planned);
    expect(replay.failed).toEqual([]);
    expect(existsSync(`${paste}${ASIDE}`)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });
});

// ── 3: original and aside are two files ──────────────────────────────────────────────────────────────────────────────────

describe("r17-3: a transcript and the copy of it a crash left aside are read and judged separately", () => {
  it("the aside names a plan slug the original does not: its plan file goes too, and nothing clears before it does", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const transcript = join(claudeProject(fx), "sess-claude-1.jsonl");
    writeFileSync(`${transcript}${ASIDE}`, dump({ type: "user", cwd: fx.folders[0], sessionId: "sess-claude-1", slug: "aside-only-slug", message: C("claude") }));
    writeFileSync(join(h, "plans", "aside-only-slug.md"), C("claude"));
    const result = whole(fx);
    expect(result.failed).toEqual([]);
    expect(existsSync(`${transcript}${ASIDE}`)).toBe(false);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(join(h, "plans", "aside-only-slug.md"))).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("the aside names a foreign working folder: it is a bystander's and stays untouched, and the original waits behind it (pending)", () => {
    const fx = buildFixture("claude", scratch);
    const transcript = join(claudeProject(fx), "sess-claude-1.jsonl");
    const foreign = dump({ type: "user", cwd: "/somebody/elses/folder", sessionId: "sess-foreign", message: B("claude") });
    writeFileSync(`${transcript}${ASIDE}`, foreign);
    const result = whole(fx);
    expect(readFileSync(`${transcript}${ASIDE}`, "utf8")).toBe(foreign); // not removed, not read as ours
    expect(result.failed).toContain(transcript); // our copy cannot be moved aside while another file sits at that name: pending
    expect(result.homeReasons?.[key(fx)]).toBe("held");
    expect(readFileSync(transcript, "utf8")).toContain(C("claude"));
    // the aside is judged on its own: with no foreign aside the same home finishes
    rmSync(`${transcript}${ASIDE}`);
    expect(whole(fx).failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
  });

  it("the plan carries a separate fingerprint for each physical file, so a change to the aside alone stops only its removal", () => {
    const fx = buildFixture("claude", scratch);
    const transcript = join(claudeProject(fx), "sess-claude-1.jsonl");
    writeFileSync(`${transcript}${ASIDE}`, dump({ type: "user", cwd: fx.folders[0], sessionId: "sess-claude-1", message: C("claude") }));
    const planned = planEngineHistory(job(fx));
    const step = planned.plans![key(fx)]!.steps.find((item) => item.k === "remove" && item.expect) as { assoc: Record<string, string>; expect: string[] };
    expect(step.expect).toContain("sess-claude-1.jsonl");
    expect(step.expect).toContain(`sess-claude-1.jsonl${ASIDE}`);
    expect(Object.keys(step.assoc).sort()).toEqual(["sess-claude-1.jsonl", `sess-claude-1.jsonl${ASIDE}`]);
    expect(step.assoc["sess-claude-1.jsonl"]).toBeTruthy();
  });
});

// ── 4: folders ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("r17-4: a folder is removed file by file, only while nobody holds the folder either, and never recursively", () => {
  it("a process retaining the project folder (open, or as its working directory) keeps the whole removal pending: nothing is renamed, read or removed", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const project = claudeProject(fx);
    const planned = planEngineHistory(job(fx));
    const release = fake.openEngine("claude");
    const refused = run(fx, planned);
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(existsSync(join(project, "sess-claude-1.jsonl"))).toBe(true);
    expect(existsSync(`${project}${ASIDE}`)).toBe(false);
    expect(h).toBeTruthy();
    release();
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(project)).toBe(false);
  });

  it("no engine's removal ever removes a folder recursively", () => {
    for (const engine of ENGINES) {
      const fx = buildFixture(engine, scratch);
      let trees = 0;
      patched(mutOps, "removeTree", (() => { trees++; throw new Error("recursive removal"); }) as typeof mutOps.removeTree, () => {
        const result = whole(fx);
        expect(result.failed, engine).toEqual([]);
      });
      expect(trees, engine).toBe(0);
      expect(canaryHits(fx.root, fx.canaries), engine).toEqual([]);
    }
  });

  it("a name that arrives in a folder while its files are being removed survives, with the folder, and the home is planned again", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const folder = join(h, "file-history", "sess-claude-1");
    const planned = planEngineHistory(job(fx));
    const real = mutOps.unlink;
    let arrived = false;
    let ran!: ReturnType<typeof run>;
    patched(mutOps, "unlink", ((path: string) => {
      real(path);
      if (!arrived && path.startsWith(`${folder}${ASIDE}${sep}`)) { arrived = true; writeFileSync(join(`${folder}${ASIDE}`, "late"), B("claude")); }
    }) as typeof mutOps.unlink, () => { ran = run(fx, planned); });
    expect(arrived).toBe(true);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(join(folder, "late"), "utf8")).toBe(B("claude")); // put back under its name, with the new file
    expect(existsSync(`${folder}${ASIDE}`)).toBe(false);
  });
});

// ── 7: Windows: every handle stays in the addon ──────────────────────────────────────────────────────────────────────────

describe("r17-7: on Windows every operation on a held file is made by the addon on a handle it owns", () => {
  beforeEach(() => { fake.restore(); fake = useFakeExclusion("win32"); });

  it("no numeric descriptor is used for a held file: reads, writes, syncs and closes all go through the handle object, and the lock is the handle's", () => {
    const kinds = new Set<string>();
    const realPwrite = mutOps.pwrite, realPread = mutOps.pread, realFsync = mutOps.fsync, realClose = mutOps.close;
    mutOps.pwrite = ((fd: unknown, bytes: Buffer, at: number) => { kinds.add(`pwrite ${typeof fd}`); return (realPwrite as (...a: unknown[]) => void)(fd, bytes, at); }) as typeof mutOps.pwrite;
    mutOps.pread = ((fd: unknown, length: number, at: number) => { kinds.add(`pread ${typeof fd}`); return (realPread as (...a: unknown[]) => Buffer)(fd, length, at); }) as typeof mutOps.pread;
    mutOps.fsync = ((fd: unknown) => { kinds.add(`fsync ${typeof fd}`); return (realFsync as (...a: unknown[]) => void)(fd); }) as typeof mutOps.fsync;
    mutOps.close = ((fd: unknown) => { kinds.add(`close ${typeof fd}`); return (realClose as (...a: unknown[]) => void)(fd); }) as typeof mutOps.close;
    const numericLock = vi.fn(() => { throw new Error("a numeric descriptor was handed to the lock"); });
    Object.assign(exclOps, { lock: numericLock });
    try {
      for (const engine of ["fuigo", "codex"] as const) {
        const fx = buildFixture(engine, scratch);
        expect(whole(fx).failed, engine).toEqual([]);
        expect(canaryHits(fx.root, fx.canaries), engine).toEqual([]);
      }
    } finally { Object.assign(mutOps, { pwrite: realPwrite, pread: realPread, fsync: realFsync, close: realClose }); }
    expect(numericLock).not.toHaveBeenCalled();
    expect([...kinds].filter((kind) => kind.startsWith("pwrite") || kind.startsWith("fsync"))).toEqual(expect.arrayContaining(["pwrite object", "fsync object"]));
    expect(kinds.has("pwrite number")).toBe(false);
    expect(kinds.has("pread number")).toBe(false);
    expect(kinds.has("fsync number")).toBe(false);
  });

  it("the handle wrapper runs every call in the addon on the one native handle, refuses a closed handle, and closes once", () => {
    const native: NativeHandle = { tag: "native" };
    const calls: string[] = [];
    const addon = {
      handleRead: (h: NativeHandle, length: number, position: number) => { expect(h).toBe(native); calls.push(`read ${length}@${position}`); return Buffer.from("ab"); },
      handleWrite: (h: NativeHandle) => { expect(h).toBe(native); calls.push("write"); },
      handleSync: () => { calls.push("sync"); },
      handleLock: () => { calls.push("lock"); return true; },
      handleMarkDelete: () => { calls.push("markDelete"); return true; },
      handleId: () => [5n, 9n] as [bigint, bigint],
      handleSize: () => 42,
      handleClose: () => { calls.push("close"); },
    } as unknown as ExclusionAddon;
    const held = heldFileOf(addon, native);
    expect(held.read(2, 7).toString()).toBe("ab");
    held.write(Buffer.from("x"), 0); held.sync();
    expect(held.lock()).toBe(true);
    expect(held.markDelete()).toBe(true);
    expect(held.id()).toEqual({ dev: 5n, ino: 9n });
    expect(held.size()).toBe(42);
    held.close(); held.close();
    expect(calls.filter((call) => call === "close")).toHaveLength(1);
    expect(() => held.read(1, 0)).toThrow(/closed/);
  });

  it("on Windows an addon that lacks the handle functions does not load", () => {
    const dir = mkdtempSync(join(scratch, "addon-"));
    const file = join(dir, "posix-only.cjs");
    writeFileSync(file, "module.exports={lock:()=>true,processes:()=>[],renameNoReplace:()=>0,version:()=>5};");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const saved = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = file;
    forgetExclusionAddon();
    try {
      expect(loadExclusionAddon()?.version()).toBe(8); // here (not Windows) it is complete enough
      forgetExclusionAddon();
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(loadExclusionAddon()).toBeNull(); // on Windows an addon without the handle functions is refused
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (saved === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = saved;
      forgetExclusionAddon();
    }
  });
});

// ── Claude Code's history: the engine's own directory lock ────────────────────────────────────────────────────────────────

describe("real-engine (a): Claude Code's history is cleared under its directory lock, history.jsonl.lock", () => {
  const hash = "ab12cd34ef56ab12";
  const pasteOf = (fx: Fixture) => join(fx.homes[0]!.home, "paste-cache", `${hash}.txt`);
  const lockOf = (fx: Fixture) => `${claudeHistory(fx)}.lock`;

  it("the folder is made before the first compare, kept fresh while held, and removed after the last verify; the file stays in place", () => {
    const fx = buildFixture("claude", scratch);
    const history = claudeHistory(fx);
    const lock = lockOf(fx);
    const planned = planEngineHistory(job(fx));
    const inode = lstatSync(history).ino;
    const events: string[] = [];
    const at: Record<string, number> = {};
    const real = { mkdir: mutOps.mkdir, rmdir: mutOps.rmdir, touchAt: mutOps.touchAt, pwrite: mutOps.pwrite, fsync: mutOps.fsync };
    // the lock is made under a private name and takes the public one by a rename that cannot replace
    const realMove = exclOps.renameNoReplace;
    exclOps.renameNoReplace = ((from: string, to: string) => { if (to === lock) { events.push("mkdir"); at.start = Date.now(); } return realMove(from, to); }) as typeof realMove;
    mutOps.rmdir = ((path: string) => { if (path.startsWith(`${lock}.murage-`)) { events.push("rmdir"); at.end = Date.now(); } real.rmdir(path); }) as typeof mutOps.rmdir;
    mutOps.touchAt = ((path: string, seconds: number) => { if (path.startsWith(lock)) events.push("touch"); real.touchAt(path, seconds); }) as typeof mutOps.touchAt;
    mutOps.pwrite = ((fd: never, bytes: Buffer, position: number) => { events.push("pwrite"); real.pwrite(fd, bytes, position); }) as typeof mutOps.pwrite;
    mutOps.fsync = ((fd: never) => { events.push("fsync"); real.fsync(fd); }) as typeof mutOps.fsync;
    try { expect(run(fx, planned).failed).toEqual([]); } finally { Object.assign(mutOps, real); exclOps.renameNoReplace = realMove; }
    const first = events.indexOf("mkdir");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("touch")).toBeGreaterThanOrEqual(0); // made fresh before it takes the name
    expect(events.indexOf("pwrite")).toBeGreaterThan(first);
    expect(events.lastIndexOf("fsync")).toBeLessThan(events.lastIndexOf("rmdir"));
    expect(events.filter((event) => event === "mkdir")).toEqual(events.filter((event) => event === "rmdir").map(() => "mkdir")); // every lock let go
    expect(at.end! - at.start!).toBeLessThan(2000); // well under the 9 s the engine waits
    expect(existsSync(lock)).toBe(false);
    expect(lstatSync(history).ino).toBe(inode);
    expect(existsSync(`${history}${ASIDE}`)).toBe(false);
    expect(readFileSync(history, "utf8")).not.toContain(C("claude"));
    expect(readFileSync(history, "utf8")).toContain(B("claude"));
  });

  it("the engine's lock is respected: a fresh folder is never removed, nothing is written, the home is pending; when it is let go the rows are cleared", () => {
    const fx = buildFixture("claude", scratch);
    const history = claudeHistory(fx);
    const lock = lockOf(fx);
    const planned = planEngineHistory(job(fx));
    const before = readFileSync(history);
    mkdirSync(lock);
    writeFileSync(join(lock, "engine-marker"), "engine");
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(ran.staleHomes).toEqual([]);
    expect(readFileSync(history).equals(before)).toBe(true);
    expect(readFileSync(join(lock, "engine-marker"), "utf8")).toBe("engine"); // its folder, untouched
    expect(existsSync(pasteOf(fx))).toBe(true);
    removeTempDirSync(lock);
    expect(run(fx, planned).failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain(C("claude"));
    expect(existsSync(lock)).toBe(false);
  });

  it("a folder nobody touched for 10 s is abandoned by the engine's own rule: it is replaced, the work is done, and it is removed", () => {
    const fx = buildFixture("claude", scratch);
    const lock = lockOf(fx);
    const planned = planEngineHistory(job(fx));
    mkdirSync(lock);
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(claudeHistory(fx), "utf8")).not.toContain(C("claude"));
  });

  it("a history the engine replaced (its own prune writes a temp file and renames it) after the plan is stale, and nothing is written", () => {
    const fx = buildFixture("claude", scratch);
    const history = claudeHistory(fx);
    const planned = planEngineHistory(job(fx));
    const text = readFileSync(history, "utf8");
    writeFileSync(`${history}.tmp`, text);
    renameSync(`${history}.tmp`, history); // as its prune does: a new file takes the name
    const ran = run(fx, planned);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(history, "utf8")).toBe(text);
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  it("the plan names the directory lock for Claude's history, and no other file uses it", () => {
    const fx = buildFixture("claude", scratch);
    const steps = Object.values(planEngineHistory(job(fx)).plans!).flatMap((plan) => plan.steps).filter((step) => step.k === "rewrite") as Array<{ how: string; path: string }>;
    expect(steps.map((step) => step.how)).toEqual(["dirlock"]);
    for (const engine of ["fuigo", "codex", "kimi"] as const) {
      const other = Object.values(planEngineHistory(job(buildFixture(engine, scratch))).plans!).flatMap((plan) => plan.steps).filter((step) => step.k === "rewrite") as Array<{ how: string }>;
      expect(other.every((step) => step.how !== "dirlock"), engine).toBe(true);
    }
  });

  it("Windows runs the same protocol (it needs no handle from the addon)", () => {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("claude", scratch);
    fake.calls.length = 0;
    expect(run(fx).failed).toEqual([]);
    expect(fake.calls.some((call) => call.includes(claudeHistory(fx)) && call.startsWith("openFile"))).toBe(false);
    expect(readFileSync(claudeHistory(fx), "utf8")).not.toContain(C("claude"));
    expect(existsSync(lockOf(fx))).toBe(false);
  });

  describe("a paste is removed only while the history that could name it is held, from the check to the removal (r17 finding 8)", () => {
    it("the lock is made before the check, the paste is taken aside and unlinked inside it, and the lock goes last", () => {
      const fx = buildFixture("claude", scratch);
      const paste = pasteOf(fx);
      const lock = lockOf(fx);
      const planned = planEngineHistory(job(fx));
      const events: string[] = [];
      const real = { mkdir: mutOps.mkdir, rmdir: mutOps.rmdir, unlink: mutOps.unlink };
      const realRename = exclOps.renameNoReplace;
      mutOps.mkdir = ((path: string) => { real.mkdir(path); }) as typeof mutOps.mkdir;
      mutOps.rmdir = ((path: string) => { events.push(`rmdir ${path}`); real.rmdir(path); }) as typeof mutOps.rmdir;
      mutOps.unlink = ((path: string) => { events.push(`unlink ${path}`); real.unlink(path); }) as typeof mutOps.unlink;
      exclOps.renameNoReplace = ((from: string, to: string) => { events.push(to === lock ? `mkdir ${lock}` : `rename ${from}`); return realRename(from, to); }) as typeof realRename;
      try { expect(run(fx, planned).failed).toEqual([]); } finally { Object.assign(mutOps, real); Object.assign(exclOps, { renameNoReplace: realRename }); }
      const held = events.lastIndexOf(`mkdir ${lock}`);
      const taken = events.indexOf(`rename ${paste}`);
      const gone = events.indexOf(`unlink ${paste}${ASIDE}`);
      const released = events.map((event) => event.startsWith(`rmdir ${lock}.murage-`)).lastIndexOf(true); // a lock folder goes only under a private name
      expect(held).toBeGreaterThanOrEqual(0);
      expect(taken).toBeLessThan(held); // the paste is out of the engine's sight before the lock is taken
      expect(taken).toBeLessThan(gone);
      expect(gone).toBeLessThan(released);
      expect(existsSync(paste)).toBe(false);
    });

    it("an engine that takes its lock between the rows' clearing and the check keeps the paste: nothing is removed and the home is pending", () => {
      const fx = buildFixture("claude", scratch);
      const lock = lockOf(fx);
      const planned = planEngineHistory(job(fx));
      const real = mutOps.rmdir;
      let injected = false;
      // right after Murage lets go of its lock for the history's own rows, the engine takes it for a write of its own
      mutOps.rmdir = ((path: string) => { real(path); if (path.startsWith(`${lock}.murage-`) && !injected) { injected = true; mkdirSync(lock); } }) as typeof mutOps.rmdir;
      let ran!: ReturnType<typeof run>;
      try { ran = run(fx, planned); } finally { mutOps.rmdir = real; }
      expect(injected).toBe(true);
      expect(ran.homeReasons[key(fx)]).toBe("engine-open");
      expect(readFileSync(pasteOf(fx), "utf8")).toBe(C("claude"));
      expect(existsSync(lock)).toBe(true); // the engine's, not removed
    });

    it("a held history keeps the paste while a row in it still names the hash", () => {
      const fx = buildFixture("claude", scratch);
      const history = claudeHistory(fx);
      const planned = planEngineHistory(job(fx));
      writeFileSync(history, readFileSync(history, "utf8") + dump({ sessionId: "sess-new", project: "/other", display: "x", pastedContents: { 1: { contentHash: hash } } }));
      expect(run(fx, planned).failed).toEqual([]);
      expect(existsSync(pasteOf(fx))).toBe(true);
    });
  });
});

// ── 10: a failed delete mark is an unfinished removal ────────────────────────────────────────────────────────────────────

describe("r17-10: Windows: a delete mark that could not be set leaves the file and the home pending", () => {
  it("every markDelete false: the transcript stays under its name, nothing is unlinked in its place, and the home says engine-open", () => {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("claude", scratch);
    const transcript = join(claudeProject(fx), "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    fake.markDeleteFails = true;
    const unlinked: string[] = [];
    let ran!: ReturnType<typeof run>;
    patched(mutOps, "unlink", ((path: string) => { unlinked.push(path); rmSync(path); }) as typeof mutOps.unlink, () => { ran = run(fx, planned); });
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(ran.staleHomes).toEqual([]);
    expect(readFileSync(transcript, "utf8")).toContain(C("claude"));
    expect(unlinked.filter((path) => path.includes("sess-claude-1.jsonl"))).toEqual([]);
    expect(existsSync(`${claudeProject(fx)}${ASIDE}`)).toBe(false);
    fake.markDeleteFails = false;
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
  });
});

// ── 9: the override is for tests ─────────────────────────────────────────────────────────────────────────────────────────

describe("r17-9: MURAGE_ENGINE_EXCLUSION_PATH is honoured only by an unpackaged test process, and is decided before any file is loaded", () => {
  it("overrideAllowed", () => {
    expect(overrideAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(overrideAllowed({ NODE_ENV: "test", MURAGE_PACKAGED: "1" })).toBe(false);
    expect(overrideAllowed({ NODE_ENV: "test", MURAGE_RESOURCES_PATH: "/app/resources" })).toBe(false);
    expect(overrideAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(overrideAllowed({})).toBe(false);
  });

  it("a packaged-mode loader never requires the override file (its initialisation code does not run)", () => {
    const dir = mkdtempSync(join(scratch, "override-"));
    const marker = join(dir, "ran");
    const file = join(dir, "hostile.cjs");
    writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); module.exports={lock:()=>true,processes:()=>[],renameNoReplace:()=>0,openFile:()=>null,handleRead:()=>0,handleWrite:()=>0,handleSync:()=>0,handleLock:()=>0,handleMarkDelete:()=>0,handleId:()=>0,handleSize:()=>0,handleClose:()=>0,version:()=>5};`);
    const saved = { path: process.env.MURAGE_ENGINE_EXCLUSION_PATH, packaged: process.env.MURAGE_PACKAGED };
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = file;
    process.env.MURAGE_PACKAGED = "1";
    forgetExclusionAddon();
    try {
      expect(loadExclusionAddon()?.version()).not.toBe(99);
      expect(existsSync(marker)).toBe(false);
      // and the same file IS used by an unpackaged test process (the stand-ins the suite relies on)
      delete process.env.MURAGE_PACKAGED;
      forgetExclusionAddon();
      expect(loadExclusionAddon()?.version()).toBe(8);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (saved.path === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = saved.path;
      if (saved.packaged === undefined) delete process.env.MURAGE_PACKAGED; else process.env.MURAGE_PACKAGED = saved.packaged;
      forgetExclusionAddon();
    }
  });
});

// ── 12: the done line expires for the window too ─────────────────────────────────────────────────────────────────────────

class ScriptedWorker extends EventEmitter {
  threadId = 12;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

describe("r17-12: 'Removed from <Engine>.' runs out for an open window as well", () => {
  async function finishedDeletion() {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const seen: Array<{ texts: string[]; rev: number }> = [];
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], onOwed: (notices, rev) => seen.push({ texts: notices.map((item) => item.text), rev }) });
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) })) as unknown as Worker;
    const release = fake.keepLock(log);
    await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    release();
    expect(await deletions.retryNow()).toBe(1);
    expect(seen.at(-1)!.texts).toEqual(["Removed from Fuigo."]);
    return { deletions, seen };
  }

  it("when the line runs out the revision advances and the window is told with an empty list (by the timer)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { deletions, seen } = await finishedDeletion();
      const shown = seen.at(-1)!.rev;
      const told = seen.length;
      vi.advanceTimersByTime(5 * 60_000 + 100);
      expect(seen.length).toBeGreaterThan(told);
      expect(seen.at(-1)!.texts).toEqual([]);
      expect(seen.at(-1)!.rev).toBeGreaterThan(shown);
      expect(deletions.currentRev()).toBe(seen.at(-1)!.rev);
      expect(deletions.notices()).toEqual([]);
      deletions.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("an answer asked after the line ran out is empty and newer than the one that showed it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { deletions, seen } = await finishedDeletion();
      const shown = seen.at(-1)!.rev;
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
      expect(deletions.notices()).toEqual([]);
      expect(seen.at(-1)!.texts).toEqual([]);
      expect(deletions.currentRev()).toBeGreaterThan(shown);
      deletions.dispose();
    } finally { vi.useRealTimers(); }
  });
});

// ── real-engine (b): Codex's daemon keeps a rollout open for about a minute after the terminal closes ───────────────────────

describe("real-engine (b): a deletion right after closing Codex is tried again every 30 s for 3 minutes", () => {
  async function pendingDeletion(engine: "codex" | "fuigo") {
    const fx = buildFixture(engine, scratch);
    const held = engine === "codex" ? join(fx.homes[0]!.home, "history.jsonl") : join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    let jobs = 0;
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => { jobs++; worker.emit("message", { type: "result", result: runEngineHistoryJob(message) }); }) as unknown as Worker;
    fake.keepLock(held); // the engine keeps its lock for the whole test
    await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    expect(deletions.pending()[0]!.owed?.homes[0]?.code).toBe("engine-open");
    return { deletions, jobs: () => jobs };
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

  it("Codex: a replay at 30, 60, 90, 120, 150 and 180 s, then the normal schedule (120 s next)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { deletions, jobs } = await pendingDeletion("codex");
      let seen = jobs();
      for (let step = 1; step <= 6; step++) {
        await vi.advanceTimersByTimeAsync(29_000); await flush();
        expect(jobs(), `before ${step * 30} s`).toBe(seen);
        await vi.advanceTimersByTimeAsync(1_000); await flush();
        expect(jobs(), `at ${step * 30} s`).toBeGreaterThan(seen);
        seen = jobs();
      }
      await vi.advanceTimersByTimeAsync(60_000); await flush();
      expect(jobs()).toBe(seen); // the seventh pause is the normal 120 s
      await vi.advanceTimersByTimeAsync(60_000); await flush();
      expect(jobs()).toBeGreaterThan(seen);
      deletions.dispose();
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it("another engine keeps the normal schedule: 30 s, then 120 s", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { deletions, jobs } = await pendingDeletion("fuigo");
      let seen = jobs();
      await vi.advanceTimersByTimeAsync(30_000); await flush();
      expect(jobs()).toBeGreaterThan(seen);
      seen = jobs();
      await vi.advanceTimersByTimeAsync(60_000); await flush();
      expect(jobs()).toBe(seen);
      await vi.advanceTimersByTimeAsync(60_000); await flush();
      expect(jobs()).toBeGreaterThan(seen);
      deletions.dispose();
    } finally { vi.useRealTimers(); }
  }, 30_000);
});

// ── real-engine (c): a Codex thread whose rollout is already gone ─────────────────────────────────────────────────────────

describe("real-engine (c): Codex threads are also found in the state database by the working folder", () => {
  it("a thread with no rollout left has its prompt rows, logs and history lines removed; another folder's thread is untouched", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!;
    const orphan = "019a0000-aaaa-7bbb-8ccc-0000000000aa", other = "019a0000-aaaa-7bbb-8ccc-0000000000bb";
    walDatabase(join(home.sqliteHome!, "state_2.sqlite"), (db) => {
      db.exec("CREATE TABLE threads(id TEXT, first_user_message TEXT, cwd TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
      db.prepare("INSERT INTO threads VALUES(?,?,?)").run(orphan, "orphan-canary-7731", fx.folders[0]!);
      db.prepare("INSERT INTO logs VALUES(?,?)").run(orphan, "orphan-canary-7731");
      db.prepare("INSERT INTO threads VALUES(?,?,?)").run(other, "orphan-bystander-1", "/some/other/folder");
      db.prepare("INSERT INTO logs VALUES(?,?)").run(other, "orphan-bystander-1");
    });
    writeFileSync(join(home.home, "history.jsonl"), readFileSync(join(home.home, "history.jsonl"), "utf8") + dump({ session_id: orphan, text: "orphan-canary-7731" }));
    const result = whole(fx);
    expect(result.failed).toEqual([]);
    expect(canaryHits(fx.root, ["orphan-canary-7731", ...fx.canaries])).toEqual([]);
    const db = new DatabaseSync(join(home.sqliteHome!, "state_2.sqlite"));
    try {
      expect(db.prepare("SELECT id FROM threads").all()).toEqual([{ id: other }]);
      expect(db.prepare("SELECT thread_id FROM logs").all()).toEqual([{ thread_id: other }]);
    } finally { db.close(); }
    expect(readFileSync(join(home.home, "history.jsonl"), "utf8")).not.toContain("orphan-canary-7731");
  });
});
