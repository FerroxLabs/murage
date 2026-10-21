// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The REAL native addon (native/engine-exclusion/exclusion.c), against REAL second processes: a flock held by another process, a
// running process that IS an engine (a copy of `sleep` named claude or codex), the list of processes, and the executor's refusal to
// change a file while either is true. The addon is built by
// scripts/build-engine-exclusion.mjs (Linux, gcc, in the build host container); where it is not built these tests are skipped, and the
// executor is covered against a model of the same behaviour (engine-exclusion-r17.test.ts).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { executeEnginePlans } from "./engine-exec.ts";
import { engineState } from "./engine-closed.ts";
import { mutOps } from "./engine-fs.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { planEngineHistory } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { asExclusive, buildFixture, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const built = builtAddonPath();
const posix = process.platform !== "win32";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-excl-")));
afterAll(() => removeTempDirSync(scratch));

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
/** A second process that takes the engine's own whole-file lock (flock) through the addon itself, prints `ready`, and keeps it. Portable:
 * macOS has no flock(1). */
function lockHolder(file: string): Promise<ChildProcess> {
  const code = `const fs=require("fs");const a=require(process.argv[1]);const fd=fs.openSync(process.argv[2],"r+");if(!a.lock(fd))process.exit(2);console.log("ready");setInterval(()=>{},1000);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code, built!, file], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    children.push(child);
    child.on("error", reject);
    child.stdout!.once("data", () => resolve(child));
    child.on("exit", () => reject(new Error("the lock holder exited before it was ready")));
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
    expect(addon.version()).toBe(8);
    expect(Object.keys(addon).sort()).toEqual(["bootId", "fullSync", "lock", "processes", "renameNoReplace", "version", "writers"]);
  });

  it("lock: free file is locked at once; a lock another process keeps is waited for about a second and then refused; released, it is taken", async () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "locked.jsonl");
    writeFileSync(file, "x\n");
    const fd = openSync(file, "r+");
    expect(addon.lock(fd)).toBe(true);
    closeSync(fd);
    // another process takes the same flock(2) lock the engine takes
    const other = await lockHolder(file);
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

  /** A copy of `sleep` under the engine's name: a real second process whose program is `claude` (or `codex`, ...). */
  const engineBinary = (name: string): string => {
    const dir = mkdtempSync(join(scratch, "bin-"));
    const file = join(dir, name);
    copyFileSync("/bin/sleep", file);
    chmodSync(file, 0o755);
    return file;
  };
  /** The process is running as the engine's program (the shell has started it, which is not the same as it having become it). */
  const running = async (file: string): Promise<ChildProcess> => {
    const child = await holder(`${file} 30 & echo ready; wait`);
    const addon = loadExclusionAddon()!;
    for (let waited = 0; waited < 5000 && !addon.processes().some((item) => item.exe === file); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    return child;
  };

  it("processes: a second process is listed with its pid, parent, owner, program and arguments, and is gone from the list once it ends", async () => {
    const addon = loadExclusionAddon()!;
    const binary = engineBinary("claude");
    const other = await running(binary);
    const mine = addon.processes().find((item) => item.exe === binary);
    expect(mine).toBeDefined();
    expect(mine!.mine).toBe(true);
    expect(mine!.argv).toEqual([binary, "30"]);
    expect(mine!.start).toBeGreaterThan(0);
    expect(typeof mine!.ppid).toBe("number");
    expect(addon.processes().some((item) => item.pid === process.pid)).toBe(true); // this process too: the caller leaves itself out
    stop(other);
    await exited(other);
    // gone from the list, or (until its parent collects it) a zombie, which has no program
    const left = addon.processes().find((item) => item.pid === mine!.pid);
    expect(left === undefined || left.exe === "").toBe(true);
  }, 20_000);

  // PR_SET_DUMPABLE (prctl) is Linux's; the process that cannot be looked into is made that way there
const python = process.platform === "linux" && spawnSync("python3", ["-V"]).status === 0;
  it.skipIf(!python)("processes: a process of this user that cannot be looked into is listed with null, never left out", async () => {
    const addon = loadExclusionAddon()!;
    // PR_SET_DUMPABLE 0: its /proc/<pid>/exe answers EACCES to other processes of this user
    const closed = await holder("exec python3 -c \"import ctypes,sys,time; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready'); sys.stdout.flush(); time.sleep(30)\"");
    const opaque = spawnSync("sh", ["-c", `readlink /proc/${closed.pid}/exe >/dev/null 2>&1`]).status !== 0;
    const item = addon.processes().find((entry) => entry.pid === closed.pid);
    expect(item).toBeDefined();
    if (opaque) {
      expect(item!.exe).toBeNull();
      expect(item!.mine).toBe(true);
    }
    stop(closed);
    await exited(closed);
  }, 20_000);

  it("an engine process that is running keeps a home pending with not one byte written; once it ends the rows are cleared", async () => {
    const fx = buildFixture("claude", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const before = readFileSync(history);
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await running(engineBinary("claude"));
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(history).equals(before)).toBe(true);
    stop(other);
    await exited(other);
    const done = executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!));
    expect(done.failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain("canary-claude-5521");
  }, 30_000);

  it.skipIf(!python)("a process whose program cannot be read is judged by the name and arguments the system still gives; only one with none of them leaves the engine unknown", async () => {
    const fx = buildFixture("claude", scratch);
    const closed = await holder("exec python3 -c \"import ctypes,sys,time; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready'); sys.stdout.flush(); time.sleep(30)\"");
    // its name (comm) and its arguments are readable and are not the engine's, so it is a bystander, not an unknown
    expect(engineState("claude", fx.homes[0]!.home).state).toBe("closed");
    stop(closed);
    await exited(closed);
    expect(engineState("claude", fx.homes[0]!.home).state).toBe("closed");
  }, 20_000);

  it("Fuigo's log: while another process keeps the engine's lock nothing is written and the home is pending; when it lets go the rows are cleared", async () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const before = readFileSync(log);
    const inode = lstatSync(log).ino;
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await lockHolder(log);
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

  it("Codex: while a codex process runs nothing is written and the home is pending; when it ends the rows are cleared and the index is back under its name", async () => {
    const fx = buildFixture("codex", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const before = readFileSync(index);
    const inode = lstatSync(index).ino;
    const plan = planEngineHistory(job(fx)).plans!;
    const other = await running(engineBinary("codex"));
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(lstatSync(index).ino).toBe(inode);
    stop(other);
    await exited(other);
    const done = executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!));
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
    removeTempDirSync(`${history}.lock`);
    const done = executeEnginePlans(structuredClone(plan));
    expect(done.failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain("canary-claude-5521");
    expect(readFileSync(history, "utf8")).toContain("bystander-claude-9917");
    expect(lstatSync(history).ino).toBe(inode);
    expect(existsSync(`${history}.lock`)).toBe(false);
  }, 30_000);

  // ── r17: the no-replace rename, folders as holders, and a scan that cannot be completed ────────────────────────────────

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
    const fx = buildFixture("kimi", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const plan = asExclusive(planEngineHistory(job(fx))).plans!;
    const real = mutOps.link;
    const bystander = '{"sessionId":"sess-new","project":"/other","display":"made-at-that-instant"}\n';
    mutOps.link = ((_from: string, to: string) => { writeFileSync(to, bystander); throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }) as typeof mutOps.link;
    let ran!: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(plan)); } finally { mutOps.link = real; }
    expect(ran.homeReasons[key(fx)]).toBe("aside");
    expect(readFileSync(history, "utf8")).toBe(bystander);
    expect(readFileSync(`${history}.murage-deleting`, "utf8")).toContain("bystander-kimi-9917");
  });
});
