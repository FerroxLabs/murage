import { opencodeConfigOverlay } from "../../flux-memory-headers.ts";
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OpenCodeDestinationKey } from "../../opencode-destination-key.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { OpenCodeDestinationResolver, openCodeDestinationAnswer, probeOpenCodeDestination } from "../../opencode-destination.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
const instances: ProviderInstance[] = [];
afterEach(async () => { for (const instance of instances.splice(0)) await instance.dispose(); });
function support(): AcpSupport {
  return { driverKind: "opencodeGo", displayName: "Fixture", defaultCli: join(process.cwd(), "server/testing/fake-acp-cli.ts"), nativeSource: "fixture", loginNote: "fixture", models: { default: "p/m", options: [{ id: "p/m", label: "Fixture" }] }, spawnArgs: () => ["acp"], pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue" };
}
async function create(s: AcpSupport, environment: Record<string, string> = {}) {
  const instance = await createAcpDriver(s).create({ instanceId: "x4", displayName: "Fixture", enabled: true, environment, config: { cli: s.defaultCli, fullAuto: false } });
  instances.push(instance); return instance;
}
// STOP-FENCE r3.2 line 124: a send stopped by reset, interrupt or Stop All before its turn started resolves to the stopped receipt (turn.started + turn.completed cancelled); dispose still rejects (engine closing, retried).
async function expectReceiptOrReject(send: Promise<{ turnId: string }>, action: string, rec: EventRecorder, threadId: string): Promise<void> {
  const pairOf = () => rec.events.filter(e => e.type === "turn.started" || e.type === "turn.completed");
  if (action === "dispose") { await expect(send).rejects.toThrow("stopped"); expect(pairOf()).toEqual([]); return; }
  const result = await send;
  expect(result).toEqual({ turnId: expect.any(String) });
  const { turnId } = result, pair = pairOf();
  expect(pair.filter(e => e.type === "turn.started")).toEqual([expect.objectContaining({ turnId, threadId, provider: "opencodeGo" })]);
  expect(pair.filter(e => e.type === "turn.completed")).toEqual([expect.objectContaining({ turnId, threadId, provider: "opencodeGo", ok: true, stopReason: "cancelled" })]);
  expect(pair.map(e => e.type)).toEqual(["turn.started", "turn.completed"]);
  expect(rec.events.slice(rec.events.indexOf(pair[1]) + 1).filter(e => e.turnId === turnId)).toEqual([]);
}
it("rejects effectiveDestination together with secretEnv at construction", () => {
  expect(() => createAcpDriver({ ...support(), secretEnv: () => ({}), effectiveDestination: async () => openCodeDestinationAnswer({}, { memoryOff: true }) })).toThrow("effectiveDestination");
});
it("refuses an effective alias before spawning ACP", async () => {
  const instance = await create({ ...support(), effectiveDestination: async () => openCodeDestinationAnswer({ provider: { p: { api: "https://api.fluxrouter.ai" } } }, { model: "p/m", memoryOff: true }) });
  await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "alias", text: "fixture", model: "p/m" })).rejects.toThrow("Switch this bot to the Flux connection");
});
it("applies the overlay after the final hand only for engines with the hook", async () => {
  const order: string[] = [];
  let probed: Record<string, string | undefined> = {};
  const instance = await create({ ...support(), spawnArgs: (_config, _turn, ctx) => {
    if (!ctx?.env) throw new Error("missing spawn environment");
    expect({ ...ctx.env, OPENCODE_CONFIG_CONTENT: undefined }).toEqual({ ...probed, OPENCODE_CONFIG_CONTENT: undefined });
    expect(JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT!).provider.flux.options.headers["x-flux-memory-app"]).toBe("murage"); return ["acp"];
  }, resolveTurnModel: () => "flux/flux-auto", finishTurnEnv: () => { order.push("finish"); }, effectiveDestination: async ctx => {
    order.push("destination"); probed = { ...ctx.env }; expect(ctx.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    return openCodeDestinationAnswer({ provider: { flux: {} } }, { model: ctx.model, memoryOff: true });
  }, applyFluxMemory: (env, { decision }) => { order.push("overlay"); env.OPENCODE_CONFIG_CONTENT = opencodeConfigOverlay("flux", decision.headers, env.OPENCODE_CONFIG_CONTENT); } });
  const events = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "order", text: "fixture", model: "flux-auto" });
  await events.until(e => e.type === "turn.completed");
  expect(order).toEqual(["finish", "destination", "overlay"]);
});
it("keeps the old overlay order for an engine without the hook", async () => {
  const order: string[] = [];
  const instance = await create({ ...support(), requestBaseUrl: () => "https://api.fluxrouter.ai/v1", finishTurnEnv: () => { order.push("finish"); }, applyFluxMemory: () => { order.push("overlay"); } });
  const events = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "old-order", text: "fixture", model: "flux-auto" });
  await events.until(e => e.type === "turn.completed");
  expect(order).toEqual(["overlay", "finish"]);
});
it.each(["interrupt", "reset", "stopAll", "dispose"])("%s waits for a held destination and prevents launch", async action => {
  let entered!: () => void; const entry = new Promise<void>(r => { entered = r; });
  let release!: () => void;
  const instance = await create({ ...support(), effectiveDestination: async ctx => {
    entered(); await new Promise<void>(resolve => { release = resolve; ctx.signal.addEventListener("abort", resolve.bind(null, undefined), { once: true }); });
    return openCodeDestinationAnswer({}, { model: "p/m", memoryOff: true });
  } });
  const events = recordEvents(instance.adapter);
  const send = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "held", text: "fixture", model: "p/m" });
  const rejected = send.then(() => undefined, () => undefined);
  await entry;
  await expect(instance.adapter.sendTurn({ threadId: "held", text: "second" })).rejects.toThrow("already running");
  if (action === "interrupt") await instance.adapter.interruptTurn("held");
  else if (action === "reset") await instance.adapter.resetSession?.("held");
  else if (action === "stopAll") await instance.adapter.stopAll?.();
  else await instance.dispose();
  release(); await rejected;
  await expectReceiptOrReject(send, action, events, "held");
  events.stop();
});

it.each(["interrupt", "dispose"])("%s confirms a hung probe and its SIGTERM-ignoring descendant are gone", async action => {
  const root = mkdtempSync(join(tmpdir(), "x4-probe-tree-"));
  const cli = join(root, "probe.mjs"), pids = join(root, "pids.json");
  writeFileSync(cli, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.19.4'); process.exit(0); }
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
setInterval(()=>{},1000);
`); chmodSync(cli, 0o755);
  let instance: ProviderInstance | undefined;
  try {
    instance = await create({ ...support(), defaultCli: cli, effectiveDestination: async ctx => {
      try { await probeOpenCodeDestination(ctx); } catch (error) { if (!ctx.signal.aborted || (error as { code?: string }).code === "provider_stop_unconfirmed") throw error; }
      return openCodeDestinationAnswer({}, { model: "p/m", memoryOff: true });
    } });
    const events = recordEvents(instance.adapter);
    const send = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "tree", text: "fixture", model: "p/m" });
    const rejected = send.then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(existsSync(pids)).toBe(true), { timeout: 10_000 });
    const ids: number[] = JSON.parse(readFileSync(pids, "utf8"));
    if (action === "interrupt") await instance.adapter.interruptTurn("tree"); else await instance.dispose();
    await rejected;
    await expectReceiptOrReject(send, action, events, "tree");
    events.stop();
    for (const pid of ids) await vi.waitFor(() => {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive && process.platform === "linux") {
        try { alive = !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    }, { timeout: 5000 });
  } finally { await instance?.dispose(); removeTempDirSync(root); }
}, 30_000);

it("OpenCode prewarm does not invoke the destination hook", async () => {
  const effectiveDestination = vi.fn(async () => openCodeDestinationAnswer({}, { memoryOff: true }));
  const instance = await create({ ...support(), effectiveDestination });
  expect(await instance.adapter.prewarm?.("cold")).toBe(false);
  expect(effectiveDestination).not.toHaveBeenCalled();
});
it.each(["alias/m", "missing/m", "flux/m"])("a resumed %s cannot bypass the destination refusal through session fallback", async model => {
  const root = mkdtempSync(join(tmpdir(), "x4-resume-")), prompt = join(root, "prompt.json");
  const instance = await create({ ...support(), selectModel: { configId: "model" }, effectiveDestination: async () =>
    openCodeDestinationAnswer({ model: "p/m", provider: { p: {}, alias: { api: "https://api.fluxrouter.ai" }, flux: {} } }, { memoryOff: true })
  }, { FAKE_ACP_MODELS: model, FAKE_ACP_PROMPT_DUMP: prompt });
  const events = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "resume", text: "fixture", resumeCursor: "saved-session" });
    expect(await events.until(e => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: false });
    expect(events.events.some(e => e.type === "runtime.error" && e.message.includes(model.startsWith("alias") ? "Switch this bot" : "couldn't confirm"))).toBe(true);
    expect(existsSync(prompt)).toBe(false);
  } finally { events.stop(); await instance.dispose(); removeTempDirSync(root); }
});

it("OpenCode still refuses provider route bindings", async () => {
  const instance = await create(support());
  await expect(instance.adapter.sendTurn({ threadId: "route", text: "fixture", providerRoute: {
    connectionId: "fixture", preset: "flux", protocol: "openai", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: "fixture", model: "flux-auto", revision: "fixture"
  } })).rejects.toThrow();
});

it("D9 disposing an unused resolver instance opens no handles and is harmless twice", async () => {
  const resolver = new OpenCodeDestinationResolver();
  const key = (resolver as unknown as { keys: OpenCodeDestinationKey }).keys;
  const state = key as unknown as { accounts: Map<string, unknown>; idleTimer?: NodeJS.Timeout };
  const read = vi.spyOn(key, "read");
  const retain = vi.spyOn(state.accounts, "set");
  const disposeDestination = vi.fn(() => resolver.dispose());
  const instance = await create({ ...support(), effectiveDestination: ctx => resolver.resolve(ctx), disposeDestination });
  try {
    expect(state.accounts.size).toBe(0);
    expect(state.idleTimer).toBeUndefined();
    await instance.dispose();
    await instance.dispose();
    expect(disposeDestination).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(state.accounts.size).toBe(0);
    expect(state.idleTimer).toBeUndefined();
  } finally { resolver.dispose(); }
});

it.skipIf(process.platform === "win32").each(["stopAll", "dispose"] as const)("D9 %s closes warmed resolver handles after outstanding probes settle", async action => {
  const root = mkdtempSync(join(tmpdir(), "x4-lifecycle-"));
  const path = join(root, "account.db");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(0)");
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const resolver = new OpenCodeDestinationResolver(async () => {
    entered(); await held; return { provider: { p: {} } };
  });
  const key = (resolver as unknown as { keys: OpenCodeDestinationKey }).keys;
  const accounts = (key as unknown as { accounts: Map<string, { conn: DatabaseSync }> }).accounts;
  const disposeDestination = vi.fn(() => resolver.dispose());
  let instance: ProviderInstance | undefined;
  try {
    instance = await create({ ...support(),
      effectiveDestination: ctx => resolver.resolve({ ...ctx, cwd: root }),
      disposeDestination,
    }, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, OPENCODE_TEST_MANAGED_CONFIG_DIR: root, OPENCODE_DB: path });
    const events = recordEvents(instance.adapter);
    const send = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "warm", text: "fixture", model: "p/m" });
    const rejected = send.then(() => undefined, () => undefined);
    await entry;
    expect(accounts.size).toBe(1);
    const conn = accounts.get(path)!.conn, close = vi.spyOn(conn, "close");
    const stopping = action === "stopAll" ? instance.adapter.stopAll!() : instance.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposeDestination).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    release(); await stopping; await rejected;
    await expectReceiptOrReject(send, action, events, "warm");
    events.stop();
    expect(disposeDestination).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(accounts.size).toBe(0);
    expect(() => conn.prepare("SELECT 1")).toThrow();
  } finally {
    release(); await instance?.dispose(); resolver.dispose(); writer.close();
    removeTempDirSync(root);
  }
});

for (const requestUrl of ["https://api.fluxrouter.ai/v1", "https://api.openai.com/v1"]) it(`R1 probed model override decides refusal scope: ${requestUrl}`, async () => {
  const instance=await create({...support(),effectiveDestination:async()=>({provider:"flux",urls:["https://api.fluxrouter.ai/v1",requestUrl]})}, {FAKE_ACP_MODE:"payment-required:missing"});
  const rec=recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({cwd:fixtureBotFolder(),threadId:"r1-probed",text:"fixture",model:"flux/m"});
    await rec.until(e=>e.type==="turn.completed");
    const decision=(rec.events.find(e=>e.type==="runtime.error") as any)?.fluxDecision;
    if(requestUrl.includes("fluxrouter.ai"))expect(decision).toEqual({reason:"fluxStop",action:"STOP",wait:"-"});
    else expect(decision).toBeUndefined();
  } finally {rec.stop();}
});
