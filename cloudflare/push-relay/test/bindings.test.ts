import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_PATTERNS, UUID } from "../../../shared/mobile-push";
import { LIMITS, clientBucket, spend } from "../src/limits";
import { publisher, registeredDevice, relayUnderTest } from "./relay-harness";

const HOUR = 3600_000;
const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });
const registration = (challenge: string, pushToken = "c".repeat(64)) =>
  ({ platform: "ios", environment: "production", pushToken, challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
const challengeOf = async (t: ReturnType<typeof relayUnderTest>, headers: Record<string, string> = {}) =>
  (await (await t.call("POST", "/v1/challenges", undefined, headers)).json() as { challenge: string }).challenge;

// Relay logs carry route, status and counts only. These routes log nothing
// at all on the way through, so any call is a finding.
let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m)); });
// A refusal may say which step failed, as a step name and Google's verdict
// enums only: never a token, an attestation object, a nonce or a digest.
const ALLOWED_LOG_KEYS = new Set(["integrity", "status", "app", "device", "environment", "debugCertMatch", "kind"]);
afterEach(() => {
  for (const spy of logs) {
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("push-relay");
      const line = JSON.parse(call[1] as string) as Record<string, unknown>;
      for (const key of Object.keys(line)) expect(ALLOWED_LOG_KEYS.has(key), key).toBe(true);
      expect(call[1] as string).not.toMatch(/[A-Za-z0-9_-]{24,}/);
    }
    spy.mockRestore();
  }
});

describe("registration", () => {
  it("registers a genuine install with a one-use challenge", async () => {
    const t = relayUnderTest();
    const { challenge } = await (await t.call("POST", "/v1/challenges")).json() as { challenge: string };
    const body = { platform: "ios", environment: "production", pushToken: "a".repeat(64), challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } };
    const first = await t.call("POST", "/v1/devices", body);
    expect(first.status).toBe(201);
    expect(((await first.json()) as { deviceSecret: string }).deviceSecret).toMatch(TOKEN_PATTERNS.deviceSecret);
    expect((await t.call("POST", "/v1/devices", body)).status).toBe(403);
  });
  it("refuses an install the verifier rejects, and an expired challenge", async () => {
    const t = relayUnderTest({ verifier: { verify: async () => ({ ok: false }) } });
    const { challenge } = await (await t.call("POST", "/v1/challenges")).json() as { challenge: string };
    expect((await t.call("POST", "/v1/devices", { platform: "ios", environment: "production", pushToken: "a".repeat(64), challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } })).status).toBe(403);
    const t2 = relayUnderTest();
    const late = await (await t2.call("POST", "/v1/challenges")).json() as { challenge: string };
    t2.tick(300_001);
    expect((await t2.call("POST", "/v1/devices", { platform: "ios", environment: "production", pushToken: "a".repeat(64), challenge: late.challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } })).status).toBe(403);
  });
  it("limits registrations per address", async () => {
    const t = relayUnderTest();
    for (let i = 0; i < 10; i++) await registeredDevice(t, `${i}`.padStart(64, "b"));
    const { challenge } = await (await t.call("POST", "/v1/challenges")).json() as { challenge: string };
    expect((await t.call("POST", "/v1/devices", { platform: "ios", environment: "production", pushToken: "c".repeat(64), challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } })).status).toBe(429);
  });
  it("the same push token registering again replaces the old device and its bindings", async () => {
    const t = relayUnderTest();
    const first = await publisher(t);
    await registeredDevice(t);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_bindings WHERE id=?").bind(first.bindingId).first<{ n: number }>()).toEqual({ n: 0 });
  });
  it("answers a challenge and a registration in the agreed shapes", async () => {
    const t = relayUnderTest();
    const res = await t.call("POST", "/v1/challenges");
    expect(res.status).toBe(201);
    const body = await res.json() as { challenge: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["challenge", "expiresAt"]);
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(t.deps.now() + LIMITS.challengeTtlMs);
    const device = await (await t.call("POST", "/v1/devices", registration(body.challenge))).json() as Record<string, string>;
    expect(Object.keys(device).sort()).toEqual(["deviceId", "deviceSecret"]);
    expect(device.deviceId).toMatch(UUID);
  });
  it("hands the verifier the challenge it issued, and a failed attestation still spends it", async () => {
    const seen: unknown[] = [];
    let ok = false;
    const t = relayUnderTest({ verifier: { verify: async (input) => { seen.push(input); return ok ? { ok: true } : { ok: false }; } } });
    const challenge = await challengeOf(t);
    expect((await t.call("POST", "/v1/devices", registration(challenge))).status).toBe(403);
    expect(seen).toEqual([{ platform: "ios", environment: "production", challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } }]);
    ok = true;
    expect((await t.call("POST", "/v1/devices", registration(challenge))).status).toBe(403);
    expect(seen).toHaveLength(1);
  });
  it("refuses a challenge it never issued without asking the verifier", async () => {
    const verify = vi.fn(async () => ({ ok: true as const }));
    const t = relayUnderTest({ verifier: { verify } });
    expect((await t.call("POST", "/v1/devices", registration("x".repeat(43)))).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });
  it("refuses a malformed registration with a stable code", async () => {
    const t = relayUnderTest();
    const challenge = await challengeOf(t);
    for (const bad of [
      { ...registration(challenge), platform: "web" },
      { ...registration(challenge), pushToken: "short" },
      { ...registration(challenge), extra: 1 },
      { ...registration(challenge), attestation: { kind: "play-integrity" } },
    ]) {
      const res = await t.call("POST", "/v1/devices", bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    const raw = await t.relay(new Request("https://push.murage.test/v1/devices", { method: "POST", body: "{not json", headers: { "cf-connecting-ip": "100.64.0.1" } }), () => {});
    expect(raw.status).toBe(400);
    // None of those spent the challenge.
    expect((await t.call("POST", "/v1/devices", registration(challenge))).status).toBe(201);
  });
  it("keeps only hashes of the device secret, the grant and the publisher token", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const binding = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { grant: string };
    const pending = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { grant: string };
    const redeemed = await (await t.call("POST", "/v1/publishers/redeem", { grant: binding.grant })).json() as { publisherToken: string };
    const tables = ["relay_devices", "relay_bindings", "relay_challenges", "relay_counters", "relay_settings"];
    const dump = JSON.stringify(tables.map((name) => t.db.raw.prepare(`SELECT * FROM ${name}`).all()));
    for (const secret of [device.deviceSecret, binding.grant, pending.grant, redeemed.publisherToken]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(secret.slice(10));
    }
  });
});

describe("bindings", () => {
  it("the eleventh binding on one device is refused", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    for (let i = 0; i < 10; i++) expect((await t.call("POST", "/v1/bindings", undefined, { authorization: `Bearer ${device.deviceSecret}` })).status).toBe(201);
    expect((await t.call("POST", "/v1/bindings", undefined, { authorization: `Bearer ${device.deviceSecret}` })).status).toBe(429);
  });
  it("a grant redeems once, within five minutes, into a publisher token", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const binding = await (await t.call("POST", "/v1/bindings", undefined, { authorization: `Bearer ${device.deviceSecret}` })).json() as { grant: string; bindingId: string };
    expect(binding.grant).toMatch(TOKEN_PATTERNS.grant);
    const redeemed = await t.call("POST", "/v1/publishers/redeem", { grant: binding.grant });
    expect(redeemed.status).toBe(200);
    expect(((await redeemed.json()) as { publisherToken: string }).publisherToken).toMatch(TOKEN_PATTERNS.publisher);
    expect((await t.call("POST", "/v1/publishers/redeem", { grant: binding.grant })).status).toBe(403);
    const late = await (await t.call("POST", "/v1/bindings", undefined, { authorization: `Bearer ${device.deviceSecret}` })).json() as { grant: string };
    t.tick(300_001);
    expect((await t.call("POST", "/v1/publishers/redeem", { grant: late.grant })).status).toBe(403);
  });
  it("the phone or the host can delete a binding, and nobody else", async () => {
    const t = relayUnderTest();
    const a = await publisher(t);
    const b = await publisher(t, (await registeredDevice(t, "d".repeat(64))).deviceSecret);
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, { authorization: `Bearer ${b.publisherToken}` })).status).toBe(403);
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, { authorization: `Bearer ${a.deviceSecret}` })).status).toBe(200);
    expect((await t.call("DELETE", `/v1/bindings/${b.bindingId}`, undefined, { authorization: `Bearer ${b.publisherToken}` })).status).toBe(200);
  });
  it("a token update to a push token another device holds is refused and changes nothing", async () => {
    const t = relayUnderTest();
    const holder = await registeredDevice(t);
    const a = await publisher(t, holder.deviceSecret);
    const b = await registeredDevice(t, "d".repeat(64));
    const res = await t.call("PUT", "/v1/devices/self/token", { pushToken: "a".repeat(64) }, auth(b.deviceSecret));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "token_in_use" });
    const rows = t.db.raw.prepare("SELECT id,push_token FROM relay_devices ORDER BY push_token").all();
    expect(rows).toEqual([{ id: holder.deviceId, push_token: "a".repeat(64) }, { id: b.deviceId, push_token: "d".repeat(64) }]);
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, auth(a.publisherToken))).status).toBe(200);
    // Its own current token is not "in use by another device".
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "d".repeat(64) }, auth(b.deviceSecret))).status).toBe(200);
  });
  it("registration still replaces the device that held the push token", async () => {
    const t = relayUnderTest();
    const a = await registeredDevice(t);
    const b = await registeredDevice(t, "d".repeat(64));
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "e".repeat(64) }, auth(b.deviceSecret))).status).toBe(200);
    await registeredDevice(t, "e".repeat(64));
    expect((await t.call("POST", "/v1/bindings", undefined, auth(b.deviceSecret))).status).toBe(401);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(a.deviceSecret))).status).toBe(201);
  });
  it("a malformed token update does not cost one of the hourly updates", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    for (let i = 0; i < 5; i++) expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "short" }, auth(device.deviceSecret))).status).toBe(400);
    for (let i = 0; i < LIMITS.tokenUpdatesPerDeviceHour; i++) {
      expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: `${i}`.padStart(64, "e") }, auth(device.deviceSecret))).status).toBe(200);
    }
  });
  it("successful creation and token refresh mark the device as seen", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const seen = () => t.db.raw.prepare("SELECT last_seen_at AS at FROM relay_devices WHERE id=?").get(device.deviceId) as { at: number };
    await publisher(t, device.deviceSecret);
    const start = t.deps.now();
    expect(seen().at).toBe(start);
    t.tick(1000);
    const { bindingId } = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { bindingId: string };
    expect(seen().at).toBe(start + 1000);
    t.tick(1000);
    expect((await t.call("DELETE", `/v1/bindings/${bindingId}`, undefined, auth(device.deviceSecret))).status).toBe(200);
    expect(seen().at).toBe(start + 1000);
    t.tick(1000);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "e".repeat(64) }, auth(device.deviceSecret))).status).toBe(200);
    expect(seen().at).toBe(start + 3000);
    // A wrong secret touches nothing.
    t.tick(1000);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(`murage_ds_${"A".repeat(43)}`))).status).toBe(401);
    expect(seen().at).toBe(start + 3000);
  });
  it("a device updates its own push token", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "e".repeat(64) }, { authorization: `Bearer ${device.deviceSecret}` })).status).toBe(200);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "e".repeat(64) }, { authorization: "Bearer murage_ds_nope" })).status).toBe(401);
  });
  it("answers unknown routes with a stable code", async () => {
    const t = relayUnderTest();
    const res = await t.call("GET", "/v1/whatever");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
  it("answers a binding and a redemption in the shapes the host reads", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const res = await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    expect(res.status).toBe(201);
    const binding = await res.json() as { bindingId: string; grant: string; grantExpiresAt: number };
    expect(Object.keys(binding).sort()).toEqual(["bindingId", "grant", "grantExpiresAt"]);
    expect(binding.bindingId).toMatch(UUID);
    expect(binding.grantExpiresAt).toBe(t.deps.now() + LIMITS.grantTtlMs);
    const redeemed = await (await t.call("POST", "/v1/publishers/redeem", { grant: binding.grant })).json() as Record<string, string>;
    expect(Object.keys(redeemed).sort()).toEqual(["bindingId", "publisherToken"]);
    expect(redeemed.bindingId).toBe(binding.bindingId);
  });
  it("two redemptions of one grant at once make exactly one publisher", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const { grant } = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { grant: string };
    const both = await Promise.all([t.call("POST", "/v1/publishers/redeem", { grant }), t.call("POST", "/v1/publishers/redeem", { grant })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
  });
  it("refuses a grant it never issued, and a malformed one, with stable codes", async () => {
    const t = relayUnderTest();
    const unknown = await t.call("POST", "/v1/publishers/redeem", { grant: `murage_pg_${"A".repeat(43)}` });
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: "grant_unavailable" });
    expect((await t.call("POST", "/v1/publishers/redeem", { grant: "murage_pg_short" })).status).toBe(400);
  });
  it("a binding needs a device secret: none, a wrong one and a publisher token are refused", async () => {
    const t = relayUnderTest();
    const a = await publisher(t);
    expect((await t.call("POST", "/v1/bindings")).status).toBe(401);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(`murage_ds_${"A".repeat(43)}`))).status).toBe(401);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(a.publisherToken))).status).toBe(401);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "e".repeat(64) }, auth(a.publisherToken))).status).toBe(401);
  });
  it("deleting a binding the relay no longer has answers 401 to the host, never a server error", async () => {
    const t = relayUnderTest();
    const a = await publisher(t);
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, auth(a.publisherToken))).status).toBe(200);
    const again = await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, auth(a.publisherToken));
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "unauthorized" });
    // The phone re-registered, so the old device and its binding are gone.
    const b = await publisher(t, (await registeredDevice(t, "f".repeat(64))).deviceSecret);
    await registeredDevice(t, "f".repeat(64));
    expect((await t.call("DELETE", `/v1/bindings/${b.bindingId}`, undefined, auth(b.publisherToken))).status).toBe(401);
    // And the phone asking about someone else's or a missing binding is refused.
    const phone = await registeredDevice(t, "9".repeat(64));
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`, undefined, auth(phone.deviceSecret))).status).toBe(403);
    expect((await t.call("DELETE", `/v1/bindings/${a.bindingId}`)).status).toBe(401);
  });
  it("a binding whose grant lapsed unredeemed does not hold one of the ten places", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    for (let i = 0; i < 10; i++) await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    expect((await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).status).toBe(429);
    t.tick(LIMITS.grantTtlMs);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).status).toBe(201);
  });
  it("a redeemed binding keeps its place after the grant would have lapsed", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const kept = await publisher(t, device.deviceSecret);
    for (let i = 0; i < 9; i++) await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    t.tick(LIMITS.grantTtlMs);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).status).toBe(201);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_bindings WHERE device_id=?").bind(device.deviceId).first<{ n: number }>()).toEqual({ n: 2 });
    expect((await t.call("DELETE", `/v1/bindings/${kept.bindingId}`, undefined, auth(kept.publisherToken))).status).toBe(200);
  });
});

describe("limits", () => {
  it("spend counts per scope and per window", async () => {
    const t = relayUnderTest();
    const now = t.deps.now();
    for (let i = 0; i < 3; i++) expect(await spend(t.db, "s", HOUR, 3, now)).toBe(true);
    expect(await spend(t.db, "s", HOUR, 3, now)).toBe(false);
    expect(await spend(t.db, "other", HOUR, 3, now)).toBe(true);
    expect(await spend(t.db, "s", HOUR, 3, now + HOUR)).toBe(true);
  });
  it("thirty challenges an hour per address, then a fresh hour", async () => {
    const t = relayUnderTest();
    for (let i = 0; i < LIMITS.challengesPerIpHour; i++) expect((await t.call("POST", "/v1/challenges")).status).toBe(201);
    const refused = await t.call("POST", "/v1/challenges");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect((await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "100.64.0.2" })).status).toBe(201);
    t.tick(HOUR);
    expect((await t.call("POST", "/v1/challenges")).status).toBe(201);
  });
  it("a request with no client address gets its own limited bucket", async () => {
    const t = relayUnderTest();
    const bare = () => t.relay(new Request("https://push.murage.test/v1/challenges", { method: "POST" }), () => {});
    for (let i = 0; i < LIMITS.challengesPerIpHour; i++) expect((await bare()).status).toBe(201);
    expect((await bare()).status).toBe(429);
    // Not shared with a client that names itself "unknown", nor with a real address.
    expect((await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "unknown" })).status).toBe(201);
    expect((await t.call("POST", "/v1/challenges")).status).toBe(201);
  });
  it("an IPv6 client is one bucket per /64, in any spelling; an IPv4-mapped address counts as IPv4", () => {
    const same = ["2001:db8:1:2::1", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2:0:0:0:9", "[2001:db8:1:2::7]", "2001:db8:1:2::a%eth0"];
    expect(new Set(same.map(clientBucket))).toEqual(new Set(["ip6=2001:0db8:0001:0002::/64"]));
    expect(clientBucket("2001:db8:1:3::1")).toBe("ip6=2001:0db8:0001:0003::/64");
    expect(clientBucket("::1")).toBe("ip6=0000:0000:0000:0000::/64");
    expect(clientBucket("2001:db8::")).toBe("ip6=2001:0db8:0000:0000::/64");
    for (const mapped of ["::ffff:100.64.0.1", "::FFFF:6440:1", "0:0:0:0:0:ffff:100.64.0.1", "100.64.0.1"]) expect(clientBucket(mapped)).toBe("ip4=100.64.0.1");
    expect(clientBucket(null)).toBe("none");
    // Anything unparseable is its own literal bucket, never "none" and never an address's.
    for (const odd of ["unknown", "none", "1:2:3", "1::2::3", "2001:db8:1:2:3:4:5:6:7", "300.1.1.1", "g::1", ""]) expect(clientBucket(odd)).toBe(`raw=${odd}`);
  });
  it("two addresses in one /64 share the challenge limit; another /64 does not", async () => {
    const t = relayUnderTest();
    for (let i = 0; i < LIMITS.challengesPerIpHour; i++) {
      expect((await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": i % 2 ? "2001:db8:1:2::1" : "2001:0db8:1:2:abcd:ef01:2345:6789" })).status).toBe(201);
    }
    expect((await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "2001:db8:1:2::ffff" })).status).toBe(429);
    expect((await t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "2001:db8:1:3::1" })).status).toBe(201);
  });
  it("an IPv4-mapped address shares the IPv4 address's registration limit", async () => {
    const t = relayUnderTest();
    const mapped = { "cf-connecting-ip": "::ffff:100.64.0.1" };
    for (let i = 0; i < LIMITS.registrationsPerIpHour; i++) {
      const headers = i % 2 ? mapped : {};
      expect((await t.call("POST", "/v1/devices", registration(await challengeOf(t, headers), `${i}`.padStart(64, "b")), headers)).status).toBe(201);
    }
    expect((await t.call("POST", "/v1/devices", registration(await challengeOf(t, mapped)), mapped)).status).toBe(429);
  });
  it("ten registrations an hour per address: the tenth lands, the eleventh does not, another address does", async () => {
    const t = relayUnderTest();
    for (let i = 0; i < LIMITS.registrationsPerIpHour; i++) {
      expect((await t.call("POST", "/v1/devices", registration(await challengeOf(t), `${i}`.padStart(64, "b")))).status).toBe(201);
    }
    const challenge = await challengeOf(t);
    expect((await t.call("POST", "/v1/devices", registration(challenge))).status).toBe(429);
    expect((await t.call("POST", "/v1/devices", registration(await challengeOf(t, { "cf-connecting-ip": "100.64.0.9" }), "z".repeat(64)), { "cf-connecting-ip": "100.64.0.9" })).status).toBe(201);
    t.tick(HOUR);
    expect((await t.call("POST", "/v1/devices", registration(await challengeOf(t), "y".repeat(64)))).status).toBe(201);
  });
  it("twenty binding creations an hour per device, even with deletes in between", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    await publisher(t, device.deviceSecret);
    for (let i = 1; i < LIMITS.bindingCreatesPerDeviceHour; i++) {
      const res = await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
      expect(res.status).toBe(201);
      const { bindingId } = await res.json() as { bindingId: string };
      expect((await t.call("DELETE", `/v1/bindings/${bindingId}`, undefined, auth(device.deviceSecret))).status).toBe(200);
    }
    const refused = await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    t.tick(HOUR);
    expect((await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).status).toBe(201);
  });
  it("the ten-binding cap answers binding_limit", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    for (let i = 0; i < LIMITS.bindingsPerDevice; i++) await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    expect(await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json()).toEqual({ error: "binding_limit" });
  });
  it("ten push-token updates an hour per device", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    for (let i = 0; i < LIMITS.tokenUpdatesPerDeviceHour; i++) {
      expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: `${i}`.padStart(64, "e") }, auth(device.deviceSecret))).status).toBe(200);
    }
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "f".repeat(64) }, auth(device.deviceSecret))).status).toBe(429);
    t.tick(HOUR);
    expect((await t.call("PUT", "/v1/devices/self/token", { pushToken: "f".repeat(64) }, auth(device.deviceSecret))).status).toBe(200);
  });
  it("a grant lasts until just before five minutes", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const early = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { grant: string };
    const onTime = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { grant: string };
    t.tick(LIMITS.grantTtlMs - 1);
    expect((await t.call("POST", "/v1/publishers/redeem", { grant: early.grant })).status).toBe(200);
    t.tick(1);
    expect((await t.call("POST", "/v1/publishers/redeem", { grant: onTime.grant })).status).toBe(403);
  });
  it("a challenge lasts until just before five minutes", async () => {
    const t = relayUnderTest();
    const early = await challengeOf(t);
    const onTime = await challengeOf(t);
    t.tick(LIMITS.challengeTtlMs - 1);
    expect((await t.call("POST", "/v1/devices", registration(early, "1".repeat(64)))).status).toBe(201);
    t.tick(1);
    expect((await t.call("POST", "/v1/devices", registration(onTime, "2".repeat(64)))).status).toBe(403);
  });
});

describe("failures", () => {
  it("an unexpected fault is a stable 500 and a content-free log line", async () => {
    const t = relayUnderTest();
    const device = await registeredDevice(t);
    const binding = await (await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret))).json() as { bindingId: string };
    await publisher(t, device.deviceSecret);
    t.db.raw.exec("DROP TABLE relay_counters");
    const res = await t.call("DELETE", `/v1/bindings/${binding.bindingId}`, undefined, auth(device.deviceSecret));
    expect(res.status).toBe(200);
    const broken = await t.call("POST", "/v1/bindings", undefined, auth(device.deviceSecret));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "internal_error" });
    const error = logs[3];
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual(["push-relay", JSON.stringify({ route: "POST /v1/bindings", status: 500 })]);
    error.mockClear();
  });
});
