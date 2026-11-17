// C7: an ACP engine callback (spawn error or close) against Cloud relay creation. Every ordering is pinned by a parked await
// (setRelayHookForTest), never by a delay. Outcome per ordering is asserted through the real createLedgerLease and the real
// CliMountRelay.create / planMcpSpawn throw, so the owner reads exactly one sentence and the MCP cause is never silently dropped.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { fixtureMountTurn } from "../../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import { CliMountRelay, setRelayHookForTest, type RelayHookPhase } from "../cli-mount-relay.ts";
import { createLedgerLease } from "../../ledger-refusal.ts";
import { emitterRefusalLine, MCP_CLOUD_UNAVAILABLE_TEXT, storedRefusalLine, type TurnEnd } from "../../turn-end.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "Race ACP", defaultCli: CLI, nativeSource: "race.acp",
  models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
  pooledSessions: true, mcpListMethod: "_fuigo/mcp/list", fluxReach: () => "elsewhere",
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
let root: string, instance: ProviderInstance | undefined, records: EventRecorder | undefined;
beforeEach(() => {
  resetAcpMcpReadinessForTests(); ensureDirs(); chmodSync(CLI, 0o755);
  root = mkdtempSync(join(tmpdir(), "race-acp-"));
  vi.stubEnv("MURAGE_ACP_POOL", "1"); vi.stubEnv("FAKE_ACP_MCP_LIST", "all:ready");
  vi.stubEnv("FAKE_ACP_SPAWN_LOG", join(root, "pids"));
});
afterEach(async () => {
  setRelayHookForTest(undefined); records?.stop(); records = undefined;
  await instance?.dispose(); instance = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await removeTempDir(root);
});

type Order = "before" | "during" | "after";
type Path = "close" | "error";
const PARK: Record<Order, RelayHookPhase | null> = { before: "entry", during: "listened", after: null };
async function run(order: Order, path: Path, options: { revoke?: boolean } = {}) {
  const missing = join(root, "missing-engine");
  const cli = path === "error" ? missing : CLI;
  instance = await createAcpDriver({ ...support, defaultCli: cli }).create({ instanceId: "race-acp", displayName: "Race ACP", enabled: true,
    environment: { HOME: root }, config: { cli, fullAuto: false } });
  records = recordEvents(instance.adapter);
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "race-bot", threadId: "race-owner", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  const control: { replace?: () => void } = {};
  const turn = fixtureMountTurn({ threadId: "race-owner", cwd: root, text: "hello", warmIdentity: { botId: "race-bot", audience: "owner", decidedOwner: true },
    integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } }, verdict => lease.onLedgerRefused(verdict), lease, control);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let created: Promise<unknown> | undefined;
  const real = CliMountRelay.create.bind(CliMountRelay);
  const trace: { atEntry?: boolean; atSettle?: boolean } = {};
  const engineErrors = () => records!.events.some(e => e.type === "runtime.error");
  vi.spyOn(CliMountRelay, "create").mockImplementation((...args) => {
    trace.atEntry = engineErrors();
    created = real(...args);
    void created.then(() => { trace.atSettle = engineErrors(); }, () => { trace.atSettle = engineErrors(); });
    return created as ReturnType<typeof real>;
  });
  const parked = deferred(), go = deferred();
  setRelayHookForTest(async phase => {
    if (phase === PARK[order]) { parked.resolve(); await go.promise; }
    // The Cloud role is switched on only once the socket exists, so the real planMcpSpawn refuses and the socket setup stays the desktop one.
    if (phase === "listened") vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  });
  const sent = await instance.adapter.sendTurn(turn);
  const facts: { engineLine?: string; frozen?: string; admits?: boolean } = {};
  if (order !== "after") {
    await parked.promise;
    if (path === "close") {
      await vi.waitFor(() => expect(readFileSync(join(root, "pids"), "utf8").trim()).not.toBe(""));
      process.kill(Number(readFileSync(join(root, "pids"), "utf8").trim().split("\n").pop()), "SIGKILL");
    }
    const callback = await records.until(e => e.type === "runtime.error" && e.turnId === sent.turnId) as { message: string };
    facts.engineLine = callback.message;
    facts.frozen = lease.frozenEnd?.kind;
    if (options.revoke) control.replace!();
    facts.admits = turn.releaseBinding!.isCurrent();
    go.resolve();
  }
  // A spawn error landing before relay creation settles the turn first and create is never entered: the trace assertion reports it.
  const failure = created ? await created.then(() => undefined, caught => caught as { code?: string; message?: string }) : undefined;
  await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
  await instance.adapter.awaitTurnTeardown!("race-owner", sent.turnId);
  const owner = records.events.filter(e => e.type === "runtime.error").map(e => (e as { message?: string }).message);
  const late = warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[turn] late-cause="));
  return { facts, failure, owner, late, lease, settled, presented, turn, trace };
}

describe("C7 ACP engine callback against Cloud relay creation", () => {
  describe.each([["close"], ["error"]] as const)("%s callback", path => {
    it.each([["before"], ["during"]] as const)(`%s relay creation: the engine line stands as the one sentence, the MCP cause is a late cause`, async order => {
      const r = await run(order, path);
      // The callback froze the cell before the relay resumed; admission still held, so the Cloud refusal reached planMcpSpawn.
      expect(r.facts).toMatchObject({ frozen: "engine", admits: true });
      expect(r.failure?.code).toBe("MCP_CLOUD_SCOPE_UNAVAILABLE");
      expect(r.owner).toEqual([r.facts.engineLine]);
      expect(r.owner[0]).not.toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
      expect(r.late).toEqual(["[turn] late-cause=mcp-cloud-unavailable after=engine"]);
      expect(r.lease.end()).toEqual({ kind: "engine", line: r.facts.engineLine });
      expect({ settled: r.settled, presented: r.presented }).toEqual({ settled: [], presented: [] });
    });
    it("during relay creation, admission revoked after the callback: :281 rejects, MCP is never noted, the owner still reads only the engine line", async () => {
      const r = await run("during", path, { revoke: true });
      expect(r.facts).toMatchObject({ frozen: "engine", admits: false });
      expect(r.failure?.code).toBe("MEMORY_CONTEXT_REVOKED");
      expect(r.owner).toEqual([r.facts.engineLine]);
      expect(r.late).toEqual([]);
      const ends = [...r.settled, ...r.presented];
      expect(ends).toHaveLength(2);
      for (const end of ends) { expect(end).toEqual({ kind: "engine", line: r.facts.engineLine }); expect(storedRefusalLine(end)).toBeUndefined(); }
      expect(emitterRefusalLine(r.turn.releaseBinding)).toBeUndefined();
    });
  });
  it("spawn error, nothing parked: the error is emitted after CliMountRelay.create is entered and before it settles, so AFTER is not reachable for a spawn error", async () => {
    const r = await run("after", "error");
    // The spawn error event is delivered while the relay is still listening, never after create has settled.
    expect(r.trace).toEqual({ atEntry: false, atSettle: true });
    expect(r.failure?.code).toBe("MCP_CLOUD_SCOPE_UNAVAILABLE");
    expect(r.owner).toHaveLength(1);
    expect(r.owner[0]).not.toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    expect(r.late).toEqual(["[turn] late-cause=mcp-cloud-unavailable after=engine"]);
    expect(r.lease.end()).toEqual({ kind: "engine", line: r.owner[0] });
  });
  it("after relay creation (close callback follows the Cloud refusal): the Cloud sentence is the one sentence and the late close adds nothing", async () => {
    const r = await run("after", "close");
    expect(r.failure?.code).toBe("MCP_CLOUD_SCOPE_UNAVAILABLE");
    expect(r.owner).toEqual([MCP_CLOUD_UNAVAILABLE_TEXT]);
    expect(r.late).toEqual([]);
    expect(r.lease.end()).toEqual({ kind: "mcp-cloud", line: MCP_CLOUD_UNAVAILABLE_TEXT });
  });
});
