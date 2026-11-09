// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN 2.9 r7 (Astra pip-build r5). Every path that leaves a stored result in place after a move revalidates it against admission
// as it stands: a deny that lands during publication's read, which answers `moved`, clears the stored result. And one family-wide count of
// paid calls, probes and content alike, caps a run at three calls that reach a provider, whatever the fingerprint does.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as reaper from "./pip-reaper.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { headlessTextOnlyTurn } from "../drivers/headless-text-only.ts";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setMemoryMode } from "./repository.ts";
import { httpTextOnlyTurn } from "../drivers/http-text-only.ts";
import { pipReadHooks, readReflectState, reconcilePipRuns, runPipReflect, type ReflectDeps } from "./pip-reflect.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(), spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn(async () => true) }));
const T0 = 1_760_000_000_000, MIN = 60_000;
const WORDS = "kept safe";
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
beforeEach(() => {
  vi.spyOn(reaper,"registerChild").mockImplementation(async pid => ({ pid: pid!, startTime: "fixture", registeredAt: Date.now() }));
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { vi.restoreAllMocks(); setMemoryCaptureRoster(null); pipReadHooks.between = undefined; });

const bindingRow = () => String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-reflect:moss'").get()?.intent ?? "");
const family = () => readReflectState(database(), "moss").run?.families.lived;
const recordsWithWords = () => Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE ?").get(`%${WORDS}%`)!.n);

/** `inFlight` runs on a second connection inside the dispatch (after the fence, before the answer). */
async function rig(inFlight?: (other: import("node:sqlite").DatabaseSync) => void, opts: { probe?: boolean; fingerprint?: () => string; content?: unknown } = {}) {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureStoredMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureStoredMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("CREATE TABLE IF NOT EXISTS zz_unrelated(x)");
  const lived = { proposals: [], stance: [], episode: { text: `The owner shared three secrets today and asked that each be ${WORDS}.`, sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
  const content = opts.content ?? lived;
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    inFlight?.(other);
    if (String(init?.body ?? "").includes('Return {\\"ok\\":true}')) return completion({ ok: true });
    return completion(content);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: opts.fingerprint?.() ?? "fp-http", probeRequired: opts.probe, engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  const deny = () => other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0);
  return { deps, fetchImpl, other, deny, close: () => other.close() };
}
/** Runs `at` at every hand-back while the family is validated (after conclusion, before publication's transaction). */
function whileValidated(at: () => void, once = true) {
  let fired = 0;
  pipReadHooks.between = () => { if ((once && fired) || family()?.state !== "validated") return; fired++; at(); };
  return () => fired;
}

it("deny during publication's read, which answers moved: the stored result is cleared, never kept as validated", async () => {
  const r = await rig();
  let stored = false, after = "";
  // the first hand-back of publication's read: the result is stored and admitted; the deny lands inside the read, which then answers moved
  const fired = whileValidated(() => { stored = family()?.resultAdmitted === true && bindingRow().includes(WORDS); r.deny(); });
  try {
    const outcome = await runPipReflect(r.deps, undefined, new AbortController().signal);
    after = bindingRow();
    expect(fired()).toBe(1);
    expect(stored).toBe(true);
    expect(outcome).toMatchObject({ status: "uncertain" });
    // what the move left on disk holds none of the revoked words
    expect(after).not.toContain(WORDS);
    expect(family()?.result).toBeUndefined();
    expect(family()?.state).not.toBe("validated");
    expect(recordsWithWords()).toBe(0);
    pipReadHooks.between = undefined;
    for (let pass = 0; pass < 3; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  } finally { r.close(); }
});

it("an unrelated move during publication's read keeps a stored result still admitted, published without a second call", async () => {
  let n = 0;
  const r = await rig();
  const fired = whileValidated(() => r.other.prepare("INSERT INTO zz_unrelated VALUES(?)").run(++n));
  try {
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(fired()).toBe(1);
    expect(family()).toMatchObject({ state: "validated", attempt: 1, resultAdmitted: true });
    pipReadHooks.between = undefined;
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(family()?.state ?? "settled").not.toBe("validated");
  } finally { r.close(); }
});

it("a successful probe and failing content attempts: three paid calls in all, then refused unstable", async () => {
  const r = await rig(undefined, { probe: true, content: { nope: 1 } });
  try {
    for (let pass = 0; pass < 10; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(3);
    const state = readReflectState(database(), "moss");
    expect(state.run?.families.lived?.state ?? "refused:unstable").toBe("refused:unstable");
    expect(state.refusals.some(x => x.state.startsWith("refused:"))).toBe(true);
  } finally { r.close(); }
});

it("a new fingerprint before every attempt: probes count too, three paid calls in all", async () => {
  let fp = 0;
  const r = await rig(undefined, { probe: true, fingerprint: () => `fp-${++fp}`, content: { nope: 1 } });
  try {
    for (let pass = 0; pass < 12; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(vi.mocked(r.fetchImpl).mock.calls.length).toBeLessThanOrEqual(3);
    expect(vi.mocked(r.fetchImpl).mock.calls.length).toBeGreaterThan(0);
    const state = readReflectState(database(), "moss");
    expect(state.run?.families.lived?.state ?? "refused:unstable").toMatch(/^refused:/);
  } finally { r.close(); }
});

it("a probe then content that succeeds: two paid calls, the cap leaves the normal path alone", async () => {
  const r = await rig(undefined, { probe: true });
  try {
    for (let pass = 0; pass < 4; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
    const state = readReflectState(database(), "moss");
    expect(state.refusals.some(x => x.reason === "paid-calls")).toBe(false);
    expect(state.run?.families.lived?.state ?? "applied").toBe("applied");
  } finally { r.close(); }
});

it.each([false, true])("Flux schema misses end as schema refusal at the paid cap (probe=%s)", async probe => {
  const r = await rig(undefined, { probe });
  const original = r.deps.resolveRoute;
  const attempts: number[] = [];
  const spawns: number[] = [];
  let probing = false;
  vi.mocked(spawnCli).mockImplementation(() => {
    spawns.push(attempts.at(-1)!);
    const child = Object.assign(new EventEmitter(), { pid: 998877, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: probing ? '{"ok":true}' : 'not JSON', usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
      child.emit("close", 0);
    });
    return child as never;
  });
  r.deps.resolveRoute = async (...args) => ({ ...await original(...args), kind: "cli", textOnlyTurn: async input => {
    attempts.push(input.context.attempt);
    probing = Boolean((input.outputSchema.properties as Record<string, unknown>)?.ok);
    return headlessTextOnlyTurn(input, {
      engine: "fuigo", cli: process.execPath, fluxKey: "fixture",
      cliPrefixArgs: [fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url)), `--stub=${(input.outputSchema.properties as Record<string, unknown>)?.ok ? "ok" : "text-bad"}`, `--stub-out=${join(DATA_DIR, "flux.jsonl")}`],
      tmpBase: r.deps.tmpBase,
      preflight: { platform: "linux", home: DATA_DIR, etcRoot: join(DATA_DIR, "etc"), mdmDir: null, claudeManagedPath: join(DATA_DIR, "absent") },
    });
  } });
  try {
    for (let pass = 0; pass < 6; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    const state = readReflectState(database(), "moss");
    expect(state.refusals.some(x => x.state === "refused:bad-output" && x.reason === "no-structured-output")).toBe(true);
    expect(state.refusals.some(x => x.reason === "paid-calls")).toBe(false);
    expect(spawns).toHaveLength(3);
    expect(Math.max(...attempts)).toBe(probe ? 1 : 2);
  } finally { r.close(); }
});

it("an unconfirmed Flux schema retry keeps run 2 owned until a confirmed reap", async () => {
  const r = await rig(), original = r.deps.resolveRoute;
  const roots: string[] = [], attempts: number[] = [];
  let reaped = false;
  r.deps.reaper = {
    observe: async () => reaped ? { state: "absent" } : { state: "unknown" },
    signal: () => { if (reaped) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    sweep: async () => reaped ? [] : null, wait: async () => {},
  };
  vi.mocked(awaitCliTreeStopped).mockImplementation(async () => roots.length !== 2);
  vi.mocked(spawnCli).mockImplementation(() => {
    expect(roots.length < 2 || reaped).toBe(true);
    roots.push(family()!.transport!.intent.tempRoot!);
    const child = Object.assign(new EventEmitter(), { pid: 998877, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "not JSON", usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
      child.emit("close", 0);
    });
    return child as never;
  });
  r.deps.resolveRoute = async (...args) => ({ ...await original(...args), kind: "cli", textOnlyTurn: async input => {
    attempts.push(input.context.attempt);
    return headlessTextOnlyTurn(input, {
      engine: "fuigo", cli: "fixture", fluxKey: "fixture", tmpBase: r.deps.tmpBase,
      preflight: { platform: "linux", home: DATA_DIR, etcRoot: join(DATA_DIR, "etc"), mdmDir: null, claudeManagedPath: join(DATA_DIR, "absent") },
    });
  } });
  try {
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(roots).toHaveLength(2);
    expect(roots[1]).not.toBe(roots[0]);
    expect(family()).toMatchObject({ state: "uncertain-transport", attempt: 1, transport: { intent: { tempRoot: roots[1] } } });
    expect(existsSync(roots[1])).toBe(true);
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(roots).toHaveLength(2);
    expect(family()).toMatchObject({ state: "uncertain-transport", attempt: 1, transport: { intent: { tempRoot: roots[1] } } });
    reaped = true;
    expect(await reconcilePipRuns(r.deps)).toMatchObject({ retried: 1 });
    expect(family()).toMatchObject({ state: "pending", attempt: 2 });
    expect(family()?.transport).toBeUndefined();
    expect(existsSync(roots[1])).toBe(false);
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(roots).toHaveLength(3);
    expect(attempts).toEqual([1, 2]);
  } finally { vi.mocked(awaitCliTreeStopped).mockResolvedValue(true); r.close(); }
});

it.each([false, true])("restart recovers the first report without early settlement (second released=%s)", async released => {
  const { transaction } = await import("../database.ts");
  const { unseenExcessCalls, reconcileDeadRetries } = await import("./extract.ts");
  const r = await rig(), original = r.deps.resolveRoute, controller = new AbortController();
  let ready!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  let calls = 0, secondChild: EventEmitter | undefined;
  vi.mocked(awaitCliTreeStopped).mockImplementation(async child => { queueMicrotask(() => child.emit("close", 0)); return true; });
  vi.mocked(spawnCli).mockImplementation(() => {
    const n = ++calls;
    const child = Object.assign(new EventEmitter(), { pid: 998877, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      if (n === 2) { secondChild = child; ready(); return; }
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "not JSON", usage: { input_tokens: 90000, output_tokens: 4500 } }) + "\n");
      child.emit("close", 0);
    });
    return child as never;
  });
  r.deps.resolveRoute = async (...args) => ({ ...await original(...args), kind: "cli", textOnlyTurn: async input => {
    const hooks = input.transport!.hooks!;
    return headlessTextOnlyTurn({ ...input, transport: { ...input.transport, hooks: { ...hooks, onIntent: async intent => {
      await hooks.onIntent!(intent);
      if (!released && calls===1) { ready(); await paused; }
    } } } }, {
      engine: "fuigo", cli: "fixture", fluxKey: "fixture", tmpBase: r.deps.tmpBase,
      preflight: { platform: "linux", home: DATA_DIR, etcRoot: join(DATA_DIR, "etc"), mdmDir: null, claudeManagedPath: join(DATA_DIR, "absent") },
    });
  } });
  const running = runPipReflect(r.deps, undefined, controller.signal);
  try {
    await reached;
    const saved=r.other.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='learning-spend'").get()!;
    const before=JSON.parse(String(saved.intent)), record=Object.values(before.retryRecords)[0] as import("./extract.ts").RetryRecord;
    expect(record.usage).toEqual({prompt_tokens:90000,completion_tokens:4500});
    expect(before.input).toBe(record.tokens.input);
    expect(before.output).toBe(record.tokens.output);
    before.open={"dead-boot":1}; record.boot="dead-boot";
    database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(before),String(saved.id));
    const reconcile=()=>transaction(db=>{const month=JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(String(saved.id))!.intent));reconcileDeadRetries(db,month);db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(month),String(saved.id));});
    reconcile();
    const read=()=>JSON.parse(String(r.other.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(String(saved.id))!.intent));
    const after=read();
    expect(after.input).toBe(Math.max(record.tokens.input,90000));expect(after.output).toBe(4500);
    expect(unseenExcessCalls(after)).toEqual({inFlight:0,settled:1});
    expect(after.retryRecords).toEqual({});
    reconcile();expect(read()).toEqual(after);
  } finally {
    controller.abort(); resume(); secondChild?.emit("close", 0); await running; r.close();
  }
});

it.each([false,true])("20, 28: an unconfirmed probe keeps its transport (probe=%s)",async probe=>{
  for(const verdict of [{state:"validated",structured:{ok:true}},{state:"refused",reason:"isolation",detail:"debug-inspection-failed",counted:true},{state:"refused",reason:"transient",detail:"fixture",counted:false}] as const){
    // Reset this isolated fixture between verdicts so no prior cooldown or uncertain child can hide the guard.
    closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("active");
    const r=await rig(undefined,{probe}),original=r.deps.resolveRoute;let calls=0,reaped=false;
    r.deps.reaper={observe:async()=>reaped?{state:"absent"}:{state:"unknown"},signal:()=>{},sweep:async()=>reaped?[]:null,wait:async()=>{}};
    r.deps.resolveRoute=async(...args)=>({...await original(...args),kind:"cli",textOnlyTurn:async input=>{
      calls++;
      const root=join(r.deps.tmpBase,"owned");mkdirSync(root,{recursive:true});
      await input.transport!.hooks!.onIntent!({runId:input.context.runId,family:input.context.family,attempt:input.context.attempt,tempRoot:root,binaryIdentity:null,bootEpoch:r.deps.bootEpoch,intentAt:T0,deadlineAt:T0+1e9});
      input.transport!.gate!.send(()=>{});
      return {text:JSON.stringify({proposals:[],stance:[],episode:null}),verdict,isolation:{exited:false,initLine:true,mcpServers:[],tools:[],homeNewFiles:[],cwdNewFiles:[]}};
    }});
    try{
      await runPipReflect(r.deps,undefined,new AbortController().signal);
      expect(family()).toMatchObject({state:"uncertain-transport",attempt:1,reason:"unconfirmed-exit"});expect(family()?.transport).toBeDefined();
      expect(readReflectState(database(),"moss").support["fp-http"]?.probe).toBeUndefined();
      await runPipReflect(r.deps,undefined,new AbortController().signal);expect(calls).toBe(1);
      reaped=true;await reconcilePipRuns(r.deps);expect(family()).toMatchObject({state:"pending",attempt:2});expect(family()?.transport).toBeUndefined();
    }finally{r.close();}
  }
});

it.each([
  ["ceiling","refused:monthly-limit","Paused: this month's learning limit has no room for this run"],
  ["unseen","refused:unseen-calls","Paused to protect your limit: some learning calls did not report their usage"],
  ["pace-zero","refused:call-pace","Paused: the learning pace has no room for this run"],
  ["pace-full","refused:call-pace","Paused: the learning pace has no room for this run"],
  ["bytes","refused:cap","Stopped: today's input allowance has no room for this run"],
  ["daily-cap","refused:cap","Stopped: daily limit reached"],
])("30: %s admission reaches its exact refusal line",async(cause,state,line)=>{
  const {readMemoryLearning,updateMemoryLearning}=await import("./learning-policy.ts");
  const {learningSpendLedgerId,learningSpendMonth}=await import("../../shared/memory-learning-contract.ts");
  const {continuityLedgerId,continuityDay,CONTINUITY_DAILY_INPUT_BYTES}=await import("./extract.ts");
  const {mutateReflect,settleRun}=await import("./pip-reflect.ts");
  const {refusalLine}=await import("../../src/lib/continuity.ts");
  const r=await rig(),db=database();
  const put=(id:string,subject:string,value:unknown)=>db.prepare("INSERT INTO memory_scope_bindings VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id,subject,JSON.stringify(value));
  if(cause==="ceiling")updateMemoryLearning(db,{ceiling:{input:1,output:10000}},readMemoryLearning(db).revision);
  if(cause==="unseen")put(learningSpendLedgerId(learningSpendMonth()),"learning-spend",{input:0,output:0,unmetered:2});
  if(cause==="pace-zero")updateMemoryLearning(db,{callsPerMinute:0},readMemoryLearning(db).revision);
  if(cause==="pace-full"||cause==="bytes")put(continuityLedgerId("moss",continuityDay()),"continuity-budget",{input:0,output:0,minute:Math.floor(Date.now()/60000),calls:cause==="pace-full"?readMemoryLearning(db).callsPerMinute:0,bytes:cause==="bytes"?CONTINUITY_DAILY_INPUT_BYTES-1:0});
  if(cause==="daily-cap"){
    const resolve=r.deps.resolveRoute;
    r.deps.resolveRoute=async(...args)=>{
      const route=await resolve(...args);
      // Candidate selection saw room; a competing admission consumes the last slot before startRun commits.
      mutateReflect("moss",s=>{s.dailyRuns={day:continuityDay(r.deps.now!()),count:24,dreamCalls:0};});
      return route;
    };
  }
  try{
    await runPipReflect(r.deps,undefined,new AbortController().signal);
    const s=readReflectState(db,"moss"),refused=s.refusals.at(-1)!;
    expect(refused.state).toBe(state);expect(refusalLine(refused.state,refused.reason)).toBe(line);expect(s.cooldownUntil).toBe(0);
    expect(r.fetchImpl).not.toHaveBeenCalled();settleRun(r.deps,"moss");expect(readReflectState(db,"moss").run).toBeUndefined();
  }finally{r.close();}
});
it("30: repeated reap failure keeps the run beyond cooldown and Try again until cleanup confirms",async()=>{
  const {mutateReflect,retryReflection,settleRun}=await import("./pip-reflect.ts");
  const {refusalLine}=await import("../../src/lib/continuity.ts");
  const r=await rig(),original=r.deps.resolveRoute;let gone=false;
  r.deps.reaper={observe:async()=>gone?{state:"absent"}:{state:"unknown"},signal:()=>{},sweep:async()=>gone?[]:null,wait:async()=>{}};
  r.deps.resolveRoute=async(...args)=>({...await original(...args),kind:"cli",textOnlyTurn:async input=>{
    const root=join(r.deps.tmpBase,"owned");mkdirSync(root,{recursive:true});await input.transport!.hooks!.onIntent!({runId:input.context.runId,family:input.context.family,attempt:input.context.attempt,tempRoot:root,binaryIdentity:null,bootEpoch:r.deps.bootEpoch,intentAt:T0,deadlineAt:T0+1e9});input.transport!.gate!.send(()=>{});
    return {text:"",verdict:{state:"uncertain-transport",reason:"fixture"},isolation:{exited:false,initLine:true,tools:[],mcpServers:[],homeNewFiles:[],cwdNewFiles:[]}};
  }});
  try{
    await runPipReflect(r.deps,undefined,new AbortController().signal);
    for(let i=0;i<3;i++)await reconcilePipRuns(r.deps);
    expect(family()?.state).toBe("refused:unstable");expect(family()?.transport).toBeDefined();const reason = family()!.reason!;
    expect(reason).toContain("Could not stop a leftover process using " + join(r.deps.tmpBase, "owned"));
    expect(reason).toContain("the folder was kept.");
    const line = refusalLine("refused:unstable", reason);
    expect(line.startsWith("Stopped: this run did not finish: ")).toBe(true);
    expect(line).toContain("Could not stop a leftover process using " + join(r.deps.tmpBase, "owned"));
    expect(line).toContain("the folder was kept.");
    for (const path of ["/tmp/a folder/.murage/pip-tmp/owned", "C:\\Temp\\a folder\\.murage\\pip-tmp\\owned"]) {
      expect(refusalLine("refused:unstable", reason.replace(join(r.deps.tmpBase, "owned"), path))).toContain(path);
    }
    expect(family()!.reason).toBe(readReflectState(database(),"moss").refusals.at(-1)!.reason);
    mutateReflect("moss",s=>{s.cooldownUntil=1;});settleRun(r.deps,"moss");expect(family()?.transport).toBeDefined();retryReflection("moss");expect(family()?.transport).toBeDefined();
    gone=true;await reconcilePipRuns(r.deps);expect(readReflectState(database(),"moss").run).toBeUndefined();
  }finally{r.close();}
});

it.each((["first","retry","probe"] as const).flatMap(kind=>(["before-charge-commit","after-charge-before-begin","after-spawn-before-commit","live-commit-failure","after-commit","refusal-before-refund"] as const).map(window=>({kind,window}))))("24: $kind paid cap at $window",async({kind,window})=>{
  const {mutateReflect}=await import("./pip-reflect.ts");
    closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("active");
    const r=await rig(undefined,{probe:kind==="probe"}),original=r.deps.resolveRoute;
    const controller=new AbortController();
    let injected=false,blockedBegins=0,initialized=false,spawns=0,refundBoundary=false;
    let crashState:string|undefined;
    const checkpoint=()=>{
      crashState=String(r.other.prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-reflect:moss'").get()!.intent);
      expect(JSON.parse(crashState).run.families.lived.paidCalls).toBe(window==="before-charge-commit"?2:3);
    };
    const durable=()=>{const row=r.other.prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-reflect:moss'").get();return row?JSON.parse(String(row.intent)).run?.families.lived?.paidCalls??0:0;};
    vi.mocked(awaitCliTreeStopped).mockImplementation(async child=>{queueMicrotask(()=>child.emit("close",0));return true;});
    vi.mocked(spawnCli).mockImplementation(()=>{
      spawns++;expect(durable()).toBeLessThanOrEqual(3);expect(durable()).toBe(kind==="retry"&&spawns===1?2:3);
      const child=Object.assign(new EventEmitter(),{pid:998877,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
      queueMicrotask(()=>{child.stdout.write(JSON.stringify({type:"system",subtype:"init",tools:[],mcp_servers:[]})+"\n"+JSON.stringify({type:"result",subtype:"success",is_error:false,result:"not JSON",usage:{input_tokens:10,output_tokens:5}})+"\n");child.emit("close",0);});return child as never;
    });
    r.deps.resolveRoute=async(...args)=>({...await original(...args),kind:"cli",textOnlyTurn:async input=>{
      const hooks=input.transport!.hooks!;
      return headlessTextOnlyTurn({...input,transport:{...input.transport,hooks:{...hooks,onIntent:async intent=>{
        await hooks.onIntent!(intent);
        if(!initialized){initialized=true;mutateReflect("moss",s=>{s.run!.families.lived.paidCalls=kind==="retry"?1:2;});}
      }}}},{engine:"fuigo",cli:"fixture",fluxKey:"fixture",tmpBase:r.deps.tmpBase,preflight:{platform:"linux",home:DATA_DIR,etcRoot:join(DATA_DIR,"etc"),mdmDir:null,claudeManagedPath:join(DATA_DIR,"absent")}}).catch(error=>{
        // End this live pass after the refused gate and its refund, before driveRun can try again.
        if(window==="after-charge-before-begin"||window==="refusal-before-refund")controller.abort();
        throw error;
      });
    }});
    const db=database(),exec=db.exec.bind(db);
    const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{
      if(sql==="BEGIN IMMEDIATE"&&blockedBegins>0){
        if(window==="refusal-before-refund"&&blockedBegins===1){refundBoundary=true;checkpoint();}
        blockedBegins--;throw Object.assign(new Error("database is locked"),{code:"SQLITE_BUSY"});}
      if(initialized&&!injected&&sql==="COMMIT"){
        const staged=family()?.paidCalls??0;
        if(window==="before-charge-commit"&&staged===3&&durable()===2){checkpoint();injected=true;throw new Error("crash before charge commit");}
        if((window==="after-charge-before-begin"||window==="refusal-before-refund")&&staged===3&&durable()===2){const value=exec(sql);if(window==="after-charge-before-begin")checkpoint();injected=true;blockedBegins=window==="after-charge-before-begin"?1:2;return value;}
        if((window==="after-spawn-before-commit"||window==="live-commit-failure")&&durable()===3&&spawns===(kind==="retry"?2:1)){checkpoint();injected=true;if(window==="after-spawn-before-commit")exec("ROLLBACK");throw new Error(window);}
      }
      const value=exec(sql);
      if(window==="after-commit"&&!injected&&sql==="COMMIT"&&spawns===(kind==="retry"?2:1)&&durable()===3){
        checkpoint();injected=true;
      }
      return value;
    });
    try{
      await runPipReflect(r.deps,undefined,controller.signal);
      expect(injected).toBe(true);
      expect(crashState).toBeDefined();
      if(window==="refusal-before-refund")expect(refundBoundary).toBe(true);
      if(window==="after-charge-before-begin"){
        expect(durable()).toBe(2); // Only gate BEGIN failed; the refund committed.
        crashState=String(r.other.prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-reflect:moss'").get()!.intent);
      }
      if(window==="live-commit-failure"||window==="after-spawn-before-commit"){expect(family()?.state).toBe("uncertain-transport");expect(family()?.transport).toBeDefined();}
      const expected=(kind==="retry"?1:0)+(["before-charge-commit","after-charge-before-begin","refusal-before-refund"].includes(window)?0:1);
      expect(spawns).toBe(expected);spy.mockRestore();
      // The live call can conclude and delete a terminal run. Replay the independently read,
      // committed crash-window state, not that later conclusion, when modelling restart.
      db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='pip-reflect:moss'").run(crashState!);
      expect(durable()).toBe(window==="before-charge-commit"||window==="after-charge-before-begin"?2:3);
      // A newer boot may reap/retry, but the persisted third charge still forbids a fourth release.
      r.deps.bootEpoch={pid:2,startedAt:2};r.deps.reaper={observe:async()=>({state:"absent"}),signal:()=>{},sweep:async()=>[]};
      for(let pass=0;pass<5;pass++){await reconcilePipRuns(r.deps);await runPipReflect(r.deps,undefined,new AbortController().signal);}
      expect(spawns).toBeLessThanOrEqual(kind==="retry"?2:1);
    }finally{spy.mockRestore();r.close();}
});


it.each(["cancelled", "budget-exhausted"] as const)("C1/F: notStarted %s has its exact persisted disposition", async reason => {
  const extract = await import("./extract.ts");
  const r = await rig(),controller=new AbortController();
  const lease = vi.spyOn(extract, "withContinuityInferenceLease").mockImplementation(async callback => {
    await callback({request:async()=>({status:"notStarted",reason})} as never);
    if(reason==="cancelled")controller.abort();
    return {status:"complete",value:undefined} as never;
  });
  try {
    await runPipReflect(r.deps,undefined,controller.signal);
    expect(lease).toHaveBeenCalledOnce();
    if(reason==="cancelled")expect(family()).toMatchObject({state:"pending",reason});
    expect(family()?.transport).toBeUndefined();
    const notes=readReflectState(database(),"moss").refusals;
    if(reason==="cancelled")expect(notes).toEqual([]);
    else expect(notes.at(-1)).toMatchObject({state:"refused:cap",reason:"budget-exhausted"});
    expect(r.fetchImpl).not.toHaveBeenCalled();
  } finally {lease.mockRestore();r.close();}
});

it.each(["run", "attempt"] as const)("F: a stale %s refund cannot debit the newer identity", async identity => {
  const {mutateReflect}=await import("./pip-reflect.ts");
  const r=await rig(),resolve=r.deps.resolveRoute;
  let boundary=false;
  r.deps.resolveRoute=async(...args)=>({...await resolve(...args),textOnlyTurn:async input=>{
    const db=database(),exec=db.exec.bind(db);let begins=0;
    const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{
      if(sql==="BEGIN IMMEDIATE"&&++begins===2){
        boundary=true;
        mutateReflect("moss",s=>{
          if(identity==="run")s.run!.runId="newer-run";
          else s.run!.families.lived.attempt++;
          s.run!.families.lived.paidCalls=3;
        });
        throw Object.assign(new Error("database is locked"),{code:"SQLITE_BUSY"});
      }
      return exec(sql);
    });
    try {input.transport!.gate!.send(()=>{throw new Error("must not release");});}
    finally {spy.mockRestore();}
    throw new Error("gate must refuse");
  }});
  try {
    await runPipReflect(r.deps,undefined,new AbortController().signal);
    expect(boundary).toBe(true);
    expect(family()?.paidCalls).toBe(3);
    expect(r.fetchImpl).not.toHaveBeenCalled();
  } finally {r.close();}
});
