// A removed phone's jobs bearer must stop working as soon as the harness has heard the removal, even when the later share and ask step
// cannot be acknowledged: the harness bar (phone_revocations) can be lost to a backup downgrade, the hash on disk must not outlive it.
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlServer, CONTROL_TOKEN_HEADER } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

describe("DELETE /devices/:id clears the phone-jobs token once the harness has answered", () => {
  let control: Server;
  let port = 0;
  let devices: DeviceRegistry;
  let ack = false;
  const revokePhoneJobs = vi.fn(async (_id: string) => true);
  const revokeShareAsk = vi.fn(async (_id: string) => ({ acknowledged: ack }));
  const TOKEN = "c".repeat(43);
  const del = (id: string) => fetch(`http://127.0.0.1:${port}/devices/${id}`, { method: "DELETE", headers: { [CONTROL_TOKEN_HEADER]: TOKEN } });
  const pairWithJobsToken = () => {
    const r = devices.redeem(devices.openPairing().code, "Phone");
    if ("error" in r) throw new Error(r.error);
    const bearer = devices.issuePhoneJobsToken(r.device.id);
    if (!bearer) throw new Error("no token");
    return { id: r.device.id, bearer };
  };

  beforeAll(async () => {
    removeTempDirSync(DATA_DIR);
    devices = new DeviceRegistry();
    control = createControlServer({
      devices, controlToken: () => TOKEN, companionPort: 8810, discovery: () => ({ advertising: false, name: "Test computer" }),
      revokePhoneJobs, revokeShareAsk, shareAskPending: () => true,
    });
    port = await new Promise<number>((resolve) => control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)));
  });
  afterAll(async () => { await new Promise<void>((resolve) => control.close(() => resolve())); });
  beforeEach(() => { ack = false; revokePhoneJobs.mockClear(); revokeShareAsk.mockClear(); vi.restoreAllMocks(); });

  it("share and ask not acknowledged: 202, the device stays pending, the jobs bearer no longer authenticates", async () => {
    const { id, bearer } = pairWithJobsToken();
    expect(devices.authenticatePhoneJobs(bearer)).toEqual({ deviceId: id });
    const res = await del(id);
    expect(res.status).toBe(202);
    expect(revokeShareAsk).toHaveBeenCalledWith(id);
    expect(devices.list().some((d) => d.id === id)).toBe(true);
    expect(devices.authenticatePhoneJobs(bearer)).toBeNull();
  });

  it("the clear cannot be saved: the device stays pending, share and ask not asked, the bearer barred by the pending flag", async () => {
    const { id, bearer } = pairWithJobsToken();
    vi.spyOn(devices, "clearPhoneJobsToken").mockImplementation(() => { throw new Error("disk"); });
    const res = await del(id);
    expect(res.status).toBe(202);
    expect(revokeShareAsk).not.toHaveBeenCalled();
    expect(devices.list().some((d) => d.id === id)).toBe(true);
    vi.restoreAllMocks();
    expect(devices.authenticatePhoneJobs(bearer)).toBeNull();
    expect(devices.list().find((d) => d.id === id)?.removalPending).toBe(true);
  });
});
