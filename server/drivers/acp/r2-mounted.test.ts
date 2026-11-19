import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { fixtureMountTurn } from "../../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import * as native from "../engine-input.ts";
import * as procs from "../../procs.ts";
import { ChatMcpDescendants } from "../chat-mcp-client.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "R2 ACP", defaultCli: CLI, nativeSource: "r2.acp",
  models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
  pooledSessions: true, mcpListMethod: "_fuigo/mcp/list",
  fluxReach: () => "elsewhere",
};
let root: string, instance: ProviderInstance | undefined;
let wire: any[];
beforeEach(async () => {
  resetAcpMcpReadinessForTests();
  ensureDirs(); chmodSync(CLI, 0o755);
  root = mkdtempSync(join(tmpdir(), "r2-acp-"));
  vi.stubEnv("MURAGE_ACP_POOL", "1");
  vi.stubEnv("FAKE_ACP_MCP_LIST", "all:ready");
  vi.stubEnv("FAKE_ACP_RPC_LOG", join(root, "rpc.jsonl"));
  vi.stubEnv("FAKE_ACP_SPAWN_LOG", join(root, "pids"));
  const release = native.releaseNativeAnswer;
  wire = [];
  vi.spyOn(native, "releaseNativeAnswer").mockImplementation((binding, sink, serialized, write) => {
    return release(binding, sink, serialized, () => {
      if (sink === "acp:approval") wire.push(JSON.parse(serialized));
      return write();
    });
  });
  const submit = native.fencedSubmit;
  vi.spyOn(native, "fencedSubmit").mockImplementation((turn, write, serialized, validate) =>
    submit(turn, () => {
      if (serialized) wire.push(JSON.parse(serialized));
      return write();
    }, serialized, validate));
});
afterEach(async () => {
  await instance?.dispose(); instance = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await removeTempDir(root);
});
async function create(extra: Partial<AcpSupport> = {}) {
  instance = await createAcpDriver({ ...support, ...extra }).create({ instanceId: "r2-acp", displayName: "R2 ACP", enabled: true,
    environment: { HOME: root }, config: { cli: CLI, fullAuto: false } });
  return recordEvents(instance.adapter);
}
const mounted = (resumeCursor?: string) => fixtureMountTurn({ threadId: "r2-mounted", cwd: root, text: "hello", resumeCursor,
  warmIdentity: { botId: "r2-bot", audience: "owner", decidedOwner: true },
  integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
function sessions() { return wire.filter(row => ["session/new", "session/load"].includes(row.method)); }
function expectShims(rows = sessions()) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.params.mcpServers).toHaveLength(1);
    for (const server of row.params.mcpServers) {
      expect(server.args[0]).toMatch(/cli-mount-shim/);
      expect(server.args).not.toContain("process.stdin.resume()");
      expect(server.env).toContainEqual(expect.objectContaining({ name: "MURAGE_RELAY_TICKET" }));
    }
  }
}
describe("LASTRESORT §6.2, §7.5a and §7.6 mounted ACP", () => {
  it("T-R3-ACP-ABSENT-BINDING-REFUSED: raw mounts cannot bypass server admission", async () => {
    const records = await create();
    const spawn = vi.spyOn(procs, "spawnCli");
    await expect(instance!.adapter.sendTurn({ threadId: "r3-acp-absent", cwd: root, text: "hello",
      integrations: { custom: { notes: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } } }))
      .rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(spawn).not.toHaveBeenCalled();
    expect(records.events.filter(event => event.type === "turn.started")).toEqual([]);
  });

  it.each(["LOAD", "RETRY", "FALLBACK"])("T-ACP-RELAY-%s", async branch => {
    if (branch === "RETRY") vi.stubEnv("FAKE_ACP_LOAD_ERROR", JSON.stringify({ code: -32603, message: "fixture lock", data: { error_kind: "session_unavailable" } }));
    if (branch === "FALLBACK") vi.stubEnv("FAKE_ACP_LOAD_NULL", "1");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted("stored-session"));
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId, 20_000)).toMatchObject({ ok: true });
    expectShims();
    expect(sessions()[0].method).toBe("session/load");
    if (branch === "RETRY") expect(sessions().filter(row => row.method === "session/load").length).toBeGreaterThan(1);
    if (branch !== "LOAD") expect(sessions().at(-1).method).toBe("session/new");
  }, 30_000);
  it("T-ACP-READINESS-REFUSES", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(records.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: "I stopped this turn because some of its context is no longer available." }));
    const failedCheck = wire.findIndex(row => row.method === "_fuigo/mcp/list");
    expect(failedCheck).toBeGreaterThan(-1);
    expect(wire.slice(failedCheck + 1).filter(row => ["session/new", "session/load", "session/prompt"].includes(row.method))).toEqual([]);
    expectShims();
  });
  it.each(["unsupported", "all:error", "partial", "silent"])("native readiness needs positive complete proof (%s)", async state => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", state === "unsupported" || state === "silent" ? "" : state === "partial" ? "{}" : state);
    vi.stubEnv("FAKE_ACP_MCP_READY", state === "silent" ? "0" : "1");
    vi.stubEnv("MURAGE_ACP_MCP_READY_MS", "300");
    const records = await create({ mcpReadyNotification: "_fuigo/mcp_initialized" });
    const sent = await instance!.adapter.sendTurn(mounted());
    const done = await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    if (state === "unsupported") expect(done).toMatchObject({ ok: true });
    else {
      expect(done).toMatchObject({ ok: false, stopReason: "memory-refused" });
      expect(wire.filter(row => row.method === "session/prompt")).toEqual([]);
    }
    expect(await instance!.adapter.awaitTurnTeardown!("r2-mounted", sent.turnId)).toMatchObject({ closeConfirmed: true });
  });
  it("T-ACP-NO-MOUNTED-REUSE", async () => {
    const records = await create();
    for (let at = 0; at < 2; at++) {
      const sent = await instance!.adapter.sendTurn(mounted(at ? "fake-acp-session" : undefined));
      expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
      expect(await instance!.adapter.awaitTurnTeardown!("r2-mounted", sent.turnId)).toMatchObject({ closeConfirmed: true });
    }
    const pids = readFileSync(join(root, "pids"), "utf8").trim().split("\n");
    expect(new Set(pids).size).toBe(2);
    expectShims();
  });
  it.each([false, true])("a mounted resend waits for combined retirement and remains stoppable (stop=%s)", async stop => {
    const records = await create();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const original = ChatMcpDescendants.prototype.stop;
    vi.spyOn(ChatMcpDescendants.prototype, "stop").mockImplementationOnce(async function (this: ChatMcpDescendants) {
      const confirmed = await original.call(this);
      entered = true;
      await held;
      return confirmed;
    });
    try {
      const first = await instance!.adapter.sendTurn(mounted());
      expect(await records.until(e => e.type === "turn.completed" && e.turnId === first.turnId)).toMatchObject({ ok: true });
      await expect.poll(() => entered).toBe(true);
      const sending = instance!.adapter.sendTurn(mounted("fake-acp-session"));
      // Give the pending dispatch a turn of the event loop. No new engine
      // may start while even one old descendant confirmation is held.
      await new Promise(resolve => setImmediate(resolve));
      expect(readFileSync(join(root, "pids"), "utf8").trim().split("\n")).toHaveLength(1);
      if (stop) {
        const stopping = instance!.adapter.interruptTurn("r2-mounted");
        const cancelled = await sending;
        expect(await records.until(e => e.type === "turn.completed" && e.turnId === cancelled.turnId)).toMatchObject({ stopReason: "cancelled" });
        expect(readFileSync(join(root, "pids"), "utf8").trim().split("\n")).toHaveLength(1);
        release();
        await stopping;
      } else {
        release();
        const next = await sending;
        expect(await records.until(e => e.type === "turn.completed" && e.turnId === next.turnId)).toMatchObject({ ok: true });
        expect(await instance!.adapter.awaitTurnTeardown!("r2-mounted", next.turnId)).toMatchObject({ closeConfirmed: true });
        expect(new Set(readFileSync(join(root, "pids"), "utf8").trim().split("\n")).size).toBe(2);
      }
    } finally { release(); }
  });
  it("T-ACP-PREWARM-NO-MOUNT", async () => {
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
    expect(await instance!.adapter.awaitTurnTeardown!("r2-mounted", sent.turnId)).toMatchObject({ closeConfirmed: true });
    const before = readFileSync(join(root, "pids"), "utf8");
    const spawn = vi.spyOn(procs, "spawnCli");
    expect(await instance!.adapter.prewarm!("r2-mounted")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "pids"), "utf8")).toBe(before);
    expect(sessions()).toHaveLength(1);
    expect(existsSync(join(root, "rpc.jsonl"))).toBe(true);
  });
});

it("R1 ACP allocates every mount before the engine can spawn", async () => {
  const records = await create();
  const turn = mounted();
  const spawn = vi.spyOn(procs, "spawnCli");
  // One valid mount precedes an invalid one; allocation failure must not leave
  // either the tool child or the engine process running.
  turn.integrations!.memory = { command: "fixture", args: [42] as unknown as string[], env: {} };
  const outcome = await instance!.adapter.sendTurn(turn).then(async sent => {
    await records.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
    return "settled";
  }, () => "refused");
  expect(spawn.mock.calls.length).toBe(0);
  expect(outcome).toBe("refused");
});
