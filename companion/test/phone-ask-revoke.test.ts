// S28: revoke publishes to the harness first, then aborts the live forwards; the per-phone switch; a removal that waits for the harness.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAskRevocations } from "../src/ask-revocations.ts";
import { CONTROL_TOKEN_HEADER, createControlServer } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { AskForwards, handlePhoneAsk, handlePhoneBootstrap, PhoneChallenges, phoneHarnessMinted, revokeShareAsk, type PhoneDoorDevices } from "../src/phone-door.ts";
import { createHarnessCall } from "../src/push-door.ts";
import { approvalKeyId } from "../src/phone-jobs-shape.ts";
import { phoneAskMessage } from "../src/phone-ask-shape.ts";
import { DATA_DIR } from "../src/state.ts";
import { KEYS, NOW, statement } from "./support-statement.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const PROOF = "d".repeat(64);
const ORIGIN = "https://desk.example.test";
const tmp = mkdtempSync(join(tmpdir(), "ask-revoke-test-"));
afterAll(() => removeTempDirSync(tmp));
let n = 0;
const qfile = () => join(tmp, `q${++n}.json`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("revokeShareAsk order", () => {
  const rig = (o: { ackNever?: boolean; revoked?: { through: number } | null } = {}) => {
    const log: string[] = [];
    const devices = { revokePhoneAsk: (id: string) => { log.push(`registry:${id}`); return o.revoked === undefined ? { through: 4 } : o.revoked; } };
    const revocations = {
      add: (e: { deviceId: string; through: number }) => { log.push(`add:${e.deviceId}:${e.through}`); },
      acked: (id: string) => { log.push(`ack:${id}`); return o.ackNever ? new Promise<void>(() => {}) : Promise.resolve(); },
      pending: () => [],
    };
    const forwards = new AskForwards();
    const real = forwards.abortAll.bind(forwards);
    forwards.abortAll = (id: string) => { log.push(`abort:${id}`); return real(id); };
    return { log, devices, revocations, forwards };
  };

  it("registry write, then queue add, then abort, then the ack wait, with no await before the abort", async () => {
    const r = rig();
    const pending = revokeShareAsk("devA", r);
    // Nothing has been awaited yet: everything up to the ack wait already ran.
    expect(r.log).toEqual(["registry:devA", "add:devA:4", "abort:devA", "ack:devA"]);
    expect(await pending).toEqual({ acknowledged: true });
  });

  it("aborts the live forwards of that device only, after the entry is queued", async () => {
    const r = rig();
    const mine = r.forwards.add("devA"); const other = r.forwards.add("devB");
    await revokeShareAsk("devA", r);
    expect(mine.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("an ack that does not come within ackWaitMs answers acknowledged false, with the entry still queued", async () => {
    const r = rig({ ackNever: true });
    expect(await revokeShareAsk("devA", { ...r, ackWaitMs: 30 })).toEqual({ acknowledged: false });
    expect(r.log).toContain("add:devA:4");
  });

  it("an unknown device changes nothing and queues nothing", async () => {
    const r = rig({ revoked: null });
    expect(await revokeShareAsk("ghost", r)).toEqual({ acknowledged: true });
    expect(r.log).toEqual(["registry:ghost"]);
  });

  it("a registry write that fails throws before anything is queued or aborted", async () => {
    const r = rig();
    r.devices.revokePhoneAsk = () => { throw new Error("disk"); };
    const f = r.forwards.add("devA");
    await expect(revokeShareAsk("devA", r)).rejects.toThrow("disk");
    expect(r.log).toEqual([]);
    expect(f.signal.aborted).toBe(false);
  });
});

describe("a revoke or switch-off survives a restart of the door", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));
  const reg = () => new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });
  const pair = (r: DeviceRegistry) => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
    const installId = "install-0123456789abcdef";
    const res = r.redeem(r.openPairing().code, "iPhone", undefined, installId, point, statement(installId, point));
    if ("error" in res) throw new Error(res.error);
    return res.device;
  };

  it("after a revoke a new registry (a restart) rejects the old token and mints above the revoked generation", async () => {
    const before = reg();
    const device = pair(before);
    const first = before.issuePhoneAskToken(device.id)!;
    const q = createAskRevocations({ file: qfile(), send: async () => true });
    await revokeShareAsk(device.id, { devices: before, revocations: q, forwards: new AskForwards() });
    expect(before.authenticatePhoneAsk(first.token)).toBeNull();
    const after = reg();
    expect(after.authenticatePhoneAsk(first.token)).toBeNull();
    const next = after.issuePhoneAskToken(device.id)!;
    expect(next.generation).toBeGreaterThan(first.generation);
  });

  it("after a switch-off a restart still refuses to mint, and the stored generation never goes below the revoked one", async () => {
    const before = reg();
    const device = pair(before);
    const first = before.issuePhoneAskToken(device.id)!;
    before.setShareAskAllowed(device.id, false);
    const q = createAskRevocations({ file: qfile(), send: async () => true });
    const { through } = before.revokePhoneAsk(device.id)!;
    expect(through).toBeGreaterThanOrEqual(first.generation);
    const after = reg();
    expect(after.authenticatePhoneAsk(first.token)).toBeNull();
    expect(after.issuePhoneAskToken(device.id)).toBeNull();
    expect(after.list().find((d) => d.id === device.id)?.shareAsk).toBe("off");
    after.setShareAskAllowed(device.id, true);
    expect(after.issuePhoneAskToken(device.id)!.generation).toBeGreaterThan(through);
    void q;
  });
});

describe("the door's loopback call is cancelled by a revoke", () => {
  let server: Server; let port = 0; let hits = 0; let closed = 0;
  beforeAll(async () => {
    server = createServer((req) => { hits++; req.on("close", () => { closed++; }); /* never answers */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.closeAllConnections?.(); server.close(); });

  it("createHarnessCall settles as 502 and drops the socket when its signal aborts", async () => {
    const ac = new AbortController();
    const started = createHarnessCall(port)({ method: "POST", path: "/x", headers: {}, body: Buffer.from("{}"), signal: ac.signal });
    await wait(50);
    ac.abort();
    expect((await started).status).toBe(502);
    await wait(50);
    expect(hits).toBe(1);
    expect(closed).toBe(1);
  });

  it("an already aborted signal never connects", async () => {
    const before = hits;
    expect((await createHarnessCall(port)({ method: "GET", path: "/x", headers: {}, body: null, signal: AbortSignal.abort() })).status).toBe(502);
    expect(hits).toBe(before);
  });

  it("a non-share ask forward passes its signal to the harness call, and a revoke aborts it", async () => {
    const forwards = new AskForwards();
    let seen: AbortSignal | undefined;
    const harness = vi.fn((r: { signal?: AbortSignal }) => { seen = r.signal; return new Promise<{ status: number; body: unknown }>(() => {}); });
    const run = handlePhoneAsk(
      { method: "POST", path: "/api/phones/self/ask", authorization: `Bearer murage_pa_${"A".repeat(43)}`, body: (async function* () { yield Buffer.from("{}"); })() },
      { devices: { authenticatePhoneAsk: () => ({ deviceId: "devA", generation: 2 }) }, harness: harness as never, stream: vi.fn(), doorToken: PROOF, spoolDir: join(tmp, "spool"), forwards },
    );
    await wait(30);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    forwards.abortAll("devA");
    expect((await run).status).toBe(401);
    expect(seen!.aborted).toBe(true);
  });
});

describe("the harness is told which kind of mint it is", () => {
  it("an ask mint sends scope ask; a jobs mint keeps the body it always had", async () => {
    const bodies: unknown[] = [];
    const harness = async (r: { body: Buffer | null }) => { bodies.push(JSON.parse(r.body!.toString("utf8"))); return { status: 200, body: { ok: true } }; };
    expect(await phoneHarnessMinted(harness, PROOF, "devA", undefined, "ask")).toBe("ok");
    expect(await phoneHarnessMinted(harness, PROOF, "devA")).toBe("ok");
    expect(bodies).toEqual([{ deviceId: "devA", scope: "ask" }, { deviceId: "devA" }]);
  });

  it("the bootstrap for scope ask sends the ask scope to minted", async () => {
    removeTempDirSync(DATA_DIR);
    const r = new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
    const installId = "install-0123456789abcdef";
    const paired = r.redeem(r.openPairing().code, "iPhone", undefined, installId, point, statement(installId, point));
    if ("error" in paired) throw new Error(paired.error);
    const keyId = approvalKeyId(point)!;
    const door: PhoneDoorDevices = {
      deviceByApprovalKeyId: (id) => r.deviceByApprovalKeyId(id), issuePhoneJobsToken: (id) => r.issuePhoneJobsToken(id),
      issuePhoneAskToken: (id) => r.issuePhoneAskToken(id), authenticatePhoneAsk: (t) => r.authenticatePhoneAsk(t), clearPhoneAskToken: (id, o) => r.clearPhoneAskToken(id, o),
      authenticatePhoneJobs: (t) => r.authenticatePhoneJobs(t), clearPhoneJobsToken: (id, o) => r.clearPhoneJobsToken(id, o),
    };
    let c = 0;
    const challenges = new PhoneChallenges({ now: () => 1_700_000_000_000, random: () => createHash("sha256").update(`s28${c++}`).digest("base64url") });
    const bodies: unknown[] = [];
    const harness = async (req: { body: Buffer | null }) => { bodies.push(JSON.parse(req.body!.toString("utf8"))); return { status: 200, body: { ok: true } }; };
    const o = { devices: door, challenges, offered: async () => true, offeredAsk: async () => true, harness, doorToken: PROOF };
    const ch = await handlePhoneBootstrap({ method: "GET", path: "/api/phones/self/challenge", query: new URLSearchParams(`key=${keyId}`), body: null, source: "s", origin: ORIGIN }, o);
    const { nonce, expiresAt } = ch.body as { nonce: string; expiresAt: number };
    const signature = sign("sha256", Buffer.from(phoneAskMessage({ origin: ORIGIN, keyId, nonce, expiresAt })), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    const answer = await handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: new URLSearchParams(""), body: Buffer.from(JSON.stringify({ keyId, nonce, expiresAt, signature, scope: "ask" })), source: "s", origin: ORIGIN }, o);
    expect(answer.status).toBe(200);
    expect(bodies).toEqual([{ deviceId: paired.device.id, scope: "ask" }]);
  });
});

describe("control: the per-phone switch and the removal that waits for the harness", () => {
  let control: Server; let port = 0; let devices: DeviceRegistry; let deviceId = "";
  let revokeShareAskCalls: string[] = [];
  let answer: { acknowledged: boolean } = { acknowledged: true };
  let pendingIds: string[] = [];
  const TOKEN = "c".repeat(43);
  const call = async (method: string, path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { [CONTROL_TOKEN_HEADER]: TOKEN } });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  beforeAll(async () => {
    removeTempDirSync(DATA_DIR);
    devices = new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
    const installId = "install-0123456789abcdef";
    const res = devices.redeem(devices.openPairing().code, "iPhone", undefined, installId, point, statement(installId, point));
    if ("error" in res) throw new Error(res.error);
    deviceId = res.device.id;
    control = createControlServer({
      devices, controlToken: () => TOKEN, companionPort: 8810, discovery: () => ({ advertising: false, name: "Test" }),
      revokeShareAsk: async (id) => { revokeShareAskCalls.push(id); devices.revokePhoneAsk(id); return answer; },
      shareAskPending: (id) => pendingIds.includes(id),
    });
    port = await new Promise<number>((r) => control.listen(0, "127.0.0.1", () => r((control.address() as AddressInfo).port)));
  });
  afterAll(() => new Promise<void>((r) => control.close(() => r())));
  beforeEach(() => { revokeShareAskCalls = []; answer = { acknowledged: true }; pendingIds = []; });

  const stateOf = () => devices.list().find((d) => d.id === deviceId)?.shareAsk;

  it("POST share-ask on an unknown device is 404, and on a known one allows it", async () => {
    expect((await call("POST", "/devices/ghost/share-ask")).status).toBe(404);
    devices.issuePhoneAskToken(deviceId);
    expect((await call("POST", `/devices/${deviceId}/share-ask`)).status).toBe(200);
  });

  it("DELETE share-ask switches it off, revokes through revokeShareAsk and answers off after the ack", async () => {
    devices.issuePhoneAskToken(deviceId);
    const r = await call("DELETE", `/devices/${deviceId}/share-ask`);
    expect(r.status).toBe(200);
    expect(revokeShareAskCalls).toEqual([deviceId]);
    expect(stateOf()).toBe("off");
    expect(r.body.devices.find((d: { id: string }) => d.id === deviceId).shareAsk).toBe("off");
    await call("POST", `/devices/${deviceId}/share-ask`);
  });

  it("when the ack is late the control answers 202 turning-off and the state shows turning-off, never off", async () => {
    devices.issuePhoneAskToken(deviceId);
    answer = { acknowledged: false };
    pendingIds = [deviceId];
    const r = await call("DELETE", `/devices/${deviceId}/share-ask`);
    expect(r).toEqual({ status: 202, body: { shareAsk: "turning-off" } });
    const state = await call("GET", "/state");
    expect(state.body.devices.find((d: { id: string }) => d.id === deviceId).shareAsk).toBe("turning-off");
    pendingIds = [];
    expect((await call("GET", "/state")).body.devices.find((d: { id: string }) => d.id === deviceId).shareAsk).toBe("off");
    await call("POST", `/devices/${deviceId}/share-ask`);
  });

  it("the share-ask routes are behind the registry-unavailable guard like the other device changes", async () => {
    expect((await call("PUT", `/devices/${deviceId}/share-ask`)).status).toBe(404);
  });

  it("DELETE /devices/:id with the harness down answers 202 and the device stays pending", async () => {
    devices.issuePhoneAskToken(deviceId);
    answer = { acknowledged: false };
    const r = await call("DELETE", `/devices/${deviceId}`);
    expect(r.status).toBe(202);
    expect(devices.list().find((d) => d.id === deviceId)?.removalPending).toBe(true);
    expect(revokeShareAskCalls).toEqual([deviceId]);
  });

  it("a device with no ask state is removed without waiting for the harness; with the ack it is removed after revokeShareAsk", async () => {
    // Pending entry still counts: the removal waits for it.
    pendingIds = [deviceId];
    answer = { acknowledged: true };
    const r = await call("DELETE", `/devices/${deviceId}`);
    expect(r.status).toBe(200);
    expect(revokeShareAskCalls).toEqual([deviceId]);
    expect(devices.list().some((d) => d.id === deviceId)).toBe(false);
  });
});
