// A removal that fails after it started stays on the computer as "removal pending": saved before the first harness step, its phone-jobs
// and share-and-ask bearers refused, retried by the companion itself (also after a restart) and by "Try again", cleared only when the
// registry has really dropped the device.
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlServer, CONTROL_TOKEN_HEADER } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { approvalKeyId } from "../src/phone-jobs-shape.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const TOKEN = "d".repeat(43);

describe("DELETE /devices/:id keeps a failed removal pending and retries it", () => {
  let servers: Server[] = [];
  let devices: DeviceRegistry;
  let harnessUp = false;
  let askAck = false;
  let jobsCalls = 0;
  let askCalls = 0;
  let sawPendingOnDiskAtFirstStep: boolean | null = null;
  let firstStepId = "";
  const disconnected: string[] = [];
  const pushRevoked: string[] = [];

  const revokePhoneJobs = async (id: string) => {
    jobsCalls += 1;
    if (sawPendingOnDiskAtFirstStep === null) {
      firstStepId = id;
      sawPendingOnDiskAtFirstStep = new DeviceRegistry().list().find((d) => d.id === id)?.removalPending === true;
    }
    return harnessUp;
  };
  const revokeShareAsk = async (_id: string) => { askCalls += 1; return { acknowledged: askAck }; };

  const start = async (registry: DeviceRegistry, delays = [30]) => {
    const control = createControlServer({
      devices: registry, controlToken: () => TOKEN, companionPort: 8810, discovery: () => ({ advertising: false, name: "Test computer" }),
      revokePhoneJobs, revokeShareAsk, shareAskPending: () => false, disconnectDevice: (id) => { disconnected.push(id); },
      removalRetryDelaysMs: delays, revokePush: (id: string) => { pushRevoked.push(id); },
    });
    const port = await new Promise<number>((resolve) => control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)));
    servers.push(control);
    return port;
  };
  const del = (port: number, id: string) => fetch(`http://127.0.0.1:${port}/devices/${id}`, { method: "DELETE", headers: { [CONTROL_TOKEN_HEADER]: TOKEN } });
  const pair = () => {
    const r = devices.redeem(devices.openPairing().code, "Phone");
    if ("error" in r) throw new Error(r.error);
    const jobs = devices.issuePhoneJobsToken(r.device.id);
    const ask = devices.issuePhoneAskToken(r.device.id);
    if (!jobs || !ask) throw new Error("no tokens");
    return { id: r.device.id, jobs, ask: ask.token };
  };
  const close = async () => { for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve())); servers = []; };

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    devices = new DeviceRegistry();
    harnessUp = false; askAck = false; jobsCalls = 0; askCalls = 0; sawPendingOnDiskAtFirstStep = null; firstStepId = ""; disconnected.length = 0; pushRevoked.length = 0;
  });
  afterEach(close);

  it("a failing step leaves the device pending and saved, and the answer says so", async () => {
    const port = await start(devices, [60_000]);
    const { id } = pair();
    const res = await del(port, id);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { devices: Array<{ id: string; removalPending?: boolean }> };
    expect(body.devices.find((d) => d.id === id)?.removalPending).toBe(true);
    expect(new DeviceRegistry().list().find((d) => d.id === id)?.removalPending).toBe(true);
    // Pending still means gone for the phone: its open streams end at once, not when the removal finally lands.
    expect(disconnected).toContain(id);
  });

  it("the pending flag is on disk before the first harness step", async () => {
    const port = await start(devices, [60_000]);
    const { id } = pair();
    await del(port, id);
    expect(firstStepId).toBe(id);
    expect(sawPendingOnDiskAtFirstStep).toBe(true);
  });

  it("a pending device's phone-jobs and share-and-ask bearers are refused, and none can be minted", async () => {
    const port = await start(devices, [60_000]);
    const { id, jobs, ask } = pair();
    expect(devices.authenticatePhoneJobs(jobs)).toEqual({ deviceId: id });
    expect(devices.authenticatePhoneAsk(ask)?.deviceId).toBe(id);
    await del(port, id);
    expect(devices.authenticatePhoneJobs(jobs)).toBeNull();
    expect(devices.authenticatePhoneAsk(ask)).toBeNull();
    expect(new DeviceRegistry().authenticatePhoneAsk(ask)).toBeNull();
    expect(devices.issuePhoneJobsToken(id)).toBeNull();
    expect(devices.issuePhoneAskToken(id)).toBeNull();
  });

  it("the companion retries by itself and completes the removal once the harness answers", async () => {
    const port = await start(devices, [30]);
    const { id } = pair();
    await del(port, id);
    const before = jobsCalls;
    harnessUp = true; askAck = true;
    await vi.waitFor(() => expect(devices.list().some((d) => d.id === id)).toBe(false), { timeout: 3000 });
    expect(jobsCalls).toBeGreaterThan(before);
    expect(new DeviceRegistry().list().some((d) => d.id === id)).toBe(false);
    expect(disconnected).toContain(id);
  });

  it("a restart resumes a pending removal", async () => {
    const port = await start(devices, [60_000]);
    const { id } = pair();
    await del(port, id);
    await close();
    const restarted = new DeviceRegistry();
    expect(restarted.list().find((d) => d.id === id)?.removalPending).toBe(true);
    disconnected.length = 0;
    harnessUp = true; askAck = true;
    await start(restarted, [60_000]);
    await vi.waitFor(() => expect(disconnected).toContain(id), { timeout: 3000 });
    await vi.waitFor(() => expect(restarted.list().some((d) => d.id === id)).toBe(false), { timeout: 3000 });
  });

  it("deleting a pending device again retries at once, and a retry that still fails keeps it pending", async () => {
    const port = await start(devices, [60_000]);
    const { id } = pair();
    await del(port, id);
    const before = jobsCalls;
    const again = await del(port, id);
    expect(again.status).toBe(202);
    expect(jobsCalls).toBe(before + 1);
    harnessUp = true; askAck = true;
    const done = await del(port, id);
    expect(done.status).toBe(200);
    expect(devices.list().some((d) => d.id === id)).toBe(false);
  });

  it("a removal that cannot even be saved as pending changes nothing and answers 500", async () => {
    const port = await start(devices, [60_000]);
    const { id, jobs } = pair();
    vi.spyOn(devices, "markRemovalPending").mockImplementation(() => { throw new Error("disk"); });
    const res = await del(port, id);
    expect(res.status).toBe(500);
    expect(jobsCalls).toBe(0);
    vi.restoreAllMocks();
    expect(devices.authenticatePhoneJobs(jobs)).toEqual({ deviceId: id });
  });

  it("a write that fails on the very last step keeps the device pending and refused, also after a restart, and the retry then finishes", async () => {
    const port = await start(devices, [40]);
    const { id, jobs, ask } = pair();
    const opened = devices.openSession(id, "Browser");
    if (!opened) throw new Error("no session");
    expect(devices.resolveSession(opened.value)?.device.id).toBe(id);
    harnessUp = true; askAck = true;
    // Fail the write only when it is the record's removal (the device is already gone from memory).
    const writable = devices as unknown as { persist: () => void };
    const realPersist = writable.persist.bind(devices);
    let failing = true;
    writable.persist = () => {
      if (failing && !devices.list().some((d) => d.id === id)) throw new Error("ENOSPC");
      realPersist();
    };
    const res = await del(port, id);
    expect(res.status).toBe(202);
    const row = devices.list().find((d) => d.id === id);
    expect(row?.removalPending).toBe(true);
    expect(devices.authenticatePhoneJobs(jobs)).toBeNull();
    expect(devices.authenticatePhoneAsk(ask)).toBeNull();
    expect(devices.resolveSession(opened.value)).toBeNull();
    expect(disconnected).toContain(id);
    // A simulated restart: a fresh registry over the same file.
    const restarted = new DeviceRegistry();
    expect(restarted.list().find((d) => d.id === id)?.removalPending).toBe(true);
    expect(restarted.authenticatePhoneJobs(jobs)).toBeNull();
    expect(restarted.authenticatePhoneAsk(ask)).toBeNull();
    expect(restarted.resolveSession(opened.value)).toBeNull();
    // The write works again: the companion's own retry completes the removal.
    failing = false;
    await vi.waitFor(() => expect(devices.list().some((d) => d.id === id)).toBe(false), { timeout: 3000 });
    expect(new DeviceRegistry().list().some((d) => d.id === id)).toBe(false);
    expect(disconnected).toContain(id);
  });
  describe("every other credential of a pending device is refused too", () => {
    const BINDING = "11111111-1111-4111-8111-111111111111";
    const setup = async (delays = [60_000]) => {
      const port = await start(devices, delays);
      const p = pair();
      const push = devices.issuePushTokens(p.id, BINDING);
      if (!push) throw new Error("no push tokens");
      const opened = devices.openSession(p.id, "Browser");
      if (!opened) throw new Error("no session");
      return { port, ...p, push, session: opened.value };
    };

    it("push detail and respond tokens stop working at pending time, also after a restart, and none can be minted", async () => {
      const { port, id, push } = await setup();
      expect(devices.authenticatePush(push.detail, "detail")).toEqual({ deviceId: id, bindingId: BINDING });
      expect(devices.authenticatePush(push.respond, "respond")).toEqual({ deviceId: id, bindingId: BINDING });
      await del(port, id);
      expect(devices.authenticatePush(push.detail, "detail")).toBeNull();
      expect(devices.authenticatePush(push.respond, "respond")).toBeNull();
      expect(devices.pushBinding(id)).toBeNull();
      expect(devices.issuePushTokens(id, BINDING)).toBeNull();
      const restarted = new DeviceRegistry();
      expect(restarted.authenticatePush(push.detail, "detail")).toBeNull();
      expect(restarted.authenticatePush(push.respond, "respond")).toBeNull();
      expect(restarted.pushBinding(id)).toBeNull();
      expect(restarted.issuePushTokens(id, BINDING)).toBeNull();
    });

    it("browser sessions are refused and no new session opens, also after a restart", async () => {
      const { port, id, session } = await setup();
      expect(devices.resolveSession(session)?.device.id).toBe(id);
      await del(port, id);
      expect(devices.resolveSession(session)).toBeNull();
      expect(devices.openSession(id, "Again")).toBeNull();
      const restarted = new DeviceRegistry();
      expect(restarted.resolveSession(session)).toBeNull();
      expect(restarted.openSession(id, "Again")).toBeNull();
    });

    it("the device bearer from pairing is refused while pending, also after a restart", async () => {
      const port = await start(devices, [60_000]);
      const r = devices.redeem(devices.openPairing().code, "Phone");
      if ("error" in r) throw new Error(r.error);
      expect(devices.authenticate(r.token)?.id).toBe(r.device.id);
      await del(port, r.device.id);
      expect(devices.authenticate(r.token)).toBeNull();
      expect(new DeviceRegistry().authenticate(r.token)).toBeNull();
    });

    it("a replayed pairing request does not hand a pending device its bearer back", async () => {
      const port = await start(devices, [60_000]);
      const window = devices.openPairing();
      const requestId = "replay-request-0123456789";
      const r = devices.redeem(window.code, "Phone", requestId);
      if ("error" in r) throw new Error(r.error);
      await del(port, r.device.id);
      const again = devices.redeem(window.code, "Phone", requestId);
      expect("error" in again).toBe(true);
    });

    it("the approval-key lookup does not find a pending device, so no phone-jobs or ask token is offered to it", async () => {
      const port = await start(devices, [60_000]);
      const p = pair();
      const dev = (devices as unknown as { devices: Array<{ id: string; installId?: string; approvalKey?: { point: string } }> }).devices.find((d) => d.id === p.id)!;
      dev.installId = "install-0123456789abcdef"; dev.approvalKey = { point: "04" + "ab".repeat(64) };
      const keyId = approvalKeyId(dev.approvalKey.point)!;
      expect(devices.deviceByApprovalKeyId(keyId)).toMatchObject({ ok: true });
      await del(port, p.id);
      expect(devices.deviceByApprovalKeyId(keyId)).toMatchObject({ ok: false });
    });

    it("the companion tells the push queue at pending time, and the retry then finishes the removal", async () => {
      const { port, id, push } = await setup([30]);
      await del(port, id);
      expect(pushRevoked).toContain(id);
      expect(devices.authenticatePush(push.detail, "detail")).toBeNull();
      harnessUp = true; askAck = true;
      await vi.waitFor(() => expect(devices.list().some((d) => d.id === id)).toBe(false), { timeout: 3000 });
      expect(new DeviceRegistry().list().some((d) => d.id === id)).toBe(false);
    });

    it("after a restart the resumed removal queues the push revocation again", async () => {
      const { port, id } = await setup();
      await del(port, id);
      await close();
      pushRevoked.length = 0;
      await start(new DeviceRegistry(), [60_000]);
      await vi.waitFor(() => expect(pushRevoked).toContain(id), { timeout: 3000 });
    });
  });
});
