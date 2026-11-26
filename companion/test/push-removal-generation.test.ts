// P1 (settings v10, v8/v9 H1): the companion's push removal queue is keyed by (device, generation), keeps what the harness answered, and
// reads Removed only on the relay's confirmation. A 200 from the harness means "queued there", never "the relay deleted it".
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessCall } from "../src/push-door.ts";
import { createPushRevocations, pushRemovalStatus, revokeDeviceSender, removalCheckSender } from "../src/push-revocations.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) removeTempDirSync(d); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "push-gen-")); dirs.push(d); return join(d, "push-revocations.json"); };
const PROOF = "a".repeat(64);
type Answer = { state: "queued" | "confirmed" | "abandoned" | "nothing"; removalId: string | null };
const queued: Answer = { state: "queued", removalId: "b1" };

describe("push removal queue by generation", () => {
  it("a harness 'queued' answer is not Removed: the entry stays owed until the check says confirmed", async () => {
    const send = vi.fn(async (): Promise<Answer | false> => queued);
    const check = vi.fn(async (): Promise<Answer | false> => queued);
    const q = createPushRevocations({ file: file(), send, check, retryMs: 60_000 });
    expect(q.add("d1")).toBe("queued");
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.pending()).toEqual(["d1"]);
    expect(q.status("d1")).toMatchObject({ state: "pending", notifications: "harness-queued" });
    check.mockResolvedValue({ state: "confirmed", removalId: "b1" });
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.pending()).toEqual([]);
    expect(q.status("d1")).toMatchObject({ state: "removed", notifications: "confirmed" });
  });

  it("survives a companion restart: the removal id is kept, the harness is asked, nothing is sent twice", async () => {
    const path = file();
    const first = createPushRevocations({ file: path, send: async () => queued, check: async () => queued, retryMs: 60_000 });
    first.add("d1");
    await first.flush();
    const send = vi.fn(async (): Promise<Answer | false> => queued);
    const check = vi.fn(async (): Promise<Answer | false> => ({ state: "confirmed", removalId: "b1" }));
    const reborn = createPushRevocations({ file: path, send, check, retryMs: 60_000 });
    expect(reborn.status("d1")).toMatchObject({ state: "pending", notifications: "harness-queued" });
    await reborn.flush();
    expect(send).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(reborn.status("d1")).toMatchObject({ state: "removed" });
    expect(pushRemovalStatus(path, "d1")).toMatchObject({ state: "removed" });
  });

  it("a lost reply is retried with the same generation, so the harness can replay its receipt", async () => {
    const generations: number[] = [];
    let attempt = 0;
    const send = vi.fn(async (_id: string, generation: number): Promise<Answer | false> => { generations.push(generation); return ++attempt === 1 ? false : queued; });
    const q = createPushRevocations({ file: file(), send, check: async () => queued, retryMs: 5 });
    q.add("d1");
    await q.flush();
    await q.flush();
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBe(generations[0]);
    expect(q.status("d1")).toMatchObject({ notifications: "harness-queued" });
  });

  it("a second producer for the same removal is a no-op; a re-add after it settled is a new generation", async () => {
    const generations: number[] = [];
    const send = vi.fn(async (_id: string, generation: number): Promise<Answer | false> => { generations.push(generation); return queued; });
    const q = createPushRevocations({ file: file(), send, check: async () => queued, retryMs: 60_000 });
    q.add("d1");
    await q.flush();
    q.add("d1"); // the registry's own removal event arriving after control's revokePush: same removal, still owed
    await q.flush();
    expect(generations).toHaveLength(1);
    const sends: number[] = [];
    const next = createPushRevocations({ file: file(), send: async (_id, g) => { sends.push(g); return { state: "nothing", removalId: null }; }, retryMs: 60_000 });
    next.add("d3"); await next.flush(); next.add("d3"); await next.flush();
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBeGreaterThan(sends[0]);
  });

  it("the registry's own removal event arriving while the first send is on the wire does not turn a queued removal into 'nothing'", async () => {
    const answers: Answer[] = [queued, { state: "nothing", removalId: null }];
    const send = vi.fn(async (): Promise<Answer | false> => answers.shift() ?? { state: "nothing", removalId: null });
    const q = createPushRevocations({ file: file(), send, check: async () => queued, retryMs: 60_000 });
    q.add("d1");
    q.add("d1"); // same tick: control's revokePush, then devices.revoke firing the removal event with no await between them
    await q.flush();
    await q.flush();
    expect(q.status("d1")).toMatchObject({ state: "pending", notifications: "harness-queued", removalId: "b1" });
  });

  it("a later generation that confirmed settles an earlier abandoned one", async () => {
    const path = file();
    const first = createPushRevocations({ file: path, send: async () => queued, check: async () => ({ state: "abandoned", removalId: "b1" }), retryMs: 60_000 });
    first.add("d1"); await first.flush(); await first.flush();
    expect(first.status("d1").state).toBe("abandoned");
    const second = createPushRevocations({ file: path, send: async () => ({ state: "confirmed", removalId: "b2" }), retryMs: 60_000 });
    second.add("d1"); await second.flush();
    expect(second.status("d1")).toMatchObject({ state: "removed", notifications: "confirmed" });
  });

  it("a check that finds the harness holding no receipt for a live binding sends the same generation again", async () => {
    const generations: number[] = [];
    const send = vi.fn(async (_id: string, g: number): Promise<Answer | false> => { generations.push(g); return queued; });
    const q = createPushRevocations({ file: file(), send, check: async () => "resend", retryMs: 60_000 });
    q.add("d1"); await q.flush(); await q.flush(); await q.flush();
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBe(generations[0]);
  });

  it("abandoned is kept and shown as abandoned, never Removed; nothing is Removed only for a device that had no binding", async () => {
    const q = createPushRevocations({ file: file(), send: async () => queued, check: async () => ({ state: "abandoned", removalId: "b1" }), retryMs: 60_000 });
    q.add("d1");
    await q.flush();
    await q.flush();
    expect(q.status("d1")).toMatchObject({ state: "abandoned", notifications: "abandoned" });
    expect(q.pending()).toEqual([]);
    const none = createPushRevocations({ file: file(), send: async () => ({ state: "nothing", removalId: null }), retryMs: 60_000 });
    none.add("d9");
    await none.flush();
    expect(none.status("d9")).toMatchObject({ state: "removed", notifications: "nothing" });
    expect(createPushRevocations({ file: file(), send: async () => false }).status("never")).toMatchObject({ state: "unknown" });
  });

  it("a failed save is an error to the caller, not swallowed, and the entry is still retried", async () => {
    const d = mkdtempSync(join(tmpdir(), "push-gen-")); dirs.push(d);
    // the queue file's parent is a regular file, so every save fails
    const path = join(d, "blocker", "push-revocations.json");
    writeFileSync(join(d, "blocker"), "x");
    const send = vi.fn(async (): Promise<Answer | false> => queued);
    const q = createPushRevocations({ file: path, send, retryMs: 60_000 });
    expect(q.add("d1")).toBe("failed");
    expect(q.pending()).toEqual(["d1"]);
  });

  it("migrates a legacy list of ids and keeps its entries owed", () => {
    const path = file();
    writeFileSync(path, JSON.stringify(["d1", "d2"]));
    const q = createPushRevocations({ file: path, send: async () => false, retryMs: 60_000 });
    expect(q.pending()).toEqual(["d1", "d2"]);
    expect(q.status("d1")).toMatchObject({ state: "pending", notifications: "not-sent" });
  });
});

describe("telling the harness, with a generation", () => {
  it("posts the generation and reads the receipt; a non-200 or an unreadable answer is a failure", async () => {
    const harness = vi.fn<HarnessCall>(async () => ({ status: 200, body: { ok: true, removalId: "b1", state: "queued" } }));
    expect(await revokeDeviceSender(harness, PROOF)("d1", 12)).toEqual({ state: "queued", removalId: "b1" });
    expect(harness).toHaveBeenCalledWith({ method: "POST", path: "/api/mobile/push/revoke-device", body: Buffer.from(JSON.stringify({ generation: 12 })),
      headers: { accept: "application/json", "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": PROOF, "x-murage-push-device": "d1" } });
    // an older harness answers a plain 200: that is what it always meant, and the entry settles as before instead of being re-sent forever
    expect(await revokeDeviceSender(async () => ({ status: 200, body: { ok: true } }), PROOF)("d1", 1)).toEqual({ state: "confirmed", removalId: null });
    expect(await revokeDeviceSender(async () => ({ status: 200, body: { ok: true, removalId: "x", state: "weird" } }), PROOF)("d1", 1)).toBe(false);
    expect(await revokeDeviceSender(async () => ({ status: 500, body: {} }), PROOF)("d1", 1)).toBe(false);
    expect(await revokeDeviceSender(vi.fn<HarnessCall>(), undefined)("d1", 1)).toBe(false);
  });
  it("Check again answers 'resend' on a 409 binding_live, and false on anything else", async () => {
    expect(await removalCheckSender(async () => ({ status: 409, body: { code: "binding_live" } }), PROOF)("d1", 1)).toBe("resend");
    expect(await removalCheckSender(async () => ({ status: 409, body: { code: "other" } }), PROOF)("d1", 1)).toBe(false);
    expect(await removalCheckSender(async () => ({ status: 500, body: {} }), PROOF)("d1", 1)).toBe(false);
  });
  it("Check again is a GET keyed by device and generation", async () => {
    const harness = vi.fn<HarnessCall>(async () => ({ status: 200, body: { removalId: "b1", state: "confirmed" } }));
    expect(await removalCheckSender(harness, PROOF)("d1", 12)).toEqual({ state: "confirmed", removalId: "b1" });
    expect(harness.mock.calls[0][0]).toMatchObject({ method: "GET", path: "/api/mobile/push/removal/d1/12", body: null });
  });
});
