import { describe, expect, it, vi } from "vitest";
import { createProviders } from "../src/providers";
import { migrated } from "./d1";

const event = { bindingId: "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", eventRef: "9b1f0c4e2a7d3e8f5c6b1a0d9e8f7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f", category: "approval" as const, revision: 1, workspaceBadge: 2,
  collapseKey: "be753ac14d84299e2b22e52b6dba3a17", threadGroup: "46af17e29b1130f0", timeSensitive: true, expiresAt: 1790000000000 };
async function apnsKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  return { teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----` };
}

describe("providers", () => {
  it("APNs goes to sandbox for development with a JWT, and maps Unregistered to invalid-token", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch, now: () => 1789999100000 });
    expect(await p.send({ platform: "ios", environment: "development", push_token: "a".repeat(64) }, event, 3, new AbortController().signal)).toBe("invalid-token");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.sandbox.push.apple.com/3/device/${"a".repeat(64)}`);
    expect((init.headers as Record<string, string>).authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
  it("an invalid token is logged with provider, status and reason, never the token (B12)", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = "b".repeat(64);
      const fetch = vi.fn(async () => new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 }));
      const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch, now: () => 1789999100000 });
      expect(await p.send({ platform: "ios", environment: "production", push_token: token }, event, 3, new AbortController().signal)).toBe("invalid-token");
      const lines = warn.mock.calls.map((c) => `${c[0]} ${c[1]}`);
      expect(lines).toContain('push-relay {"provider":"apns","status":400,"reason":"invalid_token"}');
      expect(lines.join("\n")).not.toContain(token);
    } finally { warn.mockRestore(); }
  });
  it("a 429 or 5xx is a retry with Retry-After respected and bounded", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503, headers: { "retry-after": "5" } }));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch, now: () => 1789999100000 });
    expect(await p.send({ platform: "ios", environment: "production", push_token: "a".repeat(64) }, event, 3, new AbortController().signal)).toEqual({ retryAfterMs: 60_000 });
  });
  it("an unconfigured platform holds the event for a minute, uses no attempt and logs why", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = createProviders({ apns: null, fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch: vi.fn(), now: () => 0 });
      const android = await p.send({ platform: "android", environment: "production", push_token: "t".repeat(20) }, event, 0, new AbortController().signal);
      const ios = await p.send({ platform: "ios", environment: "production", push_token: "a".repeat(64) }, event, 0, new AbortController().signal);
      expect(android).toEqual({ retryAfterMs: 60_000, network: true });
      expect(ios).toEqual({ retryAfterMs: 60_000, network: true });
      const lines = warn.mock.calls.map((c) => String(c[1]));
      expect(lines.some((l) => l.includes('"reason":"not_configured"') && l.includes('"provider":"fcm"'))).toBe(true);
      expect(lines.some((l) => l.includes('"reason":"not_configured"') && l.includes('"provider":"apns"'))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});

const ios = { platform: "ios" as const, environment: "development" as const, push_token: "a".repeat(64) };
const android = { platform: "android" as const, environment: "production" as const, push_token: "fcm-token-" + "x".repeat(40) };
async function serviceAccount() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  return { client_email: `relay-${crypto.randomUUID()}@murage-test.iam.gserviceaccount.com`, project_id: "murage-test", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----` };
}

describe("a provider that cannot be reached", () => {
  const unreachable: Array<[string, () => (url: string, init: RequestInit) => Promise<Response>, () => AbortSignal]> = [
    ["a connection failure", () => async () => { throw new TypeError("fetch failed"); }, () => new AbortController().signal],
    ["an abort", () => async (_u, init) => { init.signal!.throwIfAborted(); return new Response("{}"); }, () => AbortSignal.abort()],
    ["a timeout", () => (_u, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))), () => AbortSignal.timeout(10)],
  ];
  for (const [name, make, signal] of unreachable) {
    it(`${name} is a network retry, never a rejection`, async () => {
      const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch: vi.fn(make()) as unknown as typeof fetch, now: () => 1789999100000 });
      const result = await p.send(ios, event, 3, signal());
      expect(result).toMatchObject({ network: true });
      expect((result as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    });
  }
});

describe("provider credentials", () => {
  it("the APNs JWT is cached encrypted in relay_provider_auth and reused", async () => {
    const db = migrated();
    const key = await apnsKey();
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    const p = createProviders({ apns: key, fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch, now: () => 1789999100000 });
    expect(await p.send(ios, event, 1, new AbortController().signal)).toBe("accepted");
    const again = createProviders({ apns: key, fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch, now: () => 1789999100000 + 60_000 });
    expect(await again.send(ios, event, 1, new AbortController().signal)).toBe("accepted");
    const auths = fetch.mock.calls.map((c) => ((c as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization);
    expect(auths[0]).toBe(auths[1]);
    const rows = (await db.prepare("SELECT cache_key, ciphertext, expires_at FROM relay_provider_auth").all<{ cache_key: string; ciphertext: string; expires_at: number }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBeGreaterThan(1789999100000);
    expect(JSON.stringify(rows)).not.toContain(auths[0].slice("bearer ".length, 40));
  });
  it("the FCM OAuth token is cached encrypted with its expiry, and FCM maps UNREGISTERED to invalid-token", async () => {
    const db = migrated();
    const sa = await serviceAccount();
    const now = 1789999100000;
    const fetch = vi.fn(async (url: string) => url.startsWith("https://oauth2.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "ya29.relay-test-access-token", expires_in: 3600 }))
      : new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 }));
    const p = createProviders({ apns: null, fcm: sa, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
    expect(await p.send(android, event, 1, new AbortController().signal)).toBe("invalid-token");
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://fcm.googleapis.com/v1/projects/murage-test/messages:send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.relay-test-access-token");
    const rows = (await db.prepare("SELECT cache_key, iv, ciphertext, expires_at FROM relay_provider_auth").all<{ cache_key: string; expires_at: number }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBe(now + 3600_000);
    expect(JSON.stringify(rows)).not.toContain("ya29");
    expect(JSON.stringify(rows)).not.toContain(sa.client_email);
  });
  it("logs carry no token, push token or key: only a host and an error kind", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      // An error that quotes the URL (so the APNs device token) must not reach the log.
      const p = createProviders({ apns: await apnsKey(), fcm: await serviceAccount(), bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(),
        fetch: vi.fn(async (url: string) => { throw new TypeError(`fetch failed: ${url}`); }) as unknown as typeof fetch, now: () => 1789999100000 });
      await p.send(ios, event, 1, new AbortController().signal);
      await p.send(android, event, 1, new AbortController().signal);
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const secret of [ios.push_token, android.push_token, "PRIVATE KEY", "ya29", "bearer", "Bearer"]) expect(logged).not.toContain(secret);
      for (const call of spies.flatMap((spy) => spy.mock.calls)) {
        expect(call[0]).toBe("push-relay");
        expect(Object.keys(JSON.parse(call[1] as string)).sort()).toEqual(["kind", "unanswered"]);
        expect(JSON.parse(call[1] as string).kind).toBe("TypeError");
      }
      expect(logged).not.toContain("/3/device/");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("APNs provider-token errors", () => {
  const apnsRows = async (db: ReturnType<typeof migrated>) =>
    db.prepare("SELECT COUNT(*) AS n FROM relay_provider_auth WHERE cache_key LIKE 'apns:%'").first<{ n: number }>();
  it("ExpiredProviderToken drops a cached JWT at least 20 minutes old and retries rather than rejecting", async () => {
    const db = migrated();
    let status = 200;
    let now = 1789999100000 - 21 * 60_000;
    const fetch = vi.fn(async () => (status === 200 ? new Response("", { status }) : new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status })));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch, now: () => now });
    expect(await p.send(ios, event, 1, new AbortController().signal)).toBe("accepted");
    status = 403;
    now += 20 * 60_000;
    const result = await p.send(ios, event, 1, new AbortController().signal);
    expect(result).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect((result as { network?: true }).network).toBeUndefined();
    expect(await apnsRows(db)).toEqual({ n: 0 });
  });
  it("ExpiredProviderToken keeps a JWT younger than 20 minutes: Apple would refuse a new one", async () => {
    const db = migrated();
    let status = 200;
    let now = 1789999100000 - 21 * 60_000;
    const fetch = vi.fn(async () => (status === 200 ? new Response("", { status }) : new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status })));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch, now: () => now });
    expect(await p.send(ios, event, 1, new AbortController().signal)).toBe("accepted");
    status = 403;
    now += 60_000;
    expect(await p.send(ios, event, 1, new AbortController().signal)).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(await apnsRows(db)).toEqual({ n: 1 });
  });
  it("InvalidProviderToken retries without dropping the JWT: a new one would not fix it", async () => {
    const db = migrated();
    let status = 200;
    let now = 1789999100000 - 21 * 60_000;
    const fetch = vi.fn(async () => (status === 200 ? new Response("", { status }) : new Response(JSON.stringify({ reason: "InvalidProviderToken" }), { status })));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db, fetch, now: () => now });
    expect(await p.send(ios, event, 1, new AbortController().signal)).toBe("accepted");
    status = 403;
    now += 20 * 60_000;
    const result = await p.send(ios, event, 1, new AbortController().signal);
    expect(result).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect((result as { network?: true }).network).toBeUndefined();
    expect(await apnsRows(db)).toEqual({ n: 1 });
  });
  it("any other 403 is still a rejection", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ reason: "BadTopic" }), { status: 403 }));
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch, now: () => 1789999100000 });
    expect(await p.send(ios, event, 1, new AbortController().signal)).toBe("rejected");
  });
});

describe("APNs token minting under provider-token errors", () => {
  it("failing sends re-mint only once the token is 20 minutes old, then not again for 20 minutes", async () => {
    const start = 1789999100000 - 25 * 60_000; // the fixture event expires at 1790000000000
    let now = start;
    const auths: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      auths.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status: 403 });
    });
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
    const sign = vi.spyOn(crypto.subtle, "sign");
    try {
      const iats: number[] = [];
      for (let i = 0; i < 25; i++) {
        expect(await p.send(ios, event, 1, new AbortController().signal)).toMatchObject({ retryAfterMs: expect.any(Number) });
        iats.push(JSON.parse(atob(auths[i].split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))).iat);
        now += 60_000;
      }
      // The first token, then exactly one replacement: the 403 at minute 20
      // drops it, and the send at minute 21 mints the next.
      expect(new Set(auths).size).toBe(2);
      expect(sign).toHaveBeenCalledTimes(2);
      expect(iats.slice(0, 21).every((iat) => iat === Math.floor(start / 1000))).toBe(true);
      expect(iats[21]).toBe(Math.floor((start + 21 * 60_000) / 1000));
    } finally {
      sign.mockRestore();
    }
  });
  it("a token is minted with a fresh issue time and reused until it is 30 minutes old", async () => {
    let now = 1789999100000 - 20 * 60_000; // the fixture event expires at 1790000000000
    const auths: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => { auths.push((init.headers as Record<string, string>).authorization); return new Response("", { status: 200 }); });
    const p = createProviders({ apns: await apnsKey(), fcm: null, bundleId: "com.murage.mobile", packageName: "com.murage.mobile", db: migrated(), fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
    await p.send(ios, event, 1, new AbortController().signal);
    expect(JSON.parse(atob(auths[0].split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))).iat).toBe(Math.floor(now / 1000));
    now += 29 * 60_000;
    await p.send(ios, event, 1, new AbortController().signal);
    now += 2 * 60_000;
    await p.send(ios, event, 1, new AbortController().signal);
    expect(auths[1]).toBe(auths[0]);
    expect(auths[2]).not.toBe(auths[0]);
  });
});
