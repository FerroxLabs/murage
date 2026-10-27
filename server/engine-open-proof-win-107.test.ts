// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-WHILE-OPEN-107, Windows: the REAL addon's half of the open-home proof (exclusion.c cwdOf; engine-closed.ts holdersClearOf)
// against a process that was really started: its working folder is read and judged, and a file it holds open (Node opens with the
// right to delete shared) cannot be taken share-none, which is the open-file half of the proof there. Windows only; the POSIX
// cases are in engine-open-proof-107.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { holdersClearOf } from "./engine-closed.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const built = builtAddonPath();
const windows = process.platform === "win32";

describe.skipIf(!built || !windows)("the real addon on Windows: the open-home proof", () => {
  let restore = () => {};
  let scratch = "";
  const children: ChildProcess[] = [];
  beforeAll(() => {
    restore = useRealExclusion(built!);
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-open-proof-")));
  });
  afterEach(() => { for (const child of children.splice(0)) { try { child.kill(); } catch { /* gone */ } } });
  afterAll(() => { restore(); removeTempDirSync(scratch); });

  /** A Node process working in `cwd` that holds `file` open for reading until it is ended. */
  const holder = (cwd: string, file: string): Promise<ChildProcess> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "const fd=require('fs').openSync(process.argv[1],'r');process.stdout.write('ready');setInterval(()=>{},1000)", file], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error("the holder did not start")), 15_000);
    child.stdout!.once("data", () => { clearTimeout(timer); resolve(child); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });

  it("reads another process's working folder, and judges it inside or outside the targets", async () => {
    expect(typeof loadExclusionAddon()?.cwdOf).toBe("function");
    const thread = join(scratch, "thread");
    const work = join(thread, "src");
    const other = join(scratch, "other");
    mkdirSync(work, { recursive: true });
    mkdirSync(other, { recursive: true });
    const file = join(other, "held.jsonl");
    writeFileSync(file, "{}\n");
    const child = await holder(work, file);
    const cwd = exclOps.winCwd(child.pid!);
    expect(cwd).not.toBeNull();
    expect(realpathSync.native(cwd!).toLowerCase().replace(/\\+$/, "")).toBe(work.toLowerCase());
    expect(holdersClearOf([child.pid!], [thread])).toMatchObject({ proven: false, why: "cwd-inside", pid: child.pid });
    expect(holdersClearOf([child.pid!], [thread.toUpperCase()])).toMatchObject({ proven: false, why: "cwd-inside" });
    expect(holdersClearOf([child.pid!], [join(scratch, "elsewhere")])).toEqual({ proven: true });
    // a process that is gone cannot be read: no proof
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    expect(holdersClearOf([child.pid!], [join(scratch, "elsewhere")])).toMatchObject({ proven: false, why: "unreadable" });
  });

  it("a file another process has open for reading cannot be taken share-none (the open-file half)", async () => {
    const file = join(scratch, "transcript.jsonl");
    writeFileSync(file, "{}\n");
    const child = await holder(scratch, file);
    expect(exclOps.openFile(file, "delete")).toBeNull();
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    const taken = exclOps.openFile(file, "delete");
    expect(taken).not.toBeNull();
    mutOps.close(taken!);
  });
});
