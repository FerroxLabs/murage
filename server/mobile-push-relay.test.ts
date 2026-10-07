import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createRelayClient, DEFAULT_RELAY_ORIGIN, relayOrigin, relayRemovalSweeper, sweepRelayRemovals } from "./mobile-push-relay.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { PushOutbox } from "./mobile-push-outbox.ts";

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const PT = "murage_pt_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const binding = { bindingId: B, deviceId: "d1", publisherToken: PT, createdAt: 1 };
const event = { bindingId: B, eventRef: "9b1f0c4e2a7d3e8f5c6b1a0d9e8f7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f", category: "approval" as const, revision: 1, workspaceBadge: 2,
  collapseKey: "be753ac14d84299e2b22e52b6dba3a17", threadGroup: "46af17e29b1130f0", timeSensitive: true, expiresAt: 1790000000000 };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("relay origin", () => {
  it("defaults, accepts an https origin, and turns off", () => {
    // The phones' own relay (RelayClient.swift, RelayClient.java): a host
    // with no setting must redeem their grants (final review I1).
    expect(relayOrigin({})).toBe("https://murage-push-relay.sean-874.workers.dev");
    expect(relayOrigin({ MURAGE_PUSH_RELAY_URL: "" })).toBe("https://murage-push-relay.sean-874.workers.dev");
    expect(relayOrigin({ MURAGE_PUSH_RELAY_URL: "https://relay.test" })).toBe("https://relay.test");
    expect(relayOrigin({ MURAGE_PUSH_RELAY_URL: "off" })).toBeNull();
    expect(relayOrigin({ MURAGE_PUSH_RELAY_URL: "http://relay.test" })).toBeNull();
    expect(relayOrigin({ MURAGE_PUSH_RELAY_URL: "https://relay.test/path" })).toBeNull();
  });
});

describe("relay origin parity", () => {
  it("the host's default is the relay both phones build in", () => {
    const read = (path: string) => readFileSync(new URL(`../apps/mobile/${path}`, import.meta.url), "utf8");
    expect(read("ios/App/MurageShell/Sources/MurageShell/RelayClient.swift")).toContain(`URL(string: "${DEFAULT_RELAY_ORIGIN}")!`);
    expect(read("android/app/src/main/java/com/murage/mobile/RelayClient.java")).toContain(`DEFAULT_ORIGIN = "${DEFAULT_RELAY_ORIGIN}";`);
  });
});

describe("relay client", () => {
  it("redeems a grant, and refuses an answer that is not a binding and a publisher token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(200, { bindingId: B, publisherToken: PT }));
    const client = createRelayClient("https://relay.test", fetch);
    expect(await client.redeem("murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")).toEqual({ bindingId: B, publisherToken: PT });
    expect(fetch.mock.calls[0][0]).toBe("https://relay.test/v1/publishers/redeem");
    expect(await client.redeem("not-a-grant")).toBeNull();
    const bad = createRelayClient("https://relay.test", async () => reply(200, { bindingId: "x", publisherToken: PT }));
    expect(await bad.redeem("murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")).toBeNull();
  });

  it("tells a refused grant from a relay that did not answer about it", async () => {
    const G = "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    for (const status of [400, 403]) expect(await createRelayClient("https://relay.test", async () => reply(status)).redeem(G)).toBeNull();
    for (const status of [404, 429, 500, 503]) expect(await createRelayClient("https://relay.test", async () => reply(status)).redeem(G)).toBe("unavailable");
    expect(await createRelayClient("https://relay.test", async () => { throw new TypeError("fetch failed"); }).redeem(G)).toBe("unavailable");
  });

  it("publishes exactly the event with the publisher token, and maps the answers", async () => {
    const fetch = vi.fn(async () => reply(202));
    const client = createRelayClient("https://relay.test", fetch);
    expect(await client.publish(binding, event, new AbortController().signal)).toBe("accepted");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(event);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PT}`);
    expect(init.redirect).toBe("error");
    expect(await createRelayClient("https://relay.test", async () => reply(401)).publish(binding, event, new AbortController().signal)).toBe("gone");
    expect(await createRelayClient("https://relay.test", async () => reply(429)).publish(binding, event, new AbortController().signal)).toBe("retry");
    // 5xx (a paused relay is 503) is transient; any other 4xx is final.
    expect(await createRelayClient("https://relay.test", async () => reply(503)).publish(binding, event, new AbortController().signal)).toBe("retry");
    expect(await createRelayClient("https://relay.test", async () => reply(400)).publish(binding, event, new AbortController().signal)).toBe("rejected");
    expect(await createRelayClient("https://relay.test", async () => reply(403)).publish(binding, event, new AbortController().signal)).toBe("rejected");
    // The relay never answers 404 for a binding it knows (unknown is 401), so
    // a 404 is something in between (a wrong origin, a proxy): retry it.
    expect(await createRelayClient("https://relay.test", async () => reply(404)).publish(binding, event, new AbortController().signal)).toBe("retry");
    expect(await createRelayClient("https://relay.test", async () => { throw new Error("down"); }).publish(binding, event, new AbortController().signal)).toBe("retry");
  });

  it("removes a binding with its own publisher token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(200, { removed: true }));
    expect(await createRelayClient("https://relay.test", fetch).remove(binding)).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`https://relay.test/v1/bindings/${B}`);
    expect(await createRelayClient("https://relay.test", async () => reply(401)).remove(binding)).toBe(true);
    // A 404 is not the relay: the removal is still owed, so it retries.
    expect(await createRelayClient("https://relay.test", async () => reply(404)).remove(binding)).toBe(false);
  });

  it("a 404 from something that is not the relay un-enrols nothing and orphans nothing", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeMobilePush(db);
    const store = new PushStore(db);
    store.putBinding(binding);
    const client = createRelayClient("https://push.example.test", async () => reply(404, { error: "not_found" }));
    const world = { visible: () => true, present: () => false, badge: () => 1, latestMessageId: () => undefined, stillPending: () => true,
      risk: () => "low" as const, timeSensitive: () => false, actionable: () => true };
    const outbox = new PushOutbox({ store, world, sender: client, now: () => 1_000_000 });
    outbox.enqueue({ kind: "approval", botId: "scout", threadId: "t1", requestId: "req-1" });
    await outbox.flush();
    expect(store.binding(B)).not.toBeNull();
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    expect(store.latestForRequest(B, "req-1")).toMatchObject({ state: "pending", attempts: 1 });
    // The sweep of a removal the relay never confirmed keeps it owed.
    store.enqueueRelayRemoval({ bindingId: "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d", publisherToken: PT }, 100);
    expect(await sweepRelayRemovals(store, client, 100)).toEqual({ removed: 0, retrying: 1, abandoned: 0 });
  });

  it("does not let a body-drain failure hide a successful send or removal", async () => {
    const drainFails = (status: number) =>
      (async () => ({ status, body: { cancel: () => Promise.reject(new Error("drain failed")) } }) as unknown as Response);
    expect(await createRelayClient("https://relay.test", drainFails(202)).publish(binding, event, new AbortController().signal)).toBe("accepted");
    expect(await createRelayClient("https://relay.test", drainFails(200)).remove(binding)).toBe(true);
  });
});

describe("relay removal sweep", () => {
  const other = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
  function queued() {
    const db = new DatabaseSync(":memory:");
    initializeMobilePush(db);
    const store = new PushStore(db);
    store.enqueueRelayRemoval({ bindingId: B, publisherToken: PT }, 100);
    store.enqueueRelayRemoval({ bindingId: other, publisherToken: "murage_pt_y" }, 100);
    return store;
  }
  const relay = (remove: (b: { bindingId: string; publisherToken: string }) => Promise<boolean>) =>
    ({ redeem: vi.fn(), publish: vi.fn(), remove: vi.fn(remove) });

  it("removes due rows at the relay: success forgets the row, failure and a throw back off", async () => {
    const store = queued();
    const r = relay(async (b) => { if (b.bindingId === B) return true; throw new Error("offline"); });
    expect(await sweepRelayRemovals(store, r, 100)).toEqual({ removed: 1, retrying: 1, abandoned: 0 });
    expect(r.remove).toHaveBeenCalledWith({ bindingId: B, publisherToken: PT });
    expect(store.dueRelayRemovals(100, 10)).toEqual([]);
    expect(store.dueRelayRemovals(1100, 10)).toMatchObject([{ bindingId: other, attempts: 1 }]);
    const refused = relay(async () => false);
    expect(await sweepRelayRemovals(store, refused, 1100)).toEqual({ removed: 0, retrying: 1, abandoned: 0 });
    expect(await sweepRelayRemovals(store, refused, 1100)).toEqual({ removed: 0, retrying: 0, abandoned: 0 });
  });

  it("leaves every row queued while push is off, and counts what it gives up on", async () => {
    const store = queued();
    expect(await sweepRelayRemovals(store, null, 100)).toEqual({ removed: 0, retrying: 0, abandoned: 0 });
    expect(store.dueRelayRemovals(100, 10)).toHaveLength(2);
    expect(await sweepRelayRemovals(store, relay(async () => false), 100 + 30 * 24 * 3600_000)).toEqual({ removed: 0, retrying: 0, abandoned: 2 });
    expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it("on the outbox tick: one sweep at a time, and a throw never escapes or stops the next one", async () => {
    const store = queued();
    let release!: (value: boolean) => void;
    const r = relay(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const sweep = relayRemovalSweeper(store, r, () => 100);
    const first = sweep();
    expect(sweep()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.remove).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(true);
    await first;
    expect(r.remove).toHaveBeenCalledTimes(2);
    expect(store.dueRelayRemovals(100, 10)).toEqual([]);
    // A store that throws: the sweep settles, and the next one runs again.
    const broken = { dueRelayRemovals: vi.fn(() => { throw new Error("database closed"); }), relayRemovalDone: vi.fn(), relayRemovalFailed: vi.fn() };
    const sweepBroken = relayRemovalSweeper(broken, r, () => 100);
    await expect(sweepBroken()).resolves.toBeUndefined();
    await expect(sweepBroken()).resolves.toBeUndefined();
    expect(broken.dueRelayRemovals).toHaveBeenCalledTimes(2);
    // ...and leaves a trace when asked to, without rejecting even if that throws.
    const onError = vi.fn(() => { throw new Error("log closed"); });
    await expect(relayRemovalSweeper(broken, r, () => 100, onError)()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
