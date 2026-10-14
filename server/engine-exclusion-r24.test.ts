// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r24: a journal is kept after a sync that reported no barrier; and (Linux, the real addon) the engine lock's wait keeps its wall-clock
// deadline under a storm of signals. (The restart rule, the undo that cut by position and the fallback that dropped a journal at once
// were taken out in r25: engine-exclusion-r25.test.ts.)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { realEngineFs } from "./engine-fs.ts";
import { homeKey, Known, Planner, type HomePlanData } from "./engine-plan-core.ts";
import { redoDirectory } from "./engine-redo.ts";
import { builtAddonPath, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r24-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => { fake.restore(); });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };

// ── Astra r22: the journal waits for a sync that names its barrier ──────────────────────────────────────────────────────

/** A Fuigo log with one row to clear and one bystander, and its plan. */
function fuigoLog(): { log: string; plans: Record<string, HomePlanData> } {
  const fx = buildFixture("fuigo", scratch);
  const home = fx.homes[0]!.home;
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(log, { pred: { any: [{ field: "sid", op: "in", values: ["s-1"] }] }, needles: ["s-1"], format: "fuigo-unified", how: "lock" });
  return { log, plans: { [homeKey("fuigo", home)]: { engine: "fuigo", home, steps: pl.steps } as HomePlanData } };
}

describe.skipIf(process.platform === "win32")("a journal is dropped only after a barrier the sync named", () => {
  const withSync = (answer: (fd: number) => unknown, work: () => void) => {
    const addon = loadExclusionAddon()! as unknown as { fullSync: (fd: number) => unknown };
    const before = addon.fullSync;
    addon.fullSync = answer;
    try { work(); } finally { addon.fullSync = before; }
  };

  it("a sync that does not say which barrier it gave keeps the journal (the rows are written; the next start drops it after a full one)", () => {
    const { log, plans } = fuigoLog();
    let ran!: ReturnType<typeof executeEnginePlans>;
    withSync(() => undefined, () => { ran = executeEnginePlans(plans); });
    expect(ran.failedHomes).toHaveLength(1);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1);
    expect(recoverAll().pending).toEqual([]);
    expect(journalFiles()).toEqual([]);
  });
});

// ── Astra r22: the engine lock's wait keeps its deadline under signals (Linux, the real addon) ────────────────────────────

const built = builtAddonPath();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } } });
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

describe.skipIf(!built || process.platform !== "linux")("the real addon: lock() under a storm of signals", () => {
  it("gives up within its one second of wall clock, however many signals interrupt it, and says which barrier a sync gave", async () => {
    const addonPath = built!;
    const file = join(scratch, "locked.jsonl");
    writeFileSync(file, "x\n");
    const ready = join(scratch, "holder-ready");
    // a holder of the lock (a second process), and a waiter that counts the signals it is sent while it waits
    const holder = spawn(process.execPath, ["-e", `const a=require(${JSON.stringify(addonPath)});const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"r+");if(!a.lock(fd))process.exit(3);fs.writeFileSync(${JSON.stringify(ready)},"1");setTimeout(()=>{},60000);`], { stdio: "ignore" });
    children.push(holder);
    for (let i = 0; i < 400 && !existsSync(ready); i++) sleepMs(25);
    expect(existsSync(ready)).toBe(true);
    const waiter = spawn(process.execPath, ["-e", `const a=require(${JSON.stringify(addonPath)});const fs=require("fs");let n=0;process.on("SIGUSR2",()=>{n++;});const fd=fs.openSync(${JSON.stringify(file)},"r+");process.stdout.write("go\\n");setTimeout(()=>{const t=process.hrtime.bigint();const got=a.lock(fd);const ms=Number(process.hrtime.bigint()-t)/1e6;process.stdout.write(JSON.stringify({got,ms,sync:a.fullSync(fd)})+"\\n");process.exit(0);},200);`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(waiter);
    let out = "";
    waiter.stdout!.on("data", (chunk) => { out += String(chunk); });
    await new Promise<void>((resolve) => { const tick = () => (out.includes("go") ? resolve() : setTimeout(tick, 5)); tick(); });
    const storm = spawn(process.execPath, ["-e", `const p=${waiter.pid};const end=Date.now()+3000;(function f(){for(let i=0;i<50;i++){try{process.kill(p,"SIGUSR2")}catch{process.exit(0)}}if(Date.now()<end)setImmediate(f);})();`], { stdio: "ignore" });
    children.push(storm);
    await new Promise<void>((resolve) => waiter.on("exit", () => resolve()));
    const result = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as { got: boolean; ms: number; sync: string };
    expect(result.got).toBe(false);
    expect(result.ms).toBeGreaterThanOrEqual(950);
    expect(result.ms).toBeLessThan(1_300);
    expect(result.sync).toBe("full");
  }, 30_000);
});
