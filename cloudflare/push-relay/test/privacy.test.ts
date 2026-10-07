import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createEvents, SWEEP_LIMIT, SWEEP_ROUNDS } from "../src/events";
import { createRelay } from "../src/relay";
import { sqliteD1 } from "./d1";
import { publisher, registeredDevice, relayUnderTest } from "./relay-harness";

const DAY = 86400_000;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const root = join(import.meta.dirname, "..");
const migrations = () => readdirSync(join(root, "migrations")).filter(f => f.endsWith(".sql")).sort();
const sweep = (t: ReturnType<typeof relayUnderTest>) => createEvents({ db: t.db, now: t.deps.now, providers: { send: async () => "accepted" }, paused: async () => false, globalDailyCap: 1000, flushOnAdmit: false });
const rows = (t: ReturnType<typeof relayUnderTest>, table: string) => t.db.raw.prepare(`SELECT * FROM ${table}`).all();
const logs = () => (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("IP retention", () => {
  it.each(["100.64.0.1", "2001:db8:1:2::9"])("stores only HMAC keys in D1 and edge counters for %s", async ip => {
    const spies = logs();
    const keys: string[] = [];
    const t = relayUnderTest();
    const env = { DB: t.db, IP_HASH_KEY: "test-ip-secret", EDGE_OPEN_LIMIT: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } };
    const call = (path: string, body?: unknown) => worker.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, { waitUntil() {} } as unknown as ExecutionContext);
    const { challenge } = await (await call("/v1/challenges")).json() as { challenge: string };
    await call("/v1/devices", { platform: "ios", environment: "production", pushToken: "a".repeat(64), challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
    const bucket = ip.includes(":") ? "ip6=2001:0db8:0001:0002::/64" : `ip4=${ip}`;
    const expected = createHmac("sha256", "test-ip-secret").update(`${Math.floor(Date.now() / (2 * DAY))}\n${bucket}`).digest("hex");
    expect(keys).toEqual([expected, expected]);
    expect(rows(t, "relay_counters").map(r => r.scope)).toEqual([`ip-challenge:${expected}`, `ip-register:${expected}`]);
    const tables = t.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const { name } of tables) expect(JSON.stringify(rows(t, String(name)))).not.toContain(ip);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(ip);
  });
  it.each([undefined, "test-ip-secret"])("rotates at UTC two-day boundaries and keeps one key within a period (secret %s)", async ipHashKey => {
    const keys: string[] = [];
    const t = relayUnderTest({ ipHashKey, edge: { open: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } } });
    const boundary = (Math.floor(t.deps.now() / (2 * DAY)) + 1) * 2 * DAY;
    t.tick(boundary - t.deps.now() - 2);
    await t.call("POST", "/v1/challenges");
    t.tick(1);
    await t.call("POST", "/v1/challenges");
    t.tick(1);
    await t.call("POST", "/v1/challenges");
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(JSON.stringify(rows(t, "relay_counters"))).not.toContain("100.64.0.1");
  });
  it("hashes malformed and absent headers and ignores forwarded addresses", async () => {
    const keys: string[] = [];
    const t = relayUnderTest({ ipHashKey: "test-key", edge: { open: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } } });
    await t.relay(new Request("https://relay.test/v1/challenges", { method: "POST", headers: { "x-forwarded-for": "100.64.0.2" } }), () => {});
    await t.relay(new Request("https://relay.test/v1/challenges", { method: "POST" }), () => {});
    await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "100.64.0.3,100.64.0.4" });
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(JSON.stringify(rows(t, "relay_counters"))).not.toContain("100.64.");
  });
  it("migrates away legacy IP counter values while preserving non-IP limits", () => {
    const db = sqliteD1();
    db.raw.exec(readFileSync(join(root, "migrations/0001_push_relay.sql"), "utf8"));
    db.raw.exec("INSERT INTO relay_counters VALUES ('ip-challenge:ip4=100.64.0.1',0,1),('ip-register:ip6=2001:0db8::/64',0,1),('global-day',0,5)");
    for (const file of migrations().slice(1)) db.raw.exec(readFileSync(join(root, "migrations", file), "utf8"));
    expect(db.raw.prepare("SELECT * FROM relay_counters").all()).toEqual([{ scope: "global-day", window_start: 0, count: 5 }]);
  });
  it("sweeps an approval-key install counter once its hourly window closes", async () => {
    const t = relayUnderTest({ ipHashKey: "test-key" });
    const start = Math.floor(t.deps.now() / 3600_000) * 3600_000;
    t.db.raw.prepare("INSERT INTO relay_counters VALUES ('install-approval:abc',?,1),('device-bind:d',?,1)").run(start, start);
    await sweep(t).sweep();
    expect(rows(t, "relay_counters")).toHaveLength(2);
    t.tick(start + 2 * 3600_000 - t.deps.now());
    await sweep(t).sweep();
    expect(rows(t, "relay_counters").map(r => r.scope)).toEqual(["device-bind:d"]);
  });
  it("sweeps an IP counter once its hourly window closes, raw scopes from an older Worker included", async () => {
    const t = relayUnderTest({ ipHashKey: "test-key" });
    await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "100.64.0.5" });
    const start = Math.floor(t.deps.now() / 3600_000) * 3600_000;
    t.db.raw.prepare("INSERT INTO relay_counters VALUES ('ip-challenge:ip4=100.64.0.6',?,1),('device-bind:d',?,1)").run(start, start);
    await sweep(t).sweep();
    expect(rows(t, "relay_counters").filter(r => String(r.scope).startsWith("ip-"))).toHaveLength(2);
    t.tick(start + 2 * 3600_000 - t.deps.now());
    await sweep(t).sweep();
    expect(rows(t, "relay_counters").map(r => r.scope)).toEqual(["device-bind:d"]);
  });
});

describe("logging privacy", () => {
  it("keeps error lines but no invocation records, using installed schema options", () => {
    const source = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
    const schema = JSON.parse(readFileSync(join(root, "node_modules/wrangler/config-schema.json"), "utf8"));
    const properties = schema.definitions.Observability.properties.logs.properties;
    expect(properties).toHaveProperty("invocation_logs");
    expect(properties).not.toHaveProperty("errors_only");
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.observability.head_sampling_rate).toBe(1);
    expect(config.observability.logs.head_sampling_rate).toBe(1);
    expect(config.observability.logs.persist ?? true).toBe(true);    expect(config.observability.traces.enabled).toBe(false);
  });
  it("redacts IPs, tokens and body content from unexpected route failures", async () => {
    const spies = logs();
    const t = relayUnderTest({ verifier: { verify: async () => { throw new Error("100.64.0.1 private-push-token request-body-content"); } } });
    const { challenge } = await (await t.call("POST", "/v1/challenges")).json() as { challenge: string };
    expect((await t.call("POST", "/v1/devices", { platform: "ios", environment: "production", pushToken: "private-push-token", challenge, attestation: { kind: "app-attest", keyId: "key", attestationObject: "request-body-content" } })).status).toBe(500);
    expect(spies[3]).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
    for (const value of ["100.64.0.1", "private-push-token", "request-body-content"]) expect(output).not.toContain(value);
  });
  it("allows only error console calls in relay sources", () => {
    for (const file of readdirSync(join(root, "src")).filter(f => f.endsWith(".ts"))) {
      expect(readFileSync(join(root, "src", file), "utf8"), file).not.toMatch(/console\.(?:log|info|warn|debug)\s*\(/);
    }
  });
});

describe("idle retention", () => {
  it("cron removes a 31-day paired device and keeps a 29-day one", async () => {
    const t = relayUnderTest();
    const old = await publisher(t);
    t.tick(2 * DAY);
    const fresh = await registeredDevice(t, "b".repeat(64));
    await publisher(t, fresh.deviceSecret);
    t.tick(29 * DAY);
    vi.spyOn(Date, "now").mockImplementation(t.deps.now);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, { DB: t.db, RELAY_PAUSED: "1" } as never, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
    await Promise.all(waits);
    expect(rows(t, "relay_devices").map(r => r.id)).toEqual([fresh.deviceId]);
    expect(rows(t, "relay_bindings").map(r => r.id)).not.toContain(old.bindingId);
  });
  it("refresh resets the device and its bindings, but a malformed refresh does not", async () => {
    const t = relayUnderTest();
    const p = await publisher(t);
    t.tick(29 * DAY);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "b".repeat(64) }, auth(p.deviceSecret))).status).toBe(200);
    t.tick(29 * DAY);
    await sweep(t).sweep();
    expect(rows(t, "relay_devices")).toHaveLength(1);
    expect(rows(t, "relay_bindings")).toHaveLength(1);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "short" }, auth(p.deviceSecret))).status).toBe(400);
    t.tick(2 * DAY);
    await sweep(t).sweep();
    expect(rows(t, "relay_devices")).toHaveLength(0);
  });
  it.each(["publish", "delivery"])("%s renews the touched binding and device, leaving other bindings idle", async activity => {
    const t = relayUnderTest();
    const d = await registeredDevice(t);
    const active = await publisher(t, d.deviceSecret);
    const idle = await publisher(t, d.deviceSecret);
    t.tick(29 * DAY);
    const events = sweep(t);
    const relay = createRelay({ ...t.deps, events: events.admit });
    const event = { bindingId: active.bindingId, eventRef: "a".repeat(64), category: "approval", revision: 1, workspaceBadge: 1, collapseKey: "b".repeat(32), threadGroup: "c".repeat(16), timeSensitive: true, expiresAt: t.deps.now() + DAY };
    expect((await relay(new Request("https://relay.test/v1/events", { method: "POST", headers: auth(active.publisherToken), body: JSON.stringify(event) }), () => {})).status).toBe(202);
    if (activity === "delivery") {
      // Separate successful delivery from admission activity.
      t.db.raw.prepare("UPDATE relay_devices SET last_seen_at=?").run(t.deps.now() - 29 * DAY);
      t.db.raw.prepare("UPDATE relay_bindings SET last_active_at=? WHERE id=?").run(t.deps.now() - 29 * DAY, active.bindingId);
      expect(await events.flush(1)).toBe(1);
    }
    t.tick(2 * DAY);
    await events.sweep();
    expect(rows(t, "relay_devices")).toHaveLength(1);
    expect(rows(t, "relay_bindings").map(r => r.id)).toEqual([active.bindingId]);
    expect(rows(t, "relay_bindings").map(r => r.id)).not.toContain(idle.bindingId);
  });
  it("backfills existing activity at migration time", () => {
    const db = sqliteD1();
    db.raw.exec(readFileSync(join(root, "migrations/0001_push_relay.sql"), "utf8"));
    db.raw.exec("INSERT INTO relay_devices VALUES ('d','ios','production','t','h','s',NULL,1,1); INSERT INTO relay_bindings (id,device_id,grant_expires_at,created_at) VALUES ('b','d',1,1)");
    const before = Math.floor(Date.now() / 1000) * 1000;
    for (const file of migrations().slice(1)) db.raw.exec(readFileSync(join(root, "migrations", file), "utf8"));
    expect(db.raw.prepare("SELECT last_seen_at AS at FROM relay_devices").get()!.at).toBeGreaterThanOrEqual(before);
    expect(db.raw.prepare("SELECT last_active_at AS at FROM relay_bindings").get()!.at).toBeGreaterThanOrEqual(before);
  });
  it("bounds idle deletions per cron and drains the rest on a later run", async () => {
    const t = relayUnderTest();
    const count = SWEEP_LIMIT * SWEEP_ROUNDS + 1;
    for (let i = 0; i < count; i++) {
      t.db.raw.prepare("INSERT INTO relay_devices (id,platform,environment,push_token,token_hash,secret_hash,created_at,last_seen_at) VALUES (?,'ios','production',?,?,?,?,?)").run(`d${i}`, `t${i}`, `h${i}`, `s${i}`, t.deps.now(), t.deps.now());
      t.db.raw.prepare("INSERT INTO relay_bindings (id,device_id,publisher_hash,grant_expires_at,created_at) VALUES (?,?,?,0,?)").run(`b${i}`, `d${i}`, `p${i}`, t.deps.now());
    }
    t.tick(31 * DAY);
    await sweep(t).sweep();
    expect(rows(t, "relay_devices")).toHaveLength(1);
    expect(rows(t, "relay_bindings")).toHaveLength(1);
    await sweep(t).sweep();
    expect(rows(t, "relay_devices")).toHaveLength(0);
  });
});

describe("last binding deletion", () => {
  it.each([
    ["ios", "phone"], ["ios", "host"], ["android", "phone"], ["android", "host"],
  ] as const)("%s final removal by %s forgets the token atomically", async (platform, actor) => {
    const t = relayUnderTest();
    const d = await registeredDevice(t, "private-push-token".repeat(4), platform);
    const a = await publisher(t, d.deviceSecret);
    const b = await publisher(t, d.deviceSecret);
    const finalToken = actor === "phone" ? d.deviceSecret : b.publisherToken;
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, auth(d.deviceSecret))).status).toBe(200);
    expect(rows(t, "relay_devices")).toHaveLength(1);
    // A forced failure in the device deletion must roll back the binding removal.
    t.db.raw.exec("CREATE TRIGGER abort_device BEFORE DELETE ON relay_devices BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END");
    expect((await t.call("DELETE", `/v1/bindings/${b.bindingId}`, undefined, auth(finalToken))).status).toBe(500);
    expect(rows(t, "relay_bindings")).toHaveLength(1);
    expect(rows(t, "relay_devices")).toHaveLength(1);
    t.db.raw.exec("DROP TRIGGER abort_device");
    expect((await t.call("DELETE", `/v1/bindings/${b.bindingId}`, undefined, auth(finalToken))).status).toBe(200);
    expect(rows(t, "relay_devices")).toEqual([]);
  });
  it("sweeping the last expired grant forgets a recently registered token", async () => {
    const t = relayUnderTest();
    const d = await registeredDevice(t);
    await t.call("POST", "/v1/bindings", undefined, auth(d.deviceSecret));
    t.tick(300_000);
    t.db.raw.exec("CREATE TRIGGER abort_device BEFORE DELETE ON relay_devices BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END");
    await expect(sweep(t).sweep()).rejects.toThrow("test deletion failure");
    expect(rows(t, "relay_bindings")).toHaveLength(1);
    expect(rows(t, "relay_devices")).toHaveLength(1);
    t.db.raw.exec("DROP TRIGGER abort_device");
    await sweep(t).sweep();
    expect(rows(t, "relay_bindings")).toEqual([]);
    expect(rows(t, "relay_devices")).toEqual([]);
  });
});
