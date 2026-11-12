import { phoneOwnerRoute } from "./owner-routes.ts";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PhoneCallService, servePhoneTool } from "./service.ts";
import { RevisionStore, defaultSettings } from "./settings.ts";
import { SqliteCallStore } from "./store.ts";
import { VapiAdapter } from "./vapi-adapter.ts";
import { recordPhoneTurn, forgetAllPhoneTurns } from "./phone-turns.ts";
import { PHONE_SECRETS_ENV, loadPhoneSecretsFromEnv, _resetPhoneSecretsForTest } from "./phone-secrets.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const args = { to: "+15550123456", goal: "Book" };
beforeEach(() => loadPhoneSecretsFromEnv({ [PHONE_SECRETS_ENV]: JSON.stringify({ key: "fake", origin: "https://api.vapi.ai" }) }));
afterEach(() => { _resetPhoneSecretsForTest(); forgetAllPhoneTurns(); });
function fixture(file = ":memory:") {
  const db = new DatabaseSync(file);
  const store = new SqliteCallStore(db);
  const revisions = new RevisionStore();
  const fetch = vi.fn<import("./vapi-adapter.ts").FetchLike>(async (_url: string, init: { method: string; body?: string }) => ({ status: 200, json: async () => init.method === "POST" ? { id: "vendor-1", status: "scheduled" } : [] }));
  const adapter = new VapiAdapter(fetch);
  const service = new PhoneCallService(adapter, revisions, () => "en", () => {}, store);
  return { db, store, revisions, fetch, adapter, service };
}
it("persists before send and reconciles a lost response after restart without another POST", async () => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    let name = "";
    f.fetch.mockImplementationOnce(async (_url, init) => {
      name = JSON.parse(init.body!).name;
      expect(f.store.get(name)?.status).toBe("uncertain");
      throw new Error("response lost");
    });
    expect((await f.service.place(args)).ok).toBe(false);
    expect([...f.store.live()]).toHaveLength(1);
    const posts = f.fetch.mock.calls.filter(c => c[1].method === "POST").length;
    expect(await f.service.place({ ...args, goal: "Different task" })).toMatchObject({ ok: false });
    expect(f.fetch.mock.calls.filter(c => c[1].method === "POST")).toHaveLength(posts);
    const restarted = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, f.store);
    const before = f.fetch.mock.calls.length;
    f.fetch.mockImplementationOnce(async () => ({ status: 200, json: async () => [{ id: "accepted", name, status: "scheduled" }] }));
    expect(await restarted.place(args)).toMatchObject({ ok: true, value: { call: name, status: "scheduled" } });
    expect(f.fetch.mock.calls.slice(before).map(c => c[1].method)).toEqual(["GET"]);
    expect(f.store.get(name)?.vendorId).toBe("accepted");
  } finally { f.db.close(); }
});
it("persistence failure before send makes no provider call; failure after send retains uncertainty", async () => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    const put = vi.spyOn(f.store, "put");
    put.mockImplementationOnce(() => { throw new Error("disk full"); });
    const before = f.fetch.mock.calls.length;
    await expect(f.service.place(args)).rejects.toThrow("disk full");
    expect(f.fetch).toHaveBeenCalledTimes(before);
    put.mockRestore();
    let count = 0;
    const real = f.store.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation(row => { if (++count === 2) throw new Error("disk full"); real(row); });
    expect(await f.service.place(args)).toMatchObject({ ok: false });
    expect([...f.store.live()][0].status).toBe("uncertain");
    const sent = f.fetch.mock.calls.length;
    await f.service.place(args);
    expect(f.fetch.mock.calls.slice(sent).every(c => c[1].method === "GET")).toBe(true);
  } finally { f.db.close(); }
});
it("settings save invalidates a pending Ask's turn; a fresh turn can execute", async () => {
  const f = fixture();
  const claim = { botId: "bot", threadId: "thread", generation: "old" };
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    recordPhoneTurn("old", claim);
    expect(f.service.askPreview(args)?.settings_revision).toBe(1);
    await f.service.saveSettings({ ...defaultSettings("other", "Owner"), recordAudio: true });
    const before = f.fetch.mock.calls.length;
    expect(await servePhoneTool(() => f.service, "phone_call_place", claim, args)).toEqual({ error: "not_set_up" });
    expect(f.fetch).toHaveBeenCalledTimes(before);
    recordPhoneTurn("new", claim);
    expect(await servePhoneTool(() => f.service, "phone_call_place", { ...claim, generation: "new" }, args)).toMatchObject({ settings_revision: 2 });
  } finally { f.db.close(); }
});
it("a 500 response retains the uncertain call and its superseded assistant", async () => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    f.fetch.mockImplementationOnce(async () => ({ status: 500, json: async () => ({}) }));
    expect(await f.service.place(args)).toMatchObject({ ok: false, error: "vendor_unreachable" });
    await f.service.saveSettings(defaultSettings("other", "Owner"));
    expect(f.service.revisionsInUse().has(1)).toBe(true);
    expect([...f.store.live()][0].status).toBe("uncertain");
    expect(f.fetch.mock.calls.filter(c => c[1].method === "DELETE")).toHaveLength(0);
  } finally { f.db.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it.each(["result", "retry", "creation", "creation rejection"] as const)("late %s response preserves a reconciled cancellation", async path => {
  const f = fixture();
  const entered = gate();
  const delayed = gate();
  const request = { ...args, when: "2026-12-01T10:00:00Z" };
  let pending: ReturnType<PhoneCallService["place"]> | undefined;
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    if (path.startsWith("creation")) {
      f.fetch.mockImplementationOnce(async () => {
        entered.release();
        await delayed.promise;
        return { status: path === "creation rejection" ? 400 : 200, json: async () => ({ id: "accepted", status: "scheduled" }) };
      });
      pending = f.service.place(request);
      await entered.promise;
    } else {
      f.fetch.mockRejectedValueOnce(new Error("response lost"));
      expect(await f.service.place(request)).toMatchObject({ ok: false });
    }
    const id = [...f.store.live()][0].id;
    const response = () => ({ status: 200, json: async () => [{ id: "accepted", name: id, status: "scheduled" }] });
    if (!path.startsWith("creation")) {
      f.fetch.mockImplementationOnce(async () => {
        entered.release();
        await delayed.promise;
        return response();
      });
      pending = path === "retry" ? f.service.place(request) : f.service.result({ call: id });
      await entered.promise;
    }
    // A second reconciliation completes and the owner cancels while the first response waits.
    f.fetch.mockImplementationOnce(async () => response());
    expect(await f.service.cancel(id)).toBe("cancelled");
    expect(f.fetch.mock.calls.some(([url, init]) => init.method === "DELETE" && url.endsWith("/call/accepted"))).toBe(true);
    const cancelled = f.store.get(id);
    delayed.release();
    expect(await pending).toMatchObject(path === "creation rejection"
      ? { ok: false, error: "vendor_refused" }
      : { ok: true, value: { call: id, status: "cancelled" } });
    expect(f.store.get(id)).toEqual(cancelled);
    expect(f.service.ownerCard(id)?.status).toBe("cancelled");
    expect(await f.service.result({ call: id })).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect([...f.store.live()]).toHaveLength(0);
    expect(f.service.revisionsInUse().size).toBe(0);
    expect(f.fetch.mock.calls.filter(([url, init]) => init.method === "POST" && url.endsWith("/call"))).toHaveLength(1);
  } finally {
    delayed.release();
    await pending;
    f.db.close();
  }
});

it("missed reconciliation never reports success for place or result", async () => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    f.fetch.mockRejectedValueOnce(new Error("lost"));
    await f.service.place(args);
    const id = [...f.store.live()][0].id;
    expect(await f.service.place(args)).toEqual({ ok: false, error: "not_confirmed" });
    expect(await f.service.result({ call: id })).toEqual({ ok: false, error: "not_confirmed" });
  } finally { f.db.close(); }
});

it("owner abandon releases the lock for a corrected number and survives reopening SQLite", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.cwd(), ".abandon-test-"));
  const file = join(dir, "calls.db");
  const f = fixture();
  let db = new DatabaseSync(file);
  try {
    let store = new SqliteCallStore(db);
    let service = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, store);
    await service.saveSettings(defaultSettings("number", "Owner"));
    f.fetch.mockRejectedValueOnce(new Error("lost"));
    await service.place(args);
    const id = [...store.live()][0].id;
    expect(await service.cancel(id)).toBe("abandoned");
    expect(service.ownerCard(id)?.status).toBe("abandoned");
    expect(service.revisionsInUse().size).toBe(0);
    db.close(); db = new DatabaseSync(file); store = new SqliteCallStore(db);
    service = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, store);
    expect(store.get(id)?.status).toBe("abandoned");
    expect(await service.place({ ...args, to: "+15550987654" })).toMatchObject({ ok: true });
    // Unrelated and ambiguous names must never authorize deletion.
    for (const list of [[{ id: "wrong", name: "other" }], [{ id: "a", name: id }, { id: "b", name: id }]]) {
      f.fetch.mockResolvedValueOnce({ status: 200, json: async () => list });
      await service.reconcileAbandoned();
    }
    expect(f.fetch.mock.calls.filter(c => c[1].method === "DELETE")).toHaveLength(0);
    f.fetch.mockResolvedValueOnce({ status: 200, json: async () => [{ id: "found", name: id, status: "scheduled" }] });
    await Promise.all([service.reconcileAbandoned(), service.reconcileAbandoned()]);
    expect(store.get(id)).toMatchObject({ status: "abandoned", vendorId: "found", abandonCancel: "confirmed" });
    db.close(); db = new DatabaseSync(file); store = new SqliteCallStore(db);
    service = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, store);
    // Keep rediscovering the same call: a repeated cancellation must not hide behind an empty list.
    f.fetch.mockImplementation(async (_url, init) => ({ status: 200, json: async () => init.method === "GET"
      ? [{ id: "found", name: id, status: "scheduled" }] : {} }));
    await service.reconcileAbandoned();
    expect(store.get(id)).toMatchObject({ status: "abandoned", vendorId: "found", abandonCancel: "confirmed" });
    expect(f.fetch.mock.calls.filter(([url, init]) => init.method === "DELETE" && url.endsWith("/call/found"))).toHaveLength(1);
  } finally { db.close(); f.db.close(); removeTempDirSync(dir); }
});

it.each([
  ["creation", false], ["result", false], ["retry", false],
  ["result", true], ["retry", true],
] as const)("late %s preserves abandonment and cancels only identified calls (restart before DELETE: %s)", async (path, restartBeforeDelete) => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.cwd(), ".late-abandon-test-"));
  const file = join(dir, "calls.db");
  const f = fixture(file), entered = gate(), delayed = gate();
  let db = f.db, store = f.store, service = f.service;
  let pending: ReturnType<PhoneCallService["place"]> | undefined;
  try {
    await service.saveSettings(defaultSettings("number", "Owner"));
    if (path !== "creation") { f.fetch.mockRejectedValueOnce(new Error("lost")); await service.place(args); }
    f.fetch.mockImplementationOnce(async () => {
      entered.release(); await delayed.promise;
      const id = store.recent()[0].id;
      return { status: 200, json: async () => path === "creation"
        ? { id: "late", status: "scheduled" }
        : [{ id: "late", name: id, status: "scheduled" }] };
    });
    pending = path === "result" ? service.result({ call: store.recent()[0].id }) : service.place(args);
    await entered.promise;
    const id = store.recent()[0].id;
    expect(await service.cancel(id)).toBe("abandoned");
    // Simulate shutdown after saving the reconciliation but before the cancellation sweep.
    if (restartBeforeDelete) vi.spyOn(service, "reconcileAbandoned").mockResolvedValue(undefined);
    const requestsBeforeRelease = f.fetch.mock.calls.length;
    delayed.release();
    expect(await pending).toEqual({ ok: false, error: "abandoned" });
    expect(store.get(id)?.status).toBe("abandoned");
    expect([...store.live()]).toHaveLength(0);
    if (path !== "creation") {
      expect(store.get(id)).toMatchObject({ vendorId: "late", status: "abandoned" });
      expect(store.get(id)?.abandonCancel).toBe(restartBeforeDelete ? undefined : "confirmed");
      // Later discovery defaults to an empty list: the successful identification must be retained.
      expect(f.fetch.mock.calls.slice(requestsBeforeRelease).map(c => c[1].method))
        .toEqual(restartBeforeDelete ? [] : ["DELETE"]);
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      db.close(); db = new DatabaseSync(file); store = new SqliteCallStore(db);
      service = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, store);
      // Only previously identified paths rediscover the call; creation remains unidentified.
      if (path !== "creation") f.fetch.mockImplementation(async (_url, init) => ({ status: 200, json: async () => init.method === "GET"
        ? [{ id: "late", name: id, status: "scheduled" }] : {} }));
      await Promise.all([service.reconcileAbandoned(), service.reconcileAbandoned()]);
      expect(store.get(id)).toMatchObject(path === "creation"
        ? { status: "abandoned", vendorId: "" }
        : { status: "abandoned", vendorId: "late", abandonCancel: "confirmed" });
      expect(f.fetch.mock.calls.filter(c => c[1].method === "DELETE").map(c => c[0]))
        .toEqual(path === "creation" ? [] : ["https://api.vapi.ai/call/late"]);
    }
  } finally { delayed.release(); await pending; db.close(); removeTempDirSync(dir); }
});

it.each(["failed", "attempted"] as const)("durable %s abandonment DELETE is not repeated", async outcome => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    f.fetch.mockRejectedValueOnce(new Error("lost")); await f.service.place(args);
    const id = f.store.recent()[0].id;
    await f.service.cancel(id);
    f.fetch.mockResolvedValueOnce({ status: 200, json: async () => [{ id: "found", name: id }] });
    const entered = gate(), delayed = gate();
    f.fetch.mockImplementationOnce(async () => { entered.release(); await delayed.promise; throw new Error("lost DELETE"); });
    const pending = f.service.reconcileAbandoned();
    await entered.promise;
    expect(f.store.get(id)?.abandonCancel).toBe("attempted");
    if (outcome === "failed") { delayed.release(); await pending; }
    const restarted = new PhoneCallService(f.adapter, f.revisions, () => "en", () => {}, f.store);
    await restarted.reconcileAbandoned();
    delayed.release(); await pending;
    expect(f.store.get(id)?.abandonCancel).toBe("failed");
    expect(f.fetch.mock.calls.filter(c => c[1].method === "DELETE")).toHaveLength(1);
  } finally { f.db.close(); }
});


it.each([false, true])("normal completion releases a superseded assistant (first deletion fails: %s)", async failFirst => {
  const f = fixture();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    const placed = await f.service.place(args);
    if (!placed.ok) throw new Error("fixture placement failed");
    await f.service.saveSettings(defaultSettings("other", "Owner"));
    const remove = vi.spyOn(f.adapter, "deleteAssistant").mockResolvedValue();
    if (failFirst) remove.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(f.adapter, "result").mockResolvedValue({ vendorId: "vendor-1", status: "ended", transcript: "Done", structured: { outcome: "done" } });
    await f.service.result({ call: placed.value.call });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(f.revisions.get(1) === undefined).toBe(!failFirst);
    // A later owner refresh must retry even though there are no outstanding calls.
    await phoneOwnerRoute(() => f.service, { method: "GET", path: "/api/phone-calls", desktop: true, botCredential: false });
    expect(remove).toHaveBeenCalledTimes(failFirst ? 2 : 1);
    expect(f.revisions.get(1)).toBeUndefined();
  } finally { f.db.close(); }
});

it.each(["live", "starting"] as const)("completion retains a superseded assistant used by another %s call", async other => {
  const f = fixture();
  const hold = gate();
  try {
    await f.service.saveSettings(defaultSettings("number", "Owner"));
    const placed = await f.service.place(args);
    if (!placed.ok) throw new Error("fixture placement failed");
    if (other === "starting") vi.spyOn(f.adapter, "start").mockImplementationOnce(async () => { await hold.promise; return { vendorId: "second", status: "ringing" }; });
    const second = f.service.place({ ...args, goal: "Second" });
    await vi.waitFor(() => expect([...f.store.live()]).toHaveLength(2));
    await f.service.saveSettings(defaultSettings("other", "Owner"));
    const remove = vi.spyOn(f.adapter, "deleteAssistant").mockResolvedValue();
    vi.spyOn(f.adapter, "result").mockResolvedValue({ vendorId: "vendor-1", status: "ended", transcript: "Done", structured: { outcome: "done" } });
    await f.service.result({ call: placed.value.call });
    expect(remove).not.toHaveBeenCalled();
    expect(f.revisions.get(1)).toBeDefined();
    hold.release();
    const placedSecond = await second;
    if (!placedSecond.ok) throw new Error("fixture placement failed");
    await f.service.result({ call: placedSecond.value.call });
    expect(remove).toHaveBeenCalledTimes(1);
  } finally { hold.release(); f.db.close(); }
});
