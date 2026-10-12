// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The REAL native addon (native/engine-exclusion/exclusion.c), against REAL second processes: a flock held by another process, a
// file held open by another process, and the executor's refusal to change a file while either is true. The addon is built by
// scripts/build-engine-exclusion.mjs (Linux, gcc, in the build host container); where it is not built these tests are skipped, and the
// executor is covered against a model of the same behaviour (engine-exclusion-r17.test.ts).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { executeEnginePlans } from "./engine-exec.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { planEngineHistory } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, type Fixture } from "./testing/engine-history-fixtures.ts";

const built = builtAddonPath();
const posix = process.platform !== "win32";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-excl-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const children: ChildProcess[] = [];
/** Ends the holder and every process it started (a sleep inherits the descriptor, so killing only the shell would not let go). */
const stop = (child: ChildProcess) => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
afterEach(() => { for (const child of children.splice(0)) stop(child); });

/** A second process that prints `ready` once it holds what it was asked to hold, and then waits. */
function holder(script: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    children.push(child);
    child.on("error", reject);
    child.stdout!.once("data", () => resolve(child));
    child.on("exit", () => reject(new Error("the holder exited before it was ready")));
  });
}
const exited = (child: ChildProcess) => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode) setTimeout(resolve, 100); else child.once("exit", () => setTimeout(resolve, 100)); });
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);

describe.skipIf(!built || !posix)("the real addon, with real second processes", () => {
  let restore = () => {};
  beforeAll(() => { restore = useRealExclusion(built!); });
  afterAll(() => restore());

  it("loads, and says what it is", () => {
    const addon = loadExclusionAddon()!;
    expect(addon.version()).toBe(2);
    expect(Object.keys(addon).sort()).toEqual(["lock", "openers", "renameNoReplace", "version"]);
  });

  it("lock: free file is locked at once; a lock another process keeps is waited for about a second and then refused; released, it is taken", async () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "locked.jsonl");
    writeFileSync(file, "x\n");
    const fd = openSync(file, "r+");
    expect(addon.lock(fd)).toBe(true);
    closeSync(fd);
    // another process: util-linux flock(1) takes the same flock(2) lock the engine takes
    const other = await holder(`exec flock -x ${file} -c 'echo ready; sleep 30'`);
    const second = openSync(file, "r+");
    const started = Date.now();
    expect(addon.lock(second)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(5000);
    stop(other);
    await exited(other);
    expect(addon.lock(second)).toBe(true);
    closeSync(second);
  }, 20_000);

  it("openers: a file another process has open is reported, one only this process has open is not, and a closed one is not", async () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "held.jsonl");
    writeFileSync(file, "x\n");
    const id = (path: string) => { const stat = lstatSync(path, { bigint: true }); return [stat.dev, stat.ino] as const; };
    const [dev, ino] = id(file);
    const mine = openSync(file, "r");
    expect(addon.openers([dev], [ino])).toEqual([false]); // this process's own handle is not "another process"
    closeSync(mine);
    const other = await holder(`exec 3<${file}; echo ready; sleep 30`);
    expect(addon.openers([dev], [ino])).toEqual([true]);
    const unrelated = join(scratch, "unrelated.jsonl");
    writeFileSync(unrelated, "y\n");
    const [udev, uino] = id(unrelated);
    expect(addon.openers([dev, udev], [ino, uino])).toEqual([true, false]);
    stop(other);
    await exited(other);
    expect(addon.openers([dev], [ino])).toEqual([false]);
    expect(() => addon.openers([1 as unknown as bigint], [2n])).toThrow();
  }, 20_000);

  it("Fuigo's log: while another process keeps the engine's lock nothing is written and the home is pending; when it lets go the rows are cleared", async () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const before = readFileSync(log);
    const inode = lstatSync(log).ino;
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await holder(`exec flock -x ${log} -c 'echo ready; sleep 30'`);
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(refused.staleHomes).toEqual([]);
    expect(readFileSync(log).equals(before)).toBe(true); // not one byte
    stop(other);
    await exited(other);
    const done = executeEnginePlans(structuredClone(plan));
    expect(done.failed).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain("canary-fuigo-5521");
    expect(lstatSync(log).ino).toBe(inode);
  }, 30_000);

  it("Codex's session index (no lock protocol): while another process has it open it goes back untouched and the home is pending; when it closes the rows are cleared and the file is back under its name", async () => {
    const fx = buildFixture("codex", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const before = readFileSync(index);
    const inode = lstatSync(index).ino;
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await holder(`exec 3<>${index}; echo ready; sleep 30`);
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(lstatSync(index).ino).toBe(inode);
    stop(other);
    await exited(other);
    const done = executeEnginePlans(structuredClone(plan));
    expect(done.failed).toEqual([]);
    expect(readFileSync(index, "utf8")).not.toContain("canary-codex-5521");
    expect(readFileSync(index, "utf8")).toContain("bystander-codex-9917");
    expect(lstatSync(index).ino).toBe(inode);
  }, 30_000);

  it("Claude's history (directory lock): a process holding the file open is no obstacle (the engine holds nothing idle) but the engine's fresh lock folder is; the rows are cleared in place", async () => {
    const fx = buildFixture("claude", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const inode = lstatSync(history).ino;
    const plan = planEngineHistory(job(fx)).plans!;
    mkdirSync(`${history}.lock`);
    const before = readFileSync(history);
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(history).equals(before)).toBe(true);
    expect(existsSync(`${history}.lock`)).toBe(true);
    rmSync(`${history}.lock`, { recursive: true });
    const done = executeEnginePlans(structuredClone(plan));
    expect(done.failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain("canary-claude-5521");
    expect(readFileSync(history, "utf8")).toContain("bystander-claude-9917");
    expect(lstatSync(history).ino).toBe(inode);
    expect(existsSync(`${history}.lock`)).toBe(false);
  }, 30_000);

  it("a transcript another process has open is not removed: it is put back and the home is pending", async () => {
    const fx = buildFixture("claude", scratch);
    const project = join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
    const transcript = join(project, "sess-claude-1.jsonl");
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await holder(`exec 3<>${transcript}; echo ready; sleep 30`);
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(transcript, "utf8")).toContain("canary-claude-5521");
    expect(() => lstatSync(`${project}.murage-deleting`)).toThrow();
    expect(() => lstatSync(`${transcript}.murage-deleting`)).toThrow();
    appendFileSync(transcript, "");
    stop(other);
    await exited(other);
    expect(executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!)).failed).toEqual([]);
    expect(() => lstatSync(transcript)).toThrow();
  }, 30_000);

  // ── r17: the no-replace rename, folders as holders, and a scan that cannot be completed ────────────────────────────────

  const idsOf = (path: string) => { const stat = lstatSync(path, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; };

  it("renameNoReplace: a free name takes the file; a taken name answers 'exists' and neither file changes; a missing source throws ENOENT", () => {
    const addon = loadExclusionAddon()!;
    const dir = mkdtempSync(join(scratch, "rnr-"));
    const from = join(dir, "from"), to = join(dir, "to");
    writeFileSync(from, "mine");
    expect(addon.renameNoReplace(from, to)).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("mine");
    expect(existsSync(from)).toBe(false);
    writeFileSync(from, "second");
    expect(addon.renameNoReplace(from, to)).toBe(1);
    expect(readFileSync(to, "utf8")).toBe("mine"); // not replaced
    expect(readFileSync(from, "utf8")).toBe("second"); // not moved
    // folders too, and a folder never replaces an EMPTY folder (a plain rename would)
    mkdirSync(join(dir, "d1")); mkdirSync(join(dir, "d2"));
    writeFileSync(join(dir, "d1", "inside"), "in");
    expect(addon.renameNoReplace(join(dir, "d1"), join(dir, "d2"))).toBe(1);
    expect(readFileSync(join(dir, "d1", "inside"), "utf8")).toBe("in");
    expect(() => addon.renameNoReplace(join(dir, "missing"), join(dir, "elsewhere"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("a file made at the instant of the give-back (no hard links) is not replaced: the real no-replace rename refuses and the home is pending", () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const plan = planEngineHistory(job(fx)).plans!;
    const real = mutOps.link;
    const bystander = '{"sessionId":"sess-new","project":"/other","display":"made-at-that-instant"}\n';
    mutOps.link = ((_from: string, to: string) => { writeFileSync(to, bystander); throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }) as typeof mutOps.link;
    let ran!: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(plan)); } finally { mutOps.link = real; }
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(history, "utf8")).toBe(bystander);
    expect(readFileSync(`${history}.murage-deleting`, "utf8")).toContain("bystander-codex-9917");
  });

  it("openers: a folder another process stands in (working directory) or holds open is reported; a free folder is not", async () => {
    const addon = loadExclusionAddon()!;
    const base = mkdtempSync(join(scratch, "dirs-"));
    const cwdDir = join(base, "cwd"), fdDir = join(base, "fd"), freeDir = join(base, "free");
    for (const dir of [cwdDir, fdDir, freeDir]) mkdirSync(dir);
    const ids = [cwdDir, fdDir, freeDir].map(idsOf);
    expect(addon.openers(ids.map((id) => id.dev), ids.map((id) => id.ino))).toEqual([false, false, false]);
    const inside = await holder(`cd ${cwdDir}; echo ready; sleep 30`);
    expect(addon.openers(ids.map((id) => id.dev), ids.map((id) => id.ino))).toEqual([true, false, false]);
    const reading = await holder(`exec 3<${fdDir}; echo ready; sleep 30`);
    expect(addon.openers(ids.map((id) => id.dev), ids.map((id) => id.ino))).toEqual([true, true, false]);
    stop(inside); stop(reading);
    await exited(inside); await exited(reading);
    expect(addon.openers(ids.map((id) => id.dev), ids.map((id) => id.ino))).toEqual([false, false, false]);
  }, 20_000);

  it("a process keeping the project folder (as its working directory, or open) keeps the whole removal pending, and nothing in it is touched", async () => {
    for (const how of ["cwd", "fd"] as const) {
      const fx = buildFixture("claude", scratch);
      const project = join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
      const transcript = join(project, "sess-claude-1.jsonl");
      const plan = planEngineHistory(job(fx)).plans!;
      const other = await holder(how === "cwd" ? `cd ${project}; echo ready; sleep 30` : `exec 3<${project}; echo ready; sleep 30`);
      const refused = executeEnginePlans(structuredClone(plan));
      expect(refused.homeReasons[key(fx)], how).toBe("engine-open");
      expect(readFileSync(transcript, "utf8"), how).toContain("canary-claude-5521");
      expect(existsSync(`${project}.murage-deleting`), how).toBe(false);
      stop(other);
      await exited(other);
      expect(executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!)).failed, how).toEqual([]);
      expect(existsSync(project), how).toBe(false);
    }
  }, 40_000);

  const python = spawnSync("python3", ["-V"]).status === 0;
  it.skipIf(!python)("a scan that cannot inspect a process of this user says 'held' for everything, never 'free'", async () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "unrelated-for-scan.jsonl");
    writeFileSync(file, "x\n");
    const { dev, ino } = idsOf(file);
    expect(addon.openers([dev], [ino])).toEqual([false]);
    // a process of this user that other processes of this user may not look into (PR_SET_DUMPABLE 0): its /proc entries answer EACCES
    const closed = await holder("exec python3 -c \"import ctypes,sys,time; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready'); sys.stdout.flush(); time.sleep(30)\"");
    const opaque = spawnSync("sh", ["-c", `ls /proc/${closed.pid}/fd >/dev/null 2>&1`]).status !== 0;
    if (opaque) expect(addon.openers([dev], [ino])).toEqual([true]);
    stop(closed);
    await exited(closed);
    expect(addon.openers([dev], [ino])).toEqual([false]);
  }, 20_000);

  it("a scan does not stop at processes of other users: they are skipped only when confirmed to be another user's", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "other-users.jsonl");
    writeFileSync(file, "x\n");
    const { dev, ino } = idsOf(file);
    // pid 1 and the kernel's own threads belong to another user in a container; a free file must still be reported free
    expect(addon.openers([dev], [ino])).toEqual([false]);
    expect(exclOps.mode).toBe("posix");
  });
});
