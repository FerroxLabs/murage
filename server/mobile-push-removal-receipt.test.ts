// P1 (settings v10, v8/v9 H1): the harness's receipt for one phone removal, keyed (deviceId, generation). A 200 means "queued here", never
// "the relay deleted it"; the same generation replays its receipt; Removed is only `confirmed` or an honest `nothing`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeMobilePush, PushStore } from "./mobile-push-store.ts";
import { mobilePushRoute, type PushRouteDeps } from "./mobile-push-routes.ts";

const B1 = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const B2 = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
const DAY = 24 * 3600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function open(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  return { db, store: new PushStore(db) };
}
function harness(relayAnswer: () => Promise<boolean> = async () => false) {
  const dir = mkdtempSync(join(tmpdir(), "removal-receipt-"));
  dirs.push(dir);
  const file = join(dir, "messages.db");
  const first = open(file);
  first.store.putBinding({ bindingId: B1, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  const relay = { redeem: vi.fn(), publish: vi.fn(), remove: vi.fn(relayAnswer) };
  const depsFor = (store: PushStore): PushRouteDeps => ({
    store, relay: relay as never, outbox: { pending: () => ({ badge: 0, items: [] }) }, authorized: (h) => h["x-murage-companion-token"] === "ok",
    visible: () => true, detail: () => ({ title: "t", body: "b" }), respond: vi.fn(async () => ({ status: 200, body: {} })), now: () => 5000,
  });
  return { file, relay, db: first.db, store: first.store, deps: depsFor(first.store), depsFor };
}
const headers = (device = "d1") => ({ "x-murage-companion-token": "ok", "x-murage-push-device": device });
const post = (deps: PushRouteDeps, body: unknown, device = "d1") =>
  mobilePushRoute({ method: "POST", path: "/api/mobile/push/revoke-device", headers: headers(device), readBody: async () => body }, deps);
const ask = (deps: PushRouteDeps, generation: number, device = "d1", pathDevice = device) =>
  mobilePushRoute({ method: "GET", path: `/api/mobile/push/removal/${pathDevice}/${generation}`, headers: headers(device), readBody: async () => ({}) }, deps);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const rows = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("P1 harness removal receipt", () => {
  it("answers queued while the relay refuses, and a lost reply replays the receipt instead of reading nothing", async () => {
    const { deps, store } = harness();
    expect(await post(deps, { generation: 1 })).toEqual({ status: 200, body: { ok: true, removalId: B1, state: "queued" } });
    await flush();
    expect(store.bindingForDevice("d1")).toBeNull();
    // The reply was lost: the companion asks again for the same removal. The binding is gone, but the relay is still owed.
    expect(await post(deps, { generation: 1 })).toEqual({ status: 200, body: { ok: true, removalId: B1, state: "queued" } });
    expect((await ask(deps, 1))?.body).toEqual({ removalId: B1, state: "queued" });
  });

  it("holds the queued state across a harness restart and flips to confirmed only when the relay confirms", async () => {
    const h = harness();
    await post(h.deps, { generation: 1 });
    await flush();
    h.db.close();
    const reopened = open(h.file);
    const deps = h.depsFor(reopened.store);
    expect((await ask(deps, 1))?.body).toEqual({ removalId: B1, state: "queued" });
    reopened.store.relayRemovalDone(B1);
    expect((await ask(deps, 1))?.body).toEqual({ removalId: B1, state: "confirmed" });
    expect((await post(deps, { generation: 1 }))?.body).toEqual({ ok: true, removalId: B1, state: "confirmed" });
    reopened.db.close();
  });

  it("the fast path confirms the receipt when the relay answers at once", async () => {
    const { deps, store } = harness(async () => true);
    await post(deps, { generation: 1 });
    await flush();
    expect(store.removalReceipt("d1", 1)).toEqual({ removalId: B1, state: "confirmed" });
  });

  it("a give-up marks the receipt abandoned, never confirmed", async () => {
    const { deps, store } = harness();
    await post(deps, { generation: 1 });
    await flush();
    expect(store.relayRemovalFailed(B1, 5000 + 31 * DAY)).toBe("abandoned");
    expect(store.removalReceipt("d1", 1)).toEqual({ removalId: B1, state: "abandoned" });
    expect((await ask(deps, 1))?.body).toEqual({ removalId: B1, state: "abandoned" });
  });

  it("two producers for one removal make one receipt and one owed relay removal", async () => {
    const { deps, db } = harness();
    await post(deps, { generation: 1 });
    await post(deps, { generation: 1 });
    await flush();
    expect(rows(db, "push_removal_receipts")).toBe(1);
    expect(rows(db, "push_relay_removals")).toBe(1);
  });

  it("a re-pair is a new generation with its own receipt, and the old generation still replays", async () => {
    const { deps, store } = harness();
    await post(deps, { generation: 1 });
    await flush();
    store.putBinding({ bindingId: B2, deviceId: "d1", publisherToken: "murage_pt_y", createdAt: 2 });
    expect((await post(deps, { generation: 2 }))?.body).toEqual({ ok: true, removalId: B2, state: "queued" });
    expect((await ask(deps, 1))?.body).toEqual({ removalId: B1, state: "queued" });
    expect((await ask(deps, 2))?.body).toEqual({ removalId: B2, state: "queued" });
  });

  it("nothing is answered only when no binding and no receipt exist for that generation", async () => {
    const { deps, store } = harness();
    expect((await post(deps, { generation: 7 }, "d9"))?.body).toEqual({ ok: true, removalId: null, state: "nothing" });
    expect((await ask(deps, 7, "d9"))?.body).toEqual({ removalId: null, state: "nothing" });
    expect(store.removalReceipt("d9", 7)).toBeNull();
  });

  it("an older companion with no generation keeps the plain answer and writes no receipt", async () => {
    const { deps, db } = harness();
    expect(await post(deps, {})).toEqual({ status: 200, body: { ok: true } });
    expect(rows(db, "push_removal_receipts")).toBe(0);
    expect(rows(db, "push_relay_removals")).toBe(1);
  });

  it("refuses a malformed generation and a read for another device, and the read writes nothing", async () => {
    const { deps, db } = harness();
    for (const body of [{ generation: -1 }, { generation: 1.5 }, { generation: "1" }, { generation: 1, extra: true }, [1]]) {
      expect((await post(deps, body))?.status).toBe(400);
    }
    expect(rows(db, "push_removal_receipts")).toBe(0);
    expect(deps.store.bindingForDevice("d1")).not.toBeNull();
    expect((await ask(deps, 1, "d1", "d2"))?.status).toBe(400);
    expect(rows(db, "push_removal_receipts")).toBe(0);
  });

  it("Check again with no receipt but a binding still live is not 'nothing': it asks the companion to send again", async () => {
    const { deps, store } = harness();
    // a restore or a downgrade lost the receipt while the device is still enrolled
    const answer = await ask(deps, 3);
    expect(answer?.status).toBe(409);
    expect(answer?.body).toMatchObject({ code: "binding_live" });
    expect(store.bindingForDevice("d1")).not.toBeNull();
    expect((await post(deps, { generation: 3 }))?.body).toEqual({ ok: true, removalId: B1, state: "queued" });
  });

  it("an unauthorized caller reaches neither route", async () => {
    const { deps } = harness();
    const bare = { "x-murage-push-device": "d1" };
    expect((await mobilePushRoute({ method: "POST", path: "/api/mobile/push/revoke-device", headers: bare, readBody: async () => ({ generation: 1 }) }, deps))?.status).toBe(404);
    expect((await mobilePushRoute({ method: "GET", path: "/api/mobile/push/removal/d1/1", headers: bare, readBody: async () => ({}) }, deps))?.status).toBe(404);
  });

  it("settled receipts are pruned after 90 days; a queued one never is", async () => {
    const { deps, store, db } = harness();
    await post(deps, { generation: 1 });
    await flush();
    store.prune(5000 + 100 * DAY);
    expect(rows(db, "push_removal_receipts")).toBe(1);
    store.relayRemovalDone(B1);
    store.prune(5000 + 100 * DAY);
    expect(rows(db, "push_removal_receipts")).toBe(0);
  });
});
