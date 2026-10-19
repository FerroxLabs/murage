// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra MAKERKIT8 #1, against the REAL home verifier. The add-device route (POST /v1/homes/:id/pairing/device) is LIVE and protected
// (Astra STEPUP-EMAIL-8: it was never retired; this file once asserted a 410 that no revision emits). It runs the real control-plane
// Worker (createWorker, its D1 migrations on node:sqlite through a minimal D1 shim) and the real home handler (createCloudRequestAuth +
// CloudSessions, its pin and its CP-signed pair-hold proof verifier) side by side:
//   - the guarded desktop-code route refuses aal1 (403 step_up_required), as before;
//   - add-device: no sign-in is refused (401/403); the signed-in owner WITHOUT a completed 72-hour pair hold is refused (409
//     pair_hold_required, nothing signed or unwrapped, the home never contacted); WITH the hold the owner gets the signed body;
//   - the home's own checks: that body pairs exactly the device the hold was spent on; another device under a valid HMAC is refused.
import { createHmac, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorker } from "../../cloudflare/control-plane/src/index";
import { resolveCloudAccount } from "../../cloudflare/control-plane/src/cloud-accounts";
import { base64, stagingKeyWrapper } from "../../cloudflare/control-plane/src/key-wrapper";
import { CloudSessions } from "../cloud-sessions.ts";
import { verifiedRecoveryHold } from "./b1b-identity.ts";
import { createCloudRequestAuth } from "../cloud-request-auth.ts";

const CP_ROOT = join(import.meta.dirname, "../../cloudflare/control-plane");

/** The D1 surface the Worker uses, on one node:sqlite connection (batch = one transaction). */
function d1(sql: DatabaseSync) {
  const query = (text: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => query(text, a),
    execute(mode: "first" | "all" | "raw" | "run") {
      const s = sql.prepare(text);
      const params = args as never[];
      if (mode === "first") return s.get(...params) ?? null;
      if (mode === "all") return { success: true, results: s.all(...params), meta: { changes: 0 } };
      if (mode === "raw") return s.all(...params).map((x) => Object.values(x as object));
      const r = s.run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first(col?: string) { const r = this.execute("first") as Record<string, unknown> | null; return col ? r?.[col] ?? null : r; },
    async all() { return this.execute("all"); },
    async raw() { return this.execute("raw"); },
    async run() { return this.execute("run"); },
  });
  return {
    prepare: (text: string) => query(text),
    async exec(text: string) { sql.exec(text); return { count: 1, duration: 0 }; },
    async batch(qs: ReturnType<typeof query>[]) {
      sql.exec("BEGIN");
      try { const r = qs.map((q) => q.execute("run")); sql.exec("COMMIT"); return r; } catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
}

const b64u = (x: string | ArrayBuffer) => Buffer.from(typeof x === "string" ? Buffer.from(x) : new Uint8Array(x)).toString("base64url");

describe("CP add-device route against the real home verifier (Astra MAKERKIT8 #1, STEPUP-EMAIL-8)", () => {
  it("owner sign-in plus a completed pair hold gets a signed body; without either nothing is signed; the home pairs only the held device", async () => {
    const sql = new DatabaseSync(":memory:");
    for (const f of readdirSync(join(CP_ROOT, "migrations")).filter((x) => x.endsWith(".sql")).sort()) sql.exec(readFileSync(join(CP_ROOT, "migrations", f), "utf8"));
    const DB = d1(sql) as never;
    const mail: unknown[] = [];
    const kek = Buffer.alloc(32, 120).toString("base64");
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const signingJwk = await crypto.subtle.exportKey("jwk", signing.privateKey), signingPublic = await crypto.subtle.exportKey("jwk", signing.publicKey);
    const env = {
      DB, BETTER_AUTH_SECRET: "synthetic-test-secret-over-32-characters", BETTER_AUTH_URL: "https://auth.murage.test",
      ALLOWED_ORIGINS: "https://murage.ai", CLOUDFLARE_ACCOUNT_ID: "1".repeat(32), CLOUDFLARE_ZONE_ID: "2".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-key-not-real", COMPANION_HOST_SUFFIX: "companion.example.test",
      EMAIL_FROM: "no-reply@example.test", EMAIL: { async send(m: unknown) { mail.push(m); } },
      SUPABASE_URL: "https://testref.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef", CLOUD_KEK_V1: kek,
      CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk),
    } as never;

    const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", ec.publicKey);
    const homeFetches: string[] = [];
    const worker = createWorker(fetch, fetch, {}, {
      homeFetch: (async (u: string | URL | Request) => { homeFetches.push(String(u)); throw new Error("the CP must not call the home"); }) as typeof fetch,
    }, {}, {
      jwksFetch: (async () => Response.json({ keys: [{ ...jwk, kid: "ec-1", alg: "ES256", use: "sig" }] })) as typeof fetch,
      authFetch: (async () => { throw new Error("Supabase Auth must not be asked"); }) as typeof fetch,
    });
    const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
    const EMAIL = "owner@example.test";
    const s = Math.floor(Date.now() / 1000);
    const account = await resolveCloudAccount(DB, { sub: SUB, email: EMAIL, sessionId: "s", aal: "aal1", amr: [], mfaFactorId: null, exp: s + 3600, iat: s },
      Date.now(), async () => { throw new Error("not asked"); });
    const claims = { iss: "https://testref.supabase.co/auth/v1", aud: "authenticated", exp: s + 3600, iat: s - 5, sub: SUB, email: EMAIL,
      role: "authenticated", is_anonymous: false, app_metadata: { provider: "email", email_verified: true }, user_metadata: {},
      session_id: crypto.randomUUID(), aal: "aal1", amr: [{ method: "otp", timestamp: s - 60 }] };
    const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
    const aal1 = `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;

    const HOME = "fixture-home", origin = "https://h-fixture.murage.test", now = Date.now();
    const bootstrap = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await stagingKeyWrapper(kek).wrap(HOME, bootstrap);
    sql.prepare("INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,1,'active',?,?,'https://admin.example.test')").run(HOME, HOME, now, origin);
    sql.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").run(HOME, wrapped, wrapped, wrapped, "v1");
    sql.prepare("INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at) VALUES (?,?,?,'ready',?,?)").run(HOME, new URL(origin).hostname, `t-${HOME}`, now, now);
    sql.prepare("INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)").run(HOME, "inst-1", account.id, now, now);

    const cp = async (path: string, body: unknown, bearer: string | null = aal1) => {
      const waits: Promise<unknown>[] = [];
      const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method: "POST",
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }), env,
        { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as never);
      await Promise.allSettled(waits);
      return { status: res.status, text: await res.text() };
    };

    // The real home: owned by this account, no device paired (any more), pinned to generation 1, verifying the CP's pair-hold proof.
    const homeDB = new DatabaseSync(":memory:");
    const sessions = new CloudSessions(homeDB, Date.now, origin);
    homeDB.prepare("INSERT INTO cloud_meta VALUES ('account',?)").run(account.id);
    const authenticate = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => base64(bootstrap), homeGeneration: () => 1,
      recoveryProof: (proof: unknown) => verifiedRecoveryHold(proof as never, signingPublic as never, HOME, 1) } as Parameters<typeof createCloudRequestAuth>[0]);
    const homeCall = async (path: string, body: string, headers: Record<string, string> = {}) => {
      const req = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST",
        headers: { host: new URL(origin).host, origin, "content-type": "application/json", ...headers },
        socket: { remoteAddress: "192.0.2.22", localAddress: "192.0.2.11" } });
      const res = { headers: {} as Record<string, unknown>, status: 0, text: "",
        setHeader(n: string, v: unknown) { this.headers[n] = v; }, getHeader(n: string) { return this.headers[n]; },
        writeHead(st: number, h?: Record<string, unknown>) { this.status = st; Object.assign(this.headers, h ?? {}); return this; },
        end(t?: string) { this.text += t ?? ""; return this; } };
      expect(await authenticate(req as never, res as never, new URL(path, origin))).toBe(true);
      return { status: res.status, body: JSON.parse(res.text || "{}") as Record<string, unknown> };
    };

    const deviceKey = generateKeyPairSync("ed25519"), assertionKey = generateKeyPairSync("ed25519");
    const device = { scope: "owner-desktop", publicKey: deviceKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
      assertionKey: assertionKey.publicKey.export({ format: "pem", type: "spki" }).toString() };

    // 1. The guarded route refuses aal1, as before.
    const guarded = await cp(`/v1/account/homes/${HOME}/desktop-code`, {});
    expect(guarded.status).toBe(403);
    expect(JSON.parse(guarded.text).error).toBe("step_up_required");

    const route = `/v1/homes/${HOME}/pairing/device`;
    const unwraps = () => sql.prepare("SELECT COUNT(*) AS n FROM cloud_unwrap_log").get();
    // 2. No sign-in: refused before anything else.
    const anonymous = await cp(route, { device }, null);
    expect([401, 403]).toContain(anonymous.status);
    // 3. The signed-in owner WITHOUT a completed pair hold: refused, nothing signed or unwrapped, the home never contacted.
    const noHold = await cp(route, { device });
    expect([noHold.status, JSON.parse(noHold.text).error]).toEqual([409, "pair_hold_required"]);
    sql.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,completed_at,canceled_at,source)
      VALUES ('hold-pending-pair-0001',?,'pair',1,?,?,NULL,NULL,'customer')`).run(HOME, now - 3_600_000, now + 71 * 3_600_000);
    const pending = await cp(route, { device });
    expect([pending.status, JSON.parse(pending.text).error]).toEqual([409, "pair_hold_required"]);
    expect(unwraps()).toEqual({ n: 0 });
    expect(homeFetches).toEqual([]);
    expect(mail).toEqual([]);

    // 4. WITH a completed 72-hour pair hold: the owner gets the signed body (its proof names this device), recorded once.
    sql.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,completed_at,canceled_at,source)
      VALUES ('hold-completed-pair-0001',?,'pair',1,?,?,?,NULL,'customer')`).run(HOME, now - 73 * 3_600_000, now - 3_600_000, now - 3_600_000);
    const held = await cp(route, { device });
    expect(held.status).toBe(200);
    const signedBody = JSON.parse(held.text) as { body: string; signature: string; homeOrigin: string };
    expect(signedBody.homeOrigin).toBe(origin);
    expect(unwraps()).toEqual({ n: 1 });
    expect(homeFetches).toEqual([]);

    // 5. The home's own checks: another device under a VALID HMAC with the same proof is refused (the proof names the held device).
    const other = generateKeyPairSync("ed25519"), otherFactor = generateKeyPairSync("ed25519");
    const swapped = JSON.stringify({ ...JSON.parse(signedBody.body), nonce: crypto.randomUUID().replaceAll("-", ""),
      publicKey: other.publicKey.export({ format: "pem", type: "spki" }).toString(), assertionKey: otherFactor.publicKey.export({ format: "pem", type: "spki" }).toString() });
    const refused = await homeCall("/api/cloud/pairing", swapped, { "x-murage-signature": createHmac("sha256", base64(bootstrap)).update(swapped).digest("hex") });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBeUndefined();
    // A body with no valid HMAC is refused too.
    expect((await homeCall("/api/cloud/pairing", signedBody.body, { "x-murage-signature": "0".repeat(64) })).status).not.toBe(200);
    expect(homeDB.prepare("SELECT COUNT(*) AS n FROM cloud_devices").get()).toEqual({ n: 0 });

    // 6. The signed body as returned: the home mints a code for exactly the held device, and that device pairs.
    const minted = await homeCall("/api/cloud/pairing", signedBody.body, { "x-murage-signature": signedBody.signature });
    expect(minted.status).toBe(200);
    const msg = Buffer.from(`murage-pair:${sessions.environmentId}:${String(minted.body.code)}:${account.id}`);
    const redeemed = await homeCall("/api/cloud/pair", JSON.stringify({ code: minted.body.code, account: account.id,
      signature: nodeSign(null, msg, deviceKey.privateKey).toString("base64url"),
      assertionSignature: nodeSign(null, msg, assertionKey.privateKey).toString("base64url") }));
    expect([redeemed.status, redeemed.body.scope]).toEqual([200, "owner-desktop"]);
    expect(homeDB.prepare("SELECT COUNT(*) AS n FROM cloud_devices").get()).toEqual({ n: 1 });
  });
});
