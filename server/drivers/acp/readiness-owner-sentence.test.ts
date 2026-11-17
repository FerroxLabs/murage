import { chmodSync, mkdtempSync } from "node:fs";
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
import { consumingFixture } from "../../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { threadHumanPrincipal } from "../../human-principals.ts";
import { internalDispatchAuthorityFixture } from "../../testing/internal-dispatch-fixture.ts";
import { clearInternalAuthorityFixtures } from "../../testing/internal-authority-fixture.ts";
import { buildPreListenIndexes } from "../../memory/optional-index.ts";
import { checkedOpenTurns } from "../../memory/lineage-write.ts";
import { buildPrompt, promptPart, noneRef } from "../../memory/prompt-parts.ts";
import { createLedgerLease } from "../../ledger-refusal.ts";
import { fixtureProviderRegistry } from "../../testing/index-ports.ts";
import { LEDGER_REFUSAL_LINE, MCP_NOT_READY_TEXT, type TurnEnd } from "../../turn-end.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "Ready ACP", defaultCli: CLI, nativeSource: "ready.acp",
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
  root = mkdtempSync(join(tmpdir(), "ready-acp-"));
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
  instance = await createAcpDriver({ ...support, ...extra }).create({ instanceId: "ready-acp", displayName: "Ready ACP", enabled: true,
    environment: { HOME: root }, config: { cli: CLI, fullAuto: false } });
  return recordEvents(instance.adapter);
}
const mounted = (lease: ReturnType<typeof createLedgerLease>, resumeCursor?: string) => fixtureMountTurn({ threadId: "ready-owner", cwd: root, text: "hello", resumeCursor,
  warmIdentity: { botId: "ready-bot", audience: "owner", decidedOwner: true },
  integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } }, verdict => lease.onLedgerRefused(verdict), lease);
function leaseRig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "ready-bot", threadId: "ready-owner", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  return { lease, settled, presented };
}
const N = { kind: "mcp-not-ready", line: MCP_NOT_READY_TEXT };
describe("ACP readiness refusals tell the owner the add-on tool did not start", () => {
  it("not ready: the lease settles and presents the not-ready sentence, and the driver's own line is the same", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    const records = await create(); const rig = leaseRig();
    const sent = await instance!.adapter.sendTurn(mounted(rig.lease));
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(wire.some(row => row.method === "_fuigo/mcp/list")).toBe(true);
    expect(wire.filter(row => row.method === "session/prompt")).toEqual([]);
    expect(records.events.filter(e => e.type === "runtime.error").map(e => (e as { message?: string }).message)).toEqual([MCP_NOT_READY_TEXT]);
    expect({ settled: rig.settled, presented: rig.presented }).toEqual({ settled: [N], presented: [N] });
  });
  it("timeout: same sentence, readiness unknown", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", ""); vi.stubEnv("FAKE_ACP_MCP_READY", "0"); vi.stubEnv("MURAGE_ACP_MCP_READY_MS", "300");
    const records = await create({ mcpReadyNotification: "_fuigo/mcp_initialized" }); const rig = leaseRig();
    const sent = await instance!.adapter.sendTurn(mounted(rig.lease));
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused", mcpReadiness: "unknown" });
    expect(wire.filter(row => row.method === "session/prompt")).toEqual([]);
    expect(records.events.filter(e => e.type === "runtime.error").map(e => (e as { message?: string }).message)).toEqual([MCP_NOT_READY_TEXT]);
    expect({ settled: rig.settled, presented: rig.presented }).toEqual({ settled: [N], presented: [N] });
  });
  it("late cause: a ledger refusal settled first keeps its line; the readiness failure is logged once and the local catch adds no second line", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    const warn = vi.spyOn(console, "warn");
    const records = await create(); const rig = leaseRig();
    rig.lease.onLedgerRefused({ state: "checking", reason: "not-built" });
    const sent = await instance!.adapter.sendTurn(mounted(rig.lease));
    expect(await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    const L = { kind: "ledger", line: LEDGER_REFUSAL_LINE };
    expect({
      prompts: wire.filter(row => row.method === "session/prompt"),
      stream: records.events.filter(e => e.type === "runtime.error").map(e => (e as { message?: string }).message),
      settled: rig.settled, presented: rig.presented,
      late: warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause")),
    }).toEqual({ prompts: [], stream: [LEDGER_REFUSAL_LINE], settled: [L], presented: [L], late: [["[turn] late-cause=mcp-not-ready after=ledger"]] });
  });
});

describe("registry marker: the turn runs through the real registry's decorated instance built from the fixture config", () => {
  it("one live instance from the fixture config, a decorated adapter, and exactly one raw sendTurn for this thread and turn", async () => {
    const config = { driver: "fuigoAgent", displayName: "Ready ACP", enabled: true, environment: { HOME: root }, config: { cli: CLI, fullAuto: false } };
    const driver = createAcpDriver(support);
    let raw: ProviderInstance | undefined;
    const create = driver.create.bind(driver);
    const registry = await fixtureProviderRegistry({ ...driver, create: async (input: Parameters<typeof driver.create>[0]) => (raw = await create(input)) } as never, { "ready-acp": config as never });
    const live = registry.get("ready-acp");
    const entry = registry.entries().find(e => e.instanceId === "ready-acp");
    expect({ live: live !== null, same: registry.get("ready-acp") === live, id: live?.instanceId, builtFrom: entry?.builtFrom, decorated: live?.adapter !== raw?.adapter, rawBuilt: raw !== undefined })
      .toEqual({ live: true, same: true, id: "ready-acp", builtFrom: config, decorated: true, rawBuilt: true });
    const rawSend = vi.spyOn(raw!.adapter, "sendTurn");
    const records = recordEvents(live!.adapter); const rig = leaseRig();
    const sent = await live!.adapter.sendTurn(mounted(rig.lease));
    await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    const calls = rawSend.mock.calls.map(([input]) => ({ thread: input.threadId, binding: input.releaseBinding !== undefined }));
    expect({ calls, turn: (await rawSend.mock.results[0]!.value).turnId }).toEqual({ calls: [{ thread: "ready-owner", binding: true }], turn: sent.turnId });
  });
});

// Fixture owner: sol-mcpmsgreg2. Registry, dispatch, admission and fold policy: index.ts and the ACP driver.
it("registry readiness through index dispatch retains the execution admission before provider handback", async () => {
  vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
  let admitted: ReturnType<typeof createLedgerLease> | undefined;
  const f = consumingFixture({ audience: null }, { empty: true, internalSchema: true, botId: "ready-bot", threadId: "ready-owner", onRefused: verdict => admitted?.onLedgerRefused(verdict) });
  try {
    buildPreListenIndexes(f.f.db, { log: false });
    const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
    const capabilities = new InternalCapabilities();
    capabilities.begin(botId, threadId, generation, threadHumanPrincipal(threadId, f.f.db));
    const config = { driver: "fuigoAgent", displayName: "Ready ACP", enabled: true, environment: { HOME: root }, config: { cli: CLI, fullAuto: false } };
    let raw: ProviderInstance | undefined;
    const driver = createAcpDriver(support), createRaw = driver.create.bind(driver);
    const setup = await internalDispatchAuthorityFixture(f, capabilities, {
      provider: { driver: { ...driver, create: async (input: Parameters<typeof driver.create>[0]) => (raw = await createRaw(input)) } as never, configs: { "ready-acp": config as never } },
      settings: { modelSelection: { instanceId: "ready-acp", model: "" } },
    });
    await setup.dispatchAuthoritySetup.run(async () => {
      setup.store.checkpointTurnState();
      const bound = await setup.dispatchAuthoritySetup.bind("async () => ({ registry, bus, admitLedgerLease, foldRuntimeEvent, sendProjectUsageTurn })", {});
      const index = await bound.dispatch() as any;
      const live = index.registry.get("ready-acp") as ProviderInstance;
      expect({ builtFrom: index.registry.entries()[0].builtFrom, decorated: live.adapter !== raw!.adapter }).toEqual({ builtFrom: config, decorated: true });
      const rawSend = vi.spyOn(raw!.adapter, "sendTurn");
      const records = recordEvents(live.adapter);
      index.bus.attach(index.registry.instances());
      const lease = index.admitLedgerLease(botId, threadId, generation, f.turn, live, { seal() {} }) as ReturnType<typeof createLedgerLease>;
      admitted = lease;
      const reader = checkedOpenTurns(f.turn)[0]!.reader!;
      expect(lease.providerTurnId).toBeUndefined();
      const seen: Array<{ type: string; attached?: string; handedBack: boolean }> = [];
      const foldErrors: unknown[] = [];
      let handedBack = false;
      const off = index.bus.subscribeExecution((event: import("../../contracts.ts").RuntimeEvent) => {
        try { index.foldRuntimeEvent(event); } catch (error) { foldErrors.push(error); }
        seen.push({ type: event.type, attached: lease.providerTurnId, handedBack });
      });
      try {
        const prompt = buildPrompt(f.turn, [promptPart("hello", [noneRef("owner-turn")])]);
        const sent = await index.sendProjectUsageTurn(live, { threadId, cwd: root, prompt, system: "Fixture persona", integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } },
          recall: "off", recallPrepared: { system: "Fixture persona", integrations: ["agents"], historyPrepared: false, resumed: false } }, { reader, retained: f.turn });
        handedBack = true;
        expect(await records.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
        expect(seen.find(event => event.type === "turn.started")).toEqual({ type: "turn.started", attached: sent.turnId, handedBack: false });
        expect(foldErrors).toEqual([]);
        expect(lease.end()).toEqual({ kind: "mcp-not-ready", line: MCP_NOT_READY_TEXT });
        expect(wire.some(row => row.method === "_fuigo/mcp/list")).toBe(true);
        expect(wire.filter(row => row.method === "session/prompt")).toEqual([]);
        expect(rawSend.mock.calls.map(([input]) => ({ threadId: input.threadId, bound: input.releaseBinding !== undefined }))).toEqual([{ threadId, bound: true }]);
        expect(setup.store.activePath(threadId).filter(row => row.role === "bot" && row.kind === "text").map(row => row.text)).toEqual([MCP_NOT_READY_TEXT]);
      } finally { off(); }
    });
  } finally { await clearInternalAuthorityFixtures(); f.close(); }
});
