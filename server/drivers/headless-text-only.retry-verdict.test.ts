// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { headlessTextOnlyTurn as unscopedHeadlessTextOnlyTurn } from "./headless-text-only.ts";
import * as reaper from "../memory/pip-reaper.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import { captureMemoryUsage, type MemoryUsageReport } from "../memory/extract.ts";
import * as transport from "../memory/pip-transport.ts";
import { fixedPrompt, readMoved } from "../memory/pip-transport.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(), spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn() }));
import { withRetryReservation } from "../testing/retry-reservation.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { readMemoryLearning, updateMemoryLearning } from "../memory/learning-policy.ts";
const headlessTextOnlyTurn:typeof unscopedHeadlessTextOnlyTurn=(...args)=>withRetryReservation(()=>unscopedHeadlessTextOnlyTurn(...args));
beforeEach(()=>{closeDatabase();mkdirSync(DATA_DIR,{recursive:true});const db=database();db.exec("DELETE FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','continuity-budget','learning-spend')");updateMemoryLearning(db,{callsPerMinute:60},readMemoryLearning(db).revision);});
const actualGateRun = transport.gateRun;
let base: string;
beforeEach(() => { vi.spyOn(reaper,"registerChild").mockImplementation(async pid => ({ pid: pid!, startTime: "fixture", registeredAt: Date.now() })); vi.spyOn(transport,"gateRun"); base = mkdtempSync(join(tmpdir(), "pip-retry-verdict-")); mkdirSync(join(base, "etc")); vi.mocked(spawnCli).mockReset(); vi.mocked(awaitCliTreeStopped).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); removeTempDirSync(base); });
function rig(second: "transient" | "transient-unconfirmed" | "uncertain" | "cancelled" | "silent-stop" | "miss" | "validated" | "isolation" | "unsupported") {
  const controller = new AbortController(), gate = openLearningGate("continuity");
  let calls = 0;
  const roots:string[]=[];
  vi.mocked(spawnCli).mockImplementation((_cli,_args,options) => {
    roots.push(String(options.env?.HOME));
    const n = ++calls;
    const child = Object.assign(new EventEmitter(), { pid: 900000 + n, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      if (n === 2 && second === "transient") return;
      if (n === 2 && second === "silent-stop") { controller.abort(); child.emit("close", 0); return; }
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: n===2&&second==="validated"?'{"ok":true}':"not JSON", usage: { input_tokens: 11 * n, output_tokens: 13 * n } }) + "\n");
      if (n === 2 && second === "cancelled") controller.abort();
      child.emit("close", 0);
    });
    return child as never;
  });
  vi.mocked(awaitCliTreeStopped).mockImplementation(async child => {
    if (calls === 2 && second === "transient") queueMicrotask(() => child.emit("close", 0));
    return !(calls === 2 && (second === "uncertain" || second === "transient-unconfirmed"));
  });
  const run = () => headlessTextOnlyTurn({ cwd: DATA_DIR, system: fixedPrompt("SYS"), text: "USER", model: "m", signal: controller.signal,
    outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, maxOutputBytes: 12000, maxOutputTokens: 3000,
    context: { botId: "fixture", runId: "run", family: "lived", attempt: 1 }, transport: { gate },
  }, { engine: "fuigo", cli: "fixture", fluxKey: "fixture", tmpBase: join(base, "tmp"), firstByteMs: 10,
    preflight: { platform: "linux", home: base, etcRoot: join(base, "etc"), mdmDir: null, claudeManagedPath: join(base, "absent") } });
  return { run, gate, roots };
}
it.each(["transient", "uncertain", "transient-unconfirmed"] as const)("a %s retry preserves transport ownership and sums usage", async second => {
  const r = rig(second), reports: MemoryUsageReport[] = [];
  // Exercise the exit guard independently of gateRun, which normally labels an unconfirmed exit uncertain.
  if (second === "transient-unconfirmed") {
    const actual = actualGateRun;
    vi.mocked(transport.gateRun).mockImplementation(observation => observation.exited ? actual(observation) : { state: "refused", reason: "transient", detail: "fixture", counted: false });
  }
  const result = await captureMemoryUsage(u => reports.push(u), r.run);
  expect(result.verdict).toMatchObject(second === "transient" ? { state: "refused", reason: "bad-output", detail: "no-structured-output", counted: true }
    : second === "uncertain" ? { state: "uncertain-transport" } : { state: "refused", reason: "transient", detail: "fixture", counted: false });
  expect(result.isolation.exited).toBe(second === "transient");
  expect(r.gate.sent).toBe(2);
  expect(r.roots).toHaveLength(2);expect(existsSync(r.roots[0])).toBe(false);expect(existsSync(r.roots[1])).toBe(second!=="transient");
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject(second !== "transient" ? { prompt_tokens: 33, completion_tokens: 39 } : { prompt_tokens: undefined, completion_tokens: undefined });
});
it("a cancelled retry still throws and sums reported usage", async () => {
  const r = rig("cancelled"), reports: MemoryUsageReport[] = [];
  await expect(captureMemoryUsage(u => reports.push(u), r.run)).rejects.toMatchObject({ name: "cancelled" });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ prompt_tokens: 33, completion_tokens: 39 });
});

it("a paid-cap refusal of the second send preserves the first schema miss", async () => {
  const r = rig("miss"), send = r.gate.send.bind(r.gate), reports: MemoryUsageReport[] = [];
  r.gate.send = emit => { if (r.gate.sent === 1) throw readMoved("paid-cap"); return send(emit); };
  const result = await captureMemoryUsage(u => reports.push(u), r.run);
  expect(result.verdict).toMatchObject({ state: "refused", detail: "no-structured-output", counted: true });
  expect(spawnCli).toHaveBeenCalledOnce();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ prompt_tokens: 11, completion_tokens: 13 });
});

it("Stop during an unreported second run keeps both token reservations", async () => {
  const r = rig("silent-stop"), reports: MemoryUsageReport[] = [];
  await expect(captureMemoryUsage(u => reports.push(u), r.run)).rejects.toMatchObject({ name: "cancelled" });
  expect(reports).toHaveLength(1);
  expect(reports[0].prompt_tokens).toBeUndefined();
  expect(reports[0].completion_tokens).toBeUndefined();
  expect(r.gate.sent).toBe(2);
});

it.each(["validated","miss","isolation","unsupported"] as const)("22: confirmed second %s selects the specified result and removes both roots",async second=>{
  const r=rig(second),actual=actualGateRun;
  let calls=0;
  vi.mocked(transport.gateRun).mockImplementation(o=>{
    calls++;
    if(calls===2&&second==="isolation")return {state:"refused",reason:"isolation",detail:"fixture",counted:true};
    if(calls===2&&second==="unsupported")return {state:"unsupported",reason:"tools",detail:"fixture"};
    return actual(o);
  });
  const got=await r.run();expect(got.verdict).toMatchObject(second==="validated"?{state:"validated"}:{state:"refused",detail:"no-structured-output"});
  expect(r.roots).toHaveLength(2);expect(r.roots.every(root=>!existsSync(root))).toBe(true);
});
