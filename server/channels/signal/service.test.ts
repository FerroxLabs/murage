import { removeTempDirSync } from "../../testing/cleanup.ts";
import { randomUUID } from "node:crypto";
import { parkSignalForDowngrade,recoverSignalPark } from "./park.ts";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { SignalProcessHost } from "./process-host.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import * as atomic from "../../atomic.ts";
import { DurableDelivery } from "../durable-delivery.ts";
import { SignalService, signalDeliveryId, type SignalServiceOptions } from "./service.ts";
import { SignalTransport } from "./transport.ts";
import { wipeSignalData } from "./wipe.ts";
import { createSignalStorageGuard } from "./storage.ts";
import type { HostEvent, HostNotification } from "./process-host.ts";
import type { SignalBinding, SignalEvent, RpcRequest } from "./types.ts";

const ACI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", NOW = 1_800_000_000_000, WEEK = 7 * 86400000;
const roots: string[] = [], services: SignalService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); roots.splice(0).forEach(root => removeTempDirSync(root)); vi.restoreAllMocks(); });
function put(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(existing?: string) {
  const root = existing ?? mkdtempSync(join(tmpdir(), "signal-service-")); if (!existing) roots.push(root);
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
  const storage = { check: vi.fn(async () => ({ state: "ok" as const })), repair: vi.fn(async () => ({ state: "ok" as const })) };
  const options: SignalServiceOptions = {
    dataDir: root, park:{fence:{lease:()=>"fixture-lease",discover:()=>true,host:()=>"fixture",boot:()=>"boot",uptime:()=>1}}, now: () => now, channelsOpen: () => true, isCloudHome: () => false, isCurrentChief: () => true,
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
  function make() { const service = new SignalService(options); services.push(service); return service; }
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
const state = (f: ReturnType<typeof fixture>) => JSON.parse(readFileSync(f.ledgerFile, "utf8"));
function seed(f: ReturnType<typeof fixture>, records: unknown[] = [], tombstones: unknown[] = []) {
  put(f.ledgerFile, { version: 1, bindingKey: "one", recipient: `note-to-self:${createHash("sha256").update(ACI).digest("hex")}`, records, tombstones });
}
const receipt = (deliveryId: string, extra = {}) => ({ deliveryId, occurredAt: NOW, prompt: "private prompt", response: "answer", attempts: 1, state: "uncertain", expiryKnown: true, ...extra });

test("T-STUCK: 250 journaled notes drain in order; 20 review records plus 190 notes use admissionCapacity (mutant: pending count)", async () => {
  for (const held of [0, 20]) {
    const f = fixture(); seed(f, Array.from({ length: held }, (_, i) => receipt(`held-${i}`)));
    const service = f.make(); await service.start();
    const count = held ? 190 : 250; const ids = Array.from({ length: count }, (_, i) => signalDeliveryId(ACI, f.emit(i).timestamp));
    await service.tick(); await service.tick(); await service.tick();
    expect(f.turns).toEqual(ids); expect(f.sent).toHaveLength(count); expect(service.status().state).toBe("linked");
    expect(readFileSync(f.journal, "utf8").split('\n').filter(Boolean)).toHaveLength(count);
  }
}, 60000);

test("T-STUCK: a full tombstone window holds rows without errors and resumes after expiry (mutant: accept at capacity)", async () => {
  for (const full of [false, true]) {
    const f = fixture(); seed(f, [], full ? Array.from({ length: 10000 }, (_, i) => ({ deliveryId: `old-${i}`, occurredAt: NOW - WEEK + 100 })) : []);
    const service = f.make(); await service.start(); f.emit(); await service.tick();
    expect(f.turns).toHaveLength(full ? 0 : 1); expect(service.status().state).toBe("linked");
    f.advance(101); await service.tick(); expect(f.turns).toHaveLength(1);
  }
});

test("T-STUCK: five write failures hold the note; Try again recovers; missing receipt offers no resend (mutants: retry forever, resend missing answer)", async () => {
  const f = fixture(), service = f.make(); await service.start();
  const accept = vi.spyOn(DurableDelivery.prototype, "accept").mockImplementation(() => { throw new Error("disk write"); });
  f.emit(); for (let i = 0; i < 5; i++) { await service.tick(); f.advance(1_800_000); }
  expect(service.status()).toMatchObject({ state: "blocked", reason: "notes-stuck", noteCount: 1 });
  await service.tick(); expect(accept).toHaveBeenCalledTimes(5);
  accept.mockRestore(); await service.retryNotes(); expect(f.turns).toHaveLength(1); expect(service.status().state).toBe("linked");
  f.setResult(null); const note = f.emit(1); await service.tick();
  expect(service.status()).toMatchObject({ state: "blocked", reason: "reply-lost" });
  expect(await service.resend(signalDeliveryId(ACI, note.timestamp))).toBe("not-resendable");
  await service.settle(signalDeliveryId(ACI, note.timestamp)); expect(service.status().state).toBe("linked");
});

test("T-RESEND / T-RL-DEADLINE: reply survives uncertainty and restart, cooldown enforced, one atomic replacement (mutants: settle first, counter id)", async () => {
  const f = fixture(); f.failSend(true); let service = f.make(); await service.start(); const note = f.emit(); await service.tick();
  const id = signalDeliveryId(ACI, note.timestamp); expect(state(f).records[0]).toMatchObject({ state: "uncertain", response: "answer", resendAfter: NOW + 60_000 });
  expect(await service.resend(id)).toBe("too-early"); await service.stop();
  service = f.make(); await service.start(); expect(await service.resend(id)).toBe("too-early");
  f.advance(60_000); const settle = vi.spyOn(DurableDelivery.prototype, "settle");
  expect(await service.resend(id)).toBe("resent"); expect(settle).not.toHaveBeenCalled();
  expect(state(f).records.find((r: { deliveryId: string }) => r.deliveryId === id)).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
  expect(await service.resend(id)).toBe("already"); expect(state(f).records).toHaveLength(2);
  f.failSend(false); await service.tick(); expect(f.turns).toHaveLength(1); expect(f.sent).toEqual(["answer", "answer"]);
});

test("T-RESEND: full leaves the original recoverable; Leave it and Dismiss settle review slots (mutant: settle on full)", async () => {
  const f = fixture(); seed(f, Array.from({ length: 200 }, (_, i) => receipt(`held-${i}`)));
  const service = f.make(); await service.start(); expect(await service.resend("held-0")).toBe("full");
  expect(state(f).records[0]).toMatchObject({ state: "uncertain", response: "answer" });
  await service.settle("held-1"); expect(await service.resend("held-0")).toBe("resent");
  expect(service.status()).toMatchObject({ reviewCount: 198 });
});

test("T-RESEND: root commit faults preserve one recoverable reply across overflow and restart (mutant: settle then admit)", async () => {
  for (const fault of ["none", "before-root", "after-overflow", "after-root"]) {
    const f = fixture(), reply = "r".repeat(12000);
    seed(f, Array.from({ length: 180 }, (_, i) => receipt(`held-${i}`, { response: reply })));
    let service = f.make(); await service.start(); const write = atomic.writeFileAtomic;
    let armed = true;
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, opts) => {
      if (armed && fault === "before-root" && file === f.ledgerFile) { armed = false; throw new Error("before root"); }
      write(file, text, opts);
      if (armed && ((fault === "after-root" && file === f.ledgerFile) || (fault === "after-overflow" && file.startsWith(f.ledgerFile + ".")))) { armed = false; throw new Error("after write"); }
    });
    if (fault === "none") expect(await service.resend("held-0")).toBe("resent");
    else await expect(service.resend("held-0")).rejects.toThrow();
    spy.mockRestore(); await service.stop(); service = f.make();
    // Read every page before startup drain consumes the committed replacement.
    const root = state(f), rows = [...root.records, ...(root.overflow ?? []).flatMap((p: string) => JSON.parse(readFileSync(`${f.ledgerFile}.${p}`, "utf8")).records)];
    const source = rows.find(r => r.deliveryId === "held-0"), replacements = rows.filter(r => !r.deliveryId.startsWith("held-"));
    expect(replacements).toHaveLength(fault === "none" || fault === "after-root" ? 1 : 0);
    expect(replacements[0]?.response ?? source.response).toBe(reply);
    if (replacements.length) expect(source).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
    await service.start(); await service.resend("held-0"); await service.resend("held-0"); await service.tick();
    expect(f.sent.join("")).toBe(reply); expect(f.turns).toEqual([]);
  }
}, 30000);

test("T-CONTROL / T-TIMER: delete intent and elapsed deadlines replay before drain; timers never alter earlier notes (mutants: drain first, append marker)", async () => {
  for (const expired of [false, true]) {
    const f = fixture(), id = signalDeliveryId(ACI, NOW); seed(f, [receipt(id, { state: "queued", runId: "exact-run", response: undefined })]);
    put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "secret marker", state: "forwarded", expiresAt: expired ? NOW - 1 : NOW + 100_000 }) + '\n');
    const service = f.make(); await service.start(); await service.tick();
    expect(f.sent).toHaveLength(expired ? 0 : 1);
    if (expired) { expect(readFileSync(f.journal, "utf8")).not.toContain("secret marker"); expect(f.options.revokeRuns).toHaveBeenCalledWith("one", ["exact-run"]); }
  }
  const f = fixture(), id = signalDeliveryId(ACI, NOW); seed(f, [receipt(id, { state: "accepted", response: undefined })]);
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "deleted marker", state: "pending" }) + '\n');
  const interrupted = `${f.journal}.interrupted.tmp`; put(interrupted, "deleted marker");
  put(join(f.root, "signal/ingress/one.tombstones.json"), [{ key: id, timestamp: NOW, deletedAt: NOW }]);
  const service = f.make(); await service.start(); await service.tick(); expect(f.turns).toEqual([]); expect(f.sent).toEqual([]);
  expect(readFileSync(f.journal, "utf8")).not.toContain("deleted marker");
  expect(existsSync(interrupted)).toBe(false);
  f.emit(10, { variant: "sync-control", body: null, control: { kind: "delete", target: NOW + 20 } });
  await service.tick(); f.emit(20); await service.tick(); expect(f.turns).toEqual([]);
  f.emit(30, { expiresInSeconds: 100 }); await service.tick();
  f.emit(40, { variant: "sync-control", body: null, control: { kind: "timer", seconds: 1 } }); await service.tick();
  expect(readFileSync(f.journal, "utf8")).toContain(String(NOW + 30 + 100_000));
});

test("T-UNLINK-CRASH: durable barrier precedes revocation, late callbacks fenced, wipe failure recovered before spawn (mutants: wipe first, spawn before recovery)", async () => {
  for (const fail of [false, true]) {
    const f = fixture(), service = f.make(); await service.start(); const old = f.capture();
    const revoke = deferred<void>(); f.options.people.revoke = vi.fn(async () => {
      const saved = JSON.parse(readFileSync(f.record, "utf8")); expect(saved).toMatchObject({ generation: 2, revoking: true, enabled: false, paused: true });
      f.calls.push("revoke-human"); await revoke.promise;
    });
    f.failWipe(fail); const unlink = service.disconnect(); await Promise.resolve(); f.emit(0, {}, old); revoke.resolve(); await unlink;
    expect(f.turns).toEqual([]); expect(f.calls.indexOf("revoke-human")).toBeLessThan(f.calls.indexOf("wipe-all"));
    if (fail) {
      expect(service.status()).toMatchObject({ reason: "revoke-recovery-required" }); await service.stop(); f.failWipe(false);
      const restarted = f.make(); const spawns = f.host.spawn.mock.calls.length; await restarted.start();
      expect(f.host.spawn).toHaveBeenCalledTimes(spawns); expect(restarted.status().state).toBe("not-linked");
    }
    expect(JSON.parse(readFileSync(f.record, "utf8"))).toMatchObject({ binding: null, revoking: false });
    expect(JSON.parse(readFileSync(f.record, "utf8")).connectionId).not.toBe("one");
  }
});

test("T-OWNER-REPAIR: phone confirmation precedes barrier and wipe, failed deletion keeps recovery state (mutant: relink old keys)", async () => {
  const f = fixture(); f.storage.check.mockResolvedValue({ state: "blocked", reason: "storage-owner", scope: "signal", path: join(f.root, "signal") } as never);
  const service = f.make(); await service.start(); expect(f.host.spawn).not.toHaveBeenCalled();
  await service.link({ chiefBotId: "chief" }); expect(f.calls).not.toContain("wipe-all");
  f.failWipe(true); await service.link({ chiefBotId: "chief", removedDeviceOnPhone: true });
  expect(f.calls).toContain("revoke-human"); expect(f.calls).toContain("wipe-all"); expect(f.host.spawn).not.toHaveBeenCalled();
  expect(service.status()).toMatchObject({ state: "blocked", reason: "revoke-recovery-required" });
});

test("T-OWNER-REPAIR: fresh directories are recreated and checked before link (mutant: check missing tree)", async () => {
  const f = fixture(); f.options.storage = connectionId => createSignalStorageGuard({ dataDir: f.root, connectionId });
  const service = f.make(); await service.start(); expect(service.status().state).toBe("linked");
  expect(existsSync(join(f.root, "signal/auth"))).toBe(true);
  await service.disconnect(); expect(existsSync(join(f.root, "signal"))).toBe(false);
  f.options.linkProtocol = { policy: { contracts: { startLink: { params: z.strictObject({}), result: z.strictObject({}) }, finishLink: { params: z.strictObject({}), result: z.strictObject({}) } } },
    startParams: () => ({}), readStart: () => ({ uri: "fixture:qr", finishParams: {} }) };
  f.host.request.mockImplementation(async req => ({ jsonrpc: "2.0", id: req.id, result: req.method === "finishLink" ? await new Promise(() => {}) : {} }) as never);
  expect(await service.link({ chiefBotId: "chief" })).toMatchObject({ state: "linking" });
  expect(existsSync(join(f.root, "signal/auth"))).toBe(true);
});

test("T-ACCOUNTS / T-CLOUD: every ready token must match; missing access and Cloud stay closed (mutant: first-spawn-only identity)", async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(), service = f.make(); await service.start();
    f.setIdentity({ ownAci: ACI, ownDeviceId: mismatch ? 7 : 2, number: "+15550001234" });
    f.event({ kind: "ready", ...f.capture(), identity: f.host.identity }); f.emit(); await service.tick();
    expect(f.turns).toHaveLength(mismatch ? 0 : 1);
    if (mismatch) expect(service.status()).toMatchObject({ reason: "identity-mismatch" });
  }
  const f = fixture(); f.options.isCloudHome = () => true; const service = f.make(); await service.start(); expect(f.host.spawn).not.toHaveBeenCalled();
  const g = fixture(); delete g.options.access; const closed = g.make(); await closed.start(); g.emit(); await closed.tick(); expect(g.turns).toEqual([]);
});

test("T-WINDOW: old note drops once; paired fresh note runs (mutant: retry window errors)", async () => {
  const f = fixture(), service = f.make(); await service.start(); f.emit(0, { timestamp: NOW - WEEK - 1 }); f.emit(1); await service.tick(); await service.tick();
  expect(f.turns).toHaveLength(1); expect(readFileSync(f.journal, "utf8")).toContain('"reason":"window"');
});

test("T-LINK: absent G0 contract refuses link without spawn; dated device option is passed to the injected contract", async () => {
  const f = fixture(); await f.make().disconnect(); const service = f.make();
  expect(await service.link({ chiefBotId: "chief" })).toMatchObject({ reason: "needs-update" }); expect(f.host.spawn).not.toHaveBeenCalled();
  const finish = deferred<unknown>();
  // Empty synthetic schemas test orchestration only, never a guessed Signal wire shape.
  f.options.linkProtocol = { policy: { contracts: { startLink: { params: z.strictObject({}), result: z.strictObject({}) }, finishLink: { params: z.strictObject({}), result: z.strictObject({}) } } },
    startParams: vi.fn(() => ({})), readStart: () => ({ uri: "fixture:qr", finishParams: {} }) };
  f.host.request.mockImplementation(async (request: RpcRequest) => ({ jsonrpc: "2.0", id: request.id, result: request.method === "finishLink" ? await finish.promise : {} }) as never);
  const linked = f.make(); expect(await linked.link({ chiefBotId: "chief" })).toMatchObject({ state: "linking", uri: "fixture:qr" });
  expect(f.options.linkProtocol.startParams).toHaveBeenCalledWith({ deviceName: "Murage (2027-01-15)", args: ["-n", "Murage (2027-01-15)"] });
  finish.reject(new Error("cancelled")); await Promise.resolve();
});

test("T-REDACT: a delete during chunk one cancels chunk two and only the target run (mutant: wait for drain before control)", async () => {
  for (const authenticated of [false, true]) {
    const f = fixture(); f.setResult({ status: "completed", output: "a".repeat(3000) }); const service = f.make(); await service.start();
    const send = f.host.request.getMockImplementation()!, written = deferred<void>(), release = deferred<void>();
    f.host.request.mockImplementation(async (req, opts) => { const result = await send(req, opts); if (req.method === "send") { written.resolve(); await release.promise; } return result; });
    const note = f.emit(), draining = service.tick(); await written.promise;
    f.emit(1, { variant: "sync-control", body: null, control: { kind: "delete", target: note.timestamp }, sourceAci: authenticated ? ACI : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    release.resolve(); await draining; await service.tick();
    expect(f.sent).toHaveLength(authenticated ? 1 : 2);
    const row = state(f).records[0]; expect(row.state).toBe(authenticated ? "cancelled" : "sent");
    if (authenticated) { expect(row.prompt).toBe(""); expect(row.response).toBeUndefined(); expect(f.options.revokeRuns).toHaveBeenCalledWith("one", [`run-${signalDeliveryId(ACI, note.timestamp)}`]); }
  }
});

test("T-UNLINK-CRASH: each durable boundary recovers without a child; pre-barrier failure performs no cleanup", async () => {
  const write = atomic.writeFileAtomic;
  for (const boundary of ["none", "barrier", "after-barrier", "human", "ledger", "runs", "terminate", "wipe", "rotate"]) {
    const f = fixture(), service = f.make(); await service.start(); f.setResult({ status: "running" }); f.emit(); await service.tick();
    let armed = true;
    const crash = () => { if (armed) { armed = false; throw new Error("crash"); } };
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, opts) => {
      if (file === f.record) { const value = JSON.parse(String(text)); if ((boundary === "barrier" && value.revoking) || (boundary === "rotate" && !value.revoking)) crash(); }
      if (boundary === "ledger" && file === f.ledgerFile) crash();
      write(file, text, opts);
      if (boundary === "after-barrier" && file === f.record && JSON.parse(String(text)).revoking) crash();
    });
    if (boundary === "human") f.options.people.revoke = async () => { crash(); };
    if (boundary === "runs") f.options.revokeRuns = async () => { crash(); };
    if (boundary === "terminate") f.host.stop.mockImplementation(async () => { crash(); });
    if (boundary === "wipe") f.failWipe(true);
    await service.disconnect(); spy.mockRestore();
    if (boundary === "barrier") { expect(f.calls).not.toContain("revoke-human"); expect(f.calls).not.toContain("wipe-all"); continue; }
    if (boundary === "after-barrier") {
      const count = f.host.spawn.mock.calls.length; await service.fixPermissions(); expect(f.host.spawn).toHaveBeenCalledTimes(count);
    }
    await service.stop(); f.failWipe(false); const restart = f.make(), spawns = f.host.spawn.mock.calls.length;
    await restart.start(); expect(f.host.spawn).toHaveBeenCalledTimes(spawns); expect(restart.status().state).toBe("not-linked");
    expect(JSON.parse(readFileSync(f.record, "utf8"))).toMatchObject({ revoking: false, binding: null });
  }
});

test("T-UNLINK-CRASH: an old send response after wipe never writes another chunk or recreates data", async () => {
  const f = fixture(); f.setResult({ status: "completed", output: "a".repeat(3000) });
  const service = f.make(); await service.start(); const request = f.host.request.getMockImplementation()!;
  const written = deferred<void>(), finish = deferred<void>();
  f.host.request.mockImplementation(async (req, opts) => { const response = await request(req, opts); if (req.method === "send") { written.resolve(); await finish.promise; } return response; });
  f.emit(); const drain = service.tick(); await written.promise; const old = f.capture();
  await service.disconnect(); finish.resolve(); await drain; f.emit(1, {}, old); await service.tick();
  expect(f.sent).toHaveLength(1); expect(f.turns).toHaveLength(1); expect(existsSync(f.ledgerFile)).toBe(false);
  expect(existsSync(join(f.root, "channels/signal/one/outbox.json"))).toBe(false);
});

test("T-SOURCE-DERIVED-DISCONNECT: even an injected unregister contract cannot deregister the account", async () => {
  vi.useFakeTimers();
  try {
    for (const timeout of [false, true]) {
      const f = fixture(), service = f.make(); await service.start();
      f.options.linkProtocol = { policy: { contracts: { unregister: { params: z.strictObject({}), result: z.strictObject({}) } } },
        startParams: () => ({}), readStart: () => { throw new Error("unused"); }, unlink: { method: "unregister", params: {} } };
      if (timeout) f.host.request.mockImplementation(async () => await new Promise(() => {}));
      const disconnect = service.disconnect(); await vi.advanceTimersByTimeAsync(10000); await disconnect;
      expect(service.status()).toEqual({ state: "not-linked", removeDeviceOnPhone: true });
      expect(f.host.request.mock.calls.some(([r]) => r.method === "unregister")).toBe(false);
      expect(f.calls).toContain("wipe-all"); expect(f.host.stop).toHaveBeenCalled();
    }
  } finally { vi.useRealTimers(); }
});

test("T-ACCOUNTS: an identity-unavailable host blocks and wipes only auth; normal ready keeps auth", async () => {
  for (const unavailable of [false, true]) {
    const f = fixture(); const auth = join(f.root, "signal/auth/secret"); put(auth, "key"); const service = f.make(); await service.start();
    if (unavailable) f.event({ kind: "blocked", reason: "identity-unavailable", generation: 1 });
    await Promise.resolve(); await Promise.resolve();
    f.emit(); await service.tick(); expect(f.turns).toHaveLength(unavailable ? 0 : 1);
    if (unavailable) { expect(service.status()).toMatchObject({ reason: "identity-unavailable" }); expect(f.calls).toContain("wipe-auth"); }
    expect(existsSync(auth)).toBe(!unavailable);
  }
});

test("T-LINK: QR refresh is bounded to ten minutes and a cancelled finish cannot bind", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.make().disconnect();
    f.options.now = () => Date.now();
    f.options.linkProtocol = { policy: { contracts: { startLink: { params: z.strictObject({}), result: z.strictObject({}) }, finishLink: { params: z.strictObject({}), result: z.strictObject({}) } } },
      startParams: () => ({}), readStart: () => ({ uri: "fixture:qr", finishParams: {} }) };
    const pending = deferred<unknown>();
    f.host.request.mockImplementation(async req => ({ jsonrpc: "2.0", id: req.id, result: req.method === "finishLink" ? await pending.promise : {} }) as never);
    const service = f.make(); await service.link({ chiefBotId: "chief" });
    await vi.advanceTimersByTimeAsync(60_000); expect(f.host.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(540_000); expect(f.host.spawn).toHaveBeenCalledTimes(10);
    expect(service.status()).toMatchObject({ reason: "link-required" });
    pending.resolve({}); await Promise.resolve(); await Promise.resolve();
    expect(JSON.parse(readFileSync(f.record, "utf8")).binding).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("T-CRASH: journal append and accept/forward boundary each replay exactly once, torn tail preserves earlier rows", async () => {
  for (const point of ["append", "forward", "torn-tail"]) {
    const f = fixture(), service = f.make(); await service.start();
    const note = f.emit(), id = signalDeliveryId(ACI, note.timestamp);
    if (point === "append") vi.spyOn(DurableDelivery.prototype, "accept").mockImplementationOnce(() => { throw new Error("crash"); });
    if (point === "forward") {
      const write = atomic.writeFileAtomic; let armed = true;
      vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, opts) => {
        if (armed && file === f.journal) { armed = false; throw new Error("crash after accept"); }
        write(file, text, opts);
      });
    }
    await service.tick(); vi.restoreAllMocks(); await service.stop();
    if (point === "torn-tail") put(f.journal, readFileSync(f.journal, "utf8") + '{"key":"torn');
    f.advance(5001); const restart = f.make(); await restart.start(); await restart.tick();
    expect(f.turns.filter(turn => turn === id)).toHaveLength(1); expect(f.sent).toHaveLength(1);
    expect(restart.status().state).toBe("linked");
  }
});

test("T-BACKPRESSURE: 50 waiting fsyncs pause reads; disk failure retains the row, timeout blocks without killing the child", async () => {
  const f = fixture(), service = f.make(); await service.start();
  for (let i = 0; i < 50; i++) f.emit(i);
  expect(f.host.pauseReading).toHaveBeenCalledWith("storage-slow"); await service.tick(); expect(f.host.resumeReading).toHaveBeenCalled();
  const stopCount = f.host.stop.mock.calls.length;
  const write = atomic.writeFileAtomic;
  const fail = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, opts) => { if (file.endsWith("tombstones.json")) throw new Error("disk full"); write(file, text, opts); });
  f.emit(60, { variant: "sync-control", body: null, control: { kind: "delete", target: NOW + 49 } }); await service.tick();
  f.advance(30001); await service.tick(); expect(service.status()).toMatchObject({ reason: "disk-full" }); expect(f.host.stop).toHaveBeenCalledTimes(stopCount);
  fail.mockRestore();
}, 30000);

test("T-RESTORE: retained receipts cannot send after restore; rotate the connection and require a link", async () => {
  const f = fixture(); seed(f, [receipt("old", { state: "accepted" })]); const service = f.make();
  await service.start({ restored: true }); expect(service.status()).toMatchObject({ reason: "link-required" });
  expect(f.host.spawn).not.toHaveBeenCalled(); expect(f.sent).toEqual([]); expect(existsSync(f.ledgerFile)).toBe(true);
  expect(JSON.parse(readFileSync(f.record, "utf8")).connectionId).not.toBe("one");
});

test("T-CONTRACT: B7 typechecks against the frozen dependencies", async () => {
  const ts = await import("typescript");
  const files = [join(import.meta.dirname, "service.ts"), join(import.meta.dirname, "wipe.ts")];
  const program = ts.createProgram(files, { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, esModuleInterop: true });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file && files.includes(d.file.fileName));
  expect(diagnostics.map(d => `${d.file!.fileName}:${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)).toEqual([]);
}, 30000);

test("T-DESKTOP: normalized data and sync copies from another own device admit exactly one durable turn", async () => {
  const { createSignalAccess } = await import("./access.ts");
  const f = fixture(); f.options.access = createSignalAccess(raw => raw);
  let service = f.make(); await service.start();
  f.emit(10, { variant: "other", body: null }); f.emit(10); f.emit(10);
  await service.tick();
  expect(f.turns).toEqual([signalDeliveryId(ACI, NOW + 10)]);
  expect(f.sent).toEqual(["answer"]);
  expect(readFileSync(f.journal, "utf8").trim().split("\n")).toHaveLength(1);
  await service.stop(); service = f.make(); await service.start();
  f.emit(10); await service.tick();
  expect(f.turns).toHaveLength(1); expect(f.sent).toHaveLength(1);
});

test("T-NOLOG: normalized owner-policy refusals never journal text or start a turn", async () => {
  const { createSignalAccess } = await import("./access.ts");
  const f = fixture(); f.options.access = createSignalAccess(raw => raw);
  const service = f.make(); await service.start();
  const denied = [
    { sourceAci: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { destinationAci: null },
    { group: true }, { sourceDevice: 2 }, { envelopeDestination: `PNI:${ACI}` },
    { timestamp: NOW + 300001 },
  ];
  for (const [i, changes] of denied.entries()) f.emit(i + 1, { body: "PRIVATE-REJECTED-CONTENT", ...changes });
  await service.tick();
  expect(f.turns).toEqual([]); expect(f.sent).toEqual([]);
  if (existsSync(f.journal)) expect(readFileSync(f.journal, "utf8")).not.toContain("PRIVATE-REJECTED-CONTENT");
  f.emit(20); await service.tick();
  expect(f.turns).toEqual([signalDeliveryId(ACI, NOW + 20)]);
});


test.each(["before", "after"] as const)("T-STARTUP-RECEIVE: real host journals subscription notification %s response in one stdout chunk", async order => {
  const f = fixture();
  put(join(f.root, "signal/auth/data/accounts.json"), { accounts: [{ path: "account", uuid: ACI, number: "+15550001234" }] });
  put(join(f.root, "signal/auth/data/account"), { storage: { deviceId: 2 } });
  const note: SignalEvent = { sourceAci: ACI, sourceDevice: 3, destinationAci: ACI, envelopeDestination: null,
    timestamp: NOW, group: false, expiresInSeconds: null, longText: false, variant: "sync-sent", body: "startup note", control: null };
  f.options.host = context => new SignalProcessHost({ dataDir: f.root, storage: f.storage, onEvent: context.onEvent,
    verifyRuntime: async () => ({ java: "/fixture/java", jar: "/fixture/signal-cli.jar", version: "fixture" }),
    rpc: { contracts: { subscribeReceive: { params: z.strictObject({}), result: z.strictObject({}) } } },
    park: { fence: { lease: () => "fixture-lease", discover: () => true, host: () => "fixture", boot: () => "fixture", uptime: () => 1, start: () => "123" } },
    spawnChild: () => {
      const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new Writable(), kill: () => { queueMicrotask(() => child.emit("exit", 0)); return true; } });
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const req = JSON.parse(chunk.toString());
        const result = req.method === "version" ? { version: "fixture" } : req.method === "listAccounts"
          ? [{ number: "+15550001234", aci: ACI }] : req.method === "send"
          ? { timestamp: NOW, results: [{ recipientAddress: { uuid: ACI, number: null }, type: "SUCCESS" }] } : {};
        const response = JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n";
        const notification = JSON.stringify({ jsonrpc: "2.0", method: "receive", params: note }) + "\n";
        queueMicrotask(() => child.stdout.write(req.method === "subscribeReceive"
          ? order === "before" ? notification + response : response + notification : response));
        done();
      } });
      return child;
    },
  });
  const service = f.make(); await service.start(); await service.tick();
  expect(f.turns).toEqual([signalDeliveryId(ACI, NOW)]);
  expect(readFileSync(f.journal, "utf8")).toContain("startup note");
  expect(state(f).records[0].state).toBe("sent");
});

for (const cause of ["delete", "expiry"] as const) {
  test.each([false, true])(`T-RESEND-CONTROL: ${cause} redacts replacement after resend (restart=%s)`, async restart => {
    const f = fixture(); f.failSend(true); let service = f.make(); await service.start();
    f.emit(0, { expiresInSeconds: 120 }); await service.tick();
    const id = signalDeliveryId(ACI, NOW); f.advance(60_001);
    expect(await service.resend(id)).toBe("resent"); f.sent.length = 0; f.failSend(false);
    if (restart) await service.stop();
    if (cause === "expiry") f.advance(60_000);
    else if (restart) put(join(f.root, "signal/ingress/one.tombstones.json"), [{ key: id, timestamp: NOW, deletedAt: NOW + 60_001 }]);
    else f.emit(1, { variant: "sync-control", body: null, control: { kind: "delete", target: NOW } });
    if (restart) { service = f.make(); await service.start(); }
    await service.tick();
    expect(f.sent).toEqual([]);
    expect(readFileSync(f.ledgerFile, "utf8")).not.toContain("answer");
    expect(readFileSync(f.ledgerFile, "utf8")).not.toContain("note 0");
    expect(state(f).records.every((r: { state: string }) => r.state === "cancelled")).toBe(true);
  });
  test(`T-RESEND-CONTROL: ${cause} during replacement chunk one fences chunk two and settlement`, async () => {
    const f = fixture(); f.setResult({ status: "completed", output: "private answer ".repeat(200) });
    f.failSend(true); const service = f.make(); await service.start();
    f.emit(0, { expiresInSeconds: 120 }); await service.tick(); f.advance(60_001);
    expect(await service.resend(signalDeliveryId(ACI, NOW))).toBe("resent");
    f.sent.length = 0; f.failSend(false);
    const entered = deferred<void>(), release = deferred<void>(), request = f.host.request.getMockImplementation()!;
    f.host.request.mockImplementation(async (req, options) => {
      const response = await request(req, options);
      if (req.method === "send") { entered.resolve(); await release.promise; }
      return response;
    });
    const draining = service.tick(); await entered.promise;
    if (cause === "expiry") f.advance(60_000);
    else f.emit(1, { variant: "sync-control", body: null, control: { kind: "delete", target: NOW } });
    release.resolve(); await draining; await service.tick();
    expect(f.sent).toHaveLength(1);
    expect(readFileSync(f.ledgerFile, "utf8")).not.toContain("private answer");
    expect(state(f).records.every((r: { state: string }) => r.state === "cancelled")).toBe(true);
  });
}

test("T-RESEND-CONTROL: expiry survives journal pruning and a later restart", async () => {
  const f = fixture(); f.failSend(true); let service = f.make(); await service.start();
  f.emit(0, { expiresInSeconds: 9 * 86400 }); await service.tick();
  f.advance(8 * 86400000); await service.tick();
  expect(readFileSync(f.journal, "utf8")).not.toContain("note 0");
  expect(await service.resend(signalDeliveryId(ACI, NOW))).toBe("resent");
  await service.stop(); f.sent.length = 0; f.failSend(false); f.advance(86400000);
  service = f.make(); await service.start(); await service.tick();
  expect(f.sent).toEqual([]);
  expect(readFileSync(f.ledgerFile, "utf8")).not.toContain("answer");
});

test("T-RESEND-CONTROL: expiry during a failed final chunk redacts before settlement", async () => {
  const f = fixture(); f.failSend(true); const service = f.make(); await service.start();
  f.emit(0, { expiresInSeconds: 120 }); await service.tick(); f.advance(60_001);
  expect(await service.resend(signalDeliveryId(ACI, NOW))).toBe("resent");
  const entered = deferred<void>(), release = deferred<void>(), request = f.host.request.getMockImplementation()!;
  f.host.request.mockImplementation(async (req, options) => {
    const response = await request(req, options);
    if (req.method === "send") { entered.resolve(); await release.promise; }
    return response;
  });
  const draining = service.tick(); await entered.promise; f.advance(60_000); release.resolve(); await draining;
  expect(readFileSync(f.ledgerFile, "utf8")).not.toContain("answer");
  expect(state(f).records.every((r: { state: string }) => r.state === "cancelled")).toBe(true);
});

for (const descendant of [false, true]) {
  test(descendant ? "T-EXPIRY-UPGRADE-DESCENDANT: legacy replacement expires after journal pruning"
    : "T-EXPIRY-UPGRADE: legacy receipt expires after journal pruning", async () => {
    const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
    const copy = createHash("sha256").update(id).update("\0resend").digest("hex");
    seed(f, [receipt(id, { runId: "original-run", expiryKnown: undefined }), ...(descendant ? [receipt(copy, { runId: "copy-run", expiryKnown: undefined })] : [])]);
    put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt }) + '\n');
    const service = f.make(); await service.start();
    f.setTime(NOW + WEEK + 60000); await service.tick();
    expect(readFileSync(f.journal, "utf8")).toBe("");
    f.setTime(expiresAt + 1000); await service.resend(descendant ? copy : id); await service.tick();
    expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
    expect(state(f).records.every((r: { state: string; prompt: string; response?: string }) => r.state === "cancelled" && r.prompt === "" && r.response === undefined)).toBe(true);
    expect(f.options.revokeRuns).toHaveBeenCalledWith("one", expect.arrayContaining(descendant ? ["original-run", "copy-run"] : ["original-run"]));
  });
}

test("T-EXPIRY-BACKFILL-CRASH: ledger commit precedes the journal flag and replay does no duplicate work", async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
  seed(f, [receipt(id, { runId: "original-run", expiryKnown: undefined })]);
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt }) + '\n');
  const write = atomic.writeFileAtomic;
  let crashed = false;
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, options) => {
    if (file === f.journal && typeof text === "string" && text.includes('"expiryMirrored":true')) { crashed = true; throw new Error("crash before journal commit"); }
    write(file, text, options);
  });
  let service = f.make(); await service.start(); await service.stop(); spy.mockRestore();
  expect(crashed).toBe(true);
  expect(state(f).records[0].expiresAt).toBe(expiresAt);
  expect(readFileSync(f.journal, "utf8")).not.toContain("expiryMirrored");
  service = f.make(); await service.start();
  expect(JSON.parse(readFileSync(f.journal, "utf8")).expiryMirrored).toBe(true);
  expect(state(f).records).toHaveLength(1);
  f.setTime(NOW + WEEK + 60000); await service.tick(); f.setTime(expiresAt + 1000);
  await service.resend(id); await service.tick();
  expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
  expect(state(f).records[0]).toMatchObject({ prompt: "", state: "cancelled", error: "redacted" });
});

test("T-PRUNE-KEEPS-UNMIRRORED: an old future deadline stays until a receipt can hold it", async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt }) + '\n');
  f.setTime(NOW + WEEK + 60000);
  const service = f.make(); await service.start(); await service.tick();
  expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({ key: id, expiresAt });
  expect(readFileSync(f.journal, "utf8")).not.toContain("expiryMirrored");
  f.setTime(expiresAt + 1000); await service.tick();
  expect(readFileSync(f.journal, "utf8")).not.toContain("expiryMirrored"); expect(f.sent).toEqual([]);
  expect(service.status()).toMatchObject({ state: "blocked", reason: "ledger-write-failed" });
});

test.each([null, 120])("T-TIMER-IMMUTABLE: repeated notes and conversation updates preserve deadline %s", async seconds => {
  const f = fixture(); f.failSend(true); let service = f.make(); await service.start();
  f.emit(0, { expiresInSeconds: seconds }); await service.tick();
  for (const expiresInSeconds of [1, 240, null]) {
    f.emit(0, { expiresInSeconds });
    f.emit(40, { variant: "sync-control", body: null, control: { kind: "timer", seconds: expiresInSeconds ?? 0 } });
    await service.tick();
    expect(state(f).records[0].expiresAt).toBe(seconds === null ? undefined : NOW + seconds * 1000);
    expect(JSON.parse(readFileSync(f.journal, "utf8")).expiresAt).toBe(seconds === null ? undefined : NOW + seconds * 1000);
  }
  await service.stop(); service = f.make(); await service.start();
  expect(state(f).records[0].expiresAt).toBe(seconds === null ? undefined : NOW + seconds * 1000);
  expect(f.turns).toHaveLength(1);
});

for (const orphan of [false, true]) test(`T-EXPIRY-UNKNOWN: missing journal and lineage fail closed (orphan=${orphan})`, async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW);
  seed(f, [receipt(id, { runId: "legacy-run", expiryKnown: undefined, ...(orphan ? { sourceDeliveryId: "pruned-source" } : {}) })]);
  const service = f.make(); await service.start();
  await service.resend(id); await service.tick();
  expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
  expect(state(f).records[0]).toMatchObject({ prompt: "", state: "cancelled", error: "redacted" });
  expect(state(f).records[0].response).toBeUndefined();
  expect(f.options.revokeRuns).toHaveBeenCalledWith("one", ["legacy-run"]);
});

test("T-EXPIRY-MIGRATION-FENCE: failed coverage blocks prune and drain, including ENOENT", async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
  seed(f, [receipt(id, { state: "accepted", expiryKnown: undefined })]);
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt }) + '\n');
  f.setTime(NOW + WEEK + 60000);
  const write = atomic.writeFileAtomic;
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, text, options) => {
    if (file === f.ledgerFile) throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
    write(file, text, options);
  });
  const service = f.make(); await service.start(); await service.tick();
  expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
  expect(readFileSync(f.journal, "utf8")).toContain("private prompt");
  expect(readFileSync(f.journal, "utf8")).not.toContain("expiryMirrored");
  expect(service.status()).toMatchObject({ state: "blocked", reason: "ledger-write-failed" });
  spy.mockRestore();
});

test("T-EXPIRY-KNOWN-PERMANENT: a proven no-timer receipt survives journal pruning and restart", async () => {
  const f = fixture(); f.failSend(true); let service = f.make(); await service.start();
  f.emit(); await service.tick();
  f.advance(WEEK + 60000); await service.tick();
  expect(readFileSync(f.journal, "utf8")).toBe("");
  await service.stop(); service = f.make(); await service.start();
  f.sent.length = 0; f.failSend(false);
  await service.resend(signalDeliveryId(ACI, NOW)); await service.tick();
  expect(f.sent).toEqual(["answer"]); expect(f.turns).toHaveLength(1);
});

test("T-EXPIRY-ABSENT-ORIGINAL: journal reconstructs legacy descendants without the source receipt", async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
  const copy = createHash("sha256").update(id).update("\0resend").digest("hex");
  const grandchild = createHash("sha256").update(copy).update("\0resend").digest("hex");
  seed(f, [receipt(copy, { runId: "copy-run", expiryKnown: undefined }), receipt(grandchild, { runId: "grandchild-run", expiryKnown: undefined })]);
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt }) + '\n');
  const service = f.make(); await service.start();
  expect(state(f).records.every((r: { expiresAt?: number; state: string }) => r.expiresAt === expiresAt && r.state === "uncertain")).toBe(true);
  expect(JSON.parse(readFileSync(f.journal, "utf8")).expiryMirrored).toBe(true);
  f.setTime(NOW + WEEK + 60000); await service.tick();
  expect(readFileSync(f.journal, "utf8")).toBe("");
  f.setTime(expiresAt + 1000); await service.resend(grandchild); await service.tick();
  expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
  expect(state(f).records.every((r: { prompt: string; response?: string }) => r.prompt === "" && r.response === undefined)).toBe(true);
  expect(f.options.revokeRuns).toHaveBeenCalledWith("one", expect.arrayContaining(["copy-run", "grandchild-run"]));
});

test("T-EXPIRY-MIRROR-COVERAGE: a legacy mirror flag cannot hide a reclaimed deadline", async () => {
  const f = fixture(), id = signalDeliveryId(ACI, NOW), expiresAt = NOW + 9 * 86400000;
  put(f.journal, JSON.stringify({ key: id, timestamp: NOW, body: "private prompt", state: "forwarded", expiresAt, expiryMirrored: true }) + '\n');
  f.setTime(NOW + WEEK + 60000);
  const service = f.make(); await service.start(); await service.tick();
  expect(service.status()).toMatchObject({ state: "blocked", reason: "ledger-write-failed" });
  expect(JSON.parse(readFileSync(f.journal, "utf8")).expiresAt).toBe(expiresAt);
  expect(f.sent).toEqual([]); expect(f.turns).toEqual([]);
});

// Replay complete captured frames through the real process host's stdout parser.
function installG0Child(f: ReturnType<typeof fixture>, protocol: NonNullable<SignalServiceOptions["linkProtocol"]>,
  version: string, frame: (name: string) => any, finish?: () => void) {
  let stdout!: PassThrough;
  const requests: RpcRequest[] = [];
  f.options.host = context => new SignalProcessHost({ dataDir: f.root, storage: f.storage, onEvent: context.onEvent,
    expectedIdentity: context.expectedIdentity,
    verifyRuntime: async () => ({ java: "/fixture/java", jar: "/fixture/signal-cli.jar", version }), rpc: protocol.policy,
    park: { fence: { lease: () => "fixture-lease", discover: () => true, host: () => "fixture", boot: () => "fixture", uptime: () => 1, start: () => "123" } },
    spawnChild: () => {
      const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable(),
        kill: () => { queueMicrotask(() => child.emit("exit", 0)); return true; } }); stdout = child.stdout;
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const req = JSON.parse(chunk.toString()) as RpcRequest; requests.push(req);
        if (req.method === "finishLink") finish?.();
        const result = frame(req.method === "listAccounts" ? "listAccounts-one" : req.method);
        queueMicrotask(() => child.stdout.write(JSON.stringify({ ...result, id: req.id }) + "\n")); done();
      } }); return child;
    } });
  return { requests, receive: (name: string) => stdout.write(JSON.stringify(frame(name)) + "\n") };
}

// Live acceptance gates remain pending until B1/B2. Missing evidence is a
// qualification prerequisite failure, NOT behavioral RED evidence (amendment 8).
test("T-RAW-REPLAY: G0 stdout admits only owner notes and applies delete/expiry", async () => {
  const { g0Frame } = await import("./g0-test-fixtures.ts");
  const raw = g0Frame("own-note");
  const modulePath = "./adapters.ts"; const { loadSignalAdapters } = await import(/* @vite-ignore */ modulePath);
  const pin = JSON.parse(readFileSync(new URL("./runtime-pin.json", import.meta.url), "utf8"));
  const adapters = loadSignalAdapters(pin, "server/channels/signal/fixtures/g0"); expect(adapters.verified).toBe(true);
  const account = g0Frame("listAccounts-one").result[0];
  const f = fixture(); f.options.access = adapters.access; f.binding.ownAci = account.aci;
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/g0/manifest.json", import.meta.url), "utf8"));
  f.binding.ownDeviceId = manifest.captureDevices.M;
  const note = adapters.access.parse(raw.params); expect(note?.variant).toBe("sync-sent");
  f.setTime(note.timestamp); f.binding.linkedAt = note.timestamp - 1000;
  const record = JSON.parse(readFileSync(f.record, "utf8")); record.binding = f.binding; record.account = account.number; put(f.record, record);
  put(join(f.root, "signal/auth/data/accounts.json"), { accounts: [{ path: "account", uuid: account.aci, number: account.number }] });
  put(join(f.root, "signal/auth/data/account"), { storage: { deviceId: manifest.captureDevices.M } });
  const child = installG0Child(f, adapters.linkProtocol, pin.signalCliVersion, g0Frame);
  const service = f.make(); await service.start();
  const replay = async (name: string) => { child.receive(name); await service.tick(); };
  await replay("own-note"); expect(f.turns).toEqual([signalDeliveryId(account.aci, note.timestamp)]);
  expect(readFileSync(f.journal, "utf8").trim().split("\n")).toHaveLength(1);
  const logs = ["log", "info", "warn", "error"].map(method => vi.spyOn(console, method as "log").mockImplementation(() => {}));
  for (const name of ["other-sender-sync", "pni-sync", "other-account-text", "other-account-attachment", "owner-to-friend", "own-echo"]) await replay(name);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  expect(f.turns).toHaveLength(1); expect(readFileSync(f.journal, "utf8").trim().split("\n")).toHaveLength(1);
  await replay("edit"); expect(f.turns).toHaveLength(2);
  await replay("remote-delete"); expect(state(f).records.find((r: any) => r.deliveryId === signalDeliveryId(account.aci, note.timestamp))).toMatchObject({ prompt: "", response: "" });
  await replay("expiry"); const expiring = adapters.access.parse(g0Frame("expiry").params);
  f.setTime(expiring.timestamp + expiring.expiresInSeconds * 1000 + 1); await service.tick();
  expect(state(f).records.find((r: any) => r.deliveryId === signalDeliveryId(account.aci, expiring.timestamp))).toMatchObject({ prompt: "", response: "" });
});
test("T-LINK-CONTRACT: G0 start/finish/accounts reach linked with captured identity", async () => {
  const { g0Frame } = await import("./g0-test-fixtures.ts"); g0Frame("startLink");
  const modulePath = "./adapters.ts"; const { loadSignalAdapters } = await import(/* @vite-ignore */ modulePath);
  const adapters = loadSignalAdapters(JSON.parse(readFileSync(new URL("./runtime-pin.json", import.meta.url), "utf8")), "server/channels/signal/fixtures/g0");
  expect(adapters.verified).toBe(true);
  const f = fixture(); const record = JSON.parse(readFileSync(f.record, "utf8")); record.binding = null; record.account = null; record.enabled = false; put(f.record, record);
  f.options.linkProtocol = adapters.linkProtocol;
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/g0/manifest.json", import.meta.url), "utf8"));
  const account = g0Frame("listAccounts-one").result[0];
  installG0Child(f, adapters.linkProtocol, manifest.signalCliVersion, g0Frame, () => {
    put(join(f.root, "signal/auth/data/accounts.json"), { accounts: [{ path: "account", uuid: account.aci, number: account.number }] });
    put(join(f.root, "signal/auth/data/account"), { storage: { deviceId: manifest.captureDevices.M } });
  });
  const service = f.make(); await service.link({ chiefBotId: "chief" });
  await vi.waitFor(() => expect(service.status().state).toBe("linked"));
  expect(service.status()).toMatchObject({ binding: { ownAci: account.aci, ownDeviceId: manifest.captureDevices.M } });
});
test("T-UNREGISTER-GUARD: active linked fixture without proof retains phone removal copy and wipes locally", async () => {
  const { createSourceDerivedLinkProtocol } = await import("./adapters.ts");
  const f = fixture(); f.options.linkProtocol = createSourceDerivedLinkProtocol(); const service = f.make(); await service.start();
  expect(service.status().state).toBe("linked");
  expect(f.calls).toContain("spawn");
  expect(await service.disconnect()).toMatchObject({ state: "not-linked", removeDeviceOnPhone: true });
  expect(f.host.request.mock.calls.some(([r]) => r.method === "unregister")).toBe(false);
  expect(f.calls).toContain("wipe-all"); expect(f.host.stop).toHaveBeenCalled();
});

// Source-derived authorization test only; these are never live G0 captures.
test.each(["success", "error", "timeout", "wrong-device", "wrong-aci", "different-linked-device"])("T-UNLINK-AUTHORIZED: %s on active linked device preserves local revocation", async outcome => {
  vi.useFakeTimers();
  try {
    const { authorizeUnlink, unlinkContract } = await import("./unlink.ts");
    // @ts-expect-error Shared synthetic evidence helper.
    const { makeSyntheticEvidence } = await import("../../../scripts/fixtures/signal-test-evidence.mjs");
    // @ts-expect-error Shared ESM evidence owner.
    const { verifySignalEvidence } = await import("./evidence.mjs");
    const f = fixture(), dir = join(f.root, "synthetic-evidence");
    const { pin } = makeSyntheticEvidence(dir);
    const unlink = authorizeUnlink(pin, verifySignalEvidence(pin, dir));
    expect(unlink).toBeDefined();
    if (outcome === "different-linked-device") {
      f.binding.ownDeviceId = 7; f.host.identity!.ownDeviceId = 7;
      const record = JSON.parse(readFileSync(f.record, "utf8")); record.binding = f.binding; put(f.record, record);
    }
    f.options.linkProtocol = { policy: { contracts: { unregister: unlinkContract } },
      startParams: () => ({}), readStart: () => { throw Error("unused"); }, unlink } as any;
    const service = f.make(); await service.start(); expect(service.status().state).toBe("linked");
    if (outcome === "wrong-device") f.host.identity!.ownDeviceId = 1;
    if (outcome === "wrong-aci") f.host.identity!.ownAci = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    if (outcome === "error") f.host.request.mockImplementation(async request => ({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "private", data: { response: { timestamp: NOW, results: [] } } } }));
    if (outcome === "timeout") f.host.request.mockImplementation(async () => new Promise(() => {}));
    const disconnect = service.disconnect(); await vi.advanceTimersByTimeAsync(6000);
    expect(await disconnect).toEqual(["success", "different-linked-device"].includes(outcome) ? { state: "not-linked" } : { state: "not-linked", removeDeviceOnPhone: true });
    expect(f.host.request.mock.calls.filter(([r]) => r.method === "unregister").map(([r]) => r.params)).toEqual(["wrong-device", "wrong-aci"].includes(outcome) ? [] : [{}]);
    if (outcome === "success") expect(f.calls.indexOf("revoke-runs")).toBeLessThan(f.calls.indexOf("unregister"));
    expect(f.calls).toContain("wipe-all"); expect(f.host.stop).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test("T-SOURCE-DERIVED-LINK-WIRING: real host/service handshake reads valid account files", async () => {
  const { createSourceDerivedLinkProtocol } = await import("./adapters.ts");
  const f = fixture(), record = JSON.parse(readFileSync(f.record, "utf8"));
  record.binding = null; record.account = null; record.enabled = false; put(f.record, record);
  const protocol = createSourceDerivedLinkProtocol(); f.options.linkProtocol = protocol;
  const frames: Record<string, unknown> = { version: { version: "source-derived" }, startLink: { deviceLinkUri: "sgnl://linkdevice?uuid=fixture&pub_key=fixture" },
    finishLink: { number: "+15550001234", aci: ACI }, "listAccounts-one": [{ number: "+15550001234", aci: ACI }], subscribeReceive: 0 };
  installG0Child(f, protocol, "source-derived", name => ({ jsonrpc: "2.0", id: 1, result: frames[name] }), () => {
    put(join(f.root, "signal/auth/data/accounts.json"), { accounts: [{ path: "account", uuid: ACI, number: "+15550001234" }] });
    put(join(f.root, "signal/auth/data/account"), { storage: { deviceId: 2 } });
  });
  const service = f.make(); await service.link({ chiefBotId: "chief" });
  await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "linked", binding: { ownAci: ACI, ownDeviceId: 2 } }));
});

test("T-SOURCE-DERIVED-RAW-WIRING: production parser and host create a turn; closed parser creates none", async () => {
  const { createSourceDerivedLinkProtocol, loadSignalAdapters } = await import("./adapters.ts");
  const { sourceDerivedReceive } = await import("./fixtures/source-derived.ts");
  const pin = JSON.parse(readFileSync(new URL("./runtime-pin.json", import.meta.url), "utf8"));
  for (const activeParser of [false, true]) {
    const f = fixture(), protocol = createSourceDerivedLinkProtocol();
    f.options.access = loadSignalAdapters(pin, "server/channels/signal/fixtures/g0").access;
    if (!activeParser) f.options.access = { ...f.options.access, parse: () => null };
    put(join(f.root, "signal/auth/data/accounts.json"), { accounts: [{ path: "account", uuid: ACI, number: "+15550001234" }] });
    put(join(f.root, "signal/auth/data/account"), { storage: { deviceId: 2 } });
    const raw = { jsonrpc: "2.0", method: "receive", params: sourceDerivedReceive() };
    const child = installG0Child(f, protocol, "source-derived", name => name === "own-note" ? raw : ({ jsonrpc: "2.0", id: 1,
      result: name === "version" ? { version: "source-derived" } : name === "listAccounts-one" ? [{ number: "+15550001234", aci: ACI }] : 0 }));
    const service = f.make(); await service.start(); expect(service.status().state).toBe("linked");
    child.receive("own-note"); await service.tick();
    expect(f.turns).toHaveLength(activeParser ? 1 : 0);
  }
});

for(const problem of ["identity-unavailable","link-required"] as const)test(`RED8 restored phone-removal path ${problem} retains its distinct behavior`,async()=>{
 const f=fixture();put(join(f.root,"install-id.json"),{installId:randomUUID()});put(join(f.root,"signal/auth/data/key"),"fake auth");
 const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=>"fixture",boot:()=>"boot",uptime:()=>1};
 parkSignalForDowngrade(f.root,{fence});expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:"ready"});
 const service=f.make();
 if(problem==="identity-unavailable"){
  f.host.spawn.mockRejectedValueOnce(Object.assign(new Error("no identity"),{code:problem}));await service.start();expect(service.status()).toMatchObject({state:"blocked",reason:problem});
  expect(f.calls).toContain("wipe-auth");expect(f.calls).not.toContain("wipe-all");expect(f.calls).not.toContain("revoke-human");
 }else{
  await service.linkRequired();expect(service.status()).toMatchObject({state:"blocked",reason:"link-required"});
  expect(JSON.parse(readFileSync(f.record,"utf8")).removeDeviceOnPhone).toBe(true);
  expect(f.calls).toContain("revoke-human");expect(f.calls).toContain("revoke-runs");expect(f.calls).toContain("wipe-all");
 }
});

for(const pending of ["revoking","restoring","problem"] as const)test(`RED9 real round trip retains pending ${pending} and never normalizes into a live sender`,async()=>{
 const f=fixture();put(join(f.root,"install-id.json"),{installId:randomUUID()});put(join(f.root,"signal/auth/key"),"fake");
 const record=JSON.parse(readFileSync(f.record,"utf8"));if(pending==="problem")record.problem="identity-unavailable";else record[pending]=true;put(f.record,record);
 const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=>"fixture",boot:()=>"boot",uptime:()=>1};parkSignalForDowngrade(f.root,{fence});expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:"ready"});
 expect(JSON.parse(readFileSync(f.record,"utf8"))).toEqual(record);const service=f.make();await service.start();expect(f.host.spawn).not.toHaveBeenCalled();
 if(pending!=="problem"){expect(f.calls).toContain("revoke-human");expect(f.calls).toContain("revoke-runs");}else expect(service.status()).toMatchObject({state:"blocked",reason:"identity-unavailable"});
});
test('RED17 first link commits its strict unlinked record before any child creation',async()=>{
 const f=fixture();removeTempDirSync(join(f.root,'channels'),{strict:true});
 f.options.linkProtocol={policy:{contracts:{startLink:{params:z.strictObject({}),result:z.strictObject({})},finishLink:{params:z.strictObject({}),result:z.strictObject({})}}},startParams:()=>({}),readStart:()=>({uri:'fixture:qr',finishParams:{}})};
 f.host.request.mockImplementation(async req=>({jsonrpc:'2.0',id:req.id,result:req.method==='finishLink'?await new Promise(()=>{}):{}}) as never);
 const spawn=f.host.spawn.getMockImplementation()!;f.host.spawn.mockImplementation(async input=>{expect(JSON.parse(readFileSync(f.record,'utf8'))).toMatchObject({version:1,generation:1,binding:null,enabled:false,paused:true,revoking:false});return spawn(input);});
 const service=f.make();expect(await service.link({chiefBotId:'chief'})).toMatchObject({state:'linking'});expect(f.host.spawn).toHaveBeenCalledOnce();
});
test('RED34 local authority phase revokes people and runs in order without invoking credential operations',async()=>{
 const {revokeSignalLocalAuthority}=await import('./service.ts'),calls:string[]=[];
 const people={revoke:async()=>{calls.push('people');}},revokeRuns=async()=>{calls.push('runs');};
 await revokeSignalLocalAuthority({people,revokeRuns},'old');expect(calls).toEqual(['people','runs']);
});
test('RED19 custody exit event without optional progress still fences every service mutation',async()=>{
 const f=fixture(),service=f.make();await service.start();f.event({kind:'blocked',reason:'kept-check',generation:f.binding.generation});
 expect(service.status()).toMatchObject({state:'blocked',reason:'kept-check',preservation:{progress:'check',canLink:false,canKeepBoth:false}});
 expect(()=>service.disconnect()).toThrow();await expect(service.fixPermissions()).rejects.toThrow();await expect(service.link({chiefBotId:'chief'})).rejects.toThrow();expect(f.calls).not.toContain('wipe-all');expect(f.host.spawn).toHaveBeenCalledOnce();
});
test('RED19 stop publication refusal prevents an ordinary disconnect from reaching credential wipe',async()=>{
 const f=fixture();put(join(f.root,'signal/auth/key'),'RETAIN_UNTIL_CONFIRMED');const service=f.make();await service.start();
 f.host.stop.mockRejectedValueOnce(Object.assign(new Error('kept-check'),{code:'kept-check',preservation:{progress:'durability',canLink:false,canKeepBoth:false}}));
 const status=await service.disconnect();expect(f.calls).not.toContain('wipe-all');expect(status).toMatchObject({state:'blocked',preservation:{progress:'durability',canLink:false}});expect(readFileSync(join(f.root,'signal/auth/key'),'utf8')).toBe('RETAIN_UNTIL_CONFIRMED');expect(()=>service.finishRevocation()).toThrow();
});
