import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { ensureDirs } from "../../config.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import * as oc from "./openclaw.ts";

// All assertions concern Murage's calls. Coverage is supplied only by this fixture;
// no assertion here establishes enforcement by an installed OpenClaw package.
const CLI = join(process.cwd(), "server/testing/fake-acp-cli.ts");
// f9e659dbf1 forbids safe/safely/unsafe in visible refusals; keep the exact refusal.
const REFUSAL = "OpenClaw cannot run this turn with your folder restrictions.";
const NOTICE = "OpenClaw runs read-only here because it cannot enforce Murage’s protected-folder, refused-folder and wipe rules.";
const COVERED = { refusedReads: true, skillRoots: true, extraTools: true, nativeHarnesses: true, delegation: true, readBoundary: true };
const config = { cli: CLI, fullAuto: false, agent: "fred" };
const version = async () => "OpenClaw 2026.10.5";
const turn = { threadId: "deny", text: "fixture", warmIdentity: { botId: "b1", audience: "owner" as const } };
const ctx = (askLevel = false) => ({ env: {}, config, turn, askLevel });

let scratch: string;
let instance: ProviderInstance | undefined;
let events: EventRecorder | undefined;
beforeEach(() => { ensureDirs(); chmodSync(CLI, 0o755); scratch = mkdtempSync(join(tmpdir(), "murage-oc-deny-")); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); events?.stop(); await instance?.dispose(); instance = undefined; events = undefined; await removeTempDir(scratch); });

function gateway(answer?: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call: oc.OpenclawGatewayCall = async (_cli, method, params) => {
    calls.push({ method, params });
    if (method === "sessions.list") return { sessions: [{ key: params.search, permissionMode: "full" }] };
    return answer ?? { ok: true, key: params.key, entry: { permissionMode: params.permissionMode } };
  };
  return { call, calls };
}
function guard(gw = gateway(), coverage: Record<string, boolean> | undefined = COVERED) {
  return oc.createOpenclawPrePromptGuard({ call: gw.call, dataDir: scratch, probeVersion: version, verifyCoverage: async () => coverage });
}
async function create(prePrompt: NonNullable<AcpSupport["prePrompt"]>, environment: Record<string, string> = {}, extra: Partial<AcpSupport> = {}) {
  instance = await createAcpDriver({ ...oc.openclawSupport, ...extra, prePrompt }).create({
    instanceId: "oc-deny", displayName: "OpenClaw", enabled: true,
    config, environment: { FAKE_ACP_MODE: "no-auth", ...environment },
  });
  events = recordEvents(instance.adapter);
}
async function send(extra: Partial<SendTurnInput> = {}) {
  const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), ...turn, ...extra });
  return events!.until(e => e.type === "turn.completed" && e.turnId === turnId);
}
function lazyGuard(gw = gateway(), coverage: Record<string, boolean> | undefined = COVERED): NonNullable<AcpSupport["prePrompt"]> {
  return { notice: NOTICE, refusal: REFUSAL, apply: context => guard(gw, coverage).apply(context) };
}
function notices(title: string) { return events!.events.filter(e => e.type === "item.started" && e.itemType === "tool" && e.origin === "murage" && e.title === title); }

describe("OpenClaw deny set", () => {
  it("R1 patches the exact bridge key read-only for every level, audience and fullAuto setting", async () => {
    for (const flags of [{ routeAsks: true }, { stopLine: true }, {}, { askLevel: true as const, routeAsks: true }]) {
      for (const audience of ["owner", "non-owner"] as const) for (const fullAuto of [false, true]) {
        const gw = gateway();
        const context = { ...ctx(flags.askLevel === true), config: { ...config, fullAuto }, turn: { ...turn, ...flags, warmIdentity: { botId: "b1", audience } } };
        await oc.applyOpenclawAskStop(context, gw.call, scratch, version);
        expect(gw.calls.at(-1)).toEqual({ method: "sessions.patch", params: { key: oc.openclawBridgeArgs(config, context.turn)[2], permissionMode: "read-only" } });
        expect(oc.openclawPromptText(context.turn).split("\n")[0]).toBe("/exec security=deny");
      }
    }
  });

  it("R2 rejects a wrong key as well as echoed, rejected and malformed stored states", async () => {
    const key = oc.openclawTurnSessionKey(config, turn);
    for (const answer of [
      { ok: true, key: "another-session", entry: { permissionMode: "read-only" } },
      { ok: true, entry: { permissionMode: "read-only" } },
      { ok: true, key, permissionMode: "read-only" },
      { ok: false, key, entry: { permissionMode: "read-only" } },
      { ok: true, key, entry: {} }, { ok: true, key, entry: { permissionMode: "workspace" } },
    ]) await expect(oc.applyOpenclawAskStop(ctx(true), gateway(answer).call, scratch, version)).rejects.toThrow();
  });

  it("R2 all levels reject old, unreadable and timed-out probes or patches", async () => {
    for (const askLevel of [false, true]) for (const probe of [async () => "2026.7.35", async () => { throw new Error("unreadable"); }]) {
      const gw = gateway();
      await expect(oc.applyOpenclawAskStop(ctx(askLevel), gw.call, scratch, probe)).rejects.toThrow(REFUSAL);
      expect(gw.calls).toEqual([]);
    }
    vi.useFakeTimers();
    const pending = oc.applyOpenclawAskStop(ctx(), async () => new Promise(() => {}), scratch, version);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_001); await rejected;
  });

  it("R3 Ask to Full to No limits to Auto and restart never restore legacy values, even after owner drift", async () => {
    const key = oc.openclawTurnSessionKey(config, turn);
    const path = oc.openclawAskStopRecordPath(CLI, key, scratch);
    mkdirSync(dirname(path), { recursive: true });
    for (const record of [JSON.stringify({ key, previous: "full" }), "corrupt", undefined]) {
      if (record !== undefined) writeFileSync(path, record);
      else if (existsSync(path)) unlinkSync(path);
      const gw = gateway();
      for (const askLevel of [true, false, false, false]) {
        await oc.applyOpenclawAskStop(ctx(askLevel), gw.call, scratch, version);
        expect(gw.calls.at(-1)?.params).toEqual({ key, permissionMode: "read-only" });
      }
      if (record !== undefined) expect(readFileSync(path, "utf8")).toBe(record);
    }
  });

  it("R4 cold, warm, resumed, reset, command and repeated submissions guard before the synchronous submission fence", async () => {
    vi.stubEnv("MURAGE_ACP_POOL", "1");
    const order: string[] = [];
    const write = Socket.prototype.write;
    vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: Socket, ...args: Parameters<typeof write>) {
      try { if (JSON.parse(String(args[0])).method === "session/prompt") order.push("write"); } catch { /* other stream writes */ }
      return Reflect.apply(write, this, args) as boolean;
    });
    const gw = gateway();
    const prePrompt = lazyGuard(gw);
    await create({ ...prePrompt, apply: async context => { order.push("guard"); await prePrompt.apply(context); order.push("guard-done"); } }, { FAKE_ACP_RPC_FULL_LOG: join(scratch, "rpc.jsonl"), FAKE_ACP_SPAWN_LOG: join(scratch, "spawns.jsonl") }, { pooledSessions: true });
    for (const extra of [{}, { resumeCursor: "fake-acp-session" }, { resumeCursor: "saved-session" }, { sessionReset: true }, { engineCommand: { name: "compact", args: "" } }, {}]) {
      const before = gw.calls.length, offset = order.length;
      const done = await send({ ...extra, beforeSubmit: () => { expect(order.at(-1)).toBe("guard-done"); order.push("fence"); queueMicrotask(() => order.push("microtask")); } });
      expect(done).toMatchObject({ ok: true });
      expect(order.slice(offset)).toEqual(["guard", "guard-done", "fence", "write", "microtask"]);
      if (offset === 5) expect(readFileSync(join(scratch, "spawns.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(gw.calls.slice(before).filter(c => c.method === "sessions.patch")).toHaveLength(1);
    }
    expect(order.filter(x => x === "guard")).toHaveLength(6);
    expect(notices(NOTICE)).toHaveLength(6);
  });

  it("R4 a tool-budget retry invokes admission again and keeps one disclosure for the turn", async () => {
    // This generic ACP fixture enables mounts only to exercise the core's retry loop.
    // OpenClaw itself still declares ownTools and receives no Murage mounts.
    const { REQUIRED_CONTROLS } = await import("./opencode-tool-budget.ts");
    const log = join(scratch, "retry.jsonl"), gw = gateway();
    await create(lazyGuard(gw), { FAKE_ACP_MODE: "c11-budget", FAKE_C11_LOG: log, FAKE_C11_SPEC: JSON.stringify({ native: 11, limit: 40, awaitCatalogExit: true,
      catalogs: { agents: REQUIRED_CONTROLS.filter(n => n !== "project_propose"), murage_connectors: Array.from({ length: 25 }, (_, i) => `tool${i}`) } }) },
      { driverKind: "denyRetryFixture", ownTools: false, mcpListedWait: true, models: { default: "opencode/mock", options: [] },
        toolBudget: { routeKey: () => createHash("sha256").update(scratch).digest("hex") },
        transformEnv: env => { env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { "*": "ask" } }); } });
    expect(await send({ integrations: { agents: { command: process.execPath, args: [CLI, "--never-started"], env: {} }, composio: { command: process.execPath, args: ["fixture-only"], env: {} } } })).toMatchObject({ ok: true });
    const rows = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.event === "prompt")).toHaveLength(2);
    expect(gw.calls.filter(c => c.method === "sessions.patch")).toHaveLength(2);
    expect(notices(NOTICE)).toHaveLength(1);
  });

  it("R4 Stop while the patch is held prevents the prompt and the fence", async () => {
    const prompt = join(scratch, "prompt.json");
    let release!: () => void, entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const fence = vi.fn();
    await create({ notice: NOTICE, refusal: REFUSAL, apply: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); } }, { FAKE_ACP_PROMPT_DUMP: prompt });
    const sending = send({ beforeSubmit: fence });
    // Baseline does not invoke the hook, so it completes and fails here instead of hanging.
    await Promise.race([entry, sending]);
    expect(release).toBeTypeOf("function");
    await instance!.adapter.interruptTurn(turn.threadId); release(); await sending;
    await vi.waitFor(() => expect(fence).not.toHaveBeenCalled());
    expect(existsSync(prompt)).toBe(false);
    expect(notices(NOTICE)).toHaveLength(0);
  });

  it("R5 confirmed read-only still refuses refused descendants, skill roots, plugin, harness, delegation and unknown reads", async () => {
    const prompt = join(scratch, "prompt.json");
    let coverage: Record<string, boolean> | undefined;
    const gw = gateway();
    await create({ notice: NOTICE, refusal: REFUSAL, apply: context => guard(gw, coverage).apply(context) }, { FAKE_ACP_PROMPT_DUMP: prompt });
    for (const boundary of Object.keys(COVERED)) {
      coverage = { ...COVERED, [boundary]: false };
      expect(await send()).toMatchObject({ ok: false });
      expect(existsSync(prompt)).toBe(false);
    }
    // The production default has no coverage verifier, regardless of the version or tool listing.
    const production = oc.createOpenclawPrePromptGuard({ call: gw.call, dataDir: scratch, probeVersion: version });
    await expect(production.apply({ ...ctx(), turn: { ...turn, cwd: fixtureBotFolder() } })).rejects.toThrow(REFUSAL);
    expect(gw.calls.filter(c => c.method === "sessions.patch")).toHaveLength(7);
    expect(notices(REFUSAL)).toHaveLength(6);
    expect(notices(NOTICE)).toHaveLength(0);
  });

  it("R2 driver failure sends zero prompts and one refusal at every level", async () => {
    const prompt = join(scratch, "prompt.json");
    await create(lazyGuard(gateway({ ok: true, key: "wrong", entry: { permissionMode: "read-only" } })), { FAKE_ACP_PROMPT_DUMP: prompt });
    for (const flags of [{}, { routeAsks: true }, { stopLine: true }, { askLevel: true }] as const) expect(await send(flags)).toMatchObject({ ok: false });
    expect(existsSync(prompt)).toBe(false);
    expect(notices(REFUSAL)).toHaveLength(4);
    expect(events!.events.filter(e => e.type === "runtime.error")).toHaveLength(0);
    expect(notices(NOTICE)).toHaveLength(0);
  });

  it("R6 an admitted fixture emits one disclosure before its prompt, regardless of model output, with no mounts", async () => {
    const prompt = join(scratch, "prompt.json");
    const dump = join(scratch, "spawn.json");
    const gw = gateway();
    await create(lazyGuard(gw), { FAKE_ACP_PROMPT_DUMP: prompt, FAKE_ACP_DUMP: dump });
    expect(await send({ beforeSubmit: () => { expect(notices(NOTICE)).toHaveLength(1); expect(existsSync(prompt)).toBe(false); }, integrations: { agents: { command: "node", args: [], env: {} } } })).toMatchObject({ ok: true });
    expect(notices(NOTICE)).toHaveLength(1);
    expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers ?? []).toEqual([]);
    expect(JSON.parse(readFileSync(prompt, "utf8"))[0].text).toMatch(/^\/exec security=deny\n/);
    expect(oc.openclawSupport.ownTools).toBe(true);
    expect(oc.openclawSupport.prePrompt).toBeDefined();
  });
});
useOutsideStoreFixture();
