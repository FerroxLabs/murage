// P1 (settings v10): the notifications step of a phone removal is part of the removal. A queue that cannot write the removal down leaves the
// device pending (never "removed"); the step's recorded state is readable by Check again, also after the device row is gone.
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlServer, CONTROL_TOKEN_HEADER } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const TOKEN = "d".repeat(43);
type Status = { state: string; notifications: string; removalId?: string };

describe("a phone removal records its notifications step", () => {
  let servers: Server[] = [];
  let devices: DeviceRegistry;
  beforeEach(() => { removeTempDirSync(DATA_DIR); devices = new DeviceRegistry(); });
  afterEach(async () => { for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve())); servers = []; });

  const start = async (push: { revokePush: (id: string) => unknown; pushRemovalStatus?: (id: string) => Status }) => {
    const control = createControlServer({
      devices, controlToken: () => TOKEN, companionPort: 8810, discovery: () => ({ advertising: false, name: "Test computer" }),
      removalRetryDelaysMs: [60_000], ...push,
    } as never);
    const port = await new Promise<number>((resolve) => control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)));
    servers.push(control);
    return port;
  };
  const pair = () => { const r = devices.redeem(devices.openPairing().code, "Phone"); if ("error" in r) throw new Error(r.error); return r.device.id; };
  const call = (port: number, method: string, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { [CONTROL_TOKEN_HEADER]: TOKEN } });

  it("a notifications queue that could not write the removal down leaves the device pending, and the registry row stays", async () => {
    const port = await start({ revokePush: () => "failed" });
    const id = pair();
    const res = await call(port, "DELETE", `/devices/${id}`);
    expect(res.status).toBe(202);
    expect(new DeviceRegistry().list().some((d) => d.id === id)).toBe(true);
  });

  it("a queue that wrote it down lets the removal finish, and the answer carries the notifications step", async () => {
    const status: Status = { state: "pending", notifications: "harness-queued", removalId: "b1" };
    const port = await start({ revokePush: () => "queued", pushRemovalStatus: () => status });
    const id = pair();
    const res = await call(port, "DELETE", `/devices/${id}`);
    expect(res.status).toBe(200);
    expect(new DeviceRegistry().list().some((d) => d.id === id)).toBe(false);
    expect(((await res.json()) as { removal: Status }).removal).toEqual(status);
  });

  it("Check again reads the recorded step for a device already gone from the list, and writes nothing", async () => {
    const calls: string[] = [];
    const port = await start({ revokePush: () => "queued", pushRemovalStatus: (id) => { calls.push(id); return { state: "removed", notifications: "confirmed" }; } });
    const res = await call(port, "GET", "/devices/dev-gone/removal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "dev-gone", state: "removed", notifications: "confirmed" });
    expect(calls).toEqual(["dev-gone"]);
  });

  it("an unknown device or an unwired queue answers 404, never a guessed Removed", async () => {
    const port = await start({ revokePush: () => "queued", pushRemovalStatus: () => ({ state: "unknown", notifications: "unknown" }) });
    expect((await call(port, "GET", "/devices/dev-x/removal")).status).toBe(404);
    const bare = await start({ revokePush: () => "queued" });
    expect((await call(bare, "GET", "/devices/dev-x/removal")).status).toBe(404);
  });

  it("the read needs the control token like every other route", async () => {
    const port = await start({ revokePush: () => "queued", pushRemovalStatus: () => ({ state: "removed", notifications: "confirmed" }) });
    expect([401, 403]).toContain((await fetch(`http://127.0.0.1:${port}/devices/dev-gone/removal`)).status);
  });
});
