// q1022-channels item 2: after a Signal deletion is redacted, idle ticks (1 s) and the 60 s sweep start no checkpoint worker, copy no
// ledger state and cancel no run again, for the 7 days the tombstone is kept. Real SignalService ticks over a real delivery-ledger.db;
// checkpointFile is wrapped only to count the workers it starts (it still runs). Fixture copied from service.test.ts.
const folds = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../sqlite-file-checkpoint.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../sqlite-file-checkpoint.ts")>();
  return { ...actual, checkpointFile: (...args: Parameters<typeof actual.checkpointFile>) => { folds.n++; return actual.checkpointFile(...args); } };
});
import childProcess from "node:child_process";
import { windowsSecuritySessionDebug } from './windows-security-session.ts';
import { syncBuiltinESMExports } from "node:module";
import { signalPrivateWriter } from "./private-writer.ts";
import { privateParkTemp, parkProtocolOptions, protectParkFixtureTree, parkFixtureMkdir as mkdirSync, parkFixtureWrite as writeFileSync } from "../../testing/signal-park-fixture.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { putState, rawText, stored } from "../delivery-ledger-test-support.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DurableDelivery } from "../durable-delivery.ts";
import { SignalService, signalDeliveryId, type SignalServiceOptions } from "./service.ts";
import { SignalTransport } from "./transport.ts";
import { wipeSignalData } from "./wipe.ts";
import type { HostEvent, HostNotification } from "./process-host.ts";
import type { SignalBinding, SignalEvent, RpcRequest } from "./types.ts";

const ACI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", NOW = 1_800_000_000_000, WEEK = 7 * 86400000;
const roots: string[] = [], services: SignalService[] = [];
// Opt-in native qualification evidence, including fixture/tool spawns. Enabled
// on the Windows lane with SIGNAL_SPAWN_TRACE=1; assertions stay intact.
let spawnTrace: { children:number; powershell:number; icacls:number; whoami:number } | undefined;
let writerTrace = { childProcesses:0, protectionBatches:0 };
let restoreSpawnTrace: (()=>void) | undefined;
let sessionTrace=windowsSecuritySessionDebug();
beforeEach(()=>{
  sessionTrace=windowsSecuritySessionDebug();
  writerTrace={...signalPrivateWriter.debug};
  if(process.env.SIGNAL_SPAWN_TRACE!=='1')return;
  spawnTrace={children:0,powershell:0,icacls:0,whoami:0};
  const original=childProcess.execFileSync;
  childProcess.execFileSync=((file:string,...args:unknown[])=>{
    spawnTrace!.children++;if(/powershell[.]exe$/i.test(file))spawnTrace!.powershell++;
    if(/icacls[.]exe$/i.test(file))spawnTrace!.icacls++;if(/whoami[.]exe$/i.test(file))spawnTrace!.whoami++;
    return Reflect.apply(original,childProcess,[file,...args]);
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  restoreSpawnTrace=()=>{childProcess.execFileSync=original;syncBuiltinESMExports();};
});
afterEach(context=>{
  restoreSpawnTrace?.();restoreSpawnTrace=undefined;
  const after=windowsSecuritySessionDebug(),resident=after.spawns-sessionTrace.spawns;
  if(spawnTrace)console.error('SIGNAL_SPAWN_TRACE '+JSON.stringify({test:context.task.name,...spawnTrace,
    children:spawnTrace.children+resident,powershell:spawnTrace.powershell+resident,securityRequests:after.requests-sessionTrace.requests,
    writerChildren:signalPrivateWriter.debug.childProcesses-writerTrace.childProcesses,
    writerBatches:signalPrivateWriter.debug.protectionBatches-writerTrace.protectionBatches}));
  spawnTrace=undefined;
});
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); roots.splice(0).forEach(root => removeTempDirSync(root)); vi.restoreAllMocks(); });
function put(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
function fixture(existing?: string) {
  const root = existing ?? privateParkTemp(join(tmpdir(), "signal-service-")); if (!existing) roots.push(root);
  let now = NOW, token = Symbol("spawn"), generation = 1, identity = { ownAci: ACI, ownDeviceId: 2, number: "+15550001234" };
  let listener: ((frame: HostNotification) => void) | undefined, event: ((event: HostEvent) => void) | undefined;
  const binding: SignalBinding = { connectionId: "one", generation: 1, ownAci: ACI, ownDeviceId: 2, linkedAt: NOW - WEEK * 2, chiefBotId: "chief" };
  const record = join(root, "channels/signal/connection.json"), ledgerFile = join(root, "channels/signal/one/receipts.json"), journal = join(root, "signal/ingress/one.ndjson");
  if (!existing) put(record, { version: 1, connectionId: "one", generation: 1, enabled: true, paused: false, revoking: false, binding, account: identity.number });
  const calls: string[] = [], turns: string[] = [], sent: string[] = [];
  let result: { status: string; output?: string } | null = { status: "completed", output: "answer" };
  let failSend = false, failWipe = false;
  const host = {
    get generation() { return generation; }, get spawnToken() { return token; }, get identity() { return identity; },
    spawn: vi.fn(async (input: { generation: number; account: string | null }) => { calls.push("spawn"); generation = input.generation; token = Symbol("spawn"); event?.({ kind: "ready", generation, spawnToken: token, identity: input.account ? identity : null }); }),
    stop: vi.fn(async () => { calls.push("stop"); }),
    request: vi.fn(async (request: RpcRequest, options: { beforeWrite?: () => boolean; spawnToken?: symbol }) => {
      if (options.spawnToken !== token || options.beforeWrite?.() === false) throw Object.assign(new Error(), { code: "offline" });
      calls.push(request.method);
      if (request.method === "send") {
        sent.push((request.params as { message: string }).message);
        return failSend ? { jsonrpc: "2.0", id: request.id, error: { code: -5, message: "private", data: { response: { timestamp: now, results: [{ recipientAddress: { uuid: ACI, number: null }, type: "RATE_LIMIT_FAILURE" }] } } } }
          : { jsonrpc: "2.0", id: request.id, result: { timestamp: now, results: [{ recipientAddress: { uuid: ACI, number: null }, type: "SUCCESS" }] } };
      }
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }),
    onNotification: (fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; },
    pauseReading: vi.fn(), resumeReading: vi.fn(),
  };
  // The fake storage guard owns only disposable fixture data. Protect files
  // made by the fake service/host, just as the real guard protects fresh logs.
  const readyStorage = async () => { protectParkFixtureTree(root); return { state: "ok" as const }; };
  const storage = { check: vi.fn(readyStorage), repair: vi.fn(readyStorage) };
  const options: SignalServiceOptions = {
    dataDir: root, park:{...parkProtocolOptions,fence:{lease:()=>"fixture-lease",discover:()=>true,host:()=>"fixture",boot:()=>"boot",uptime:()=>1}}, now: () => now, channelsOpen: () => true, isCloudHome: () => false, isCurrentChief: () => true,
    storage: () => storage,
    host: context => { event = context.onEvent; return host as ReturnType<SignalServiceOptions["host"]>; },
    transport: context => new SignalTransport({ file: join(root, "channels/signal", context.binding.connectionId, "outbox.json"),
      connectionId: context.binding.connectionId, ownAci: context.binding.ownAci, generation: context.binding.generation, host: context.host,
      isCurrent: context.isCurrent, timestampSupported: false, pin: { signalCliVersion: "fixture", rateLimitNotSentProof: null }, liveVersion: () => "fixture", now: () => now, log: () => {} }),
    // Synthetic normalized events exercise B7 only; these are not G0 wire fixtures.
    access: { parse: raw => raw as SignalEvent, decide: (e, c) => e.sourceAci === c.binding.ownAci && e.sourceDevice !== c.binding.ownDeviceId ? "accept" : "drop",
      control: (e, c) => e.sourceAci === c.binding.ownAci && e.sourceDevice !== c.binding.ownDeviceId },
    runs: context => { expect(context.notOwnerAudience).toBe(false); expect(context.channelOrigin.platform).toBe("signal"); return {
      enqueue: ({ deliveryId }) => { turns.push(deliveryId); return { id: `run-${deliveryId}` }; }, result: () => result,
    }; },
    people: { linkOwner: vi.fn(async () => { calls.push("owner"); }), revoke: vi.fn(async () => { calls.push("revoke-human"); }) },
    revokeRuns: vi.fn(async () => { calls.push("revoke-runs"); }),
    wipeData: async (id, scope) => { calls.push(`wipe-${scope}`); if (failWipe) throw new Error("wipe"); await wipeSignalData(root, id, scope); },
  };
  function make() { protectParkFixtureTree(root); const service = new SignalService(options); services.push(service); return service; }
  function emit(i = 0, changes: Partial<SignalEvent> = {}, captured = { generation, spawnToken: token }) {
    const note = { sourceAci: ACI, sourceDevice: 3, destinationAci: ACI, envelopeDestination: null, timestamp: now + i,
      group: false, expiresInSeconds: null, longText: false, variant: "sync-sent", body: `note ${i}`, control: null, ...changes } as SignalEvent;
    listener?.({ ...captured, notification: { jsonrpc: "2.0", method: "receive", params: note } }); return note;
  }
  return { root, record, ledgerFile, journal, options, host, storage, calls, turns, sent, binding, make, emit,
    setTime: (n: number) => { now = n; }, advance: (ms: number) => { now += ms; }, setResult: (r: typeof result) => { result = r; },
    setIdentity: (i: typeof identity) => { identity = i; }, failSend: (yes: boolean) => { failSend = yes; }, failWipe: (yes: boolean) => { failWipe = yes; },
    capture: () => ({ generation, spawnToken: token }), event: (e: HostEvent) => event?.(e),
  };
}
const state = (f: ReturnType<typeof fixture>) => stored(f.ledgerFile);
/** The committed ledger text; never empty, so a "does not contain" check cannot pass on a missing ledger. */
const ledgerText = (f: ReturnType<typeof fixture>) => { const text = rawText(f.ledgerFile); expect(text).not.toBe(""); return text; };
function seed(f: ReturnType<typeof fixture>, records: unknown[] = [], tombstones: unknown[] = []) {
  mkdirSync(dirname(f.ledgerFile), { recursive: true, mode: 0o700 });
  putState(f.ledgerFile, { version: 1, bindingKey: "one", recipient: `note-to-self:${createHash("sha256").update(ACI).digest("hex")}`, records, tombstones });
}
const receipt = (deliveryId: string, extra = {}) => ({ deliveryId, occurredAt: NOW, prompt: "private prompt", response: "answer", attempts: 1, state: "uncertain", expiryKnown: true, ...extra });

test.each([false, true])("an already redacted deletion costs nothing on idle ticks or the 60 s sweep (runs cancelled once, states unchanged; expired=%s)", async expired => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW);
  seed(f, [receipt(id, { state: "queued", runId: "exact-run", response: undefined }), receipt(signalDeliveryId(ACI, NOW + 5), { state: "uncertain" })]);
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "secret marker", state: "forwarded", ...(expired ? { expiresAt: NOW - 1 } : {}) }) + "\n");
  // plus a deletion of a note the ledger never held (its redact finds nothing, so nothing is remembered for it)
  const never = signalDeliveryId(ACI, NOW + 9);
  put(join(f.root, "signal/ingress/one.tombstones.json"), [...(expired ? [] : [{ key: id, timestamp: NOW, deletedAt: NOW }]), { key: never, timestamp: NOW + 9, deletedAt: NOW }]);
  const service = f.make(); await service.start(); await service.tick();
  expect(f.options.revokeRuns).toHaveBeenCalledWith("one", ["exact-run"]);
  expect(state(f).records.find((r: { deliveryId: string }) => r.deliveryId === id)).toMatchObject({ state: "cancelled", error: "redacted", prompt: "" });
  // let the commit's own fold finish, so only what the idle passes start is counted
  const ledger = (service as unknown as { ledger: DurableDelivery }).ledger;
  await ledger.sweepPages();
  await vi.waitFor(() => expect(ledger.maintenancePending).toBe(false));
  const before = ledgerText(f), revokes = vi.mocked(f.options.revokeRuns).mock.calls.length;
  const clone = vi.spyOn(globalThis, "structuredClone");
  folds.n = 0;
  for (let i = 0; i < 10; i++) { f.advance(1000); await service.tick(); }
  f.advance(61_000); await service.tick();
  await vi.waitFor(() => expect(ledger.maintenancePending).toBe(false));
  const idle = { folds: folds.n, clones: clone.mock.calls.length, revokes: vi.mocked(f.options.revokeRuns).mock.calls.length - revokes };
  expect(idle).toEqual({ folds: 0, clones: 0, revokes: 0 });
  // WhatsApp/Signal delivery states unchanged end to end: the redacted receipt and the other receipt read back exactly as before
  expect(ledgerText(f)).toBe(before);
  expect(readFileSync(f.journal, "utf8")).not.toContain("secret marker");
  expect(service.status().state).toBe("linked");
});
