import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush, type PushEventRow } from "./mobile-push-store.ts";
import { respondFromPush } from "./mobile-push-respond.ts";
import { mobilePushRoute, type PushRouteDeps } from "./mobile-push-routes.ts";
import { pushDetail } from "./mobile-push-detail.ts";

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const REF = "a".repeat(64);
function setup(over: Partial<PushRouteDeps> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  const row: PushEventRow = { eventRef: REF, bindingId: B, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
    messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 1, timeSensitive: true, resolvedBy: null,
    createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0 };
  store.insertEvent(row);
  const relay = { redeem: vi.fn(async () => ({ bindingId: "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d", publisherToken: "murage_pt_y" })), publish: vi.fn(), remove: vi.fn(async () => true) };
  const deps: PushRouteDeps = {
    store, relay, outbox: { pending: () => ({ badge: 1, items: [] }) }, authorized: (h) => h["x-murage-companion-token"] === "ok",
    visible: () => true, detail: () => ({ title: "Lena needs approval", body: "rm x" }),
    respond: vi.fn(async () => ({ status: 200, body: { ok: true, outcome: "rejected" } })), now: () => 5000, ...over,
  };
  return { store, relay, deps };
}
const headers = (extra: Record<string, string> = {}) => ({ "x-murage-companion-token": "ok", "x-murage-push-device": "d1", ...extra });
const bearer = (scope: string) => headers({ "x-murage-push-binding": B, "x-murage-push-scope": scope });
const call = (deps: PushRouteDeps, method: string, path: string, h: Record<string, string>, body: unknown = {}) =>
  mobilePushRoute({ method, path, headers: h, readBody: async () => body }, deps);

describe("harness push routes", () => {
  it("stores explicit preview consent for only the proven phone and applies it to detail immediately", async () => {
    const { deps, store } = setup();
    store.putBinding({ bindingId: "other", deviceId: "d2", publisherToken: "token", createdAt: 1 });
    deps.detail = event => pushDetail(event, { bot: () => ({ id: "lena", name: "Lena", threadId: "t1" }),
      message: () => ({ card: { subtitle: "PRIVATE TOOL INPUT" } }), prefs: undefined,
      previewContent: store.binding(event.bindingId)?.previewContent }, new Date());
    const path = "/api/mobile/push/preferences";
    expect(await call(deps, "GET", path, headers())).toEqual({ status: 200, body: { previewContent: false } });
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.body)
      .toMatchObject({ title: "Murage", body: "Your attention is needed." });
    expect(await call(deps, "POST", path, headers(), { previewContent: true })).toEqual({ status: 200, body: { previewContent: true } });
    expect(store.bindingForDevice("d2")?.previewContent).toBe(false);
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.body)
      .toMatchObject({ title: "Lena needs approval", body: "PRIVATE TOOL INPUT" });
    expect((await call(deps, "POST", path, headers(), { previewContent: false }))?.status).toBe(200);
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.body)
      .toMatchObject({ title: "Murage", body: "Your attention is needed." });
  });
  it("refuses unproven, bearer-only and malformed preview choices", async () => {
    const { deps, store } = setup();
    const path = "/api/mobile/push/preferences";
    expect((await call(deps, "POST", path, {}, { previewContent: true }))?.status).toBe(404);
    expect((await call(deps, "POST", path, bearer("detail"), { previewContent: true }))?.status).toBe(401);
    for (const body of [null, {}, { previewContent: "true" }, { previewContent: true, bindingId: "other" }]) {
      expect((await call(deps, "POST", path, headers(), body))?.status).toBe(400);
    }
    expect(store.binding(B)?.previewContent).toBe(false);
  });
  it("ignores other paths and hides every route without the proof", async () => {
    const { deps } = setup();
    expect(await call(deps, "GET", "/api/bots", headers())).toBeNull();
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, { ...bearer("detail"), "x-murage-companion-token": "forged" }))?.status).toBe(404);
  });

  it("serves the detail for this binding's live, visible event", async () => {
    const { deps } = setup();
    expect(await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))
      .toEqual({ status: 200, body: { title: "Lena needs approval", body: "rm x", target: { bindingId: B, threadId: "t1", messageId: "m1", requestId: "req-1" } } });
  });

  it("a thread hidden since the push answers unavailable", async () => {
    const { deps } = setup({ visible: () => false });
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.status).toBe(404);
  });

  it("a thread hidden since the push is as unavailable to respond as to detail, and nothing runs (B7)", async () => {
    let visible = true;
    const answer = vi.fn(async () => "allowed-once");
    const { deps, store } = setup();
    deps.visible = () => visible;
    deps.respond = (input) => respondFromPush(input, { store, now: () => 5000, visible: (threadId) => deps.visible(threadId), liveRating: () => "low", card: () => ({ pending: true }), answer, log: () => {} });
    visible = false;
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.status).toBe(404);
    const res = await call(deps, "POST", "/api/mobile/push/respond", bearer("respond"), { requestId: "req-1", decision: "deny", revision: 1 });
    expect(res?.status).toBe(404);
    expect(answer).not.toHaveBeenCalled();
  });

  it("an expired event, another binding's event and the wrong scope answer as they should", async () => {
    expect((await call(setup({ now: () => 20_000 }).deps, "GET", `/api/mobile/push/${REF}`, bearer("detail")))?.status).toBe(404);
    expect((await call(setup().deps, "GET", `/api/mobile/push/${REF}`, headers({ "x-murage-push-binding": "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d", "x-murage-push-scope": "detail" })))?.status).toBe(401);
    expect((await call(setup().deps, "GET", `/api/mobile/push/${REF}`, bearer("respond")))?.status).toBe(401);
  });

  it("lists pending work and hands respond on with the proven ids", async () => {
    const { deps } = setup();
    expect(await call(deps, "GET", "/api/mobile/push/pending", bearer("detail"))).toEqual({ status: 200, body: { badge: 1, items: [] } });
    await call(deps, "POST", "/api/mobile/push/respond", bearer("respond"), { requestId: "req-1", decision: "deny", revision: 1 });
    expect(deps.respond).toHaveBeenCalledWith({ deviceId: "d1", bindingId: B, body: { requestId: "req-1", decision: "deny", revision: 1 } });
  });

  it("enrol redeems the grant, replaces the device's old binding and removes it at the relay", async () => {
    const { deps, store, relay } = setup();
    const result = await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" });
    expect(result).toEqual({ status: 200, body: { bindingId: "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d" } });
    expect(store.bindingForDevice("d1")?.bindingId).toBe("a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d");
    expect(relay.remove).toHaveBeenCalledWith(expect.objectContaining({ bindingId: B }));
  });

  it("enrol and a tokens check record when this device's token pair expires", async () => {
    const { deps, store } = setup();
    const ttl = 30 * 24 * 3600_000;
    await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" });
    expect(store.bindingForDevice("d1")?.tokenExpiresAt).toBe(5000 + ttl);
    deps.now = () => 9000;
    await call(deps, "GET", "/api/mobile/push/binding", headers());
    expect(store.bindingForDevice("d1")?.tokenExpiresAt).toBe(9000 + ttl);
  });

  it("enrol says push is off when the host has no relay", async () => {
    expect((await call(setup({ relay: null }).deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }))?.status).toBe(503);
  });

  it("revoke-device drops the binding here and at the relay, and is idempotent", async () => {
    const { deps, store, relay } = setup();
    expect(await call(deps, "POST", "/api/mobile/push/revoke-device", headers())).toEqual({ status: 200, body: { ok: true } });
    expect(store.bindingForDevice("d1")).toBeNull();
    expect(relay.remove).toHaveBeenCalledTimes(1);
    expect(await call(deps, "POST", "/api/mobile/push/revoke-device", headers())).toEqual({ status: 200, body: { ok: true } });
  });

  it("binding answers what the harness holds for the device", async () => {
    const { deps } = setup();
    expect(await call(deps, "GET", "/api/mobile/push/binding", headers())).toEqual({ status: 200, body: { bindingId: B } });
    expect((await call(deps, "GET", "/api/mobile/push/binding", headers({ "x-murage-push-device": "d9" })))?.status).toBe(404);
  });

  it("another binding's event reads exactly like one that does not exist", async () => {
    const { deps, store } = setup();
    const other = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
    const REF2 = "e".repeat(64);
    store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_z", createdAt: 1 });
    store.insertEvent({ ...(store.event(B, REF) as PushEventRow), eventRef: REF2, bindingId: other });
    const missing = await call(deps, "GET", `/api/mobile/push/${"f".repeat(64)}`, bearer("detail"));
    expect(missing?.status).toBe(404);
    expect(await call(deps, "GET", `/api/mobile/push/${REF2}`, bearer("detail"))).toEqual(missing);
    // and the owner still reads it
    expect((await call(deps, "GET", `/api/mobile/push/${REF2}`, headers({ "x-murage-push-device": "d2", "x-murage-push-binding": other, "x-murage-push-scope": "detail" })))?.status).toBe(200);
  });

  it("each bearer route takes only its own scope and a proven binding", async () => {
    const { deps } = setup();
    expect((await call(deps, "GET", "/api/mobile/push/pending", bearer("respond")))?.status).toBe(401);
    expect((await call(deps, "POST", "/api/mobile/push/respond", bearer("detail"), { requestId: "req-1", decision: "allow", revision: 1 }))?.status).toBe(401);
    expect((await call(deps, "GET", "/api/mobile/push/pending", headers({ "x-murage-push-scope": "detail" })))?.status).toBe(401);
    expect((await call(deps, "GET", `/api/mobile/push/${REF}`, headers({ "x-murage-push-binding": B })))?.status).toBe(401);
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("unknown push paths and bad device headers are no route", async () => {
    const { deps } = setup();
    expect((await call(deps, "GET", "/api/mobile/push/tokens", bearer("detail")))?.status).toBe(404);
    expect((await call(deps, "POST", `/api/mobile/push/${REF}`, bearer("detail")))?.status).toBe(404);
    expect((await call(deps, "GET", "/api/mobile/push/binding", headers({ "x-murage-push-device": "../d1" })))?.status).toBe(404);
  });

  it("enrol refuses a malformed or unredeemable grant", async () => {
    const { deps, relay } = setup();
    expect(await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "nope" })).toMatchObject({ status: 400, body: { code: "bad_grant" } });
    expect(relay.redeem).not.toHaveBeenCalled();
    relay.redeem.mockResolvedValueOnce(null as never);
    expect(await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" })).toMatchObject({ status: 400, body: { code: "bad_grant" } });
    expect(await call(deps, "POST", "/api/mobile/push/enrol", headers(), null)).toMatchObject({ status: 400, body: { code: "bad_grant" } });
  });

  it("a relay that does not answer about the grant is an outage, not a bad grant (final review I1)", async () => {
    const { deps, relay, store } = setup();
    relay.redeem.mockResolvedValueOnce("unavailable" as never);
    expect(await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }))
      .toMatchObject({ status: 503, body: { code: "relay_unavailable" } });
    expect(store.bindingForDevice("d1")?.bindingId).toBe(B);
  });

  it("with push off, enrol and the binding lookup both say push_off, so the door can tell the page", async () => {
    const { deps } = setup({ relay: null });
    expect(await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }))
      .toMatchObject({ status: 503, body: { code: "push_off" } });
    expect(await call(deps, "GET", "/api/mobile/push/binding", headers())).toMatchObject({ status: 503, body: { code: "push_off" } });
  });

  it("a relay that throws on remove does not break enrol or revoke", async () => {
    const { deps, relay, store } = setup();
    relay.remove.mockRejectedValue(new Error("offline"));
    expect((await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }))?.status).toBe(200);
    expect(await call(deps, "POST", "/api/mobile/push/revoke-device", headers())).toEqual({ status: 200, body: { ok: true } });
    expect(store.bindingForDevice("d1")).toBeNull();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const GRANT = "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const NEW = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";

  it("revoke-device answers once the removal is queued; a relay that refuses leaves it queued for the sweep", async () => {
    const { deps, store, relay } = setup();
    relay.remove.mockResolvedValue(false);
    expect(await call(deps, "POST", "/api/mobile/push/revoke-device", headers())).toEqual({ status: 200, body: { ok: true } });
    await flush();
    expect(store.bindingForDevice("d1")).toBeNull();
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toMatchObject([{ bindingId: B, publisherToken: "murage_pt_x" }]);
  });

  it("the fast path clears the queued removal when the relay confirms it", async () => {
    const { deps, store } = setup();
    await call(deps, "POST", "/api/mobile/push/revoke-device", headers());
    await flush();
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: GRANT });
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it("with push off, revoke-device still drops the binding and queues it for when a relay returns", async () => {
    const { deps, store } = setup({ relay: null });
    expect(await call(deps, "POST", "/api/mobile/push/revoke-device", headers())).toEqual({ status: 200, body: { ok: true } });
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toMatchObject([{ bindingId: B }]);
  });

  it("enrol rotation queues the old binding when the relay refuses its removal", async () => {
    const { deps, store, relay } = setup();
    relay.remove.mockResolvedValue(false);
    expect((await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: GRANT }))?.status).toBe(200);
    await flush();
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toMatchObject([{ bindingId: B, publisherToken: "murage_pt_x" }]);
  });

  it("enrol that cannot save the redeemed binding queues it for removal, keeps the old one, and answers 5xx", async () => {
    const { deps, store, relay } = setup();
    relay.remove.mockResolvedValue(false);
    vi.spyOn(store, "putBinding").mockImplementation(() => { throw new Error("disk I/O error"); });
    const result = await call(deps, "POST", "/api/mobile/push/enrol", headers(), { grant: GRANT });
    expect(result?.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("murage_pt_");
    await flush();
    expect(store.bindingForDevice("d1")?.bindingId).toBe(B);
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toMatchObject([{ bindingId: NEW, publisherToken: "murage_pt_y" }]);
  });

  it("respond answers bad_request when its body cannot be read", async () => {
    const { deps } = setup();
    const result = await mobilePushRoute({ method: "POST", path: "/api/mobile/push/respond", headers: bearer("respond"), readBody: async () => { throw new Error("bad json"); } }, deps);
    expect(result).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(deps.respond).not.toHaveBeenCalled();
  });
});
