// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r20, with REAL second processes and the REAL native addon (built by scripts/build-engine-exclusion.mjs; skipped where it is not built):
// an engine that starts right after Murage's last look at the process list, running the engine's own file protocol, must lose nothing and
// must never be written over; and the addon lists every process, with the fields the check needs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { engineState } from "./engine-closed.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { mutOps } from "./engine-fs.ts";
import { planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { homeKey, type Step } from "./engine-plan-core.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { asExclusive, buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const built = builtAddonPath();
const posix = process.platform !== "win32";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r20r-")));
afterAll(() => removeTempDirSync(scratch));

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ } } });
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const waitFor = (check: () => boolean, ms = 10_000): boolean => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; sleepMs(2); } return check(); };
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;

/** Starts `node <script>` as a second process (never a copy of this one) and returns it; it is ended after the test. */
function start(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
}
const stop = (child: ChildProcess): void => { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000); sleepMs(150); };

/** A fake engine of the given name: a script `<dir>/bin/<name>` (for Claude a link to `node_modules/@anthropic-ai/claude-code/cli.js`, as
 * npm's bin links are) holding `code`. Returns the path to run with node. */
function engineScript(name: string, code: string, viaPackage = false): string {
  const dir = mkdtempSync(join(scratch, `${name}-bin-`));
  mkdirSync(join(dir, "bin"));
  if (viaPackage) {
    mkdirSync(join(dir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), code);
    symlinkSync(join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), join(dir, "bin", name));
  } else writeFileSync(join(dir, "bin", name), code);
  return join(dir, "bin", name);
}

/** The first look at the engine's file that Murage makes under its hold: the commit's own sync. A pause of `ms` is taken there. */
function pauseAtCommit(ms: number): () => void {
  const real = mutOps.fsync;
  let done = false;
  mutOps.fsync = ((fd: never) => { real(fd); if (!done) { done = true; sleepMs(ms); } }) as typeof mutOps.fsync;
  return () => { mutOps.fsync = real; };
}

describe.skipIf(!built || !posix)("T1: an engine that starts right after the last look, speaking its own file protocol, loses nothing and is never written over", () => {
  let restore = () => {};
  beforeAll(() => { restore = useRealExclusion(built!); });
  afterAll(() => restore());

  const common = `const fs=require("fs");const sleep=ms=>new Promise(r=>setTimeout(r,ms));const E=process.env;`;

  it("Claude: `node <link>/bin/claude` -> the package's cli.js makes its lock folder, appends its row, lets go; it waits (EEXIST) while Murage holds the lock", () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    const history = join(home, "history.jsonl");
    const ready = join(fx.root, "ready"), result = join(fx.root, "result");
    const row = JSON.stringify({ sessionId: "sess-child", project: "/other", display: "written-by-the-claude-that-started", timestamp: 7 });
    const script = engineScript("claude", `${common}
(async()=>{
  fs.writeFileSync(E.R_READY,"1"); await sleep(20);
  const lock=E.R_HOME+"/history.jsonl.lock"; let eexist=0;
  // it reaches for the lock while Murage holds it (Murage reads and journals first, with no hold, then takes the lock)
  for(const end=Date.now()+9000;!fs.existsSync(lock)&&Date.now()<end;) await sleep(1);
  for(const end=Date.now()+9000;;){ try{ fs.mkdirSync(lock); break; }catch(e){ if(e.code!=="EEXIST") throw e; eexist++; if(Date.now()>end) process.exit(3); await sleep(4); } }
  const fd=fs.openSync(E.R_HOME+"/history.jsonl","a"); fs.writeSync(fd,E.R_ROW+"\\n"); fs.closeSync(fd);
  fs.rmdirSync(lock);
  fs.writeFileSync(E.R_RESULT,JSON.stringify({eexist}));
  setTimeout(()=>{},120000);
})();`, true);
    const before = readFileSync(history, "utf8").split("\n");
    const planned = planEngineHistory(job(fx));
    let launched: ChildProcess | undefined;
    const unpause = pauseAtCommit(120);
    let ran!: ReturnType<typeof executeEnginePlans>;
    try {
      ran = executeEnginePlans(structuredClone(planned.plans!), undefined, {
        // right after the last look at the process list said "closed", the engine starts
        afterGate: (_key: string, _index: number, step: Step) => {
          if (launched || step.k !== "rewrite") return;
          launched = start(script, { R_HOME: home, R_ROW: row, R_READY: ready, R_RESULT: result, CLAUDE_CONFIG_DIR: home });
          expect(waitFor(() => existsSync(ready))).toBe(true);
        },
      });
    } finally { unpause(); }
    expect(launched).toBeDefined();
    expect(waitFor(() => existsSync(result))).toBe(true);
    const answer = JSON.parse(readFileSync(result, "utf8")) as { eexist: number };
    expect(answer.eexist).toBeGreaterThan(0); // its mkdir met EEXIST until Murage let go
    const after = readFileSync(history, "utf8");
    expect(after).toContain(row); // its row, byte for byte
    expect(after).not.toContain(C("claude")); // the planned rows are cleared
    expect(after.split("\n").filter((line) => line.includes(B("claude")))).toEqual(before.filter((line) => line.includes(B("claude")))); // bystanders byte for byte
    expect(after.split("\n").filter((line) => line.trim() !== "").every((line) => { try { JSON.parse(line); return true; } catch { return false; } })).toBe(true);
    // the engine is running now: the last look leaves the home pending
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(existsSync(join(home, "paste-cache", "ab12cd34ef56ab12.txt"))).toBe(true); // nothing after the first step ran
    // closed again: the next attempt finishes
    stop(launched!);
    const next = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(next.failedHomes).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(readFileSync(history, "utf8")).toContain(row);
  }, 60_000);

  it("Codex: a writer that takes the history lock to append waits for Murage's hold and its row lands", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!.home;
    const history = join(home, "history.jsonl");
    const ready = join(fx.root, "ready"), result = join(fx.root, "result");
    const row = JSON.stringify({ session_id: "sess-child", ts: 9, text: "typed-in-the-codex-that-started" });
    const script = engineScript("codex", `${common}
const addon=require(E.R_ADDON);
fs.writeFileSync(E.R_READY,"1");
(async()=>{
  await sleep(20);
  const fd=fs.openSync(E.R_HOME+"/history.jsonl","a"); let got=false;
  for(let i=0;i<8&&!got;i++) got=addon.lock(fd);
  if(got){ fs.writeSync(fd,E.R_ROW+"\\n"); }
  fs.closeSync(fd);
  fs.writeFileSync(E.R_RESULT,JSON.stringify({got}));
  setTimeout(()=>{},120000);
})();`);
    const planned = planEngineHistory(job(fx));
    let launched: ChildProcess | undefined;
    const unpause = pauseAtCommit(120);
    try {
      executeEnginePlans(structuredClone(planned.plans!), undefined, {
        afterGate: (_key: string, _index: number, step: Step) => {
          if (launched || step.k !== "rewrite" || step.path !== history) return;
          launched = start(script, { R_HOME: home, R_ROW: row, R_READY: ready, R_RESULT: result, R_ADDON: built! });
          expect(waitFor(() => existsSync(ready))).toBe(true);
        },
      });
    } finally { unpause(); }
    expect(waitFor(() => existsSync(result))).toBe(true);
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ got: true }); // its append landed, it was not dropped
    const text = readFileSync(history, "utf8");
    expect(text).toContain(row);
    expect(text).not.toContain(C("codex"));
    expect(text).toContain(B("codex"));
    stop(launched!);
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true).failedHomes).toEqual([]);
  }, 60_000);

  it("Codex session_index: it appends and then replaces the file by rename in the middle of Murage's write: nothing of Codex's is lost, the step is stale, the next attempt clears it", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!.home;
    const index = join(home, "session_index.jsonl");
    const go = join(fx.root, "go"), done = join(fx.root, "done"), ready = join(fx.root, "ready");
    const row = JSON.stringify({ id: "019a0000-aaaa-7bbb-8ccc-0000000000aa", thread_name: "a-thread-codex-just-named", updated_at: "x" });
    const script = engineScript("codex", `${common}
fs.writeFileSync(E.R_READY,"1");
(async()=>{
  while(!fs.existsSync(E.R_GO)) await sleep(2);
  const file=E.R_HOME+"/session_index.jsonl";
  const fd=fs.openSync(file,"a"); fs.writeSync(fd,E.R_ROW+"\\n"); fs.closeSync(fd);   // append: write and close
  fs.writeFileSync(file+".tmp",fs.readFileSync(file)); fs.renameSync(file+".tmp",file);    // and a rewrite by rename-over
  fs.writeFileSync(E.R_DONE,"1");
  setTimeout(()=>{},120000);
})();`);
    const planned = planEngineHistory(job(fx));
    let launched: ChildProcess | undefined;
    const inode = mutOps.idOf(index).ino;
    const real = mutOps.pwrite;
    let hooked = false;
    mutOps.pwrite = ((fd: never, bytes: Buffer, at: number) => {
      // the first overwrite of the index: Codex's append and rename-over happen right now, before it lands
      if (!hooked && mutOps.idOfFd(fd).ino === inode) { hooked = true; writeFileSync(go, "1"); expect(waitFor(() => existsSync(done))).toBe(true); }
      real(fd, bytes, at);
    }) as typeof mutOps.pwrite;
    let ran!: ReturnType<typeof executeEnginePlans>;
    try {
      ran = executeEnginePlans(structuredClone(planned.plans!), undefined, {
        // Codex starts right after the last look before the index is written
        afterGate: (_key: string, _index: number, step: Step) => {
          if (launched || step.k !== "rewrite" || step.path !== index) return;
          launched = start(script, { R_HOME: home, R_ROW: row, R_GO: go, R_DONE: done, R_READY: ready });
          expect(waitFor(() => existsSync(ready))).toBe(true);
        },
      });
    } finally { mutOps.pwrite = real; }
    expect(hooked).toBe(true);
    expect(ran.staleHomes).toEqual([key(fx)]); // a new file at the name: Codex's rewrite won
    const text = readFileSync(index, "utf8");
    expect(text).toContain(row); // nothing of Codex's was lost
    expect(text).toContain(B("codex"));
    expect(text).toContain(C("codex")); // retained until the next attempt, never lost
    stop(launched!);
    const next = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(next.failedHomes).toEqual([]);
    const final = readFileSync(index, "utf8");
    expect(final).not.toContain(C("codex"));
    expect(final).toContain(row);
  }, 60_000);

  it("Kimi: a fresh index made while the old one is set aside: both are kept, and the next attempt joins them", () => {
    const fx = buildFixture("kimi", scratch);
    const home = fx.homes[0]!.home;
    const index = join(home, "session_index.jsonl");
    const done = join(fx.root, "done"), ready = join(fx.root, "ready");
    const row = JSON.stringify({ sessionId: "s-new", workDir: "/other", title: "started-by-the-kimi-that-started" });
    const script = engineScript("kimi", `${common}
fs.writeFileSync(E.R_READY,"1");
(async()=>{
  const file=E.R_HOME+"/session_index.jsonl";
  while(!(fs.existsSync(file+".murage-deleting")&&!fs.existsSync(file))) await sleep(1);
  fs.writeFileSync(file,E.R_ROW+"\\n");
  fs.writeFileSync(E.R_DONE,"1");
  setTimeout(()=>{},120000);
})();`);
    const planned = asExclusive(planEngineHistory(job(fx)));
    let launched: ChildProcess | undefined;
    const real = mutOps.fsync;
    let waited = false;
    mutOps.fsync = ((fd: never) => { real(fd); if (!waited) { waited = true; expect(waitFor(() => existsSync(done))).toBe(true); } }) as typeof mutOps.fsync;
    let ran!: ReturnType<typeof executeEnginePlans>;
    try {
      ran = executeEnginePlans(structuredClone(planned.plans!), undefined, {
        afterGate: (_key: string, _index: number, step: Step) => {
          if (launched || step.k !== "rewrite" || step.path !== index) return;
          launched = start(script, { R_HOME: home, R_ROW: row, R_DONE: done, R_READY: ready });
          expect(waitFor(() => existsSync(ready))).toBe(true);
        },
      });
    } finally { mutOps.fsync = real; }
    expect(ran.homeReasons[key(fx)]).toBe("aside");
    expect(readFileSync(index, "utf8")).toBe(`${row}\n`); // what the engine wrote is exactly that
    const aside = readFileSync(`${index}.murage-deleting`, "utf8");
    expect(aside).not.toContain(C("kimi"));
    expect(aside).toContain(B("kimi"));
    stop(launched!);
    const next = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(next.failedHomes).toEqual([]);
    const joined = readFileSync(index, "utf8");
    expect(joined).toContain(row);
    expect(joined).toContain(B("kimi"));
    expect(joined).not.toContain(C("kimi"));
    expect(existsSync(`${index}.murage-deleting`)).toBe(false);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
  }, 60_000);

  it("Fuigo: a writer that appends to its log under the log's own lock is never dropped", () => {
    const fx = buildFixture("fuigo", scratch);
    const home = fx.homes[0]!.home;
    const log = join(home, "logs", "unified.jsonl");
    const ready = join(fx.root, "ready"), result = join(fx.root, "result");
    const row = JSON.stringify({ sid: "s-child", text: "logged-by-the-fuigo-that-started" });
    const script = engineScript("fuigo", `${common}
const addon=require(E.R_ADDON);
fs.writeFileSync(E.R_READY,"1");
(async()=>{
  await sleep(20);
  const fd=fs.openSync(E.R_LOG,"a"); let got=false;
  for(let i=0;i<8&&!got;i++) got=addon.lock(fd);
  if(got) fs.writeSync(fd,E.R_ROW+"\\n");
  fs.closeSync(fd);
  fs.writeFileSync(E.R_RESULT,JSON.stringify({got}));
  setTimeout(()=>{},120000);
})();`);
    const planned = planEngineHistory(job(fx));
    let launched: ChildProcess | undefined;
    const unpause = pauseAtCommit(120);
    try {
      executeEnginePlans(structuredClone(planned.plans!), undefined, {
        afterGate: (_key: string, _index: number, step: Step) => {
          if (launched || step.k !== "rewrite") return;
          launched = start(script, { R_LOG: log, R_ROW: row, R_READY: ready, R_RESULT: result, R_ADDON: built! });
          expect(waitFor(() => existsSync(ready))).toBe(true);
        },
      });
    } finally { unpause(); }
    expect(waitFor(() => existsSync(result))).toBe(true);
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ got: true });
    const text = readFileSync(log, "utf8");
    expect(text).toContain(row);
    expect(text).not.toContain(C("fuigo"));
    stop(launched!);
  }, 60_000);
});

describe.skipIf(!built || !posix)("T8: the addon lists every process, with the fields the check needs", () => {
  let restore = () => {};
  beforeAll(() => { restore = useRealExclusion(built!); });
  afterAll(() => restore());

  it("every process `ps` shows is listed, and each entry carries pid, ppid, uid, mine, comm, exe and argv", () => {
    const addon = loadExclusionAddon()!;
    const ps = spawnSync("ps", ["-axo", "pid="], { encoding: "utf8" });
    const listed = new Map(addon.processes().map((item) => [item.pid, item]));
    const wanted = ps.stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => pid > 0 && pid !== ps.pid);
    expect(wanted.length).toBeGreaterThan(1);
    for (const pid of wanted) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) expect(listed.has(pid), `pid ${pid}`).toBe(true);
    }
    const mine = listed.get(process.pid)!;
    expect(mine.mine).toBe(true);
    expect(mine.uid).toBe(process.getuid!());
    expect(typeof mine.comm).toBe("string");
    expect(listed.get(process.ppid)).toBeDefined();
    expect(Array.isArray(mine.argv)).toBe(true);
  });

  it("a second process is listed with its name, program, arguments and owner", () => {
    // The child marks itself up from its own code, so Node has finished starting (and naming its main thread) before it is listed.
    const up = join(mkdtempSync(join(scratch, "sleeper-up-")), "up");
    const child = start(engineScript("sleeper", `require("fs").writeFileSync(process.env.R_UP,"up");setTimeout(()=>{},60000);`), { R_UP: up });
    const addon = loadExclusionAddon()!;
    expect(waitFor(() => existsSync(up))).toBe(true);
    expect(waitFor(() => addon.processes().some((item) => item.pid === child.pid && item.argv !== null && item.argv.length > 1))).toBe(true);
    const item = addon.processes().find((entry) => entry.pid === child.pid)!;
    expect(item.mine).toBe(true);
    expect(item.uid).toBe(process.getuid!());
    expect(item.argv![1]).toMatch(/bin\/sleeper$/);
    // comm is the name the system gives the process: macOS its program's (node); Linux its main thread's, which Node names itself
    // ("MainThread" since Node 24), so it is compared with what the system says, not with a name
    expect(item.comm).toBe(process.platform === "linux" ? readFileSync(`/proc/${child.pid}/comm`, "utf8").trim() : "node");
    stop(child);
  });

  it("every process of ANOTHER user that `ps` shows (root's daemons, launchd) is listed with its owner and its name, never as unreadable", () => {
    const addon = loadExclusionAddon()!;
    const ps = spawnSync("ps", ["-axo", "pid=,uid=,comm="], { encoding: "utf8" });
    const listed = new Map(addon.processes().map((item) => [item.pid, item]));
    const me = process.getuid!();
    let others = 0;
    for (const line of ps.stdout.split("\n")) {
      const [pid, uid] = line.trim().split(/\s+/).map(Number);
      if (!pid || uid === undefined || uid === me || !listed.has(pid)) continue; // gone since, or this user's
      others++;
      const item = listed.get(pid)!;
      expect(item.uid, `pid ${pid}`).toBe(uid);
      expect(item.mine, `pid ${pid}`).toBe(false);
      expect(typeof item.comm, `pid ${pid}`).toBe("string");
    }
    if (process.platform === "darwin") expect(others).toBeGreaterThan(10); // a Mac always runs root's daemons
  });

  it("on this machine, with no engine running, the check says closed (and, if not, names the processes it could not read)", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-nobody-home-"));
    try {
      const verdict = engineState("kimi", home);
      expect(verdict, JSON.stringify(verdict.unknownBy ?? [])).toEqual({ state: "closed", via: "process" });
    } finally { removeTempDirSync(home); }
  });
});

describe.skipIf(!built || process.platform !== "win32")("T9 (Windows): the built addon loads and lists a spawned child with its owner and its arguments split as CommandLineToArgvW splits them", () => {
  it("lists a child with mine true and exact arguments", () => {
    const addon = loadExclusionAddon()!;
    expect(addon.version()).toBe(9);
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", "a b", 'c"d', "e\\\\", "--x"], { stdio: "ignore" });
    children.push(child);
    expect(waitFor(() => addon.processes().some((item) => item.pid === child.pid && item.argv !== null))).toBe(true);
    const item = addon.processes().find((entry) => entry.pid === child.pid)!;
    expect(item.mine).toBe(true);
    expect(item.argv!.slice(1)).toEqual(["-e", "setTimeout(()=>{},20000)", "a b", 'c"d', "e\\\\", "--x"]);
    expect(item.comm).toMatch(/node/i);
    // the vectors of the CommandLineToArgvW rules (backslashes before a quote), through a real process each
    for (const args of [['"C:\\Py\\python.exe" "C:\\k y\\kimi.py" --x'], ["a\\\\\\\"b"], ["x\\\\"]]) {
      const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", ...args], { stdio: "ignore" });
      children.push(other);
      expect(waitFor(() => addon.processes().some((entry) => entry.pid === other.pid && entry.argv !== null))).toBe(true);
      const seen = addon.processes().find((entry) => entry.pid === other.pid)!;
      expect(seen.argv!.slice(3)).toEqual(args);
    }
  });
});
