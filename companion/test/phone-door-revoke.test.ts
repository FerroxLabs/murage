// Plan S5: revoke order is harness job map first, door token second.
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlServer, CONTROL_TOKEN_HEADER } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { handlePhoneBearer, phoneHarnessRevoke } from "../src/phone-door.ts";
import { watchDeviceRemovals } from "../src/push-revocations.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const DOOR = "d".repeat(64);
const TOKEN_A = `murage_pj_${"A".repeat(43)}`;
type Req = { method: string; path: string; headers: Record<string, string>; body: Buffer | null };
const ok = { status: 200, body: { revoked: 2 } };

describe("DELETE /api/phones/self (bearer)", () => {
  const setup = (harnessAnswer: () => Promise<{ status: number; body: unknown }>, clear?: () => boolean) => {
    const order: string[] = [];
    const harness = vi.fn(async (r: Req) => { order.push("harness"); void r; return harnessAnswer(); });
    const clearPhoneJobsToken = vi.fn((_id: string) => { order.push("registry"); return clear ? clear() : true; });
    const call = () => handlePhoneBearer(
      { method: "DELETE", path: "/api/phones/self", authorization: `Bearer ${TOKEN_A}`, body: null },
      { devices: { authenticatePhoneJobs: () => ({ deviceId: "devA" }), clearPhoneJobsToken }, harness, jobsHarness: vi.fn(), doorToken: DOOR },
    );
    return { order, harness, clearPhoneJobsToken, call };
  };

  it("calls the harness first, then clears the token, then answers 200", async () => {
    const s = setup(async () => ok);
    const r = await s.call();
    expect(r.status).toBe(200);
    expect(s.order).toEqual(["harness", "registry"]);
    expect(s.clearPhoneJobsToken).toHaveBeenCalledWith("devA");
  });

  it("sends one POST /api/phones/revoke with the launch proof, the proven device and reason switch-off", async () => {
    const s = setup(async () => ok);
    await s.call();
    expect(s.harness).toHaveBeenCalledOnce();
    const req = s.harness.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/phones/revoke");
    expect(req.headers["x-murage-companion-token"]).toBe(DOOR);
    expect(JSON.parse(req.body!.toString("utf8"))).toEqual({ deviceId: "devA", reason: "switch-off" });
  });

  it("a harness 500 keeps the token and answers an error", async () => {
    const s = setup(async () => ({ status: 500, body: { error: "boom" } }));
    const r = await s.call();
    expect(r.status).toBe(502);
    expect(s.clearPhoneJobsToken).not.toHaveBeenCalled();
  });

  it("a harness that never answers, or answers without a revoked count, keeps the token", async () => {
    for (const answer of [async () => ({ status: 502, body: { error: "unavailable" } }), async () => ({ status: 200, body: {} }), async () => { throw new Error("down"); }]) {
      const s = setup(answer as () => Promise<{ status: number; body: unknown }>);
      expect((await s.call()).status).toBe(502);
      expect(s.clearPhoneJobsToken).not.toHaveBeenCalled();
    }
  });

  it("a token that cannot be cleared after the harness write answers an error, and the retry clears it", async () => {
    let fail = true;
    const s = setup(async () => ok, () => { if (fail) throw new Error("ENOSPC"); return true; });
    const first = await s.call();
    expect(first.status).toBe(500);
    expect(JSON.stringify(first.body)).not.toContain("ENOSPC");
    fail = false;
    const retry = await s.call();
    expect(retry.status).toBe(200);
    expect(s.harness).toHaveBeenCalledTimes(2);
    expect(s.order).toEqual(["harness", "registry", "harness", "registry"]);
  });

  it("without a valid door token the harness is not called and the token stays", async () => {
    const harness = vi.fn();
    const clearPhoneJobsToken = vi.fn();
    const r = await handlePhoneBearer(
      { method: "DELETE", path: "/api/phones/self", authorization: `Bearer ${TOKEN_A}`, body: null },
      { devices: { authenticatePhoneJobs: () => ({ deviceId: "devA" }), clearPhoneJobsToken }, harness, jobsHarness: vi.fn(), doorToken: undefined },
    );
    expect(r.status).toBe(503);
    expect(harness).not.toHaveBeenCalled();
    expect(clearPhoneJobsToken).not.toHaveBeenCalled();
  });
});

describe("phoneHarnessRevoke", () => {
  it("is false without the launch proof and never calls the harness", async () => {
    const harness = vi.fn();
    expect(await phoneHarnessRevoke(harness, undefined, "d", "removed")).toBe(false);
    expect(await phoneHarnessRevoke(harness, "short", "d", "removed")).toBe(false);
    expect(harness).not.toHaveBeenCalled();
  });
  it("accepts revoked: 0 (a retry finds nothing left)", async () => {
    expect(await phoneHarnessRevoke(async () => ({ status: 200, body: { revoked: 0 } }), DOOR, "d", "removed")).toBe(true);
  });
});

describe("DELETE /devices/:id (control)", () => {
  let control: Server;
  let port = 0;
  let devices: DeviceRegistry;
  let order: string[] = [];
  let answer: () => Promise<boolean> = async () => true;
  const revokePhoneJobs = vi.fn(async (id: string) => { order.push(`harness:${id}`); return answer(); });
  const disconnected: string[] = [];
  const removedQueue: string[] = [];
  const TOKEN = "c".repeat(43);
  const del = async (id: string) => fetch(`http://127.0.0.1:${port}/devices/${id}`, { method: "DELETE", headers: { [CONTROL_TOKEN_HEADER]: TOKEN } });
  const pair = (name: string) => {
    const { code } = devices.openPairing();
    const r = devices.redeem(code, name);
    if ("error" in r) throw new Error(r.error);
    return r.device.id;
  };

  beforeAll(async () => {
    removeTempDirSync(DATA_DIR);
    devices = new DeviceRegistry();
    watchDeviceRemovals(devices, { add: (id) => { order.push(`relay:${id}`); removedQueue.push(id); } });
    const realRevoke = devices.revoke.bind(devices);
    devices.revoke = (id: string) => { order.push(`registry:${id}`); return realRevoke(id); };
    control = createControlServer({
      devices, controlToken: () => TOKEN, companionPort: 8810,
      discovery: () => ({ advertising: false, name: "Test computer" }),
      disconnectDevice: (id) => { disconnected.push(id); },
      revokePhoneJobs,
    });
    port = await new Promise<number>((resolve) => control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)));
  });
  afterAll(async () => { await new Promise<void>((resolve) => control.close(() => resolve())); });
  beforeEach(() => { order = []; answer = async () => true; revokePhoneJobs.mockClear(); disconnected.length = 0; removedQueue.length = 0; });

  it("harness first, then the registry, then the existing relay notice", async () => {
    const id = pair("Phone with tools");
    devices.issuePhoneJobsToken(id);
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(order).toEqual([`harness:${id}`, `registry:${id}`, `relay:${id}`]);
    expect(removedQueue).toEqual([id]);
    expect(disconnected).toEqual([id]);
    expect(devices.list().some((d) => d.id === id)).toBe(false);
  });

  it("a harness failure keeps the device pending, bars its token, and ends its streams", async () => {
    const id = pair("Phone, harness down");
    const token = devices.issuePhoneJobsToken(id)!;
    answer = async () => false;
    const res = await del(id);
    expect(res.status).toBe(202);
    expect(order).toEqual([`harness:${id}`]);
    expect(devices.list().some((d) => d.id === id)).toBe(true);
    expect(devices.list().find((d) => d.id === id)?.removalPending).toBe(true);
    expect(devices.authenticatePhoneJobs(token)).toBeNull();
    expect(disconnected).toEqual([id]);
    expect(removedQueue).toEqual([]);
    answer = async () => true;
    expect((await del(id)).status).toBe(200);
  });

  it("a harness that throws leaves the device pending too", async () => {
    const id = pair("Phone, harness throws");
    devices.issuePhoneJobsToken(id);
    answer = async () => { throw new Error("down"); };
    expect((await del(id)).status).toBe(202);
    expect(devices.list().some((d) => d.id === id)).toBe(true);
  });

  it("a device with no phone-jobs token is removed without calling the harness", async () => {
    const id = pair("Phone without tools");
    answer = async () => false;
    expect((await del(id)).status).toBe(200);
    expect(revokePhoneJobs).not.toHaveBeenCalled();
  });

  it("an unknown device is still 404 and the harness is not called", async () => {
    expect((await del("missing-device")).status).toBe(404);
    expect(revokePhoneJobs).not.toHaveBeenCalled();
  });
});
