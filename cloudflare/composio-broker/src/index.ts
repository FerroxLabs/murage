import { z } from "zod";

export interface InstallationRow {
  id: string;
  composio_user_id: string;
  session_id: string | null;
  disabled_at: number | null;
  // Moving this install's connected apps to a FluxRouter account, in three
  // legs. `claim_issued_at` records that this Worker SIGNED an assertion;
  // `claim_confirmed_at` records that FluxRouter accepted it and the desktop
  // said so. Only the second one starts the clock that retires the install
  // here — an assertion that was never redeemed (FluxRouter 5xx, a paused
  // claim route, a network failure) must leave the install working.
  claim_issued_at: number | null;
  claim_confirmed_at: number | null;
  last_claim_jti: string | null;
}

interface ComposioSession {
  sessionId: string;
  url: string;
  headers: Record<string, string>;
  userId?: string;
  multiAccountConfigured: boolean;
}

interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const sessionWireSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
  }).optional(),
});
type SessionWire = z.infer<typeof sessionWireSchema>;

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;
const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });
const aliasRequestSchema = z.object({ alias: z.string().nullable().optional() });
const upstreamErrorSchema = z.object({
  message: z.string().optional(),
  error: z.union([
    z.string(),
    z.object({ message: z.string().optional(), error: z.string().optional() }),
  ]).optional(),
});

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_MCP_BODY = 2 * 1024 * 1024;
const MAX_ALIAS_BODY = 2 * 1024;
// A client that stalls mid-upload must not hold the request open indefinitely.
const MCP_BODY_READ_DEADLINE_MS = 30_000;
const ALIAS_BODY_READ_DEADLINE_MS = 10_000;
const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;
// Workers on the free plan get 50 subrequests per request, and the connected
// inventory runs two paginated sweeps back to back — 20 pages each keeps the
// worst case at ~40 fetches with headroom for the session lookup. At 100
// accounts per page nobody real is near the ceiling.
const MAX_CONNECTED_ACCOUNT_PAGES = 20;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | undefined | boolean | number | string | ConnectedAccountSummary | ConnectorServiceState | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function json(value: JsonValue, status = 200, extraHeaders?: Record<string, string>) {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  return new Response(JSON.stringify(value), { status, headers });
}

function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw new Error("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw new Error("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSession(value: SessionWire): ComposioSession {
  const url = new URL(value.mcp.url);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted MCP URL");
  }
  const headers: Record<string, string> = {};
  if (value.mcp.headers) {
    for (const [name, header] of Object.entries(value.mcp.headers)) {
      if (/^(host|cookie|content-length)$/i.test(name)) continue;
      headers[name] = header;
    }
  }
  const config = value.config;
  const multi = config?.multi_account;
  return {
    sessionId: value.session_id,
    url: url.toString(),
    headers,
    userId: config?.user_id,
    // Only `enable` gates reuse: the cap and selection flags are requested at
    // creation, and recreating a Session would post the same config and get
    // the same echo back — strict equality here can only churn, never fix.
    multiAccountConfigured: multi?.enable === true,
  };
}

async function upstreamError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  try {
    const body = upstreamErrorSchema.parse(JSON.parse(text));
    const nested = body.error instanceof Object ? body.error.message ?? body.error.error : body.error;
    return String(body.message ?? nested ?? fallback).slice(0, 240);
  } catch {
    return text.trim().slice(0, 240) || fallback;
  }
}

function composioRequest(env: Env, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("x-api-key", env.COMPOSIO_API_KEY);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${env.COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

async function getSession(env: Env, sessionId: string) {
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(sessionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await upstreamError(response, `Session lookup failed (${response.status})`));
  return parseSession(sessionWireSchema.parse(await response.json()));
}

async function createSession(env: Env, userId: string) {
  const response = await composioRequest(env, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: MULTI_ACCOUNT_CONFIG,
    }),
  });
  if (!response.ok) throw new Error(await upstreamError(response, `Session creation failed (${response.status})`));
  return parseSession(sessionWireSchema.parse(await response.json()));
}

/** Session ids this isolate already tried to upgrade once. If the fresh
 *  Session STILL doesn't echo multi-account, Composio isn't granting it —
 *  serve single-account behavior instead of recreating a Session and writing
 *  D1 on every request. */
const multiAccountUpgradeAttempted = new Set<string>();

async function ensureSession(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  if (!(await env.SESSION_LIMITER.limit({ key: installation.id })).success) {
    throw new Response(JSON.stringify({ error: "too many connected-app requests" }), { status: 429, headers: JSON_HEADERS });
  }
  let session = installation.session_id ? await getSession(env, installation.session_id) : null;
  if (session && !session.multiAccountConfigured && multiAccountUpgradeAttempted.has(session.sessionId)) {
    return session;
  }
  if (!session?.multiAccountConfigured) {
    // Connected accounts are attached to this stable Composio user ID. A new
    // Session upgrades legacy installations without relinking OAuth grants.
    session = await createSession(env, installation.composio_user_id);
    multiAccountUpgradeAttempted.add(session.sessionId);
    await env.DB.prepare("UPDATE installations SET session_id = ?, last_seen_at = ? WHERE id = ?")
      .bind(session.sessionId, Date.now(), installation.id)
      .run();
  } else {
    ctx.waitUntil(
      env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
        .bind(Date.now(), installation.id)
        .run()
        .catch((error: Error) => console.error(JSON.stringify({ message: "last-seen update failed", id: installation.id, error: error.message }))),
    );
  }
  return session;
}

async function authenticate(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id, composio_user_id, session_id, disabled_at, claim_issued_at, claim_confirmed_at, last_claim_jti FROM installations WHERE token_hash = ?",
  ).bind(await sha256(token)).first<InstallationRow>();
  return row && row.disabled_at === null ? row : null;
}

const UNKNOWN_REGISTRATION_ACTOR = "ip:unknown";

function parseIPv4(value: string): number[] | null {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null for anything that is not an IPv6 literal. */
function parseIPv6(value: string): number[] | null {
  let address = value.toLowerCase();
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  if (!address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return null;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const v4 = parseIPv4(address.slice(lastColon + 1));
    if (!v4) return null;
    address = `${address.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if ([...head, ...tail].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

/** Registration actor identity used by the registration limiter.
 *
 * This is the single seam that decides "who is registering". Today it is the
 * client address Cloudflare observed (`cf-connecting-ip`, which a client
 * cannot set through Cloudflare's edge): an IPv4 address exactly, an IPv6
 * address by its /64 (one subscriber allocation hands out a whole /64), and an
 * IPv4-mapped IPv6 address as its IPv4 address. Client-controlled headers such
 * as User-Agent never contribute, so rotating them cannot mint fresh limiter
 * buckets. A missing or unparsable address shares one fail-closed bucket.
 *
 * A later authenticated identity layer (for example a FluxRouter-gated broker)
 * replaces this function; nothing else derives registration identity.
 */
function registrationActorKey(request: Request): string {
  const address = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!address || address.length > 64) return UNKNOWN_REGISTRATION_ACTOR;
  const v4 = parseIPv4(address);
  if (v4) return `ip4:${v4.join(".")}`;
  const v6 = parseIPv6(address);
  if (!v6) return UNKNOWN_REGISTRATION_ACTOR;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return `ip4:${[v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff].join(".")}`;
  }
  return `ip6:${v6.slice(0, 4).map((group) => group.toString(16).padStart(4, "0")).join(":")}::/64`;
}

async function register(request: Request, env: Env) {
  if (env.REGISTRATION_MODE !== "open") return json({ error: "registration is temporarily closed" }, 503);
  const actor = registrationActorKey(request);
  if (!(await env.REGISTRATION_LIMITER.limit({ key: await sha256(actor) })).success) {
    return json({ error: "too many registration attempts" }, 429);
  }
  const installationId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO installations (id, token_hash, composio_user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(installationId, await sha256(token), `murage_${installationId.replaceAll("-", "")}`, now, now).run();
  console.log(JSON.stringify({ message: "installation registered", installationId }));
  return json({ installationId, token }, 201);
}

// ── moving an install to FluxRouter ────────────────────────────────────
// Composio cannot re-key a connection to a new user id, so a FluxRouter
// account ADOPTS this install's `murage_<id>` user instead. This Worker signs
// a short-lived assertion saying "install X is composio user Y"; FluxRouter
// verifies it against a public key and binds the account; the desktop then
// confirms back here. Only that confirmation starts the clock after which this
// Worker stops serving the install, because legs 1 and 2 can fail in ways that
// must leave the install exactly as it was.

const CLAIM_TYP = "murage-composio-claim+jwt";
const CLAIM_AUDIENCE = "fluxrouter-composio";
const CLAIM_LIFETIME_SECONDS = 300;
const DEFAULT_CLAIM_GRACE_SECONDS = 900;
const DEFAULT_CLAIM_ISSUED_FALLBACK_SECONDS = 604_800;
const MAX_CLAIM_BODY = 2 * 1024;
const MAX_CONFIRM_BODY = 512;

const claimRequestSchema = z.object({
  audience: z.literal(CLAIM_AUDIENCE),
  // sha256 of the FluxRouter BROKER token, not of the Flux API key: the Flux
  // key must never reach this Worker in any form, not even hashed. The hash is
  // signed into the assertion and then discarded — it is never stored, never
  // logged, and binds the assertion to one broker token so a leaked assertion
  // is useless to any other account.
  brokerTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const confirmRequestSchema = z.object({
  jti: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
});

interface ClaimEnv {
  CLAIM_MODE?: string;
  CLAIM_UNTIL?: string;
  CLAIM_SIGNING_JWK?: string;
  CLAIM_GRACE_SECONDS?: string;
  CLAIM_ISSUED_FALLBACK_SECONDS?: string;
  LEGACY_BROKER_UNTIL?: string;
  MIGRATION_GATE?: string;
}

function claimEnv(env: Env): ClaimEnv {
  return env as unknown as ClaimEnv;
}

/** A configured instant in milliseconds, or null when unset. An unparseable
 * value is treated as unset rather than as "now": a typo must not retire every
 * install in the fleet. */
export function configuredInstant(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

function configuredSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlText(value: string): string {
  return base64url(new TextEncoder().encode(value));
}

/** The compact JWS FluxRouter verifies. Ed25519 rather than a shared secret:
 * this Worker holds the only private key, FluxRouter holds public keys only,
 * so a FluxRouter compromise cannot mint claims for anyone's install. */
export async function signClaimAssertion(
  jwkText: string,
  payload: Record<string, string | number>,
): Promise<string> {
  const jwk = JSON.parse(jwkText) as JsonWebKey & { kid?: string };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const header = base64urlText(JSON.stringify({ alg: "EdDSA", typ: CLAIM_TYP, kid: jwk.kid }));
  const body = base64urlText(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

async function readJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  { maxBytes, tooLargeMessage }: { maxBytes: number; tooLargeMessage: string },
): Promise<z.infer<T>> {
  const bytes = await readBoundedBody(request, {
    maxBytes,
    deadlineMs: ALIAS_BODY_READ_DEADLINE_MS,
    tooLargeMessage,
  });
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes))) as z.infer<T>;
  } catch {
    throw new Response(JSON.stringify({ error: "invalid request body" }), { status: 400, headers: JSON_HEADERS });
  }
}

/** Leg 1 — issue. Signing does NOT retire the install: `claim_issued_at` is
 * audit plus the 7-day backstop, and the gate keys on the confirmation. */
async function issueClaim(request: Request, installation: InstallationRow, env: Env) {
  const claims = claimEnv(env);
  if (claims.CLAIM_MODE !== "open") return json({ error: "claims are temporarily closed" }, 503);
  const until = configuredInstant(claims.CLAIM_UNTIL);
  if (until !== null && Date.now() >= until) {
    return json({ error: "Moving connected apps to FluxRouter has ended", code: "claims_closed" }, 410);
  }
  if (!(await env.SESSION_LIMITER.limit({ key: await sha256(`claim:${installation.id}`) })).success) {
    return json({ error: "too many claim attempts" }, 429);
  }
  if (!claims.CLAIM_SIGNING_JWK?.trim()) {
    console.error(JSON.stringify({ message: "claim signing key is not configured" }));
    return json({ error: "claims are temporarily closed" }, 503);
  }
  let body: z.infer<typeof claimRequestSchema>;
  try {
    body = await readJsonBody(request, claimRequestSchema, { maxBytes: MAX_CLAIM_BODY, tooLargeMessage: "request body is too large" });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  let assertion: string;
  try {
    assertion = await signClaimAssertion(claims.CLAIM_SIGNING_JWK, {
      iss: "murage-composio",
      aud: CLAIM_AUDIENCE,
      sub: installation.id,
      // Always the stored user id. Never anything the client sent, or a claim
      // would be a way to point a FluxRouter account at someone else's apps.
      cuid: installation.composio_user_id,
      bth: body.brokerTokenSha256,
      iat: issuedAt,
      exp: issuedAt + CLAIM_LIFETIME_SECONDS,
      jti,
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "claim signing failed", error: error instanceof Error ? error.message : "unknown" }));
    return json({ error: "claims are temporarily closed" }, 503);
  }
  await env.DB.prepare(
    `UPDATE installations
        SET claim_issued_at = COALESCE(claim_issued_at, ?1),
            claims_issued = claims_issued + 1,
            last_claim_jti = ?2
      WHERE id = ?3`,
  ).bind(Date.now(), jti, installation.id).run();
  // The assertion and the broker-token hash are deliberately absent from this
  // log line: one is a bearer credential for five minutes, the other a
  // credential derivative this Worker promised never to keep.
  console.log(JSON.stringify({ message: "claim issued", installationId: installation.id, jti }));
  return json({ assertion, expiresAt: (issuedAt + CLAIM_LIFETIME_SECONDS) * 1000, jti });
}

/** Leg 3 — confirm. This is the only thing that starts the grace clock, and it
 * is always served: a confirmation arriving after the cut-off or after claims
 * close is still the truth about where these apps now live. */
async function confirmClaim(request: Request, installation: InstallationRow, env: Env) {
  let body: z.infer<typeof confirmRequestSchema>;
  try {
    body = await readJsonBody(request, confirmRequestSchema, { maxBytes: MAX_CONFIRM_BODY, tooLargeMessage: "request body is too large" });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  if (!installation.last_claim_jti || body.jti !== installation.last_claim_jti) {
    // A newer assertion was issued since, or none ever was. The desktop
    // answers this by running all three legs again; FluxRouter's redeem is
    // idempotent for an account that already holds this install.
    return json({ error: "unknown claim", code: "claim_unknown" }, 409);
  }
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE installations SET claim_confirmed_at = COALESCE(claim_confirmed_at, ?1) WHERE id = ?2",
  ).bind(now, installation.id).run();
  const confirmedAt = installation.claim_confirmed_at ?? now;
  const grace = configuredSeconds(claimEnv(env).CLAIM_GRACE_SECONDS, DEFAULT_CLAIM_GRACE_SECONDS);
  console.log(JSON.stringify({ message: "claim confirmed", installationId: installation.id, jti: body.jti }));
  return json({ confirmed: true, graceEndsAt: confirmedAt + grace * 1000 });
}

/** Whether this install may still use the Murage broker for data.
 *
 * Returns a 410 Response when it may not, null when it may. Never a 401:
 * an old desktop deletes its token on 401 and would lose the identity the
 * claim depends on.
 */
export function migrationGate(installation: InstallationRow, env: Env, now = Date.now()): Response | null {
  const claims = claimEnv(env);
  const retiredAt = configuredInstant(claims.LEGACY_BROKER_UNTIL);
  if (retiredAt !== null && now >= retiredAt) {
    return json({
      error: "Murage's connected-apps service has ended. Connect FluxRouter in Settings to keep using connected apps.",
      code: "legacy_broker_retired",
    }, 410);
  }
  // The Flux-rollback switch. With the gate off, every install that still has
  // a token is served — including claimed ones, whose desktops deliberately
  // kept that token. Both brokers point at the same Composio user, so there is
  // nothing to orphan either way.
  if (claims.MIGRATION_GATE !== "on") return null;
  const moved = json({
    error: "This install's connected apps moved to FluxRouter. Connect FluxRouter in Settings to use them.",
    code: "migrated_to_flux",
  }, 410);
  const grace = configuredSeconds(claims.CLAIM_GRACE_SECONDS, DEFAULT_CLAIM_GRACE_SECONDS);
  if (installation.claim_confirmed_at !== null && installation.claim_confirmed_at + grace * 1000 < now) return moved;
  // The backstop for an install that redeemed at FluxRouter but never
  // confirmed here — a buggy or deliberately silent client that would
  // otherwise use both brokers on one identity for free, indefinitely. Seven
  // days is long enough that any real outage has resolved or been rolled back.
  const fallback = configuredSeconds(claims.CLAIM_ISSUED_FALLBACK_SECONDS, DEFAULT_CLAIM_ISSUED_FALLBACK_SECONDS);
  if (
    installation.claim_confirmed_at === null
    && installation.claim_issued_at !== null
    && installation.claim_issued_at + fallback * 1000 < now
  ) return moved;
  return null;
}

/** Billable-call ceiling.
 *
 * A fuse, not a meter. Composio bills $4 per 1,000 tool calls against one
 * account shared by every install, so a single looping bot could drain the
 * quota for everybody. This caps that blast radius without capping anyone's
 * real use — the default is far above a working day's tool calls.
 *
 * Tunable at deploy time with no code change, the same way the registration
 * kill switch is: `wrangler deploy --var DAILY_CALL_CEILING:500`. Set it to
 * "0" or "off" to disable the fuse entirely.
 */
const DEFAULT_DAILY_CALL_CEILING = 250;

function dailyCallCeiling(env: Env): number {
  const raw = (env as { DAILY_CALL_CEILING?: string }).DAILY_CALL_CEILING?.trim().toLowerCase();
  if (raw === "off" || raw === "0") return Infinity;
  if (!raw) return DEFAULT_DAILY_CALL_CEILING;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CALL_CEILING;
}

/** Count one billable call and report whether this install is over its ceiling.
 *
 * The UTC day number is written in the same statement that increments, so the
 * counter rolls over on comparison and needs no scheduled reset. On a database
 * error this deliberately fails OPEN: the fuse exists to catch a runaway
 * install, and a D1 hiccup taking every user's tools offline is the worse
 * outcome of the two.
 */
/** How many billable Composio executions one MCP POST asks for.
 *
 * The fuse used to count every POST, which made `initialize` and `tools/list`
 * — free at Composio, and the bulk of the traffic — burn the same budget as a
 * real tool run. Only a JSON-RPC `tools/call` costs anything; a batch costs
 * one per `tools/call` message in it. An unparseable body counts as one, which
 * is the conservative direction for a fuse.
 */
export function billableCallCount(body: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return 1;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let count = 0;
  for (const message of messages) {
    if (message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call") count += 1;
  }
  return count;
}

async function chargeCall(installation: InstallationRow, env: Env, units: number): Promise<{ over: boolean; used: number }> {
  const ceiling = dailyCallCeiling(env);
  if (ceiling === Infinity || units <= 0) return { over: false, used: 0 };
  const day = Math.floor(Date.now() / 86_400_000);
  try {
    const row = await env.DB.prepare(
      `UPDATE installations
          SET calls_today = CASE WHEN calls_day = ?1 THEN calls_today + ?3 ELSE ?3 END,
              calls_total = calls_total + ?3,
              calls_day = ?1
        WHERE id = ?2
      RETURNING calls_today`,
    ).bind(day, installation.id, units).first<{ calls_today: number }>();
    const used = row?.calls_today ?? 0;
    return { over: used > ceiling, used };
  } catch (error) {
    console.error(JSON.stringify({
      message: "call ceiling accounting failed; allowing the call",
      id: installation.id,
      error: (error as Error).message,
    }));
    return { over: false, used: 0 };
  }
}

interface BodyBounds {
  maxBytes: number;
  deadlineMs: number;
  tooLargeMessage: string;
}

function bodyRejection(status: number, error: string) {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

/** Read a request body without ever holding more than `maxBytes`.
 *
 * Content-Length is advisory. A chunked or dishonest upload is counted as it
 * streams and the read is cancelled as soon as it passes the cap, so the
 * oversized tail is never pulled or buffered. A malformed declared length is
 * refused, an honest over-cap declaration is refused before any byte is read,
 * and a stalled upload fails at `deadlineMs`. Rejections are thrown as JSON
 * Responses (400, 408, 413) before any billing or upstream work starts.
 */
async function readBoundedBody(
  request: Pick<Request, "body" | "headers">,
  { maxBytes, deadlineMs, tooLargeMessage }: BodyBounds,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = declaredHeader.trim();
    if (!/^\d+$/.test(declared)) throw bodyRejection(400, "invalid content-length");
    if (Number(declared) > maxBytes) throw bodyRejection(413, tooLargeMessage);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(bodyRejection(408, "request body was not received in time")), deadlineMs);
  });
  // The race below observes the rejection; this only stops a late timer from
  // surfacing as unhandled while a cancel is still settling.
  deadline.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw bodyRejection(413, tooLargeMessage);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled read can still be settling; the stream is already closed.
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function proxyMcp(request: Request, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readBoundedBody(request, {
      maxBytes: MAX_MCP_BODY,
      deadlineMs: MCP_BODY_READ_DEADLINE_MS,
      tooLargeMessage: "MCP request is too large",
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const charge = await chargeCall(installation, env, billableCallCount(body));
  if (charge.over) {
    return json({
      error: "This install has hit today's connected-app request limit. It resets at 00:00 UTC.",
      code: "daily_call_ceiling",
      used: charge.used,
    }, 429, { "retry-after": String(Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000)) });
  }
  const session = await ensureSession(installation, env, ctx);
  const upstreamHeaders = new Headers(session.headers);
  upstreamHeaders.set("x-api-key", env.COMPOSIO_API_KEY);
  upstreamHeaders.set("content-type", request.headers.get("content-type") ?? "application/json");
  upstreamHeaders.set("accept", "application/json, text/event-stream");
  const incomingMcpSession = request.headers.get("mcp-session-id");
  if (incomingMcpSession) upstreamHeaders.set("mcp-session-id", incomingMcpSession);
  const response = await fetch(session.url, {
    method: "POST",
    headers: upstreamHeaders,
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  const mcpSession = response.headers.get("mcp-session-id");
  if (mcpSession) headers.set("mcp-session-id", mcpSession);
  return new Response(response.body, { status: response.status, headers });
}

async function catalog(env: Env, url: URL) {
  const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
  const cursor = url.searchParams.get("cursor");
  if (cursor && /^[A-Za-z0-9+/_=-]{1,256}$/.test(cursor)) params.set("cursor", cursor);
  const response = await fetch(`${env.COMPOSIO_TOOLKIT_BASE}/toolkits?${params}`, {
    headers: { accept: "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Catalog unavailable") }, 502);
  return new Response(response.body, {
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, max-age=600" },
  });
}

async function listConnectedAccounts(env: Env, userId: string, slugs: string[]) {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/connected_accounts?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Account lookup failed (${response.status})`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Connected-account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  env: Env,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // Avoid walking the full marketplace just to render the Connected tab.
    // Composio supports a server-side connected-only filter on this route.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
    );
    if (!response.ok) throw new Error(await upstreamError(response, "Toolkit inventory unavailable"));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !account.id || !ACCOUNT_ID.test(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummary & { updatedAt: string } = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return bySlug;
}

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(accounts: ConnectedAccountSummary[]): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = selected?.id && ACCOUNT_ID.test(selected.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    const existingAccounts = accountsBySlug.get(slug) ?? [];
    const accounts = [...existingAccounts];
    if (selectedId && !accounts.some((account) => account.id === selectedId)) {
      accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
    }
    const accountState = serviceStateFromAccounts(accounts);
    const status = toolkit.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
    services.set(slug, {
      connected: toolkit.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    });
  }
  return Object.fromEntries(services);
}

async function connectedServices(
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(env, session.sessionId),
    listConnectedAccounts(env, installation.composio_user_id, []).catch(() => []),
  ]);
  return json({
    configured: true,
    services: allServiceStates(summarizeAccounts(accounts, []), toolkits),
  });
}

async function connectionStatus(url: URL, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const slugs = [...new Set((url.searchParams.get("services") ?? "").split(",").map((slug) => slug.toLowerCase()).filter(Boolean))].slice(0, 50);
  const session = await ensureSession(installation, env, ctx);
  const [response, accounts] = await Promise.all([
    composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slugs.join(",") })}`,
    ),
    listConnectedAccounts(env, installation.composio_user_id, slugs).catch(() => []),
  ]);
  if (!response.ok) return json({ error: await upstreamError(response, "Connection status unavailable") }, 502);
  const body = toolkitPageSchema.parse(await response.json());
  const items = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  const accountsBySlug = summarizeAccounts(accounts, slugs);
  return json({ services: Object.fromEntries(slugs.map((slug) => {
    const item = items.get(slug);
    const serviceAccounts = accountsBySlug.get(slug) ?? [];
    const accountState = serviceStateFromAccounts(serviceAccounts);
    const status = item?.connected_account?.status ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
    return [slug, {
      connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    }];
  })) });
}

async function authorize(
  slug: string,
  alias: string | undefined,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  // Read-only status views may degrade when the inventory is unavailable, but
  // this is a write. An outage or a denied list scope is not proof that no
  // account exists, and linking without the inventory would skip the alias,
  // duplicate and per-toolkit account-count protections. Refuse instead.
  let accounts: ConnectedAccountResponse[];
  try {
    accounts = await listConnectedAccounts(env, installation.composio_user_id, [slug]);
  } catch (error) {
    console.error(JSON.stringify({
      message: "connected-account inventory unavailable; link refused",
      id: installation.id,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    }));
    return json({
      error: "Connected accounts could not be checked right now, so no new link was created. Try again in a moment.",
      code: "account_inventory_unavailable",
    }, 503);
  }
  const serviceAccounts = accounts.filter((account) => account.toolkit?.slug?.toLowerCase() === slug);
  const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
  if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
    return json({ error: `${slug} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts` }, 409);
  }
  if (usableAccounts.length > 0 && !alias) {
    return json({ error: "Add an account alias so the existing connection is not replaced" }, 400);
  }
  if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
    return json({ error: `Account alias "${alias}" is already in use for ${slug}` }, 409);
  }
  const linkRequest: AccountLinkRequest = { toolkit: slug };
  if (alias) linkRequest.alias = alias;
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(session.sessionId)}/link`, {
    method: "POST",
    body: JSON.stringify(linkRequest),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Authorization unavailable") }, 502);
  const body = linkResponseSchema.parse(await response.json());
  if (!body.redirect_url) return json({ error: "Composio returned no authorization link" }, 502);
  const redirect = new URL(body.redirect_url);
  if (redirect.protocol !== "https:" || (redirect.hostname !== "composio.dev" && !redirect.hostname.endsWith(".composio.dev"))) {
    return json({ error: "Composio returned an untrusted authorization link" }, 502);
  }
  return json({ url: redirect.toString() });
}

async function disconnect(slug: string, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const session = await ensureSession(installation, env, ctx);
  const list = await composioRequest(
    env,
    `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slug })}`,
  );
  if (!list.ok) return json({ error: await upstreamError(list, "Connection lookup unavailable") }, 502);
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug)?.connected_account?.id;
  if (!id) return json({ removed: 0 });
  const response = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function disconnectAccount(
  slug: string,
  accountId: string,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  if (!ACCOUNT_ID.test(accountId)) return json({ error: "Invalid connected-account ID" }, 400);
  await ensureSession(installation, env, ctx);
  const accounts = await listConnectedAccounts(env, installation.composio_user_id, [slug]);
  const owned = accounts.some((account) =>
    account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug
  );
  if (!owned) return json({ removed: 0 });
  const response = await composioRequest(
    env,
    `/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE" },
  );
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function requestAlias(request: Request) {
  if (!request.body) return undefined;
  const bytes = await readBoundedBody(request, {
    maxBytes: MAX_ALIAS_BODY,
    deadlineMs: ALIAS_BODY_READ_DEADLINE_MS,
    tooLargeMessage: "request body is too large",
  });
  let body: z.infer<typeof aliasRequestSchema>;
  try {
    const raw = new TextDecoder().decode(bytes);
    // Some Fetch implementations expose a zero-length POST as a non-null
    // ReadableStream. First-account authorization intentionally has no alias,
    // so accept that wire representation exactly like a missing body.
    if (!raw.trim()) return undefined;
    body = aliasRequestSchema.parse(JSON.parse(raw));
  } catch {
    throw new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }
  try {
    return normalizeAccountAlias(body.alias);
  } catch (error) {
    throw new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 400, headers: JSON_HEADERS });
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "murage-composio", ready: Boolean(env.COMPOSIO_API_KEY) });
  if (request.method === "POST" && url.pathname === "/v1/installations") return register(request, env);
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  const installation = await authenticate(request, env);
  if (!installation) return json({ error: "unauthorized" }, 401);
  // Identity and the three claim legs are answered whatever the migration
  // gate says. `/v1/me` is how a desktop learns where it stands, and a claim
  // or a confirmation after the cut-off is still worth recording.
  if (request.method === "GET" && url.pathname === "/v1/me") {
    return json({
      installationId: installation.id,
      claimIssued: installation.claim_issued_at !== null,
      claimConfirmed: installation.claim_confirmed_at !== null,
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/claims") return issueClaim(request, installation, env);
  if (request.method === "POST" && url.pathname === "/v1/claims/confirm") return confirmClaim(request, installation, env);
  // Everything below is a data call on the user's connected apps, and stops
  // once this install has moved to FluxRouter or the service has retired.
  const gated = migrationGate(installation, env);
  if (gated) return gated;
  if (request.method === "POST" && url.pathname === "/v1/mcp") return proxyMcp(request, installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/catalog") return catalog(env, url);
  if (request.method === "GET" && url.pathname === "/v1/connectors/connected") return connectedServices(installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/connectors") return connectionStatus(url, installation, env, ctx);
  const accountMatch = url.pathname.match(/^\/v1\/connectors\/([a-z0-9][a-z0-9_-]{0,80})\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  if (accountMatch && request.method === "DELETE") {
    return disconnectAccount(accountMatch[1], accountMatch[2], installation, env, ctx);
  }
  const match = url.pathname.match(/^\/v1\/connectors\/([a-z0-9][a-z0-9_-]{0,80})(?:\/(authorize))?$/);
  if (match?.[2] && request.method === "POST") return authorize(match[1], await requestAlias(request), installation, env, ctx);
  if (match && !match[2] && request.method === "DELETE") return disconnect(match[1], installation, env, ctx);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "service unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

export {
  authorize,
  catalog,
  confirmClaim,
  issueClaim,
  route,
  connectedServices,
  connectionStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  normalizeAccountAlias,
  parseSession,
  proxyMcp,
  readBoundedBody,
  register,
  registrationActorKey,
  requestAlias,
  sha256,
};
