// C7 on the real ACP driver: a sign-in refusal emits runtime.error and turn.completed before sendTurn returns (core.ts sendTurn,
// authRefused). Each event goes, as it is emitted, through the shipped index.ts lease lookup and error card with the lease not yet
// handed its provider id. The engine line freezes on the lease, and a later MCP cause through the binding's ports logs after=engine once.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import { createLedgerLease } from "../../ledger-refusal.ts";
import { ownerEngineText, type TurnEnd } from "../../turn-end.ts";
import { ERROR_MESSAGE_MAX } from "../../../shared/provider-error.ts";
import { wiring } from "../../decision-wiring/fixture.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const SIGN_IN = "Sign in to this engine, then send your message again.";
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "Ready ACP", defaultCli: CLI, nativeSource: "ready.acp",
  models: { default: "", options: [] }, loginNote: SIGN_IN, spawnArgs: () => [],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => false, requireAuthenticationBeforeSpawn: true,
  pooledSessions: true, fluxReach: () => "elsewhere",
};
let root: string, instance: ProviderInstance | undefined;
beforeEach(() => { resetAcpMcpReadinessForTests(); ensureDirs(); chmodSync(CLI, 0o755); root = mkdtempSync(join(tmpdir(), "c7-acp-")); vi.stubEnv("MURAGE_ACP_POOL", "1"); });
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); await removeTempDir(root); });

function rig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "ready-bot", threadId: "ready-owner", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  const admittedLedgerLeases = new Map([["G", lease]]);
  const admission = {}, source = { admission, attachment: "A" }, sources = new WeakMap<object, typeof source>();
  const index = wiring(["runtimeErrorCardName", "admittedLeaseForEvent", "admittedTurnEndPorts", "terminalDispatchFor"], { ownerEngineText, ERROR_MESSAGE_MAX, admittedLedgerLeases,
    bus: { sourceForExecution: (event: object) => sources.get(event) }, ledgerLeasesByAdmission: new Map([[admission, lease]]),
    ledgerCompletionSources: new Map([[lease, source]]), ledgerProviderInstances: new Map([[lease, "ready-acp"]]) });
  const ports = index.admittedTurnEndPorts!("G"); // bound before dispatch, as index.ts does
  const cards: string[] = [], seen: Array<{ type: string; handedBack: boolean; attached: string | undefined }> = [];
  let handedBack = false;
  /** The bus stamps the instance and records the admission source per execution event; the fold then runs the two index steps. */
  const fold = (raw: RuntimeEvent) => {
    const event = { ...raw, providerInstanceId: "ready-acp" } as RuntimeEvent; sources.set(event, source);
    const found = index.admittedLeaseForEvent!(event);
    seen.push({ type: event.type, handedBack, attached: lease.providerTurnId });
    if (event.type === "runtime.error") cards.push(index.runtimeErrorCardName!((event as { message: string }).message, found.lease));
  };
  return { lease, admittedLedgerLeases, settled, presented, ports, cards, seen, fold, handBack: () => { handedBack = true; } };
}

describe("C7 on the real ACP driver: error and completion before sendTurn returns", () => {
  it("the card shows the engine line, the lease freezes on it before handback, the late MCP cause is logged once after=engine, nothing else is shown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createAcpDriver(support).create({ instanceId: "ready-acp", displayName: "Ready ACP", enabled: true, environment: { HOME: root }, config: { cli: CLI, fullAuto: false } });
    const r = rig();
    const off = instance.adapter.onEvent(event => r.fold(event));
    const sent = await instance.adapter.sendTurn({ threadId: "ready-owner", cwd: root, text: "hello", warmIdentity: { botId: "ready-bot", audience: "owner", decidedOwner: true } } as never);
    r.handBack(); off();
    r.lease.attach(sent.turnId); // index.ts attaches the returned id: the same id, accepted
    expect({ seen: r.seen, cards: r.cards, frozen: r.lease.state, end: r.lease.end(), admitted: r.admittedLedgerLeases.size, verdict: r.lease.verdict }).toEqual({
      seen: [{ type: "turn.started", handedBack: false, attached: sent.turnId }, { type: "runtime.error", handedBack: false, attached: sent.turnId }, { type: "turn.completed", handedBack: false, attached: sent.turnId }],
      cards: [`error: ${SIGN_IN}`], frozen: "settled", end: { kind: "engine", line: SIGN_IN }, admitted: 0, verdict: undefined,
    });
    r.ports.noteCause("mcp-not-ready");
    r.ports.noteCause("mcp-not-ready");
    expect({ late: warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause")), settled: r.settled, presented: r.presented, end: r.ports.turnEnd() })
      .toEqual({ late: [["[turn] late-cause=mcp-not-ready after=engine"]], settled: [], presented: [], end: { kind: "engine", line: SIGN_IN } });
  });
});
