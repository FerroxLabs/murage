// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The REAL native addon on Windows (native/engine-exclusion/exclusion.c, built by scripts/build-engine-exclusion.mjs with cl.exe): files
// held by handles the addon owns (share-none, shared with a lock, the right to delete), the no-replace rename, the process list with a
// named process that was really started, and whole deletions of engine history through all of it. These run on Windows only; the POSIX
// twin of each is in engine-exclusion.test.ts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { engineState } from "./engine-closed.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { homeKey } from "./engine-plan-core.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const built = builtAddonPath();
const windows = process.platform === "win32";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-excl-win-")));
afterAll(() => removeTempDirSync(scratch));

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) { try { child.kill(); } catch { /* gone */ } } });
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const waitFor = (check: () => boolean, ms = 15_000): boolean => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; sleepMs(25); } return check(); };

describe.skipIf(!built || !windows)("the real addon on Windows", () => {
  let restore = () => {};
  beforeAll(() => { restore = useRealExclusion(built!); });
  afterAll(() => restore());

  it("loads, says its version, and offers the handle functions", () => {
    const addon = loadExclusionAddon()!;
    expect(addon.version()).toBe(10);
    for (const name of ["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose", "renameNoReplace", "processes"] as const) expect(typeof addon[name], name).toBe("function");
  });

  it("removes shutdown privileges and accepts an already stripped token in a disposable process", () => {
    const code = "const a=require(process.argv[1]);process.stdout.write(JSON.stringify([a.dropShutdownPrivileges(),a.dropShutdownPrivileges()]));";
    const child = spawnSync(process.execPath, ["-e", code, built!], { encoding: "utf8", timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([{ ok: true }, { ok: true }]);
  });

  it("a share-none handle keeps every other opener out, in the addon and in Node; letting go lets them in", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "none.jsonl");
    writeFileSync(file, "x\n");
    const held = addon.openFile!(file, 0)!;
    expect(held).toBeTruthy();
    expect(addon.openFile!(file, 0)).toBeNull(); // a sharing violation is null, not a throw
    expect(() => openSync(file, "r")).toThrow();
    addon.handleClose!(held);
    const again = addon.openFile!(file, 0);
    expect(again).toBeTruthy();
    addon.handleClose!(again!);
    expect(readFileSync(file, "utf8")).toBe("x\n");
  });

  it("reads, writes, syncs and reports size and identity through the handle", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "rw.jsonl");
    writeFileSync(file, "0123456789\n");
    const held = addon.openFile!(file, 0)!;
    expect(addon.handleSize!(held)).toBe(11);
    expect(addon.handleRead!(held, 4, 3).toString()).toBe("3456");
    addon.handleWrite!(held, Buffer.from("abc"), 2);
    addon.handleSync!(held);
    expect(addon.handleRead!(held, 11, 0).toString()).toBe("01abc56789\n");
    const [volume, index] = addon.handleId!(held);
    expect(typeof volume).toBe("bigint");
    expect(index).toBeGreaterThan(0n);
    addon.handleClose!(held);
    expect(readFileSync(file, "utf8")).toBe("01abc56789\n");
  });

  it("the identity a removal compares is the same number from Node and from the addon's handle (or every Windows removal is 'changed')", () => {
    const file = join(scratch, "ino.jsonl");
    writeFileSync(file, "row\n");
    const node = lstatSync(file);
    const held = exclOps.openFile(file, "delete")!;
    try {
      // markDeleteEach compares lstat().ino (judged before the hold) with fstat of the held file (handleId's file index)
      expect(mutOps.fstat(held).ino).toBe(node.ino);
      expect(mutOps.fstat(held).size).toBe(node.size);
      expect(held.id().ino).toBe(lstatSync(file, { bigint: true }).ino);
    } finally { mutOps.close(held); }
  });

  it("the whole-file lock on a shared handle: a second handle cannot take it until the first lets go", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "lock.jsonl");
    writeFileSync(file, "x\n");
    const first = addon.openFile!(file, 2)!;
    const second = addon.openFile!(file, 2)!;
    expect(first && second).toBeTruthy(); // shared with every other opener, as an engine's own handle is
    expect(addon.handleLock!(first)).toBe(true);
    expect(addon.handleLock!(second)).toBe(false);
    addon.handleClose!(first);
    expect(addon.handleLock!(second)).toBe(true);
    addon.handleClose!(second);
  });

  it("the right to delete: a file marked on its handle is still read through that handle, nobody else opens it, and it is gone when the handle closes", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "gone.jsonl");
    writeFileSync(file, "x\n");
    const held = addon.openFile!(file, 1)!;
    try {
      expect(addon.handleMarkDelete!(held)).toBe(true);
      // a file whose delete is pending is not looked up by name the usual way (Windows refuses opens of it), but the handle that marked
      // it still reads it: what can be said is what the handle sees and that no one else gets in
      expect(addon.handleRead!(held, 2, 0).toString("utf8")).toBe("x\n");
      let other: unknown;
      try { other = addon.openFile!(file, 2); } catch { other = null; } // in use (null) or delete pending (access denied)
      expect(other).toBeNull();
    } finally { addon.handleClose!(held); }
    expect(existsSync(file)).toBe(false);
  });

  it("a path longer than 260 characters (an engine's session folder named after a whole working folder) is held, moved and marked like any other", () => {
    const dir = join(scratch, "long", "C%3A%5CUsers%5Crunneradmin%5CAppData%5CLocal%5CTemp%5Cmurage-r15-x%5Cfx-fuigo-y%5Cdata%5Cworkspaces%5Cf25024c1-a18e-4251-acf1-0c1713d9b6d9%5Cthreads%5C2e9018ee-1f45-46be-8ed1-7a02fc022807", "s-1");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "chat_history.jsonl");
    writeFileSync(file, "row\n");
    expect(file.length).toBeGreaterThan(260);
    const held = exclOps.openFile(file, "exclusive");
    expect(held).not.toBeNull();
    held!.close();
    expect(exclOps.renameNoReplace(dir, `${dir}.murage-deleting`)).toBe("ok");
    expect(readFileSync(join(`${dir}.murage-deleting`, "chat_history.jsonl"), "utf8")).toBe("row\n");
    const marked = exclOps.openFile(join(`${dir}.murage-deleting`, "chat_history.jsonl"), "delete")!;
    expect(marked.markDelete()).toBe(true);
    marked.close();
    expect(existsSync(join(`${dir}.murage-deleting`, "chat_history.jsonl"))).toBe(false);
  });

  it("an engine's lock file the owner made read only is still looked at: the engine counts as closed when nobody holds the lock", () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    chmodSync(log, 0o444);
    try { expect(engineState("fuigo", fx.homes[0]!.home).state).toBe("closed"); } finally { chmodSync(log, 0o644); }
  });

  it("renameNoReplace moves a file and a folder, never over a name that is taken, and reports a missing source", () => {
    const addon = loadExclusionAddon()!;
    const dir = mkdtempSync(join(scratch, "rename-"));
    const from = join(dir, "a"), to = join(dir, "b");
    writeFileSync(from, "first");
    expect(addon.renameNoReplace(from, to)).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("first");
    writeFileSync(from, "second");
    expect(addon.renameNoReplace(from, to)).toBe(1);
    expect(readFileSync(to, "utf8")).toBe("first");
    expect(readFileSync(from, "utf8")).toBe("second");
    mkdirSync(join(dir, "d1")); mkdirSync(join(dir, "d2"));
    writeFileSync(join(dir, "d1", "inside"), "in");
    expect(addon.renameNoReplace(join(dir, "d1"), join(dir, "d2"))).toBe(1);
    expect(addon.renameNoReplace(join(dir, "d1"), join(dir, "d3"))).toBe(0);
    expect(readFileSync(join(dir, "d3", "inside"), "utf8")).toBe("in");
    expect(() => addon.renameNoReplace(join(dir, "missing"), join(dir, "elsewhere"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("processes() lists a process that was really started: by the name of its program, its owner, and its arguments split as Windows splits them", () => {
    const addon = loadExclusionAddon()!;
    const dir = mkdtempSync(join(scratch, "proc-"));
    const copy = join(dir, "qqq-named-engine.exe");
    copyFileSync(process.execPath, copy);
    chmodSync(copy, 0o755);
    const child = spawn(copy, ["-e", "setTimeout(()=>{},30000)", "a b", 'c"d', "--x"], { stdio: "ignore" });
    children.push(child);
    expect(waitFor(() => addon.processes().some((item) => item.pid === child.pid && item.argv !== null))).toBe(true);
    const item = addon.processes().find((entry) => entry.pid === child.pid)!;
    expect(item.mine).toBe(true);
    expect(item.comm?.toLowerCase()).toBe("qqq-named-engine.exe");
    expect(item.exe?.toLowerCase()).toBe(copy.toLowerCase());
    expect(item.argv!.slice(1)).toEqual(["-e", "setTimeout(()=>{},30000)", "a b", 'c"d', "--x"]);
    expect(addon.processes().some((entry) => entry.pid === process.pid)).toBe(true);
    // a process of the system that cannot be opened is listed too, never left out
    expect(addon.processes().length).toBeGreaterThan(10);
  });

  it("processes() reports a process that has ended but whose handle its parent still holds as one with no program, never as one whose arguments cannot be read", () => {
    const addon = loadExclusionAddon()!;
    const dir = mkdtempSync(join(scratch, "ended-"));
    const done = join(dir, "done");
    // A node that writes a file and ends. This thread is then blocked, so its loop cannot close the handle it holds to the ended
    // process: Windows keeps that process in the list until the handle closes, with its memory (and command line) gone.
    const child = spawn(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(done)}, "x")`], { stdio: "ignore" });
    children.push(child);
    expect(waitFor(() => existsSync(done))).toBe(true);
    sleepMs(1_000);
    const item = addon.processes().find((entry) => entry.pid === child.pid);
    if (item) expect({ exe: item.exe, argv: item.argv }).toEqual({ exe: "", argv: [] });
  });

  for (const engine of ["fuigo", "codex", "claude", "kimi"] as const) {
    it(`${engine}: a whole deletion through the real handles clears the content and keeps the bystanders`, () => {
      const fx = buildFixture(engine, scratch);
      expect(engineState(engine, fx.homes[0]!.home).state).toBe("closed");
      const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
      expect(result.failedHomes, engine).toEqual([]);
      expect(canaryHits(fx.root, fx.canaries), engine).toEqual([]);
      expect(fx.checkBystanders(), engine).toEqual([]);
    }, 60_000);
  }

  it("Codex session_index: Codex writes a temporary file and renames it over the index while Murage holds it: nothing of Codex's is lost, the hold never outlasts the write, and the index ends cleared", () => {
    const fx = buildFixture("codex", scratch);
    const home = fx.homes[0]!.home;
    const index = join(home, "session_index.jsonl");
    const go = join(fx.root, "go"), tried = join(fx.root, "tried"), done = join(fx.root, "done");
    const row = JSON.stringify({ id: "019a0000-aaaa-7bbb-8ccc-0000000000ab", thread_name: "a-thread-codex-just-named", updated_at: "x" });
    // Codex as a second process: its rewrite is a temporary file renamed over the name (MoveFileExW with REPLACE_EXISTING, as a Rust
    // temp-file persist does); it says how its first try went, and tries again until the rename lands, as Codex does on its next write
    const codex = spawn(process.execPath, ["-e", `const fs=require("fs");const E=process.env;
const wait=()=>new Promise(r=>setTimeout(r,5));
(async()=>{
  while(!fs.existsSync(E.R_GO)) await wait();
  const file=E.R_INDEX, tmp=file+".tmp-codex";
  let first=null;
  for(let i=0;i<2000;i++){
    fs.writeFileSync(tmp,fs.readFileSync(file).toString()+E.R_ROW+"\\n");
    try{fs.renameSync(tmp,file);if(first===null)fs.writeFileSync(E.R_TRIED,"replaced");break;}
    catch(e){if(first===null){first=e.code;fs.writeFileSync(E.R_TRIED,"refused "+e.code);}await wait();}
  }
  fs.writeFileSync(E.R_DONE,"1");
})();`], { env: { ...process.env, R_GO: go, R_TRIED: tried, R_DONE: done, R_INDEX: index, R_ROW: row }, stdio: "ignore" });
    children.push(codex);
    const planned = planEngineHistory({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" });
    const inode = lstatSync(index, { bigint: true }).ino;
    const real = mutOps.pwrite;
    let hooked = false;
    mutOps.pwrite = ((fd: never, bytes: Buffer, at: number) => {
      // the first overwrite of the index, under Murage's handle: Codex's rewrite runs now, and Murage goes on once Codex has tried once
      if (!hooked && mutOps.idOfFd(fd).ino === inode) { hooked = true; writeFileSync(go, "1"); expect(waitFor(() => existsSync(tried))).toBe(true); }
      real(fd, bytes, at);
    }) as typeof mutOps.pwrite;
    let ran!: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.pwrite = real; }
    expect(hooked).toBe(true);
    // Murage's handle is let go by now: a rename Codex retries lands at once
    expect(waitFor(() => existsSync(done), 5_000)).toBe(true);
    const outcome = readFileSync(tried, "utf8");
    console.log(`[r24 windows codex temp+rename under Murage's shared handle] first try: ${outcome}`);
    const key = homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
    if (outcome === "replaced") expect(ran.staleHomes).toEqual([key]); // a new file at the name: Codex's rewrite won, planned again
    else expect(outcome).toMatch(/^refused (EPERM|EACCES|EBUSY)$/);
    const text = readFileSync(index, "utf8");
    expect(text).toContain(row); // nothing of Codex's was lost
    const next = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(next.failedHomes).toEqual([]);
    const final = readFileSync(index, "utf8");
    expect(final).not.toContain("canary-codex-5521");
    expect(final).toContain(row);
    expect(fx.checkBystanders()).toEqual([]);
  }, 60_000);

  it("a handle another process keeps leaves the file untouched and the home pending, and letting go finishes it", () => {
    const fx = buildFixture("kimi", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const before = readFileSync(index);
    const plan = planEngineHistory({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" }).plans!;
    const addon = loadExclusionAddon()!;
    const keeping = addon.openFile!(index, 0)!;
    const refused = executeEnginePlans(structuredClone(plan));
    expect(refused.homeReasons[homeKey(fx.homes[0]!.engine, fx.homes[0]!.home)]).toBe("held");
    addon.handleClose!(keeping);
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(executeEnginePlans(structuredClone(plan)).failed).toEqual([]);
    expect(readFileSync(index, "utf8")).not.toContain("canary-kimi-5521");
  }, 60_000);
});
