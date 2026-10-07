import { describe, expect, it, vi } from "vitest";
import { SWEEP_LIMIT, SWEEP_ROUNDS, createEvents, relayPaused } from "../src/events";
import { createProviders, type Providers } from "../src/providers";
import { createRelay } from "../src/relay";
import { publisher, relayUnderTest } from "./relay-harness";

function withEvents(o: { paused?: boolean; cap?: number; send?: Providers["send"] } = {}) {
  const sent: unknown[] = [];
  const send: Providers["send"] = o.send ?? (async (_d, e) => { sent.push(e); return "accepted"; });
  const providers: Providers = { send: vi.fn(send) };
  const t = relayUnderTest();
  const events = createEvents({ db: t.db, providers, now: t.deps.now, paused: async () => o.paused ?? false, globalDailyCap: o.cap ?? 100_000, flushOnAdmit: false });
  const relay = createRelay({ ...t.deps, events: events.admit });
  const emit = (token: string, event: unknown) => relay(new Request("https://push.murage.test/v1/events", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event) }), () => {});
  return { ...t, events, providers, sent, emit };
}
const event = (bindingId: string, over: Record<string, unknown> = {}) => ({
  bindingId, eventRef: "9b1f0c4e2a7d3e8f5c6b1a0d9e8f7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f", category: "approval", revision: 1, workspaceBadge: 2,
  collapseKey: "be753ac14d84299e2b22e52b6dba3a17", threadGroup: "46af17e29b1130f0", timeSensitive: true, expiresAt: Date.parse("2026-09-27T12:15:00Z"), ...over,
});
const ref = (i: number) => i.toString(16).padStart(64, "0");

describe("admission", () => {
  it("accepts one event, deduplicates a retry, and delivers it", async () => {
    const t = withEvents();
    const pub = await publisher(t);
    expect((await t.emit(pub.publisherToken, event(pub.bindingId))).status).toBe(202);
    expect(await (await t.emit(pub.publisherToken, event(pub.bindingId))).json()).toEqual({ status: "deduplicated" });
    expect(await t.events.flush(10)).toBe(1);
    expect(t.providers.send).toHaveBeenCalledTimes(1);
  });
  it("refuses an event for another binding, one with content, and one already expired", async () => {
    const t = withEvents();
    const pub = await publisher(t);
    expect((await t.emit(pub.publisherToken, event("a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d"))).status).toBe(403);
    expect((await t.emit(pub.publisherToken, { ...event(pub.bindingId), title: "Scout needs approval" })).status).toBe(400);
    expect((await t.emit(pub.publisherToken, event(pub.bindingId, { expiresAt: Date.parse("2026-09-27T11:00:00Z") }))).status).toBe(400);
  });
  it("the 501st push of the day is refused", async () => {
    const t = withEvents();
    const pub = await publisher(t);
    for (let i = 1; i <= 500; i++) {
      const res = await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(i) }));
      expect(res.status).toBe(202);
      await t.events.flush(1);
    }
    expect(await (await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(501) }))).json()).toEqual({ error: "quota" });
  });
  it("a full queue refuses", async () => {
    const t = withEvents();
    const pub = await publisher(t);
    for (let i = 1; i <= 50; i++) await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(i) }));
    const res = await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(51) }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "queue_full" });
  });
  it("the global cap refuses once reached", async () => {
    const t = withEvents({ cap: 2 });
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(1) }));
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(2) }));
    expect(await (await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(3) }))).json()).toEqual({ error: "global_cap" });
  });
  it("the kill switch refuses every event", async () => {
    const t = withEvents({ paused: true });
    const pub = await publisher(t);
    const res = await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "relay_paused" });
  });
});

describe("delivery", () => {
  it("sends the sum of the device's workspace badges (R8)", async () => {
    const t = withEvents();
    const a = await publisher(t);
    const b = await publisher(t, a.deviceSecret);
    await t.emit(b.publisherToken, event(b.bindingId, { workspaceBadge: 3, eventRef: ref(9) }));
    await t.events.flush(10);
    await t.emit(a.publisherToken, event(a.bindingId, { workspaceBadge: 2 }));
    await t.events.flush(10);
    const badges = (t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(badges).toEqual([3, 5]);
  });
  it("an invalid token deletes the device, and a retry backs off", async () => {
    const t = withEvents({ send: async () => "invalid-token" });
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    await t.events.flush(10);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_devices").first<{ n: number }>()).toEqual({ n: 0 });
    const r = withEvents({ send: async () => ({ retryAfterMs: 120_000 }) });
    const pub2 = await publisher(r);
    await r.emit(pub2.publisherToken, event(pub2.bindingId));
    await r.events.flush(10);
    expect(await r.events.flush(10)).toBe(0);
    r.tick(120_000);
    expect(await r.events.flush(10)).toBe(1);
  });
});

const DAY = 24 * 3600_000;
/** A relay whose kill switch is the real relay_settings row, with a short send timeout. */
function withSwitch(send: Providers["send"], sendTimeoutMs = 10_000, configured?: { ios: boolean; android: boolean }) {
  const providers: Providers = { send: vi.fn(send) };
  const t = relayUnderTest();
  const events = createEvents({ db: t.db, providers, now: t.deps.now, paused: () => relayPaused(t.db, undefined), globalDailyCap: 100_000, flushOnAdmit: false, sendTimeoutMs, ...(configured ? { configured } : {}) });
  const relay = createRelay({ ...t.deps, events: events.admit });
  const emit = (token: string, e: unknown) => relay(new Request("https://push.murage.test/v1/events", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(e) }), () => {});
  const pause = (on: boolean) => t.db.prepare("INSERT INTO relay_settings (key,value) VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(on ? "1" : "0").run();
  return { ...t, events, providers, emit, pause };
}
const pending = async (t: { db: { prepare(sql: string): { first<T>(): Promise<T | null> } } }) =>
  (await t.db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE accepted_at IS NULL").first<{ n: number }>())?.n;

describe("the kill switch", () => {
  it("the relay_settings row refuses admission with 503 and stops the flush until it is lifted", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    expect((await t.emit(pub.publisherToken, event(pub.bindingId))).status).toBe(202);
    await t.pause(true);
    const res = await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(2) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "relay_paused" });
    expect(await t.events.flush(10)).toBe(0);
    expect(t.providers.send).not.toHaveBeenCalled();
    await t.pause(false);
    expect(await t.events.flush(10)).toBe(1);
  });
  it("the environment flag pauses too", async () => {
    const t = relayUnderTest();
    expect(await relayPaused(t.db, "1")).toBe(true);
    expect(await relayPaused(t.db, "0")).toBe(false);
  });
});

describe("a provider that cannot be reached", () => {
  it("a network failure backs off and never uses up the event, however many times it happens", async () => {
    let failures = 9;
    const t = withSwitch(async () => (failures-- > 0 ? { retryAfterMs: 1000, network: true } : "accepted"));
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = t.deps.now();
      expect(await t.events.flush(10)).toBe(1);
      const row = await t.db.prepare("SELECT next_attempt_at, attempts FROM relay_events").first<{ next_attempt_at: number; attempts: number }>();
      expect(row!.attempts).toBe(0);
      delays.push(row!.next_attempt_at - before);
      expect(await t.events.flush(10)).toBe(0);
      t.tick(row!.next_attempt_at - before);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[8]).toBeGreaterThan(delays[1]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(await t.events.flush(10)).toBe(1);
    expect(await pending(t)).toBe(0);
    expect(t.providers.send).toHaveBeenCalledTimes(10);
  });
  it("a send that hangs is aborted by its timeout and retried, not dropped", async () => {
    let hang = true;
    const t = withSwitch((_d, _e, _b, signal) => hang
      ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      : Promise.resolve("accepted"), 20);
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(await t.events.flush(10)).toBe(1);
    expect(await pending(t)).toBe(1);
    hang = false;
    t.tick(60_000);
    expect(await t.events.flush(10)).toBe(1);
    expect(await pending(t)).toBe(0);
  });
  it("a platform with no provider secret is refused retryably at admission and delays nobody (B9, I-2)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: unknown[] = [];
    const t = withSwitch(async (_d, e) => { sent.push(e); return "accepted"; }, 10_000, { ios: false, android: true });
    const ios = await publisher(t);
    const refused = await t.emit(ios.publisherToken, event(ios.bindingId));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "provider_unavailable" });
    // nothing was queued, so the queue and the quotas are untouched
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM relay_events").first<{ n: number }>())!.n).toBe(0);
    expect(t.providers.send).not.toHaveBeenCalled();
  });
  it("240 events already held for the unconfigured platform do not delay the other platform or the queue cap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = withSwitch(async () => "accepted", 10_000, { ios: false, android: true });
    const ios = await publisher(t);
    const android = await publisher(t, undefined, "android");
    const now = t.deps.now();
    // events admitted before the secret went missing: older than anything new
    for (let i = 1; i <= 240; i++) {
      await t.db.prepare("INSERT INTO relay_events (binding_id,event_ref,revision,payload,admitted_at,expires_at,next_attempt_at) VALUES (?,?,1,?,?,?,?)")
        .bind(ios.bindingId, ref(i), JSON.stringify(event(ios.bindingId, { eventRef: ref(i), collapseKey: ref(i).slice(0, 32) })), now - 1000, now + 3600_000, now - 1000).run();
    }
    expect((await t.emit(android.publisherToken, event(android.bindingId, { eventRef: ref(999) }))).status).toBe(202);
    // one flush of 5 reaches the Android event at once, whatever is held
    expect(await t.events.flush(5)).toBe(1);
    expect(t.providers.send).toHaveBeenCalledTimes(1);
    expect((t.providers.send as ReturnType<typeof vi.fn>).mock.calls[0][0].platform).toBe("android");
    // and the held ones were never claimed
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE next_attempt_at=? AND accepted_at IS NULL").bind(now - 1000).first<{ n: number }>())!.n).toBe(240);
  });
  it("a rejection is final", async () => {
    const t = withSwitch(async () => "rejected");
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(await t.events.flush(10)).toBe(1);
    t.tick(3600_000);
    expect(await t.events.flush(10)).toBe(0);
  });
});

describe("the sweep", () => {
  it("deletes what has lapsed and keeps what has not", async () => {
    const t = relayUnderTest();
    const events = createEvents({ db: t.db, providers: { send: vi.fn() }, now: t.deps.now, paused: async () => false, globalDailyCap: 1 });
    const now = t.deps.now();
    const run = (sql: string, ...v: unknown[]) => t.db.prepare(sql).bind(...v).run();
    const device = (id: string, seen: number) => run("INSERT INTO relay_devices (id,platform,environment,push_token,token_hash,secret_hash,created_at,last_seen_at) VALUES (?,'ios','production',?,?,?,?,?)", id, `t-${id}`, `th-${id}`, `sh-${id}`, seen, seen);
    await device("old-orphan", now - 31 * DAY);
    await device("recent-orphan", now - 29 * DAY);
    await device("old-bound", now - DAY);
    await device("old-lapsed", now - 31 * DAY);
    await run("INSERT INTO relay_bindings (id,device_id,publisher_hash,grant_expires_at,created_at) VALUES ('live','old-bound','ph',?,?)", now - DAY, now - DAY);
    await run("INSERT INTO relay_bindings (id,device_id,grant_hash,grant_expires_at,created_at) VALUES ('lapsed','old-lapsed','g1',?,?)", now - 1, now - 400_000);
    await run("INSERT INTO relay_bindings (id,device_id,grant_hash,grant_expires_at,created_at) VALUES ('granted','recent-orphan','g2',?,?)", now + 60_000, now);
    await run("INSERT INTO relay_challenges (id,expires_at) VALUES ('c-old',?),('c-new',?)", now - 1, now + 60_000);
    await run("INSERT INTO relay_counters (scope,window_start,count) VALUES ('s',?,1),('s',?,1)", now - 3 * DAY, now - DAY);
    await run("INSERT INTO relay_events (binding_id,event_ref,revision,payload,admitted_at,expires_at,next_attempt_at) VALUES ('live','e-old',1,'{}',?,?,?),('live','e-new',1,'{}',?,?,?)", now - DAY, now - 1, now, now, now + 60_000, now);
    await run("INSERT INTO relay_provider_auth (cache_key,iv,ciphertext,expires_at) VALUES ('a-old','i','c',?),('a-new','i','c',?)", now - 1, now + 60_000);
    await run("UPDATE relay_bindings SET last_active_at=created_at");
    await events.sweep();
    const ids = async (sql: string) => (await t.db.prepare(sql).all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(await ids("SELECT id FROM relay_devices")).toEqual(["old-bound", "recent-orphan"]);
    expect(await ids("SELECT id FROM relay_bindings")).toEqual(["granted", "live"]);
    expect(await ids("SELECT id FROM relay_challenges")).toEqual(["c-new"]);
    expect(await ids("SELECT window_start AS id FROM relay_counters")).toEqual([now - DAY]);
    expect(await ids("SELECT event_ref AS id FROM relay_events")).toEqual(["e-new"]);
    expect(await ids("SELECT cache_key AS id FROM relay_provider_auth")).toEqual(["a-new"]);
  });
});

describe("fix round 1", () => {
  const counters = async (t: ReturnType<typeof relayUnderTest>) =>
    (await t.db.prepare("SELECT scope, count FROM relay_counters WHERE scope NOT LIKE 'ip-%' AND scope NOT LIKE 'device-%' ORDER BY scope").all<{ scope: string; count: number }>()).results;

  it("a newer revision retires an undelivered older one, which is never sent afterwards", async () => {
    let down = true;
    const t = withSwitch(async (_d, e) => (down && e.revision === 1 ? { retryAfterMs: 2000, network: true } : "accepted"));
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(await t.events.flush(10)).toBe(1);
    down = false;
    const changed = event(pub.bindingId, { eventRef: ref(7), revision: 2 });
    expect((await t.emit(pub.publisherToken, changed)).status).toBe(202);
    t.tick(60_000);
    expect(await t.events.flush(10)).toBe(1);
    t.tick(120_000);
    expect(await t.events.flush(10)).toBe(0);
    const revisions = (t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { revision: number }).revision);
    expect(revisions).toEqual([1, 2]);
  });
  it("a resolution is never sent for a group the phone was never shown, and leaves the queue", async () => {
    let down = true;
    const t = withSwitch(async (_d, e) => (down && e.revision === 1 ? { retryAfterMs: 2000, network: true } : "accepted"));
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(await t.events.flush(10)).toBe(1);
    down = false;
    const resolved = event(pub.bindingId, { eventRef: ref(7), revision: 2, category: "resolved", timeSensitive: false });
    expect((await t.emit(pub.publisherToken, resolved)).status).toBe(202);
    for (let i = 0; i < 3; i++) { t.tick(120_000); expect(await t.events.flush(10)).toBe(0); }
    expect((t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { revision: number }).revision)).toEqual([1]);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE accepted_at IS NULL AND attempts<6").first()).toEqual({ n: 0 });
    // A resolution with nothing below it at all is not sent either.
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(8), revision: 3, category: "resolved", timeSensitive: false, collapseKey: "0".repeat(32) }));
    expect(await t.events.flush(10)).toBe(0);
  });
  it("a resolution is sent once a lower revision in its group was accepted", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    expect(await t.events.flush(10)).toBe(1);
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(7), revision: 2, category: "resolved", timeSensitive: false }));
    expect(await t.events.flush(10)).toBe(1);
    expect((t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { category: string }).category)).toEqual(["approval", "resolved"]);
  });
  it("an older revision arriving after a newer one is deduplicated and never sent", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(7), revision: 2 }));
    const late = await t.emit(pub.publisherToken, event(pub.bindingId, { revision: 1 }));
    expect(late.status).toBe(202);
    expect(await late.json()).toEqual({ status: "deduplicated" });
    await t.events.flush(10);
    expect((t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { revision: number }).revision)).toEqual([2]);
  });
  it("a flush cut off mid-send uses up no attempt, however often it happens", async () => {
    const t = withSwitch(() => new Promise(() => {}), 50);
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    for (let i = 0; i < 8; i++) {
      void t.events.flush(1); // the invocation dies here: no result is ever written
      await new Promise((r) => setTimeout(r, 5));
      const row = await t.db.prepare("SELECT attempts, lease_until FROM relay_events").first<{ attempts: number; lease_until: number }>();
      expect(row!.attempts).toBe(0);
      expect(row!.lease_until).toBeGreaterThan(t.deps.now());
      t.tick(60_000);
    }
    expect(t.providers.send).toHaveBeenCalledTimes(8);
  });
  it("queue_full spends no quota", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    for (let i = 1; i <= 50; i++) await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(i) }));
    const before = await counters(t);
    for (let i = 0; i < 6; i++) expect(await (await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(51) }))).json()).toEqual({ error: "queue_full" });
    expect(await counters(t)).toEqual(before);
  });
  it("global_cap gives back the binding's quota", async () => {
    const providers: Providers = { send: vi.fn(async () => "accepted" as const) };
    const t = relayUnderTest();
    const events = createEvents({ db: t.db, providers, now: t.deps.now, paused: async () => false, globalDailyCap: 1, flushOnAdmit: false });
    const relay = createRelay({ ...t.deps, events: events.admit });
    const pub = await publisher(t);
    const emit = (e: unknown) => relay(new Request("https://push.murage.test/v1/events", { method: "POST", headers: { authorization: `Bearer ${pub.publisherToken}` }, body: JSON.stringify(e) }), () => {});
    expect((await emit(event(pub.bindingId, { eventRef: ref(1) }))).status).toBe(202);
    for (let i = 0; i < 3; i++) expect(await (await emit(event(pub.bindingId, { eventRef: ref(2) }))).json()).toEqual({ error: "global_cap" });
    expect((await counters(t)).find((c) => c.scope.startsWith("binding-day:"))!.count).toBe(1);
  });
  it("the whole relay's queue is bounded by pendingTotal, and expired rows do not count", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    const now = t.deps.now();
    await t.db.prepare("INSERT INTO relay_devices (id,platform,environment,push_token,token_hash,secret_hash,created_at,last_seen_at) VALUES ('other','ios','production','t','th','sh',?,?)").bind(now, now).run();
    await t.db.prepare("INSERT INTO relay_bindings (id,device_id,publisher_hash,grant_expires_at,created_at) VALUES ('ob','other','ph',?,?)").bind(now, now).run();
    const fill = (n: number, expires: number) => t.db.prepare(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?)
      INSERT INTO relay_events (binding_id,event_ref,revision,payload,admitted_at,expires_at,next_attempt_at) SELECT 'ob', printf('%d-%d', ?, i), 1, '{}', ?, ?, ? FROM s`).bind(n, expires, now, expires, now + 3600_000).run();
    await fill(9_999, now + 3600_000);
    await fill(500, now - 1);
    expect((await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(1) }))).status).toBe(202);
    const res = await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(2) }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "queue_full" });
  });
  it("an event already expired, or more than 24 h ahead, is event_expired", async () => {
    const t = withSwitch(async () => "accepted");
    const pub = await publisher(t);
    for (const expiresAt of [t.deps.now(), t.deps.now() + DAY + 1]) {
      const res = await t.emit(pub.publisherToken, event(pub.bindingId, { expiresAt }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "event_expired" });
    }
    expect((await t.emit(pub.publisherToken, event(pub.bindingId, { expiresAt: t.deps.now() + DAY }))).status).toBe(202);
  });
  it("two flushes at once send an event once", async () => {
    const t = withSwitch(() => new Promise((r) => setTimeout(() => r("accepted"), 10)));
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    const [a, b] = await Promise.all([t.events.flush(10), t.events.flush(10)]);
    expect(a + b).toBe(1);
    expect(t.providers.send).toHaveBeenCalledTimes(1);
  });
  it("each sweep delete is bounded, and a backlog drains over several runs", async () => {
    const t = relayUnderTest();
    const events = createEvents({ db: t.db, providers: { send: vi.fn() }, now: t.deps.now, paused: async () => false, globalDailyCap: 1 });
    const now = t.deps.now();
    await t.db.prepare("WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?) INSERT INTO relay_challenges (id,expires_at) SELECT 'c'||i, ? FROM s").bind(SWEEP_LIMIT * SWEEP_ROUNDS + 7, now - 1).run();
    await events.sweep();
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_challenges").first<{ n: number }>()).toEqual({ n: 7 });
    await events.sweep();
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_challenges").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("fix round 2", () => {
  for (const outcome of ["network", "retry", "accepted"] as const) {
    it(`revision 2 is not sent while revision 1 is mid-send, and goes once it ends (${outcome})`, async () => {
      let release!: (v: unknown) => void;
      const order: string[] = [];
      const t = withSwitch(async (_d, e) => {
        order.push(`start${e.revision}`);
        if (e.revision === 1) {
          await new Promise((r) => { release = r; });
          order.push("end1");
          return outcome === "network" ? { retryAfterMs: 1000, network: true } : outcome === "retry" ? { retryAfterMs: 1000 } : "accepted";
        }
        order.push("end2");
        return "accepted";
      });
      const pub = await publisher(t);
      await t.emit(pub.publisherToken, event(pub.bindingId));
      const f1 = t.events.flush(1);
      await new Promise((r) => setTimeout(r, 5));
      expect((await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(7), revision: 2, category: "resolved", timeSensitive: false }))).status).toBe(202);
      expect(await t.events.flush(10)).toBe(0);
      release(undefined);
      await f1;
      // The resolution goes only if revision 1 reached the phone.
      expect(await t.events.flush(10)).toBe(outcome === "accepted" ? 1 : 0);
      for (let i = 0; i < 5; i++) { t.tick(120_000); await t.events.flush(10); }
      expect(order).toEqual(outcome === "accepted" ? ["start1", "end1", "start2", "end2"] : ["start1", "end1"]);
    });
  }
  it("revision 2 goes once revision 1's lease lapses, even if its flush never finishes", async () => {
    const t = withSwitch(async (_d, e) => (e.revision === 1 ? new Promise(() => {}) : "accepted"), 50);
    const pub = await publisher(t);
    await t.emit(pub.publisherToken, event(pub.bindingId));
    void t.events.flush(1);
    await new Promise((r) => setTimeout(r, 5));
    await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(7), revision: 2 }));
    expect(await t.events.flush(10)).toBe(0);
    t.tick(10_000);
    expect(await t.events.flush(10)).toBe(1);
    expect((t.providers.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { revision: number }).revision)).toEqual([1, 2]);
  });
  it("a lower revision that slips past the staleness check is still not stored, and its quota is given back", async () => {
    const t = withSwitch(async () => "accepted");
    // The race: revision 2 lands between revision 1's staleness check and its insert.
    const real = t.db.prepare.bind(t.db);
    t.db.prepare = (sql: string) => sql.startsWith("SELECT 1 AS yes FROM relay_events WHERE binding_id=? AND json_extract") ? { ...real(sql), bind: () => ({ first: async () => null }) } as never : real(sql);
    const pub = await publisher(t);
    expect((await t.emit(pub.publisherToken, event(pub.bindingId, { eventRef: ref(7), revision: 2, category: "resolved", timeSensitive: false, workspaceBadge: 0 }))).status).toBe(202);
    const late = await t.emit(pub.publisherToken, event(pub.bindingId, { revision: 1, workspaceBadge: 4 }));
    expect(late.status).toBe(202);
    expect(await late.json()).toEqual({ status: "deduplicated" });
    expect(await t.db.prepare("SELECT revision FROM relay_events").all()).toEqual({ results: [{ revision: 2 }] });
    expect(await t.db.prepare("SELECT badge FROM relay_bindings").first()).toEqual({ badge: 0 });
    const counts = (await t.db.prepare("SELECT scope, count FROM relay_counters WHERE scope LIKE 'binding-day:%' OR scope='global-day'").all<{ count: number }>()).results;
    expect(counts.map((c) => c.count)).toEqual([1, 1]);
  });
});
