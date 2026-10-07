// The relay's routes (spec §3.5). Enrolment is rooted in the phone: a
// genuine install registers once with an attestation and gets a device
// secret; each workspace gets a binding and a five-minute, single-use grant
// the host redeems for a publisher token that can publish to that binding
// only. Every refusal is a stable code, never prose. Secrets are stored and
// looked up only as SHA-256 digests of 256 random bits, so no comparison ever
// touches a secret itself.
import { z } from "zod";
import { TOKEN_PATTERNS, UUID } from "../../../shared/mobile-push";
import { APPROVAL_STATEMENT_TTL_MS, approvalBindingNonce, approvalKeyHash, signStatement, type StatementKey } from "./approval-statement";
import type { AttestationVerifier } from "./attestation";
import type { Db } from "./db";
import { HTTPError, bearer, fromBase64url, json, randomToken, readJson, sha256Hex } from "./http";
import { LIMITS, clientHash, edgeAllows, spend, type EdgeLimiter } from "./limits";

export interface RelayDeps {
  db: Db;
  ipHashKey?: string;
  verifier: AttestationVerifier;
  /** The only verifier the approval route uses (Android: release or tester certificate). Absent means 503. */
  approvalVerifier?: AttestationVerifier;
  /** The Ed25519 key that signs approval statements; null or absent means the route answers 503. */
  statementKey?: () => Promise<StatementKey | null>;
  now: () => number;
  paused: () => Promise<boolean>;
  flush?: (waitUntil: (p: Promise<unknown>) => void) => void;
  events?: (request: Request, waitUntil: (p: Promise<unknown>) => void) => Promise<Response>;
  /** The Workers Rate Limiting bindings; either may be absent (no limit). */
  edge?: { open?: EdgeLimiter; bearer?: EdgeLimiter };
}

const HOUR = 3600_000;
const pushToken = z.string().min(16).max(4096).regex(/^\S+$/);
const platform = z.enum(["ios", "android"]);
const environment = z.enum(["development", "production"]);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const attestation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("app-attest"), keyId: z.string().min(1).max(200), attestationObject: z.string().min(1).max(16_000) }),
  z.strictObject({ kind: z.literal("play-integrity"), token: z.string().min(1).max(16_000) }),
]);
const registration = z.strictObject({ platform, environment, pushToken, challenge, attestation });
const approvalKeyRequest = z.strictObject({
  platform, environment, challenge, attestation,
  installId: z.string().regex(/^[A-Za-z0-9._-]{16,128}$/),
  approvalKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
});
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

/** The route as a template, for the one log line: never an id or a token. */
function routeName(method: string, path: string): string {
  const known = ["/v1/challenges", "/v1/devices", "/v1/approval-keys", "/v1/devices/self/token", "/v1/bindings", "/v1/publishers/redeem", "/v1/events"];
  if (known.includes(path)) return `${method} ${path}`;
  return /^\/v1\/bindings\/[^/]+$/.test(path) ? `${method} /v1/bindings/:id` : "other";
}

/** Which edge limit a request spends before any D1 work, if any.
 *  "open": no credential to check yet (a challenge, a registration, a
 *  redemption) or a bearer that is missing or not the route's token shape.
 *  "bearer": a well-formed bearer. Only D1 can tell a real one from a made-up
 *  one, so every lookup is paid for here, at a limit no real client meets. */
function edgeScope(request: Request, path: string): "open" | "bearer" | null {
  const { method } = request;
  if (method === "POST" && ["/v1/challenges", "/v1/devices", "/v1/approval-keys", "/v1/publishers/redeem"].includes(path)) return "open";
  let accepted: RegExp[];
  if ((method === "PUT" && path === "/v1/devices/self/token") || (method === "POST" && path === "/v1/bindings")) accepted = [TOKEN_PATTERNS.deviceSecret];
  else if (method === "POST" && path === "/v1/events") accepted = [TOKEN_PATTERNS.publisher];
  else if (method === "DELETE" && UUID.test(path.match(/^\/v1\/bindings\/([^/]+)$/)?.[1] ?? "")) accepted = [TOKEN_PATTERNS.publisher, TOKEN_PATTERNS.deviceSecret];
  else return null;
  return accepted.some((pattern) => bearer(request, pattern)) ? "bearer" : "open";
}

export function createRelay(deps: RelayDeps) {
  const { db } = deps;
  /** Authenticate without extending retention for a refused request. */
  async function device(request: Request) {
    const secret = bearer(request, TOKEN_PATTERNS.deviceSecret);
    const row = secret ? await db.prepare("SELECT id FROM relay_devices WHERE secret_hash=?").bind(await sha256Hex(secret)).first<{ id: string }>() : null;
    if (!row) throw new HTTPError(401, "unauthorized");
    return row.id;
  }

  async function route(request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
    const now = deps.now();
    const path = new URL(request.url).pathname;
    // Cloudflare always sets it; a request without one shares a bucket with
    // every other such request rather than going unlimited.
    const client = await clientHash(request.headers.get("cf-connecting-ip"), now, deps.ipHashKey);
    // The cheap first gate, ahead of every D1 read (the kill switch included).
    const scope = edgeScope(request, path);
    if (scope && !(await edgeAllows(deps.edge?.[scope], client))) throw new HTTPError(429, "rate_limited");

    if (request.method === "POST" && path === "/v1/challenges") {
      if (!(await spend(db, `ip-challenge:${client}`, HOUR, LIMITS.challengesPerIpHour, now))) throw new HTTPError(429, "rate_limited");
      const challenge = randomToken("");
      await db.prepare("INSERT INTO relay_challenges (id,expires_at) VALUES (?,?)").bind(challenge, now + LIMITS.challengeTtlMs).run();
      return json({ challenge, expiresAt: now + LIMITS.challengeTtlMs }, 201);
    }

    if (request.method === "POST" && path === "/v1/devices") {
      const input = await body(request, registration);
      if (!(await spend(db, `ip-register:${client}`, HOUR, LIMITS.registrationsPerIpHour, now))) throw new HTTPError(429, "rate_limited");
      // Spent before the verifier runs: a refused attestation still uses it up.
      const used = await db.prepare("DELETE FROM relay_challenges WHERE id=? AND expires_at>? RETURNING id").bind(input.challenge, now).first();
      if (!used) throw new HTTPError(403, "challenge_unavailable");
      const verdict = await deps.verifier.verify({ platform: input.platform, environment: input.environment, challenge: input.challenge, attestation: input.attestation });
      if (!verdict.ok) throw new HTTPError(403, "attestation_failed");
      const tokenHash = await sha256Hex(`${input.platform}\n${input.environment}\n${input.pushToken}`);
      const deviceId = crypto.randomUUID();
      const deviceSecret = randomToken("murage_ds_");
      await db.batch([
        db.prepare("DELETE FROM relay_devices WHERE token_hash=?").bind(tokenHash),
        db.prepare("INSERT INTO relay_devices (id,platform,environment,push_token,token_hash,secret_hash,attest_key,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(deviceId, input.platform, input.environment, input.pushToken, tokenHash, await sha256Hex(deviceSecret), verdict.attestKey ?? null, now, now),
      ]);
      return json({ deviceId, deviceSecret }, 201);
    }

    if (request.method === "POST" && path === "/v1/approval-keys") {
      const input = await body(request, approvalKeyRequest);
      // Spent before the attestation is checked, on purpose: verification is the
      // expensive step, so this caps abuse; the cost is a nuisance denial at most.
      if (!(await spend(db, `ip-approval:${client}`, HOUR, LIMITS.approvalStatementsPerIpHour, now))) throw new HTTPError(429, "rate_limited");
      if (!(await spend(db, `install-approval:${await sha256Hex(input.installId)}`, HOUR, LIMITS.approvalStatementsPerInstallHour, now))) throw new HTTPError(429, "rate_limited");
      const signer = await deps.statementKey?.();
      const approvalVerifier = deps.approvalVerifier;
      if (!signer || !approvalVerifier) throw new HTTPError(503, "statement_unavailable");
      const point = fromBase64url(input.approvalKey);
      try {
        if (point.length !== 65 || point[0] !== 4) throw new Error("shape");
        await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch { throw new HTTPError(400, "invalid_request"); }
      // Spent before the verifier runs, as at registration.
      const used = await db.prepare("DELETE FROM relay_challenges WHERE id=? AND expires_at>? RETURNING id").bind(input.challenge, now).first();
      if (!used) throw new HTTPError(403, "challenge_unavailable");
      const keyHash = await approvalKeyHash(point);
      const nonce = await approvalBindingNonce(input.challenge, input.installId, keyHash);
      const verdict = await approvalVerifier.verify({ platform: input.platform, environment: input.environment, challenge: nonce, attestation: input.attestation });
      if (!verdict.ok) throw new HTTPError(403, "attestation_failed");
      const statement = await signStatement(signer, { platform: input.platform, environment: input.environment, installId: input.installId, keyHash, issuedAt: now });
      return json({ statement, expiresAt: now + APPROVAL_STATEMENT_TTL_MS }, 201);
    }

    if (request.method === "PUT" && path === "/v1/devices/self/token") {
      const id = await device(request);
      const input = await body(request, z.strictObject({ pushToken }));
      if (!(await spend(db, `device-token:${id}`, HOUR, LIMITS.tokenUpdatesPerDeviceHour, now))) throw new HTTPError(429, "rate_limited");
      const row = await db.prepare("SELECT platform,environment FROM relay_devices WHERE id=?").bind(id).first<{ platform: string; environment: string }>();
      if (!row) throw new HTTPError(401, "unauthorized");
      const tokenHash = await sha256Hex(`${row.platform}\n${row.environment}\n${input.pushToken}`);
      // Only an attested registration may take a push token from another
      // device; a device secret alone cannot knock another phone off.
      const [updated] = await db.batch([
        db.prepare(`UPDATE relay_devices SET push_token=?,token_hash=?,last_seen_at=MAX(last_seen_at,?) WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM relay_devices WHERE token_hash=? AND id<>?)`)
        .bind(input.pushToken, tokenHash, now, id, tokenHash, id),
        db.prepare("UPDATE relay_bindings SET last_active_at=MAX(last_active_at,?) WHERE device_id=? AND EXISTS (SELECT 1 FROM relay_devices WHERE id=? AND token_hash=?)").bind(now, id, id, tokenHash),
      ]);
      if (!updated.meta.changes) throw new HTTPError(409, "token_in_use");
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/v1/bindings") {
      const id = await device(request);
      if (!(await spend(db, `device-bind:${id}`, HOUR, LIMITS.bindingCreatesPerDeviceHour, now))) throw new HTTPError(429, "rate_limited");
      const bindingId = crypto.randomUUID();
      const grant = randomToken("murage_pg_");
      // A grant that lapsed unredeemed can never become a publisher, so its
      // binding gives its place back rather than holding one of the ten.
      // Insert before retiring old grants, so a replacement never briefly
      // removes the last binding and triggers deletion of its device.
      const [result] = await db.batch([
        db.prepare(`INSERT INTO relay_bindings (id,device_id,grant_hash,grant_expires_at,created_at,last_active_at)
          SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM relay_bindings WHERE device_id=? AND (publisher_hash IS NOT NULL OR grant_expires_at>?))<?`)
          .bind(bindingId, id, await sha256Hex(grant), now + LIMITS.grantTtlMs, now, now, id, now, LIMITS.bindingsPerDevice),
        db.prepare("DELETE FROM relay_bindings WHERE device_id=? AND publisher_hash IS NULL AND grant_expires_at<=?").bind(id, now),
        db.prepare("UPDATE relay_devices SET last_seen_at=MAX(last_seen_at,?) WHERE id=? AND EXISTS (SELECT 1 FROM relay_bindings WHERE id=?)").bind(now, id, bindingId),
      ]);
      if (!result.meta.changes) throw new HTTPError(429, "binding_limit");
      return json({ bindingId, grant, grantExpiresAt: now + LIMITS.grantTtlMs }, 201);
    }

    const deleting = path.match(/^\/v1\/bindings\/([^/]+)$/);
    if (request.method === "DELETE" && deleting && UUID.test(deleting[1])) {
      const publisherToken = bearer(request, TOKEN_PATTERNS.publisher);
      if (publisherToken) {
        // A binding already gone answers 401: the host counts that as removed.
        const row = await db.prepare("SELECT id FROM relay_bindings WHERE publisher_hash=?").bind(await sha256Hex(publisherToken)).first<{ id: string }>();
        if (!row) throw new HTTPError(401, "unauthorized");
        if (row.id !== deleting[1]) throw new HTTPError(403, "forbidden");
      } else {
        const id = await device(request);
        const owned = await db.prepare("SELECT 1 AS yes FROM relay_bindings WHERE id=? AND device_id=?").bind(deleting[1], id).first();
        if (!owned) throw new HTTPError(403, "forbidden");
      }
      await db.prepare("DELETE FROM relay_bindings WHERE id=?").bind(deleting[1]).run();
      return json({ removed: true });
    }

    if (request.method === "POST" && path === "/v1/publishers/redeem") {
      const input = await body(request, z.strictObject({ grant: z.string().regex(TOKEN_PATTERNS.grant) }));
      const publisherToken = randomToken("murage_pt_");
      // One statement: the grant is spent and the publisher set together, so
      // two redemptions racing make exactly one publisher.
      const row = await db.prepare(`UPDATE relay_bindings SET publisher_hash=?, grant_hash=NULL
        WHERE grant_hash=? AND grant_expires_at>? AND publisher_hash IS NULL RETURNING id`)
        .bind(await sha256Hex(publisherToken), await sha256Hex(input.grant), now).first<{ id: string }>();
      if (!row) throw new HTTPError(403, "grant_unavailable");
      return json({ bindingId: row.id, publisherToken });
    }

    if (request.method === "POST" && path === "/v1/events" && deps.events) return deps.events(request, waitUntil);
    throw new HTTPError(404, "not_found");
  }

  return async (request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response> => {
    try {
      return await route(request, waitUntil);
    } catch (error) {
      if (error instanceof HTTPError) return json({ error: error.code }, error.status);
      // Route and status only: the error itself may quote a token or an id.
      console.error("push-relay", JSON.stringify({ route: routeName(request.method, new URL(request.url).pathname), status: 500 }));
      return json({ error: "internal_error" }, 500);
    }
  };
}
