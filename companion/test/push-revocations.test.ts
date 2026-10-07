import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../src/devices.ts";
import type { HarnessCall } from "../src/push-door.ts";
import { createPushRevocations, revokeDeviceSender, watchDeviceRemovals } from "../src/push-revocations.ts";
import { DATA_DIR } from "../src/state.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "push-rev-")); dirs.push(d); return join(d, "push-revocations.json"); };

describe("push revocation queue", () => {
  it("sends each removed device to the harness and forgets it once acknowledged", async () => {
    const send = vi.fn(async () => true);
    const q = createPushRevocations({ file: file(), send, retryMs: 10 });
    q.add("d1");
    await q.flush();
    expect(send).toHaveBeenCalledWith("d1");
    expect(q.pending()).toEqual([]);
  });
  it("keeps an unacknowledged device on disk across a restart", async () => {
    const path = file();
    const q = createPushRevocations({ file: path, send: async () => false, retryMs: 60_000 });
    q.add("d1");
    await q.flush();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(["d1"]);
    const again = vi.fn(async () => true);
    const reborn = createPushRevocations({ file: path, send: again, retryMs: 60_000 });
    await reborn.flush();
    expect(again).toHaveBeenCalledWith("d1");
    expect(reborn.pending()).toEqual([]);
  });
  it("holds at most 200 ids", () => {
    const q = createPushRevocations({ file: file(), send: async () => false, retryMs: 60_000 });
    for (let i = 0; i < 250; i++) q.add(`d${i}`);
    expect(q.pending()).toHaveLength(200);
  });
});

describe("push revocation queue, past the happy path", () => {
  it("drops anything in the file that is not a device id", () => {
    const path = file();
    for (const text of ["not json", "{\"d1\":true}", "null", "\"d1\""]) {
      writeFileSync(path, text);
      expect(createPushRevocations({ file: path, send: async () => false, retryMs: 60_000 }).pending(), text).toEqual([]);
    }
    writeFileSync(path, JSON.stringify(["d1", 5, null, "bad id", "x\r\ny", "", "z".repeat(129), { id: "d3" }, "d2"]));
    expect(createPushRevocations({ file: path, send: async () => false, retryMs: 60_000 }).pending()).toEqual(["d1", "d2"]);
  });

  it("refuses to queue a malformed id", () => {
    const q = createPushRevocations({ file: file(), send: async () => false, retryMs: 60_000 });
    q.add("bad id\r\n");
    expect(q.pending()).toEqual([]);
  });

  it("sends a device added while a flush is already running, in that same flush", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = vi.fn(async (id: string) => { if (id === "d1") await gate; return true; });
    const q = createPushRevocations({ file: file(), send, retryMs: 60_000 });
    q.add("d1");
    q.add("d2");
    release();
    await q.flush();
    expect(send.mock.calls.map((c) => c[0])).toEqual(["d1", "d2"]);
    expect(q.pending()).toEqual([]);
  });

  it("an id re-added while its own send is in flight gets another attempt, not swallowed by that send's 200", async () => {
    // H7 Minor 1: the revoke for d1 is in flight; an enrolment for d1 lands
    // meanwhile and queues d1 again. The in-flight 200 predates that binding.
    const releases: Array<() => void> = [];
    const send = vi.fn((_id: string) => new Promise<boolean>((resolve) => { releases.push(() => resolve(true)); }));
    const q = createPushRevocations({ file: file(), send, retryMs: 60_000 });
    q.add("d1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    q.add("d1");
    releases[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(q.pending()).toEqual(["d1"]);
    releases[1]();
    await q.flush();
    expect(send.mock.calls.map((c) => c[0])).toEqual(["d1", "d1"]);
    expect(q.pending()).toEqual([]);
  });

  it("a re-added id whose in-flight send failed stays queued, once", async () => {
    let fail!: () => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { fail = () => resolve(false); }));
    const q = createPushRevocations({ file: file(), send, retryMs: 60_000 });
    q.add("d1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    q.add("d1");
    fail();
    await q.flush();
    expect(q.pending()).toEqual(["d1"]);
  });

  it("a send that never settles cannot wedge the queue", async () => {
    let hang = true;
    const send = vi.fn((id: string) => (hang && id === "d1" ? new Promise<boolean>(() => {}) : Promise.resolve(true)));
    const q = createPushRevocations({ file: file(), send, retryMs: 60_000, sendTimeoutMs: 50 });
    q.add("d1");
    await q.flush();
    expect(q.pending()).toEqual(["d1"]);
    hang = false;
    await q.flush();
    expect(q.pending()).toEqual([]);
  });
});

describe("telling the harness", () => {
  const PROOF = "a".repeat(64);
  it("sends a fresh header set, and only with a launch proof", async () => {
    const harness = vi.fn<HarnessCall>(async () => ({ status: 200, body: { ok: true } }));
    expect(await revokeDeviceSender(harness, PROOF)("d1")).toBe(true);
    expect(harness).toHaveBeenCalledWith({ method: "POST", path: "/api/mobile/push/revoke-device", body: null,
      headers: { accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": PROOF, "x-murage-push-device": "d1" } });
    expect(await revokeDeviceSender(async () => ({ status: 500, body: {} }), PROOF)("d1")).toBe(false);
    const never = vi.fn<HarnessCall>();
    expect(await revokeDeviceSender(never, undefined)("d1")).toBe(false);
    expect(await revokeDeviceSender(never, "short")("d1")).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it("queues a device the moment the registry removes it", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    const result = registry.redeem(code, "iPhone");
    if ("error" in result) throw new Error(result.error);
    const queue = { add: vi.fn() };
    watchDeviceRemovals(registry, queue);
    expect(queue.add).not.toHaveBeenCalled();
    registry.revoke(result.device.id);
    expect(queue.add).toHaveBeenCalledWith(result.device.id);
  });
});
