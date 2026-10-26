// SPDX-License-Identifier: AGPL-3.0-or-later
// Customer self-service from the members area (src/self-service.ts): every route, its rate limits, the Fix-it ladder stopping once the
// home is healthy, the watchdog's loop bound, members-area holds (fresh aal2 + 72 h hold, cancellable), Reset my Cloud (reversible, no
// hold), redacted logs, and the automated MFA-gated export. Real-shaped Supabase ES256 tokens; the B3 fake provider; no network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import { RECOVERY_HOLD_MS, type Home } from "../src/b3-control";
import { sweepCustomerWaiting, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import type { StorageBoxAdapter } from "../src/b5-backup";
import { ageIdentity, allowedLogMessage, EXPORT_MIN_AVAILABLE_MS, EXPORT_STORAGE_BUDGET_BYTES, HEALTHY_HEARTBEAT_MS, JOB_GRACE_MS, JOB_PICKUP_MS, LIMITS,
  LOG_EVENTS, POWER_RELEASE_BEATS, POWER_UNCERTAIN_MS, settlePower, redact, RESET_UNDO_MS, RUN_MS, STEP_WAIT_MS, sweepSelfService, WATCHDOG_STALE_MS } from "../src/self-service";
import { purgeBackup } from "../src/b5-backup";
import { appOutcome, healthState, healthy, liveAt } from "../src/self-service";
import { recordHealth } from "../src/ops-monitor";
import { HostError } from "../src/b5-provisioner";
import contract from "../../../shared/self-service-contract.json";

const ADMIN = "test-only-b3-admin-no-real-access";
const KEK = btoa("x".repeat(32));
const IMAGE = `sha256:${"a".repeat(64)}`;
const NOW = 1_800_000_000_000;
const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const INSTALL = "12345678-1234-4123-8123-123456789012";
const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const JWKS_URL = `${ISS}/.well-known/jwks.json`;
const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_SUB = "6f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5c";
const CONFIG = {
  reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "hel-available", projectId: "project-2", location: "hel1", serverType: "cpx32", outcome: "available" }],
};
const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? Buffer.from(b) : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
let reboots: string[]; let starts: string[];
let notices: { kind: string; data: Record<string, unknown> }[];
let fluxUsage: Partial<FluxEntitlementHooks> | undefined;
let box: { files: Map<string, string>; purged: string[]; fail?: "stream" | "short" };
/** A provider power call that fails: "provider_timeout" is what bounded() reports for a call that may still be executing. */
let providerFailure: string | null;
/** What the provider reports for a power action's status, and the action ids it was asked about. */
type PS = "running" | "success" | "error" | "none";
let powerStatus: PS; let powerQueries: (string | null)[]; let powerByServer: Map<string, PS>;
/** The provider says the server is up (server_up); the call answers without an action id (Vultr); a provider error to throw. */
let serverUp: boolean; let receiptless: boolean; let providerError: Error | null;
/** Runs during provider discovery (list_by_tag): a test can change the world while the provider call is in flight. */
let duringDiscovery: (() => Promise<void>) | null;
/** A reboot answer that arrives only after this many ms (the local bound is then timeoutMs); null: at once. */
let lateAnswerMs: number | null; let timeoutMs: number | undefined;

/** The member's trusted second factor (makerkit-auth: step-up needs a factor trusted here and still verified at Supabase). */
const FACTOR = "7d3e0c1a-1111-4222-8333-944455566677";
const claimsOf = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { sub: string; aal: string; email: string };
const authFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const c = claimsOf(String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, ""));
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: FACTOR, factor_type: "totp", status: "verified" }] });
}) as typeof fetch;
const jwksFetch = (async (input: RequestInfo | URL) => String(input) === JWKS_URL ? Response.json(jwks) : new Response("no", { status: 404 })) as typeof fetch;
const noNetwork = async () => { throw new Error("attempted network transport"); };
const provider = (db: D1Database): ProviderAdapter => {
  const base = fakeProvider(db);
  const fail = () => { if (providerError) throw providerError; if (providerFailure) throw new Error(providerFailure); };
  return { ...base, reboot: async (id) => {
      reboots.push(id); fail();
      if (lateAnswerMs !== null) { const n = reboots.length; await new Promise((r) => setTimeout(r, lateAnswerMs!)); return { actionId: `late-${n}` }; }
      return { actionId: receiptless ? null : `act-${reboots.length}` };
    },
    start: async (id) => { starts.push(id); fail(); return { actionId: receiptless ? null : `start-${starts.length}` }; },
    power_action_status: async (id, _action, actionId) => { powerQueries.push(actionId); return powerByServer.get(id) ?? powerStatus; },
    server_up: async () => serverUp,
    list_by_tag: async (...args: Parameters<ProviderAdapter["list_by_tag"]>) => {
      if (duringDiscovery) { const hook = duringDiscovery; duringDiscovery = null; await hook(); }
      return base.list_by_tag(...args);
    } };
};
const notifier: BillingNotifier = { async notify(_env, notice) { notices.push({ kind: notice.kind, data: notice.data }); } };
const under = (d: string) => [...box.files.keys()].filter((k) => k.startsWith(`${d}/`));
const fakeBox = (): StorageBoxAdapter => ({
  createSubaccount: noNetwork, purgeDirectory: async (d) => { box.purged.push(d); for (const k of under(d)) box.files.delete(k); },
  directoryExists: async (d) => under(d).length > 0,
  deleteSubaccount: async () => {}, countSubaccounts: async () => 0,
  makeDirectory: async () => {},
  moveDirectory: async (from, to) => { for (const k of under(from)) { box.files.set(to + k.slice(from.length), box.files.get(k)!); box.files.delete(k); } },
  download: async (path) => {
    const f = box.files.get(path); if (f === undefined) throw new Error("missing");
    if (box.fail === "short") return new Response(f.slice(0, 5));
    if (box.fail === "stream") {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(f.slice(0, 5))); c.error(new Error("storage connection reset")); } }));
    }
    return new Response(f);
  },
});
function worker() {
  return createWorker(noNetwork, noNetwork, { provider }, {}, { notifier, ...(fluxUsage ? { flux: fluxUsage as FluxEntitlementHooks } : {}) },
    { jwksFetch, authFetch, now: () => Date.now() }, { storageBox: () => fakeBox(), ...(timeoutMs ? { providerTimeoutMs: timeoutMs } : {}) });
}
function testEnv(): Env {
  return { ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: "1", CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(CONFIG),
    CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined } as unknown as Env;
}
async function token(opts: { aal2?: boolean; stale?: boolean; sub?: string; email?: string } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const claims = { iss: ISS, aud: "authenticated", exp: nowS + 3600, iat: nowS - 5, sub: opts.sub ?? SUB, email: opts.email ?? "pat@example.test", phone: "",
    app_metadata: { provider: "email", providers: ["email"], email_verified: true }, user_metadata: {}, role: "authenticated",
    aal: opts.aal2 ? "aal2" : "aal1", amr: opts.aal2 ? [{ method: "totp", timestamp: nowS - (opts.stale ? 1200 : 30) }] : [{ method: "password", timestamp: nowS - 60 }],
    session_id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", is_anonymous: false, ...(opts.aal2 ? { mfa_factor_id: FACTOR } : {}) };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
/** A fresh-token caller has the trusted factor its token names (the account is created by a plain request first if it does not exist yet). */
async function trustFactorFor(tok: string) {
  let c: ReturnType<typeof claimsOf>;
  try { c = claimsOf(tok); } catch { return; } // a machine or admin credential, not a member token
  if (c.aal !== "aal2") return;
  const find = () => env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(c.sub).first<{ user_id: string }>();
  let row = await find();
  if (!row) {
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${tok}`, "CF-Connecting-IP": "203.0.113.10" } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    row = await find();
  }
  if (!row) return;
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row.user_id, FACTOR).run();
}
async function call(path: string, bearer: string | null, body?: unknown, method?: string) {
  if (bearer && bearer !== ADMIN) await trustFactorFor(bearer);
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.10" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker().fetch(new Request(`https://auth.murage.test${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers,
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const admin = (path: string, body: unknown) => call(path, ADMIN, body);
const getHome = async () => (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id='home-1'").first<Home>())!;
const sweep = (now = Date.now()) => sweepSelfService(testEnv(), { b3: { provider }, billing: { notifier }, storageBox: () => fakeBox() }, now);
const at = (ms: number) => vi.mocked(Date.now).mockReturnValue(ms);
const errorOf = async (r: Response) => (await r.json<{ error: string }>()).error;

let account: string;
let machineCredential: string;
let generation: number;
/** A paid, enrolled, canary-passed home owned by the members-area customer SUB. */
async function readyHome() {
  expect((await call("/v1/account/home", await token())).status).toBe(404); // creates the account; no home yet
  account = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(SUB).first<{ user_id: string }>())!.user_id;
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'Self-service test','linux',?,?)`).bind(INSTALL, account, INSTALL, NOW, NOW).run();
  expect((await admin("/v1/fake-b3/reserve", { homeId: "home-1", installationId: INSTALL, ownerId: account,
    publicOrigin: "https://home-1.murage.test", idempotencyKey: "reserve-key-home-1-0001" })).status).toBe(201);
  expect((await admin("/v1/fake-b3/payments", { eventId: "evt-1", homeId: "home-1", version: 1, status: "paid", paymentId: "payment-home-1" })).status).toBe(202);
  expect((await admin("/v1/fake-b3/reconcile", {})).status).toBe(200);
  const rotated = await (await admin("/v1/machines/home-1/rotate", {})).json<{ enrollmentToken: string }>();
  const enrolled = await (await call("/v1/machines/home-1/enroll", "", { token: rotated.enrollmentToken })).json<{ machineCredential: string; generation: number }>();
  machineCredential = enrolled.machineCredential; generation = enrolled.generation;
  await call("/v1/machines/home-1/commands", machineCredential); // the image's self-service runner polls: it can run commands
  expect((await admin("/v1/fake-b3/homes/home-1/canary", { generation, imageDigest: IMAGE,
    checks: { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true } })).status).toBe(200);
  expect(await getHome()).toMatchObject({ desired_state: "ready", observed_state: "ready" });
}
const heartbeat = async () => expect((await call("/v1/machines/home-1/heartbeat", machineCredential, { generation })).status).toBe(200);
const desiredCommands = async () => (await (await call("/v1/machines/home-1/commands", machineCredential)).json<{ commands: { id: string; kind: string; payload: Record<string, unknown> }[] }>()).commands;
const ack = (commandId: string, outcome = "done") => call("/v1/machines/home-1/commands/ack", machineCredential, { generation, commandId, outcome });

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  reboots = []; starts = []; notices = []; fluxUsage = undefined; box = { files: new Map(), purged: [] }; duringDiscovery = null; providerFailure = null; powerStatus = "success"; powerQueries = []; powerByServer = new Map(); serverUp = false; receiptless = false; providerError = null; lateAnswerMs = null; timeoutMs = undefined;
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), kid: "ec-1", alg: "ES256", use: "sig", key_ops: ["verify"], ext: true }] };
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
  await readyHome();
  // Sequence 5 is the fleet's promoted release (rollout controller): the only sequence the Update button installs.
  await env.DB.prepare(`INSERT INTO cloud_releases (id,sequence,manifest_ref,state,wave,created_at,updated_at,promoted_at) VALUES ('rel-5',5,'rev-5','promoted',3,?,?,?)`)
    .bind(NOW, NOW, NOW).run();
});
afterEach(() => vi.restoreAllMocks());

describe("identity and status", () => {
  it("every self-service route needs the members-area token; another customer never reaches this home", async () => {
    for (const [path, body] of [["/v1/account/home", undefined], ["/v1/account/usage", undefined], ["/v1/account/home/audit", undefined],
      ["/v1/account/home/fix-it", {}], ["/v1/account/home/restart", {}], ["/v1/account/home/reboot", {}], ["/v1/account/home/start", {}],
      ["/v1/account/home/safe-mode", {}], ["/v1/account/home/update", {}], ["/v1/account/home/hold/cancel", { holdId: "x" }]] as const) {
      expect([path, (await call(path, null, body)).status]).toEqual([path, 401]);
      expect([path, (await call(path, ADMIN, body)).status]).toEqual([path, 401]); // the operator token is not a customer
    }
    const stranger = await token({ sub: OTHER_SUB, email: "someone@example.test" });
    expect((await call("/v1/account/home", stranger)).status).toBe(404);
    expect((await call("/v1/account/home/reboot", stranger, {})).status).toBe(404);
    expect(reboots).toEqual([]);
  });

  it("status shows state, health, heartbeat, disk and last backup", async () => {
    await call("/v1/machines/home-1/heartbeat", machineCredential, { generation, health: { diskUsedPercent: 42, lastBackupAt: NOW - HOUR, appResponding: true } });
    const s = await (await call("/v1/account/home", await token())).json<Record<string, unknown>>();
    expect(s).toMatchObject({ homeId: "home-1", desiredState: "ready", observedState: "ready", health: "healthy", healthy: true, heartbeatAt: NOW,
      diskUsedPercent: 42, lastBackupAt: NOW - HOUR, fixIt: null, holds: [], export: null, reset: null });
  });
});

describe("restart, reboot, start, safe mode, update: signed-in is enough, each rate limited and audited", () => {
  it("restart queues a command the home sees on its command poll; 5 an hour, then 429 with retry-after; allowed again next hour", async () => {
    const t = await token();
    for (let i = 0; i < LIMITS.restart[0][0]; i++) expect((await call("/v1/account/home/restart", t, {})).status).toBe(202);
    const refused = await call("/v1/account/home/restart", t, {});
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited", retry_after_seconds: 3600 });
    expect((await desiredCommands()).filter((c) => c.kind === "restart_service")).toHaveLength(5);
    const log = await (await call("/v1/account/home/audit", t)).json<{ entries: { action: string; outcome: string; actor: string }[] }>();
    expect(log.entries.filter((e) => e.action === "restart").map((e) => e.outcome).sort()).toEqual(["queued", "queued", "queued", "queued", "queued", "rate_limited"]);
    at(NOW + HOUR + 1);
    expect((await call("/v1/account/home/restart", await token(), {})).status).toBe(202);
  });

  it("reboot power-cycles the home's own server, 3 an hour and 6 a day", async () => {
    // Each reboot holds the home's job slot until the provider confirms it finished (here at once), then the next may run.
    const reboot = async (ms: number) => { at(ms); return (await call("/v1/account/home/reboot", await token(), {})).status; };
    for (let i = 0; i < 3; i++) expect(await reboot(NOW + i * MIN)).toBe(202);
    expect(await reboot(NOW + 3 * MIN)).toBe(429);
    expect(reboots).toHaveLength(3);
    expect(new Set(reboots).size).toBe(1);
    for (let i = 0; i < 3; i++) expect(await reboot(NOW + HOUR + 1 + i * MIN)).toBe(202);
    at(NOW + 2 * HOUR + 2); const t = await token();
    expect((await call("/v1/account/home/reboot", t, {})).status).toBe(429); // the day cap (6)
    expect(reboots).toHaveLength(6);
  });

  it("start powers the server on; safe mode and update queue commands; a stopped home is not self-service", async () => {
    const t = await token();
    expect((await call("/v1/account/home/start", t, {})).status).toBe(202);
    expect(starts).toHaveLength(1);
    expect((await call("/v1/account/home/safe-mode", t, {})).status).toBe(202);
    const update = await call("/v1/account/home/update", t, {});
    expect(update.status).toBe(202);
    const kinds = await desiredCommands();
    expect(kinds.map((c) => c.kind)).toEqual(["safe_mode", "update_software"]);
    expect(kinds[1].payload).toMatchObject({ keep: ["files", "settings", "logins"] });
    // One data job at a time: a second update waits for the first to be answered.
    expect(await errorOf(await call("/v1/account/home/update", t, {}))).toBe("job_in_progress");
    for (let i = 0; i < 2; i++) {
      await ack((await desiredCommands()).find((c) => c.kind === "update_software")!.id);
      expect((await call("/v1/account/home/update", t, {})).status).toBe(202);
    }
    await ack((await desiredCommands()).find((c) => c.kind === "update_software")!.id);
    expect((await call("/v1/account/home/update", t, {})).status).toBe(429);
    const h = await getHome();
    expect((await admin("/v1/fake-b3/homes/home-1/action", { generation: h.generation, idempotencyKey: "operator-stop-key-1", action: "stop" })).status).toBe(202);
    expect(await errorOf(await call("/v1/account/home/start", t, {}))).toBe("home_inactive");
    expect(starts).toHaveLength(1);
  });

  it("commands are fenced by generation and acked once", async () => {
    await call("/v1/account/home/restart", await token(), {});
    const [cmd] = await desiredCommands();
    expect((await call("/v1/machines/home-1/commands/ack", machineCredential, { generation: generation + 1, commandId: cmd.id, outcome: "done" })).status).toBe(409);
    expect((await ack(cmd.id)).status).toBe(200);
    expect(await desiredCommands()).toEqual([]);
    expect((await call("/v1/machines/home-1/commands/ack", "wrong-credential", { generation, commandId: cmd.id, outcome: "done" })).status).toBe(401);
  });
});

describe("the Fix-it ladder", () => {
  it("does nothing to a healthy home", async () => {
    await heartbeat();
    const r = await call("/v1/account/home/fix-it", await token(), {});
    expect(r.status).toBe(200);
    expect((await r.json<{ fixIt: { outcome: string; suggestion: string | null } }>()).fixIt).toMatchObject({ outcome: "healthy", suggestion: null });
    expect(await desiredCommands()).toEqual([]);
    expect(reboots).toEqual([]);
  });

  it("restarts first and stops as soon as the home heals: no reboot", async () => {
    const t = await token();
    const first = await (await call("/v1/account/home/fix-it", t, {})).json<{ fixIt: { step: string; outcome: null } }>();
    expect(first.fixIt).toMatchObject({ step: "restart_service", outcome: null });
    expect((await desiredCommands()).map((c) => c.kind)).toEqual(["restart_service"]);
    at(NOW + 2 * MIN); await heartbeat();
    at(NOW + STEP_WAIT_MS.restart_service + MIN);
    await sweep();
    const s = await (await call("/v1/account/home", await token())).json<{ fixIt: { outcome: string } }>();
    expect(s.fixIt.outcome).toBe("healed");
    expect(reboots).toEqual([]);
  });

  it("escalates restart, then reboot, then stops with needs-attention, an ops alert, an email and a Reset suggestion", async () => {
    await call("/v1/account/home/fix-it", await token(), {});
    at(NOW + STEP_WAIT_MS.restart_service); await sweep();
    expect(reboots).toHaveLength(1);
    at(NOW + STEP_WAIT_MS.restart_service + STEP_WAIT_MS.reboot); await sweep();
    const s = await (await call("/v1/account/home", await token())).json<{ fixIt: { outcome: string; suggestion: string } }>();
    expect(s.fixIt).toMatchObject({ outcome: "needs_attention", suggestion: "reset" });
    expect(await env.DB.prepare("SELECT severity FROM cloud_alerts WHERE kind='home.fixit_exhausted'").first()).toEqual({ severity: "high" });
    expect(notices.map((n) => n.kind)).toContain("home_needs_attention");
    // Finished means finished: more sweeps do nothing.
    at(NOW + 2 * HOUR); await sweep();
    expect(reboots).toHaveLength(1);
  });

  it("the Fix-it button itself is limited to 6 an hour", async () => {
    await heartbeat();
    const t = await token();
    for (let i = 0; i < 6; i++) expect((await call("/v1/account/home/fix-it", t, {})).status).toBe(200);
    expect((await call("/v1/account/home/fix-it", t, {})).status).toBe(429);
  });

  it("provisioning homes report progress instead of forcing a second attempt", async () => {
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='provisioning' WHERE id='home-1'").run();
    const r = await (await call("/v1/account/home/retry-provisioning", await token(), {})).json<{ provisioning: { state: string } }>();
    expect(r.provisioning.state).toBe("provisioning");
    const f = await (await call("/v1/account/home/fix-it", await token(), {})).json<{ fixIt: null }>();
    expect(f.fixIt).toBeNull();
  });
});

describe("the watchdog", () => {
  it("leaves a home with fresh heartbeats alone", async () => {
    for (let t = 0; t < 2 * HOUR; t += 5 * MIN) { at(NOW + t); await heartbeat(); await sweep(); }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fixit_runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("is bounded: a home that never comes back gets at most 3 automatic runs a day, then one ops alert, never a loop", async () => {
    // Never a heartbeat, for 23 hours of 5-minute cron ticks.
    for (let t = 0; t < 23 * HOUR; t += 5 * MIN) { at(NOW + t); await sweep(); }
    const runs = (await env.DB.prepare("SELECT source,outcome,started_at FROM cloud_fixit_runs ORDER BY started_at").all<{ source: string; outcome: string; started_at: number }>()).results;
    expect(runs.length).toBe(LIMITS.wd_run[0][0]);
    expect(runs.every((r) => r.source === "watchdog" && ["needs_attention", "watchdog_budget_spent"].includes(r.outcome))).toBe(true);
    expect(runs[0].started_at).toBeGreaterThanOrEqual(NOW + WATCHDOG_STALE_MS);
    expect(reboots.length).toBeLessThanOrEqual(LIMITS.wd_reboot[0][0]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.watchdog_exhausted'").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fixit_runs WHERE finished_at IS NULL").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM selfservice_audit WHERE actor='watchdog'").first<{ n: number }>())?.n).toBeGreaterThan(0);
    // The watchdog never touched data: no hold, no reset, no delete.
    expect((await getHome()).desired_state).toBe("ready");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds").first<{ n: number }>())?.n).toBe(0);
  }, 30_000); // 276 simulated cron ticks

  it("stops the moment the home heals", async () => {
    at(NOW + WATCHDOG_STALE_MS + MIN); await sweep();
    expect((await desiredCommands()).map((c) => c.kind)).toEqual(["restart_service"]);
    at(NOW + WATCHDOG_STALE_MS + 2 * MIN); await heartbeat();
    at(NOW + WATCHDOG_STALE_MS + MIN + STEP_WAIT_MS.restart_service); await sweep();
    expect(await env.DB.prepare("SELECT source,outcome FROM cloud_fixit_runs").first()).toEqual({ source: "watchdog", outcome: "healed" });
    expect(reboots).toEqual([]);
    expect(HEALTHY_HEARTBEAT_MS).toBeLessThan(WATCHDOG_STALE_MS);
  });
});

describe("members-area holds: fresh aal2 and the 72-hour hold, cancellable", () => {
  it("refuses aal1 and a stale second factor; needs the typed home name; holds instead of acting", async () => {
    for (const t of [await token(), await token({ aal2: true, stale: true })]) {
      const r = await call("/v1/account/home/hold", t, { action: "delete", confirm: "home-1" });
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toBe("step_up_required");
    }
    const fresh = await token({ aal2: true });
    expect(await errorOf(await call("/v1/account/home/hold", fresh, { action: "delete" }))).toBe("confirmation_required");
    expect((await call("/v1/account/home/hold", fresh, { action: "restore", confirm: "home-1" })).status).toBe(400); // restore is Reset now
    const r = await call("/v1/account/home/hold", fresh, { action: "delete", confirm: "home-1" });
    expect(r.status).toBe(202);
    const hold = await r.json<{ holdId: string; completesAt: number }>();
    expect(hold.completesAt).toBe(NOW + RECOVERY_HOLD_MS);
    expect((await getHome()).desired_state).toBe("ready");
    expect(notices.map((n) => n.kind)).toContain("hold_started");
    const devices = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE kind='notice_required'").first<{ payload: string }>();
    expect(JSON.parse(devices!.payload)).toMatchObject({ audience: "all_registered_devices", event: "hold_started", action: "delete" });
    // Asking again returns the same hold.
    expect(await (await call("/v1/account/home/hold", fresh, { action: "delete", confirm: "home-1" })).json()).toMatchObject({ holdId: hold.holdId, existing: true });
    // Not before 72 hours, even for the sweep.
    at(NOW + RECOVERY_HOLD_MS - 1); await sweep();
    expect((await getHome()).desired_state).toBe("ready");
    at(NOW + RECOVERY_HOLD_MS); await sweep();
    expect((await getHome()).desired_state).toBe("deleting");
  });

  it("adding a device waits 72 hours too, and the members area can cancel with sign-in only", async () => {
    const r = await (await call("/v1/account/home/hold", await token({ aal2: true }), { action: "pair" })).json<{ holdId: string }>();
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_outbox WHERE kind='pair_required'").first()).toBeNull();
    const cancel = await call("/v1/account/home/hold/cancel", await token(), { holdId: r.holdId });
    expect(cancel.status).toBe(200);
    expect(notices.map((n) => n.kind)).toContain("hold_canceled");
    expect((await call("/v1/account/home/hold/cancel", await token(), { holdId: r.holdId })).status).toBe(409);
    at(NOW + RECOVERY_HOLD_MS + 1); await sweep();
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_outbox WHERE kind='pair_required'").first()).toBeNull();
  });
});

describe("D1 Add a computer: the pair hold on My Cloud (door v2 r4.2)", () => {
  const USE_MS = 7 * 24 * 3_600_000;
  it("D1 pair hold: waiting with completesAt, one completion email, then ready until spent, reserved while a door ticket holds it", async () => {
    const r = await (await call("/v1/account/home/hold", await token({ aal2: true }), { action: "pair" })).json<{ holdId: string; completesAt: number }>();
    const holds = async () => (await (await call("/v1/account/home", await token())).json<{ holds: Record<string, unknown>[] }>()).holds;
    expect(await holds()).toEqual([expect.objectContaining({ holdId: r.holdId, action: "pair", state: "waiting", completesAt: NOW + RECOVERY_HOLD_MS })]);
    at(NOW + RECOVERY_HOLD_MS - 1); await sweep();
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(0);
    at(NOW + RECOVERY_HOLD_MS); await sweep();
    const ready = notices.filter((n) => n.kind === "pair_hold_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0].data).toMatchObject({ holdId: r.holdId, emailText: expect.stringContaining("press Connect") });
    await sweep();
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(1); // sent once
    expect(await holds()).toEqual([expect.objectContaining({ holdId: r.holdId, action: "pair", state: "ready", readyUntil: NOW + RECOVERY_HOLD_MS + USE_MS })]);
    await env.DB.prepare("UPDATE cloud_recovery_holds SET reserved_by='nonce-1', reserved_until=? WHERE id=?").bind(NOW + RECOVERY_HOLD_MS + 90_000, r.holdId).run();
    expect(await holds()).toEqual([expect.objectContaining({ holdId: r.holdId, state: "reserved" })]);
    at(NOW + RECOVERY_HOLD_MS + 90_000);
    expect(await holds()).toEqual([expect.objectContaining({ holdId: r.holdId, state: "ready" })]); // the reservation lapsed
    await env.DB.prepare("UPDATE cloud_recovery_holds SET spent_device_digest='d', spent_at=? WHERE id=?").bind(NOW, r.holdId).run();
    expect(await holds()).toEqual([]);
  });
  it("D2 Astra D1 #5: the completion email's notice is recorded with the completion: an inline send that fails (a busy lease) is delivered by the billing sweep, once", async () => {
    const r = await (await call("/v1/account/home/hold", await token({ aal2: true }), { action: "pair" })).json<{ holdId: string }>();
    const busy: BillingNotifier = { async notify(_env, notice) { if (notice.kind === "pair_hold_ready") throw new Error("home_busy"); notices.push({ kind: notice.kind, data: notice.data }); } };
    at(NOW + RECOVERY_HOLD_MS);
    await sweepSelfService(testEnv(), { b3: { provider }, billing: { notifier: busy }, storageBox: () => fakeBox() }, NOW + RECOVERY_HOLD_MS);
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT completed_at FROM cloud_recovery_holds WHERE id=?").bind(r.holdId).first()).toEqual({ completed_at: NOW + RECOVERY_HOLD_MS });
    const owed = await env.DB.prepare("SELECT id,sent_at,payload FROM billing_notices WHERE kind='pair_hold_ready'").all<{ id: string; sent_at: number | null; payload: string }>();
    expect(owed.results).toHaveLength(1);
    expect(owed.results[0]).toMatchObject({ id: expect.stringContaining(r.holdId), sent_at: null });
    expect(JSON.parse(owed.results[0].payload)).toMatchObject({ holdId: r.holdId, emailText: expect.stringContaining("press Connect") });
    // Later self-service sweeps skip the completed hold (nothing sent from there) ...
    await sweep(NOW + RECOVERY_HOLD_MS + 1);
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(0);
    // ... and the billing sweep's notice retries deliver it.
    const billingEnv = { ...testEnv(), STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_fixturefixture",
      BILLING_RETURN_ORIGIN: "https://murage.test", STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as Env;
    await sweepCustomerWaiting(billingEnv, { notifier });
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(1);
    expect(notices.find((n) => n.kind === "pair_hold_ready")!.data).toMatchObject({ holdId: r.holdId });
  });
  it("D1 pair hold: a completed hold past its 7 days is no longer listed; a delete hold never sends the computer email", async () => {
    const r = await (await call("/v1/account/home/hold", await token({ aal2: true }), { action: "pair" })).json<{ holdId: string }>();
    at(NOW + RECOVERY_HOLD_MS); await sweep();
    at(NOW + RECOVERY_HOLD_MS + USE_MS);
    expect((await (await call("/v1/account/home", await token())).json<{ holds: unknown[] }>()).holds).toEqual([]);
    expect(notices.filter((n) => n.kind === "pair_hold_ready")).toHaveLength(1);
    void r;
  });
});

describe("Reset my Cloud: reversible, so fresh aal2 + confirm and no hold", () => {
  it("snapshots first, rebuilds, can be undone within 7 days, and never opens a hold", async () => {
    expect((await call("/v1/account/home/reset", await token(), { confirm: "home-1" })).status).toBe(403);
    const t = await token({ aal2: true });
    expect(await errorOf(await call("/v1/account/home/reset", t, { confirm: "wrong" }))).toBe("confirmation_required");
    const r = await call("/v1/account/home/reset", t, { confirm: "home-1" });
    expect(r.status).toBe(202);
    const reset = await r.json<{ resetId: string; undoDays: number }>();
    expect(reset.undoDays).toBe(7);
    expect(await errorOf(await call("/v1/account/home/reset", t, { confirm: "home-1" }))).toBe("job_in_progress");
    const [cmd] = await desiredCommands();
    expect(cmd).toMatchObject({ kind: "reset_from_backup", payload: { resetId: reset.resetId, snapshotFirst: true, from: "last_good_backup",
      snapshotTag: `murage-pre-reset-${reset.resetId}`, keepSnapshotDays: 9 } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds").first<{ n: number }>())?.n).toBe(0);
    expect(await errorOf(await call("/v1/account/home/reset/undo", t, { resetId: reset.resetId }))).toBe("undo_unavailable"); // not done yet
    expect((await ack(cmd.id)).status).toBe(200);
    const s = await (await call("/v1/account/home", t)).json<{ reset: { state: string; undoUntil: number } }>();
    expect(s.reset).toMatchObject({ state: "done", undoUntil: NOW + RESET_UNDO_MS });
    expect((await call("/v1/account/home/reset/undo", await token(), { resetId: reset.resetId })).status).toBe(403);
    expect((await call("/v1/account/home/reset/undo", t, { resetId: reset.resetId })).status).toBe(202);
    const [undo] = await desiredCommands();
    expect(undo).toMatchObject({ kind: "undo_reset", payload: { resetId: reset.resetId, snapshotTag: `murage-pre-reset-${reset.resetId}` } });
    await ack(undo.id);
    expect(await env.DB.prepare("SELECT state FROM cloud_resets").first()).toEqual({ state: "undone" });
    expect((await getHome()).desired_state).toBe("ready");
  });

  it("undo is gone after 7 days, and a failed reset is reported", async () => {
    const t = await token({ aal2: true });
    const reset = await (await call("/v1/account/home/reset", t, { confirm: "home-1" })).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    at(NOW + RESET_UNDO_MS); await sweep();
    expect(await errorOf(await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId }))).toBe("undo_unavailable");
    const second = await (await call("/v1/account/home/reset", await token({ aal2: true }), { confirm: "home-1" })).json<{ resetId: string }>();
    await ack((await desiredCommands()).find((c) => c.kind === "reset_from_backup")!.id, "failed");
    expect(await env.DB.prepare("SELECT state FROM cloud_resets WHERE id=?").bind(second.resetId).first()).toEqual({ state: "failed" });
  });
});

describe("logs: fresh aal2, redacted twice", () => {
  it("requests and reads redacted logs; aal1 is refused", async () => {
    expect((await call("/v1/account/home/logs/request", await token(), {})).status).toBe(403);
    expect((await call("/v1/account/home/logs", await token())).status).toBe(403);
    const t = await token({ aal2: true });
    expect((await call("/v1/account/home/logs/request", t, {})).status).toBe(202);
    const [cmd] = await desiredCommands();
    expect(cmd.kind).toBe("collect_logs");
    const secretLine = "auth failed for pat@example.test from 198.51.100.7 with Bearer abc.def token=sk_live_1234567890 key eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
    expect((await call("/v1/machines/home-1/logs", machineCredential, { generation, commandId: cmd.id, chunk: 0, final: true,
      lines: [{ at: NOW, level: "error", source: "murage", message: secretLine }] })).status).toBe(200);
    const logs = await (await call("/v1/account/home/logs", t)).json<{ lines: { message: string }[]; pending: boolean }>();
    expect(logs.pending).toBe(false);
    const text = logs.lines[0].message;
    for (const leaked of ["pat@example.test", "198.51.100.7", "abc.def", "sk_live_1234567890", "eyJhbGciOiJFUzI1NiJ9"]) expect(text).not.toContain(leaked);
    // Chat, engines and anything outside the runner's allow-listed units are not log sources the home may send.
    for (const source of ["chat", "engine", "scheduler"]) {
      expect((await call("/v1/machines/home-1/logs", machineCredential, { generation, commandId: cmd.id, chunk: 1, final: true,
        lines: [{ at: NOW, level: "info", source, message: "hello" }] })).status).toBe(400);
    }
  });

  it("redact() removes secrets, keys and long tokens", () => {
    expect(redact("password: hunter2 api_key=abcd")).toBe("password: [redacted] api_key=[redacted]");
    expect(redact(`-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----`)).toBe("[redacted-key]");
    expect(redact("x".repeat(40))).toBe("[redacted]");
    expect(redact("started scheduler in 120 ms")).toBe("started scheduler in 120 ms");
  });
});

describe("automated export (S7): encrypted archive, MFA-gated download", () => {
  it("request -> home builds archive -> aal2 link + key -> one-time-ish download closes the request", async () => {
    await env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at)
      VALUES ('home-1',?,7,'sub-1','u1','box.example.test','homes/home-1-g1',?)`).bind((await getHome()).resource_generation, NOW).run();
    const req = await call("/v1/account/export-request", await token({ aal2: true }), {});
    expect(req.status).toBe(201);
    const { requestId } = await req.json<{ requestId: string }>();
    const [cmd] = await desiredCommands();
    expect(cmd).toMatchObject({ kind: "export_archive", payload: { requestId, format: "tar.zst.age", path: `exports/${requestId}/archive.tar.zst.age` } });
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = Buffer.from(keyBytes).toString("base64url");
    const file = `exports/${requestId}/archive.tar.zst.age`;
    box.files.set(`homes/home-1-g1/${file}`, "age-encrypted-bytes");
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("age-encrypted-bytes"))).toString("hex");
    expect((await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId, file: "../../etc/passwd",
      format: "tar.zst.age", bytes: 19, sha256: digest, key })).status).toBe(400);
    expect((await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId, file,
      format: "tar.zst.age", bytes: 19, sha256: digest, key })).status).toBe(200);
    expect(notices.map((n) => n.kind)).toContain("export_ready");
    const stored = await env.DB.prepare("SELECT wrapped_key FROM cloud_export_jobs").first<{ wrapped_key: string }>();
    expect(stored!.wrapped_key).not.toContain(key);
    // The download link and key need a fresh second factor.
    expect((await call("/v1/account/export/download", await token(), { requestId })).status).toBe(403);
    const link = await (await call("/v1/account/export/download", await token({ aal2: true }), { requestId })).json<{ url: string; key: string; keyFormat: string }>();
    // The member gets age's own identity form, so `age -d -i key.txt` works directly.
    expect(link.key).toBe(ageIdentity(keyBytes));
    expect(link.key).toMatch(/^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
    expect(link.keyFormat).toBe("age-identity");
    const dl = await call(link.url, null);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(await dl.text()).toBe("age-encrypted-bytes");
    expect(await env.DB.prepare("SELECT status FROM data_export_requests WHERE id=?").bind(requestId).first()).toEqual({ status: "delivered" });
    expect((await call(link.url, null)).status).toBe(200);
    expect((await call(link.url, null)).status).toBe(200);
    expect((await call(link.url, null)).status).toBe(404); // 3 uses
    at(NOW + 11 * MIN);
    const late = await (await call("/v1/account/export/download", await token({ aal2: true }), { requestId })).json<{ url: string }>();
    at(NOW + 22 * MIN);
    expect((await call(late.url, null)).status).toBe(404); // 10-minute link
    // After 7 days the archive is purged and no link is issued.
    at(NOW + 7 * DAY + 1); await sweep();
    expect(box.purged).toEqual([`homes/home-1-g1/exports/${requestId}`]);
    expect((await call("/v1/account/export/download", await token({ aal2: true }), { requestId })).status).toBe(409);
  });

  it("a home that is not running goes to the operator path at once", async () => {
    const h = await getHome();
    await admin("/v1/fake-b3/homes/home-1/action", { generation: h.generation, idempotencyKey: "operator-stop-key-2", action: "stop" });
    expect((await call("/v1/account/export-request", await token({ aal2: true }), {})).status).toBe(201);
    expect(await env.DB.prepare("SELECT state FROM cloud_export_jobs").first()).toEqual({ state: "manual" });
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_alerts WHERE kind='export.manual_needed'").first()).not.toBeNull();
  });
});

describe("usage summary", () => {
  it("plan, included credits used %, resets-in days and the extra-spend cap; unknown usage is null, never 0", async () => {
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,plan,status,current_period_start,current_period_end,created_at,updated_at)
      VALUES ('home-1','cus_test','pro','active',?,?,?,?)`).bind(NOW - 10 * DAY, NOW + 20 * DAY - HOUR, NOW, NOW).run();
    await env.DB.prepare(`INSERT INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,updated_at)
      VALUES ('home-1',?,1,2000,500,10000,'calendar month','00:00 UTC on the first day of each month',?)`).bind(account, NOW).run();
    let u = await (await call("/v1/account/usage", await token())).json<Record<string, unknown>>();
    expect(u).toMatchObject({ plan: "pro", includedCreditsUsedPercent: null, resetsInDays: 20,
      extraSpendCap: { enabled: true, capUsd: 100, period: "calendar month" } });
    fluxUsage = { usedIncludedCreditMicrocents: async () => ({ usedMicrocents: 2_500 }), includedCreditMicrocents: async () => ({ includedMicrocents: 10_000 }) };
    u = await (await call("/v1/account/usage", await token())).json<Record<string, unknown>>();
    expect(u.includedCreditsUsedPercent).toBe(25);
  });
});

// ---- Astra SELFSERVICE1 reproductions ----------------------------------------------------------------------------------------------

const resetNow = async () => (await call("/v1/account/home/reset", await token({ aal2: true }), { confirm: "home-1" }));
const resetRow = (id: string) => env.DB.prepare("SELECT state,command_id,undo_command_id,done_at,keep_until FROM cloud_resets WHERE id=?").bind(id)
  .first<{ state: string; command_id: string; undo_command_id: string | null; done_at: number | null; keep_until: number }>();
const activeJobs = async () => (await env.DB.prepare("SELECT kind FROM cloud_home_jobs WHERE home_id='home-1' AND state='active'").all<{ kind: string }>()).results;
const backupSpace = async () => env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at)
  VALUES ('home-1',?,7,'sub-1','u1','box.example.test','homes/home-1-g1',?)`).bind((await getHome()).resource_generation, NOW).run();
const sha = async (text: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");

describe("#1 the wire matches the home runner (shared/self-service-contract.json)", () => {
  it("every command the control plane sends has exactly the contract's payload fields and JSON types, in the contract's envelope", async () => {
    await backupSpace();
    const t = await token(); const fresh = await token({ aal2: true });
    const seen = new Map<string, { payload: Record<string, unknown>; envelope: string[] }>();
    const collect = async () => {
      const res = await (await call("/v1/machines/home-1/commands", machineCredential)).json<Record<string, unknown>>();
      expect(Object.keys(res).sort()).toEqual([...contract.commandsResponse].sort());
      for (const c of res.commands as Record<string, unknown>[]) {
        seen.set(c.kind as string, { payload: c.payload as Record<string, unknown>, envelope: Object.keys(c).sort() });
        if (c.kind !== "collect_logs" && c.kind !== "export_archive") expect((await ack(c.id as string)).status).toBe(200);
      }
    };
    await call("/v1/account/home/restart", t, {}); await call("/v1/account/home/safe-mode", t, {}); await collect();
    await call("/v1/account/home/update", t, {}); await collect();
    const reset = await (await resetNow()).json<{ resetId: string }>(); await collect();
    expect((await call("/v1/account/home/reset/undo", fresh, { resetId: reset.resetId })).status).toBe(202); await collect();
    await call("/v1/account/home/logs/request", fresh, {});
    await call("/v1/account/export-request", fresh, {}); await collect();
    const typeOf = (v: unknown) => Array.isArray(v) ? "array" : typeof v;
    expect([...seen.keys()].sort()).toEqual(Object.keys(contract.commands).sort());
    for (const [kind, sample] of Object.entries(contract.commands) as [string, Record<string, unknown>][]) {
      const got = seen.get(kind)!;
      expect([kind, got.envelope]).toEqual([kind, [...contract.commandEnvelope].sort()]);
      expect([kind, Object.keys(got.payload).sort()]).toEqual([kind, Object.keys(sample).sort()]);
      for (const field of Object.keys(sample)) expect([kind, field, typeOf(got.payload[field])]).toEqual([kind, field, typeOf(sample[field])]);
    }
    expect(contract.homeBodies.logSources).toEqual(["murage", "backup", "update", "tunnel", "system"]);
  });

  it("a home whose image has no self-service runner is never sent commands it cannot run; its export goes to the operator", async () => {
    await env.DB.prepare("DELETE FROM cloud_home_runner").run();
    const t = await token(); const fresh = await token({ aal2: true });
    for (const [path, tok, body] of [["/v1/account/home/restart", t, {}], ["/v1/account/home/safe-mode", t, {}], ["/v1/account/home/update", t, {}],
      ["/v1/account/home/reset", fresh, { confirm: "home-1" }], ["/v1/account/home/logs/request", fresh, {}]] as const) {
      expect([path, await errorOf(await call(path, tok, body))]).toEqual([path, "home_unsupported"]);
    }
    expect((await call("/v1/account/export-request", fresh, {})).status).toBe(201);
    expect(await env.DB.prepare("SELECT state FROM cloud_export_jobs").first()).toEqual({ state: "manual" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_commands").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("the age identity matches the runner's encoding (contract vector)", () => {
    const key = Uint8Array.from(Buffer.from(contract.ageIdentityVector.keyB64url, "base64url"));
    expect(ageIdentity(key)).toBe(contract.ageIdentityVector.identity);
  });
});

describe("#3 reset, undo, update and export are exclusive per home", () => {
  it("two simultaneous resets: exactly one is admitted; the database itself refuses a second active job", async () => {
    const [a, b] = await Promise.all([resetNow(), resetNow()]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_resets").first<{ n: number }>())?.n).toBe(1);
    expect(await activeJobs()).toEqual([{ kind: "reset" }]);
    expect((await desiredCommands()).filter((c) => c.kind === "reset_from_backup")).toHaveLength(1);
    await expect(env.DB.prepare("INSERT INTO cloud_home_jobs (id,home_id,kind,generation,state,created_at) VALUES ('x','home-1','update',1,'active',1)").run())
      .rejects.toThrow();
  });

  it("reset vs update vs export at once: one data job; nothing that power-cycles the home runs while it does", async () => {
    const t = await token();
    const results = await Promise.all([resetNow(), call("/v1/account/home/update", t, {})]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await activeJobs()).toHaveLength(1);
    expect(await errorOf(await call("/v1/account/home/reboot", t, {}))).toBe("job_in_progress");
    expect(await errorOf(await call("/v1/account/home/restart", t, {}))).toBe("job_in_progress");
    expect(await errorOf(await call("/v1/account/home/fix-it", t, {}))).toBe("job_in_progress");
    expect(reboots).toEqual([]);
  });

  it("a failed enqueue keeps nothing: no command, no reset row, no job", async () => {
    // Any part of the batch failing (here the reset row) rolls back the job and its command with it.
    const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const before = [await count("cloud_home_jobs"), await count("cloud_home_commands"), await count("cloud_resets")];
    await env.DB.prepare("CREATE TRIGGER refuse_reset BEFORE INSERT ON cloud_resets BEGIN SELECT RAISE(ABORT, 'refused'); END").run();
    try {
      expect(await errorOf(await resetNow())).toBe("state_conflict");
    } finally { await env.DB.prepare("DROP TRIGGER refuse_reset").run(); }
    expect([await count("cloud_home_jobs"), await count("cloud_home_commands"), await count("cloud_resets")]).toEqual(before);
    expect((await resetNow()).status).toBe(202);
  });

  it("undo is only for the latest reset, never while another job runs", async () => {
    const fresh = await token({ aal2: true });
    const first = await (await resetNow()).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    const second = await (await resetNow()).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    expect(await errorOf(await call("/v1/account/home/reset/undo", fresh, { resetId: first.resetId }))).toBe("undo_unavailable");
    expect((await call("/v1/account/home/update", await token(), {})).status).toBe(202);
    expect(await errorOf(await call("/v1/account/home/reset/undo", fresh, { resetId: second.resetId }))).toBe("job_in_progress");
  });
});

describe("#4 acknowledgements: exactly once, by the job's own command", () => {
  it("a replayed ack of a failed undo cannot complete a later undo; identical duplicates get the stored result", async () => {
    const fresh = await token({ aal2: true });
    const reset = await (await resetNow()).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    expect((await call("/v1/account/home/reset/undo", fresh, { resetId: reset.resetId })).status).toBe(202);
    const undoA = (await desiredCommands())[0].id;
    expect((await ack(undoA, "failed")).status).toBe(200);
    expect((await ack(undoA, "failed")).status).toBe(200); // identical duplicate: the stored result
    expect((await resetRow(reset.resetId))?.state).toBe("done");
    expect((await call("/v1/account/home/reset/undo", fresh, { resetId: reset.resetId })).status).toBe(202);
    const undoB = (await desiredCommands())[0].id;
    // Replay A with a different outcome: refused, and nothing changes.
    const replay = await ack(undoA, "done");
    expect(replay.status).toBe(409);
    expect(await errorOf(replay)).toBe("ack_conflict");
    expect(await resetRow(reset.resetId)).toMatchObject({ state: "undo_requested", undo_command_id: undoB });
    expect(await activeJobs()).toEqual([{ kind: "undo" }]);
    expect((await ack(undoB, "done")).status).toBe(200);
    expect((await resetRow(reset.resetId))?.state).toBe("undone");
    expect(await activeJobs()).toEqual([]);
  });

  it("an ack for a job that never reached the home changes nothing", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    at(NOW + JOB_PICKUP_MS); await sweep(); // never picked: it cannot have run
    expect((await resetRow(reset.resetId))?.state).toBe("failed");
    const id = (await env.DB.prepare("SELECT command_id FROM cloud_resets WHERE id=?").bind(reset.resetId).first<{ command_id: string }>())!.command_id;
    expect((await ack(id, "done")).status).toBe(409);
    expect((await resetRow(reset.resetId))?.state).toBe("failed");
  });
});

describe("#5 log redaction: whole values, on both sides (the home applies the same rules first)", () => {
  it("every planted fake secret in the shared vectors is removed; diagnostics are kept", () => {
    for (const v of contract.redactionVectors) {
      const out = redact(v.input);
      for (const leak of v.leaks) expect([v.input, out.includes(leak)]).toEqual([v.input, false]);
    }
    for (const keep of contract.redactionKeeps) expect(redact(keep)).toBe(keep);
    // Astra's exact reproductions.
    expect(redact('password="two word secret"')).toBe("password=[redacted]");
    expect(redact("Cookie: sid=short; csrf=second-secret")).toBe("Cookie: [redacted]");
    expect(redact('{"access_token": "a.b", "refresh_token": "c.d"}')).toBe('{"access_token": [redacted], "refresh_token": [redacted]}');
  });

  it("a fake secret uploaded by a home is scrubbed again before the members area reads it", async () => {
    const fresh = await token({ aal2: true });
    await call("/v1/account/home/logs/request", fresh, {});
    const [cmd] = await desiredCommands();
    const lines = contract.redactionVectors.map((v, i) => ({ at: NOW + i, level: "info", source: "murage", message: v.input.slice(0, 200) }));
    expect((await call("/v1/machines/home-1/logs", machineCredential, { generation, commandId: cmd.id, chunk: 0, final: true, lines })).status).toBe(200);
    const text = JSON.stringify(await (await call("/v1/account/home/logs", fresh)).json());
    for (const v of contract.redactionVectors) for (const leak of v.leaks) expect([leak, text.includes(leak)]).toEqual([leak, false]);
  });
});

describe("#6 provider actions re-check the lease, generation, lifecycle and job slot right before the call", () => {
  it("lease lost during discovery: no reboot, 409", async () => {
    duringDiscovery = async () => {
      await env.DB.prepare("UPDATE billing_home_leases SET holder='someone-else',lease_until=? WHERE home_id='home-1'").bind(NOW + HOUR).run();
    };
    const r = await call("/v1/account/home/reboot", await token(), {});
    expect(r.status).toBe(409);
    expect(reboots).toEqual([]);
    expect(await env.DB.prepare("SELECT 1 AS x FROM selfservice_audit WHERE action='reboot' AND outcome='intent'").first()).toBeNull();
  });

  it("home stopped (generation moved) during discovery: no reboot, no start, 409 state_changed", async () => {
    for (const action of ["reboot", "start"] as const) {
      const h = await getHome();
      duringDiscovery = async () => {
        await env.DB.prepare("UPDATE cloud_homes SET desired_state='stopped',generation=generation+1 WHERE id='home-1'").run();
      };
      const r = await call(`/v1/account/home/${action}`, await token(), {});
      expect([action, r.status, await errorOf(r)]).toEqual([action, 409, `${action}_state_changed`]);
      await env.DB.prepare("UPDATE cloud_homes SET desired_state='ready',generation=? WHERE id='home-1'").bind(h.generation).run();
    }
    expect(reboots).toEqual([]); expect(starts).toEqual([]);
  });

  it("a data job admitted during discovery stops the reboot; the intent is recorded before every call that is made", async () => {
    duringDiscovery = async () => {
      await env.DB.prepare("INSERT INTO cloud_home_jobs (id,home_id,kind,generation,state,created_at) VALUES ('j1','home-1','update',?,'active',?)")
        .bind((await getHome()).generation, NOW).run();
      await env.DB.prepare(`INSERT INTO cloud_home_commands (id,home_id,generation,kind,payload,created_at,expires_at) VALUES ('j1','home-1',?,'update_software','{}',?,?)`)
        .bind((await getHome()).generation, NOW, NOW + DAY).run();
    };
    expect(await errorOf(await call("/v1/account/home/reboot", await token(), {}))).toBe("reboot_state_changed");
    expect(reboots).toEqual([]);
    await env.DB.prepare("DELETE FROM cloud_home_jobs").run();
    expect((await call("/v1/account/home/reboot", await token(), {})).status).toBe(202);
    const log = (await env.DB.prepare("SELECT outcome FROM selfservice_audit WHERE action='reboot' ORDER BY at,rowid").all<{ outcome: string }>()).results.map((r) => r.outcome);
    expect(log.slice(-2)).toEqual(["intent", "issued"]);
  });

  it("the Fix-it ladder's reboot is fenced the same way", async () => {
    await call("/v1/account/home/fix-it", await token(), {});
    duringDiscovery = async () => { await env.DB.prepare("UPDATE cloud_homes SET desired_state='stopped' WHERE id='home-1'").run(); };
    at(NOW + STEP_WAIT_MS.restart_service); await sweep();
    expect(reboots).toEqual([]);
  });
});

describe("#7 only a completed download closes the export request", () => {
  async function readyExport() {
    await backupSpace();
    const { requestId } = await (await call("/v1/account/export-request", await token({ aal2: true }), {})).json<{ requestId: string }>();
    const [cmd] = await desiredCommands();
    const body = "age-encrypted-bytes";
    box.files.set(`homes/home-1-g1/exports/${requestId}/archive.tar.zst.age`, body);
    expect((await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId,
      file: `exports/${requestId}/archive.tar.zst.age`, format: "tar.zst.age", bytes: body.length, sha256: await sha(body),
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") })).status).toBe(200);
    return requestId;
  }
  const requestStatus = async (id: string) => (await env.DB.prepare("SELECT status FROM data_export_requests WHERE id=?").bind(id).first<{ status: string }>())?.status;

  it("a stream that fails part way, a short body or an expired link leaves the request open (deletion stays paused)", async () => {
    const requestId = await readyExport();
    const link = await (await call("/v1/account/export/download", await token({ aal2: true }), { requestId })).json<{ url: string }>();
    box.fail = "stream";
    const broken = await call(link.url, null);
    await broken.text().catch(() => "");
    expect(await requestStatus(requestId)).toBe("open");
    box.fail = "short";
    await (await call(link.url, null)).text().catch(() => "");
    expect(await requestStatus(requestId)).toBe("open");
    box.fail = undefined;
    at(NOW + 11 * MIN);
    expect((await call(link.url, null)).status).toBe(404);
    expect(await requestStatus(requestId)).toBe("open");
    const again = await (await call("/v1/account/export/download", await token({ aal2: true }), { requestId })).json<{ url: string }>();
    expect(await (await call(again.url, null)).text()).toBe("age-encrypted-bytes");
    expect(await requestStatus(requestId)).toBe("delivered");
  });
});

describe("#8 reset timing: 7 full days of undo from completion; expired commands fail the job and free the slot", () => {
  it("a reset picked after 23 hours still gets 7 full days of undo from when it finished", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    at(NOW + 23 * HOUR);
    const [cmd] = await desiredCommands();
    at(NOW + 23 * HOUR + 30 * MIN);
    await ack(cmd.id);
    expect(await resetRow(reset.resetId)).toMatchObject({ state: "done", done_at: NOW + 23 * HOUR + 30 * MIN, keep_until: NOW + 23 * HOUR + 30 * MIN + RESET_UNDO_MS });
    at(NOW + 23 * HOUR + 30 * MIN + RESET_UNDO_MS - MIN);
    const s = await (await call("/v1/account/home", await token())).json<{ reset: { undoUntil: number } }>();
    expect(s.reset.undoUntil).toBe(NOW + 23 * HOUR + 30 * MIN + RESET_UNDO_MS);
    expect((await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId })).status).toBe(202);
    // The undo must be picked before the window ends.
    const undo = await env.DB.prepare("SELECT expires_at FROM cloud_home_commands WHERE kind='undo_reset'").first<{ expires_at: number }>();
    expect(undo!.expires_at).toBe(NOW + 23 * HOUR + 30 * MIN + RESET_UNDO_MS);
  });

  it("a reset never picked up fails when its command expires, and the slot is free again", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    at(NOW + JOB_PICKUP_MS); await sweep();
    expect((await resetRow(reset.resetId))?.state).toBe("failed");
    expect(await activeJobs()).toEqual([]);
    expect((await desiredCommands()).filter((c) => c.kind === "reset_from_backup")).toEqual([]); // never offered after expiry
    expect((await resetNow()).status).toBe(202);
  });

  it("a picked reset not answered by its run deadline plus grace fails; the home sees the run deadline as expiresAt", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    at(NOW + HOUR);
    const [cmd] = await (await (await call("/v1/machines/home-1/commands", machineCredential)).json<{ commands: { id: string; expiresAt: number }[] }>()).commands;
    expect(cmd.expiresAt).toBe(NOW + HOUR + RUN_MS.reset_from_backup);
    at(NOW + HOUR + RUN_MS.reset_from_backup + JOB_GRACE_MS - 1); await sweep();
    expect((await resetRow(reset.resetId))?.state).toBe("requested");
    at(NOW + HOUR + RUN_MS.reset_from_backup + JOB_GRACE_MS); await sweep();
    expect((await resetRow(reset.resetId))?.state).toBe("unknown"); // it may have happened: never reported failed (Astra SELFSERVICE2 #3)
    expect(await activeJobs()).toEqual([]);
  });

  it("an expired undo leaves the reset undoable for the rest of its window", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    expect((await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId })).status).toBe(202);
    at(NOW + JOB_PICKUP_MS); await sweep();
    expect(await resetRow(reset.resetId)).toMatchObject({ state: "done", undo_command_id: null });
    expect(await activeJobs()).toEqual([]);
  });
});

describe("#9 health is the Murage app answering, not the root daemon", () => {
  const beat = (appResponding?: boolean) => call("/v1/machines/home-1/heartbeat", machineCredential,
    { generation, ...(appResponding === undefined ? {} : { health: { appResponding } }) });

  it("a hung app behind a live daemon is unhealthy, gets Fix-it and the watchdog; an answering app is healthy", async () => {
    expect((await beat(true)).status).toBe(200);
    let s = await (await call("/v1/account/home", await token())).json<{ healthy: boolean; appRespondedAt: number }>();
    expect(s).toMatchObject({ healthy: true, appRespondedAt: NOW });
    // The daemon keeps beating every minute; the app stopped answering.
    for (let t = MIN; t <= WATCHDOG_STALE_MS + 2 * MIN; t += MIN) { at(NOW + t); expect((await beat(false)).status).toBe(200); }
    s = await (await call("/v1/account/home", await token())).json<{ healthy: boolean; appRespondedAt: number }>();
    expect(s).toMatchObject({ healthy: false, appRespondedAt: NOW });
    await sweep();
    expect(await env.DB.prepare("SELECT source FROM cloud_fixit_runs").first()).toEqual({ source: "watchdog" });
    expect((await desiredCommands()).map((c) => c.kind)).toEqual(["restart_service"]);
  });

  it("the ladder counts healed only once the app answers again", async () => {
    await beat(false);
    await call("/v1/account/home/fix-it", await token(), {});
    at(NOW + 2 * MIN); await beat(false);
    at(NOW + STEP_WAIT_MS.restart_service - 1); await sweep();
    expect((await env.DB.prepare("SELECT outcome FROM cloud_fixit_runs").first<{ outcome: string | null }>())?.outcome).toBeNull();
    at(NOW + STEP_WAIT_MS.restart_service + MIN); await beat(true); await sweep();
    expect((await env.DB.prepare("SELECT outcome FROM cloud_fixit_runs").first<{ outcome: string }>())?.outcome).toBe("healed");
    expect(reboots).toEqual([]);
  });
});

describe("AUTOCANARY-3 P2: health is the latest app report's outcome; app_ok_at is only the last success", () => {
  const ready = { desired_state: "ready", observed_state: "ready", heartbeat_at: NOW } as const;
  it("the readers decide on app_ok, whatever app_ok_at says (pure permutations)", () => {
    const T = NOW;
    // success then failure at the same millisecond (stored app_ok=0, app_ok_at=T): unhealthy, last success T still shown
    expect(healthy(ready, { app_reported_at: T, app_ok_at: T, app_ok: 0 }, T)).toBe(false);
    expect(healthState(ready, { app_reported_at: T, app_ok_at: T, app_ok: 0 }, T)).toBe("unhealthy");
    expect(liveAt(ready, { app_reported_at: T, app_ok_at: T, app_ok: 0 })).toBe(T);
    // failure then success at the same millisecond (stored app_ok=0, app_ok_at earlier or null): unhealthy
    expect(healthy(ready, { app_reported_at: T, app_ok_at: null, app_ok: 0 }, T)).toBe(false);
    expect(healthy(ready, { app_reported_at: T, app_ok_at: T - MIN, app_ok: 0 }, T)).toBe(false);
    // a failure after a recent success: unhealthy at once (no grace on the old success time)
    expect(healthy(ready, { app_reported_at: T, app_ok_at: T - 1, app_ok: 0 }, T)).toBe(false);
    // the latest report succeeded: healthy while it is recent, then stale
    expect(healthy(ready, { app_reported_at: T, app_ok_at: T, app_ok: 1 }, T + HEALTHY_HEARTBEAT_MS)).toBe(true);
    expect(healthy(ready, { app_reported_at: T, app_ok_at: T, app_ok: 1 }, T + HEALTHY_HEARTBEAT_MS + 1)).toBe(false);
    // rows written before app_ok existed: the latest report succeeded only when app_ok_at=app_reported_at
    expect(appOutcome({ app_reported_at: T, app_ok_at: T, app_ok: null })).toBe(true);
    expect(appOutcome({ app_reported_at: T, app_ok_at: T - 1 })).toBe(false);
    expect(appOutcome({ app_reported_at: null, app_ok_at: null })).toBeNull();
    expect(healthState(ready, null, T)).toBe("unknown");
  });
  it("same-millisecond reports read unhealthy in either order, through the merge and the members area; Fix-it does not finish healthy on them", async () => {
    const T = NOW + MIN;
    at(T);
    const report = (ok: boolean, when: number) => recordHealth(env as unknown as Parameters<typeof recordHealth>[0], "home-1", { appResponding: ok }, when, undefined, generation);
    const status = async () => (await call("/v1/account/home", await token())).json<{ health: string; healthy: boolean | null; appRespondedAt: number | null }>();
    await report(true, T); await report(false, T);
    expect(await env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ app_reported_at: T, app_ok_at: T, app_ok: 0 });
    expect(await status()).toMatchObject({ health: "unhealthy", healthy: false, appRespondedAt: T });
    await call("/v1/account/home/fix-it", await token(), {});
    expect((await env.DB.prepare("SELECT outcome FROM cloud_fixit_runs").first<{ outcome: string | null }>())?.outcome).not.toBe("healthy");
    at(T + 1);
    await report(false, T + 1); await report(true, T + 1);
    // The last success is T+1 in this order too (Astra AUTOCANARY-4 P2); the outcome is still the fail-closed merge.
    expect(await env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ app_reported_at: T + 1, app_ok_at: T + 1, app_ok: 0 });
    expect(await status()).toMatchObject({ health: "unhealthy", healthy: false, appRespondedAt: T + 1 });
    at(T + 2);
    await report(true, T + 2);
    expect(await status()).toMatchObject({ health: "healthy", healthy: true, appRespondedAt: T + 2 });
  });
  it("a tie against a row written before app_ok existed merges against the outcome the reader showed for it", async () => {
    const T = NOW + MIN;
    at(T);
    const report = (ok: boolean, when: number) => recordHealth(env as unknown as Parameters<typeof recordHealth>[0], "home-1", { appResponding: ok }, when, undefined, generation);
    await report(true, T);
    await env.DB.prepare("UPDATE cloud_home_health SET app_ok=NULL WHERE home_id='home-1'").run(); // as a pre-0102 row
    await report(false, T);
    expect(await env.DB.prepare("SELECT app_ok FROM cloud_home_health WHERE home_id='home-1'").first()).toEqual({ app_ok: 0 });
    expect((await (await call("/v1/account/home", await token())).json<{ healthy: boolean }>()).healthy).toBe(false);
  });
});

describe("AUTOCANARY-4 P2: the last success merges independently of arrival order", () => {
  const MIN_ = 60_000;
  /** Last success eleven minutes ago (past WATCHDOG_STALE_MS), then a failure and a success at the same time T in the given order. */
  async function tied(order: "failure-first" | "success-first") {
    const T = NOW + 11 * MIN_;
    const report = (ok: boolean, when: number) => recordHealth(env as unknown as Parameters<typeof recordHealth>[0], "home-1", { appResponding: ok }, when, undefined, generation);
    at(NOW); await report(true, NOW);
    at(T);
    if (order === "failure-first") { await report(false, T); await report(true, T); } else { await report(true, T); await report(false, T); }
    return T;
  }
  for (const order of ["failure-first", "success-first"] as const) {
    it(`${order}: app_ok_at is the tied success, app_ok the failure, and the watchdog does not treat the home as silent`, async () => {
      const T = await tied(order);
      expect(await env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id='home-1'").first())
        .toEqual({ app_reported_at: T, app_ok_at: T, app_ok: 0 });
      expect((await (await call("/v1/account/home", await token())).json<{ health: string; appRespondedAt: number | null }>()))
        .toMatchObject({ health: "unhealthy", appRespondedAt: T });
      await sweep(T);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fixit_runs WHERE home_id='home-1' AND source='watchdog'").first()).toEqual({ n: 0 });
      // Silent once WATCHDOG_STALE_MS has passed since that success, in either order.
      at(T + WATCHDOG_STALE_MS + 1);
      await sweep(T + WATCHDOG_STALE_MS + 1);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fixit_runs WHERE home_id='home-1' AND source='watchdog'").first()).toEqual({ n: 1 });
    });
  }
  it("a success that arrives after a newer failure still moves the last success forward, never the outcome", async () => {
    const report = (ok: boolean, when: number) => recordHealth(env as unknown as Parameters<typeof recordHealth>[0], "home-1", { appResponding: ok }, when, undefined, generation);
    at(NOW + 3); await report(true, NOW + 1); await report(false, NOW + 3); await report(true, NOW + 2);
    expect(await env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ app_reported_at: NOW + 3, app_ok_at: NOW + 2, app_ok: 0 });
  });
});

describe("#10 the watchdog is fair", () => {
  it("51 silent homes with the first 50 exhausted and alerted: the 51st still gets its run; a busy home is not charged", async () => {
    const stale = NOW - 2 * HOUR;
    for (let i = 0; i < 52; i++) {
      const id = `wd-${String(i).padStart(2, "0")}`;
      await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,heartbeat_at,created_at,updated_at)
        VALUES (?,?,?,'ready','ready','sha256:x','k',?,?,?)`).bind(id, `inst-${id}`, `owner-${id}`, stale - (51 - i), stale, stale).run();
      if (i < 50) {
        await env.DB.prepare("INSERT INTO selfservice_rate_limits (subject,window_started_at,attempts) VALUES (?,?,3)").bind(`wd_run:${DAY}:${id}`, NOW - HOUR).run();
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.watchdog_exhausted','high','x',?)")
          .bind(crypto.randomUUID(), id, NOW - HOUR).run();
      }
    }
    // wd-51's lease is held by someone else: it is skipped this tick and its daily budget is not spent.
    await env.DB.prepare("INSERT OR REPLACE INTO billing_home_leases (home_id,holder,generation,lease_until) VALUES ('wd-51','other',1,?)").bind(NOW + HOUR).run();
    await sweep();
    expect(await env.DB.prepare("SELECT source FROM cloud_fixit_runs WHERE home_id='wd-50'").first()).toEqual({ source: "watchdog" });
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_fixit_runs WHERE home_id='wd-00'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT attempts FROM selfservice_rate_limits WHERE subject=?").bind(`wd_run:${DAY}:wd-51`).first()).toBeNull();
  });
});

describe("#11 export archives: one job per home, coalesced, within a storage budget", () => {
  it("twelve simultaneous requests are all accepted and share one archive job", async () => {
    await backupSpace();
    const t = await token();
    const fresh = await token({ aal2: true });
    const answers = await Promise.all(Array.from({ length: 12 }, () => call("/v1/account/export-request", fresh, {})));
    expect(answers.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const ids = new Set((await env.DB.prepare("SELECT id FROM data_export_requests").all<{ id: string }>()).results.map((r) => r.id));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_commands WHERE kind='export_archive'").first<{ n: number }>())?.n).toBe(1);
    expect(await activeJobs()).toEqual([{ kind: "export" }]);
    const rows = (await env.DB.prepare("SELECT request_id,archive_id,command_id FROM cloud_export_jobs").all<{ request_id: string; archive_id: string; command_id: string }>()).results;
    expect(rows.map((r) => r.request_id).sort()).toEqual([...ids].sort());
    expect(new Set(rows.map((r) => r.command_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.archive_id)).size).toBe(1);
    const [cmd] = await desiredCommands();
    const body = "shared-archive";
    expect((await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId: cmd.payload.requestId,
      file: cmd.payload.path, format: "tar.zst.age", bytes: body.length, sha256: await sha(body),
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_export_jobs WHERE state='ready'").first<{ n: number }>())?.n).toBe(ids.size);
  });

  it("an export waits while another data job runs, then takes the slot; over the budget it goes to the operator", async () => {
    await backupSpace();
    const reset = await resetNow();
    expect(reset.status).toBe(202);
    expect((await call("/v1/account/export-request", await token({ aal2: true }), {})).status).toBe(201);
    expect(await env.DB.prepare("SELECT state,command_id FROM cloud_export_jobs").first()).toEqual({ state: "requested", command_id: null });
    await ack((await desiredCommands()).find((c) => c.kind === "reset_from_backup")!.id);
    const [cmd] = await desiredCommands();
    expect(cmd.kind).toBe("export_archive");
    expect(cmd.payload.maxBytes).toBe(EXPORT_STORAGE_BUDGET_BYTES);
    // An archive bigger than its budget is refused and goes to the operator.
    const over = await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId: cmd.payload.requestId,
      file: cmd.payload.path, format: "tar.zst.age", bytes: EXPORT_STORAGE_BUDGET_BYTES + 1, sha256: "a".repeat(64),
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") });
    expect(await errorOf(over)).toBe("export_over_budget");
    expect(await env.DB.prepare("SELECT state FROM cloud_export_jobs").first()).toEqual({ state: "manual" });
    // Retained archives use the whole budget: the next request goes to the operator at once.
    await env.DB.prepare(`INSERT INTO cloud_export_jobs (request_id,home_id,state,requested_at,deliver_by,available_until,bytes,archive_id)
      VALUES ('old','home-1','ready',?,?,?,?,'old')`).bind(NOW, NOW, NOW + DAY, EXPORT_STORAGE_BUDGET_BYTES).run();
    at(NOW + 8 * DAY);
    await env.DB.prepare("UPDATE cloud_export_jobs SET available_until=? WHERE request_id='old'").bind(NOW + 9 * DAY).run();
    expect((await call("/v1/account/export-request", await token({ aal2: true }), {})).status).toBe(201);
    const latest = await env.DB.prepare("SELECT state FROM cloud_export_jobs WHERE request_id<>'old' ORDER BY requested_at DESC LIMIT 1").first();
    expect(latest).toEqual({ state: "manual" });
  });
});

// ---- Astra SELFSERVICE2 reproductions ----------------------------------------------------------------------------------------------

describe("SELFSERVICE2 #3 a reset or undo that times out is unknown, and the home's late result settles it", () => {
  it("a picked reset with no answer by its deadline is unknown (not failed, no undo yet); the late 'done' gives it its undo window", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    at(NOW + HOUR);
    const [cmd] = await desiredCommands(); // picked at NOW + 1h
    at(NOW + HOUR + RUN_MS.reset_from_backup + JOB_GRACE_MS); await sweep();
    expect((await resetRow(reset.resetId))?.state).toBe("unknown");
    expect(await activeJobs()).toEqual([]); // the slot is free (a dead home does not block Fix-it or a reboot)
    const s = await (await call("/v1/account/home", await token())).json<{ reset: { state: string; undoUntil: number | null } }>();
    expect(s.reset).toMatchObject({ state: "unknown", undoUntil: null });
    expect(await errorOf(await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId }))).toBe("undo_unavailable");
    // Two days later (retention ran meanwhile) the home is back and its runner re-sends the result it journaled.
    at(NOW + 2 * DAY); await heartbeat(); await sweep();
    expect((await ack(cmd.id, "done")).status).toBe(200);
    // Undo for 7 days, but never past what the home keeps the snapshot for (9 days from its completion, which is after pickup).
    expect(await resetRow(reset.resetId)).toMatchObject({ state: "done", done_at: NOW + 2 * DAY, keep_until: Math.min(NOW + 2 * DAY + RESET_UNDO_MS, NOW + HOUR + 9 * DAY - HOUR) });
    expect((await ack(cmd.id, "done")).status).toBe(200); // an identical duplicate
    expect((await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId })).status).toBe(202);
  });

  it("an undo with no answer is undo_unknown (not undoable again); a late 'failed' makes the reset undoable again", async () => {
    const reset = await (await resetNow()).json<{ resetId: string }>();
    await ack((await desiredCommands())[0].id);
    expect((await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId })).status).toBe(202);
    const [undo] = await desiredCommands();
    at(NOW + RUN_MS.undo_reset + JOB_GRACE_MS); await sweep();
    expect((await resetRow(reset.resetId))?.state).toBe("undo_unknown");
    expect(await errorOf(await call("/v1/account/home/reset/undo", await token({ aal2: true }), { resetId: reset.resetId }))).toBe("undo_unavailable");
    expect((await ack(undo.id, "failed")).status).toBe(200);
    expect(await resetRow(reset.resetId)).toMatchObject({ state: "done", undo_command_id: null });
  });
});

describe("power reservations: only a correlated receipt completes one; the bounded policy releases the rest (Astra SELFSERVICE3-5)", () => {
  const beatsAfter = async (from: number, n: number) => {
    for (let i = 1; i <= n; i++) { at(from + i * MIN); await heartbeat(); await sweep(); }
  };
  const job = () => env.DB.prepare("SELECT state,outcome,action_id,fresh_beats FROM cloud_home_jobs WHERE kind='power' ORDER BY created_at DESC LIMIT 1")
    .first<{ state: string; outcome: string; action_id: string | null; fresh_beats: number }>();

  it("a timed-out reboot blocks everything for the uncertain window and while the home is not seen up; then it is released as unconfirmed_released, never done", async () => {
    providerFailure = "provider_timeout";
    const r = await call("/v1/account/home/reboot", await token(), {});
    expect([r.status, await errorOf(r)]).toEqual([502, "reboot_provider_timeout"]);
    providerFailure = null;
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    expect(await errorOf(await call("/v1/account/home/update", await token(), {}))).toBe("job_in_progress");
    expect(await errorOf(await call("/v1/account/home/restart", await token(), {}))).toBe("job_in_progress");
    // Fresh heartbeats inside the window never count; nor do they while the provider does not report the server up.
    await beatsAfter(NOW, 5);
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    serverUp = false;
    await beatsAfter(NOW + POWER_UNCERTAIN_MS, 5);
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_alerts WHERE kind='power.unconfirmed'").first()).not.toBeNull(); // telemetry only
    serverUp = true;
    await beatsAfter(NOW + POWER_UNCERTAIN_MS + 10 * MIN, POWER_RELEASE_BEATS - 1);
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    await beatsAfter(NOW + POWER_UNCERTAIN_MS + 10 * MIN + (POWER_RELEASE_BEATS - 1) * MIN, 1);
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
    expect(powerQueries).toEqual([]); // no receipt to ask about: nothing else is ever taken as this call's
    expect((await resetNow()).status).toBe(202);
    expect(reboots).toHaveLength(1); // never replayed
  });

  it("a heartbeat invalidated by a concurrent rotation is a 409 and does not count (Astra SELFSERVICE8 P2)", async () => {
    providerFailure = "provider_timeout";
    expect((await call("/v1/account/home/reboot", await token(), {})).status).toBe(502);
    providerFailure = null;
    at(NOW + POWER_UNCERTAIN_MS + MIN); await heartbeat();
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 1 });
    // The rotation lands after the heartbeat authenticated (machine() read its credential row), before the heartbeat write.
    const real = env.DB;
    const rotating = { batch: (st: D1PreparedStatement[]) => real.batch(st), prepare: (sql: string) => {
      const db = real; const stmt = db.prepare(sql);
      if (!sql.includes("SELECT credential_hash")) return stmt;
      return { bind: (...a: unknown[]) => { const b = stmt.bind(...a); return { first: async (...x: unknown[]) => {
        const row = await (b.first as (...y: unknown[]) => Promise<unknown>)(...x);
        await db.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id='home-1'").run();
        return row;
      } }; } };
    } };
    const ctx = createExecutionContext();
    at(NOW + POWER_UNCERTAIN_MS + 2 * MIN);
    const res = await worker().fetch(new Request("https://auth.murage.test/v1/machines/home-1/heartbeat", { method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.10", authorization: `Bearer ${machineCredential}`, "content-type": "application/json" },
      body: JSON.stringify({ generation }) }), { ...testEnv(), DB: rotating } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect([res.status, await errorOf(res)]).toEqual([409, "stale_generation"]);
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 1 }); // unchanged
    expect((await getHome()).heartbeat_at).not.toBe(NOW + POWER_UNCERTAIN_MS + 2 * MIN);
  });

  it("a newer boot or another action is never taken as this call's completion (Astra SELFSERVICE4-5 #2)", async () => {
    receiptless = true; // Vultr: 204, no action id
    const BOOT_A = "0a0a0a0a-0000-4000-8000-00000000000a", BOOT_B = "0b0b0b0b-0000-4000-8000-00000000000b";
    const beat = (bootId: string) => call("/v1/machines/home-1/heartbeat", machineCredential, { generation, health: { bootId } });
    await beat(BOOT_A);
    expect((await call("/v1/account/home/reboot", await token(), {})).status).toBe(202);
    serverUp = true;
    at(NOW + 2 * MIN); await beat(BOOT_B); await sweep(); // a new boot: only a candidate
    expect(await job()).toMatchObject({ state: "active", action_id: null });
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
  });

  it("a correlated receipt completes it: the action id from the call's own answer, in success or error", async () => {
    powerStatus = "running";
    expect((await call("/v1/account/home/reboot", await token(), {})).status).toBe(202);
    expect(await job()).toMatchObject({ state: "active", outcome: "issued", action_id: "act-1" });
    at(NOW + 5 * MIN);
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    expect(powerQueries.at(-1)).toBe("act-1");
    powerStatus = "error";
    expect((await resetNow()).status).toBe(202);
    expect(await job()).toMatchObject({ state: "failed", outcome: "provider_error" });
  });

  it("a definite provider rejection (HTTP 401) releases the slot at once as failed (Astra SELFSERVICE5 #3a)", async () => {
    providerError = new HostError(401, "unauthorized");
    const r = await call("/v1/account/home/reboot", await token(), {});
    expect([r.status, await errorOf(r)]).toEqual([502, "reboot_provider_rejected"]);
    expect(await job()).toMatchObject({ state: "failed", outcome: "provider_rejected" });
    expect((await resetNow()).status).toBe(202);
    providerError = new HostError(429, "rate_limit_exceeded"); // not a definite refusal: stays reserved
    at(NOW + HOUR);
    await ack((await desiredCommands()).find((c) => c.kind === "reset_from_backup")!.id);
    await call("/v1/account/home/reboot", await token(), {});
    expect(await job()).toMatchObject({ state: "active", outcome: "uncertain" });
  });

  it("start is not sent to a server that is already running: success, no reservation (Astra SELFSERVICE5 #3b)", async () => {
    serverUp = true;
    const r = await call("/v1/account/home/start", await token(), {});
    expect(r.status).toBe(202);
    expect(starts).toEqual([]);
    expect(await activeJobs()).toEqual([]);
    expect((await resetNow()).status).toBe(202);
  });

  it("a receipt that arrives after release is recorded, never acted on or replayed", async () => {
    powerStatus = "running";
    expect((await call("/v1/account/home/reboot", await token(), {})).status).toBe(202);
    serverUp = true;
    await beatsAfter(NOW + POWER_UNCERTAIN_MS, POWER_RELEASE_BEATS);
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
    powerStatus = "success";
    at(NOW + HOUR); await sweep();
    expect(await env.DB.prepare("SELECT late_receipt FROM cloud_home_jobs WHERE kind='power'").first<{ late_receipt: string }>())
      .toEqual({ late_receipt: `success@${NOW + HOUR}` });
    expect(reboots).toHaveLength(1);
  });

  const legacyRow = async (id: string, withAudit: boolean, home = "home-1") => {
    // A reservation from before 0041: no server_id. Its intent audit (written in the same batch) names the server and the reservation.
    await env.DB.prepare(`INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at,outcome) VALUES (?,?,'power','reboot',?,'active',?,'uncertain')`)
      .bind(id, home, generation, NOW).run();
    if (withAudit) {
      await env.DB.prepare(`INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,'customer',NULL,'reboot','intent',?,?)`)
        .bind(crypto.randomUUID(), home, JSON.stringify({ serverId: "srv-legacy", reservation: id }), NOW).run();
      // Decoys: another home's intent and another reservation's intent are never taken as this one's.
      await env.DB.prepare(`INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,'customer',NULL,'reboot','intent',?,?)`)
        .bind(crypto.randomUUID(), "home-other", JSON.stringify({ serverId: "srv-other-home", reservation: id }), NOW - 1).run();
      await env.DB.prepare(`INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,'customer',NULL,'reboot','intent',?,?)`)
        .bind(crypto.randomUUID(), home, JSON.stringify({ serverId: "srv-other-reservation", reservation: "another" }), NOW - 2).run();
    }
  };
  const serverOf = async (id: string) => (await env.DB.prepare("SELECT server_id FROM cloud_home_jobs WHERE id=?").bind(id).first<{ server_id: string | null }>())?.server_id;

  it("migration 0058 backfills a legacy reservation's server from its own intent audit (home and reservation both matched) (Astra SELFSERVICE6 #2)", async () => {
    await legacyRow("legacy", true);
    await legacyRow("legacy-no-audit", false, "home-2");
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0058_"))!;
    for (const sql of migration.queries.filter((x) => /^\s*UPDATE/iu.test(x))) await env.DB.prepare(sql).run();
    expect(await serverOf("legacy")).toBe("srv-legacy");
    expect(await serverOf("legacy-no-audit")).toBeNull(); // nothing to match: settlement recovers it at run time (next test)
  });

  it("a legacy reservation with no server id is recovered and released automatically, no manual edit (Astra SELFSERVICE6 #2)", async () => {
    await legacyRow("legacy", true);
    serverUp = true;
    await beatsAfter(NOW + POWER_UNCERTAIN_MS, POWER_RELEASE_BEATS);
    expect(await serverOf("legacy")).toBe("srv-legacy");
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
    expect((await resetNow()).status).toBe(202);
    expect(reboots).toEqual([]); // never replayed
  });

  it("a legacy reservation whose audit is gone gets the home's own server from the provider's labels, then is released", async () => {
    await legacyRow("legacy", false);
    serverUp = true;
    await beatsAfter(NOW + POWER_UNCERTAIN_MS, POWER_RELEASE_BEATS);
    const h = await getHome();
    expect(await serverOf("legacy")).toBe(String((await provider(env.DB).list_by_tag(h.id, h.resource_generation, "home"))[0].id));
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
  });

  it("stale heartbeats never count toward release; a stale gap resets the run (Astra SELFSERVICE6 #3)", async () => {
    providerFailure = "provider_timeout";
    await call("/v1/account/home/reboot", await token(), {});
    providerFailure = null; serverUp = true;
    // Three distinct heartbeats, each nine minutes old (past HEALTHY_HEARTBEAT_MS) when the sweep sees it: none counts.
    const start = NOW + POWER_UNCERTAIN_MS;
    expect(9 * MIN).toBeGreaterThan(HEALTHY_HEARTBEAT_MS);
    for (let i = 0; i < 3; i++) {
      at(start + i * 20 * MIN); await heartbeat();
      at(start + i * 20 * MIN + 9 * MIN); await sweep();
    }
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 0 });
    // Two recent beats, then a stale gap, then two more: still not three consecutive.
    const t = start + 2 * HOUR;
    await beatsAfter(t, 2);
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 2 });
    at(t + 10 * MIN); await sweep();
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 0 });
    await beatsAfter(t + 10 * MIN, 2);
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 2 });
    await beatsAfter(t + 12 * MIN, 1);
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
  });

  it("one-minute heartbeats and the configured five-minute sweep, no dashboard polling, release it by minute 30 (Astra SELFSERVICE7 #1)", async () => {
    providerFailure = "provider_timeout";
    await call("/v1/account/home/reboot", await token(), {});
    providerFailure = null; serverUp = true;
    let releasedAt: number | null = null;
    for (let m = 1; m <= 60 && releasedAt === null; m++) {
      at(NOW + m * MIN); await heartbeat(); // the home beats every minute (heartbeatEveryMs 60000)
      if (m % 5 === 0) { // wrangler.jsonc crons: "*/5 * * * *"; nothing else (no status page) runs settlement
        await sweep();
        if ((await job())?.state !== "active") releasedAt = m;
      }
    }
    expect(releasedAt).not.toBeNull();
    expect(releasedAt!).toBeGreaterThanOrEqual(POWER_UNCERTAIN_MS / MIN);
    expect(releasedAt!).toBeLessThanOrEqual(30);
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
    expect(reboots).toHaveLength(1); // never replayed
  });

  it("a burst of heartbeats does not stand in for minutes of uptime; a provider-down answer holds release (Astra SELFSERVICE7 #1)", async () => {
    providerFailure = "provider_timeout";
    await call("/v1/account/home/reboot", await token(), {});
    providerFailure = null; serverUp = false;
    const t = NOW + POWER_UNCERTAIN_MS + MIN;
    for (let i = 0; i < 5; i++) { at(t + i * 1000); await heartbeat(); }
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 1 });
    await beatsAfter(t, 3);
    expect(await job()).toMatchObject({ state: "active", fresh_beats: 4 }); // a full run, but the server is not seen up
    serverUp = true;
    await beatsAfter(t + 3 * MIN, 1);
    expect(await job()).toMatchObject({ state: "expired", outcome: "unconfirmed_released" });
  });

  it("a receipt that arrives after the local timeout is still recorded on its reservation, then settles it; never replayed (Astra SELFSERVICE6 #4)", async () => {
    timeoutMs = 20; lateAnswerMs = 120; powerStatus = "running";
    const r = await call("/v1/account/home/reboot", await token(), {});
    expect([r.status, await errorOf(r)]).toEqual([502, "reboot_provider_timeout"]);
    expect(await job()).toMatchObject({ state: "active", outcome: "uncertain", action_id: "late-1" });
    at(NOW + 2 * MIN);
    expect(await errorOf(await resetNow())).toBe("job_in_progress");
    expect(powerQueries.at(-1)).toBe("late-1");
    powerStatus = "success";
    expect((await resetNow()).status).toBe(202);
    expect(await job()).toMatchObject({ state: "done", outcome: "provider_success" });
    expect(reboots).toHaveLength(1);
  });

  it("late-receipt checks rotate by last-checked time: ten still running never starve the eleventh (Astra SELFSERVICE6 #5)", async () => {
    for (let i = 1; i <= 11; i++) {
      const id = `r-${String(i).padStart(2, "0")}`;
      await env.DB.prepare(`INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at,outcome,server_id,action_id,finished_at)
        VALUES (?,?,'power','reboot',1,'expired',?,'unconfirmed_released',?,?,?)`).bind(id, `home-${id}`, NOW - HOUR, `srv-${id}`, `a-${id}`, NOW - HOUR + i).run();
      powerByServer.set(`srv-${id}`, i === 11 ? "success" : "running");
    }
    const deps = { b3: { provider }, billing: { notifier }, storageBox: () => fakeBox() };
    await settlePower(testEnv(), deps, NOW);
    expect(await env.DB.prepare("SELECT late_receipt FROM cloud_home_jobs WHERE id='r-11'").first()).toEqual({ late_receipt: null });
    await settlePower(testEnv(), deps, NOW + MIN);
    expect(await env.DB.prepare("SELECT late_receipt FROM cloud_home_jobs WHERE id='r-11'").first()).toEqual({ late_receipt: `success@${NOW + MIN}` });
  });

  it("settlement rotates: 21 unresolved reservations never starve the 21st (Astra SELFSERVICE4 #3)", async () => {
    for (let i = 1; i <= 21; i++) {
      const id = `p-${String(i).padStart(2, "0")}`;
      await env.DB.prepare(`INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at,outcome,server_id,action_id)
        VALUES (?,?,'power','reboot',1,'active',?,'issued',?,?)`).bind(id, `home-${id}`, NOW - 100 + i, `srv-${id}`, `a-${id}`).run();
      powerByServer.set(`srv-${id}`, i === 21 ? "success" : "running");
    }
    const deps = { b3: { provider }, billing: { notifier }, storageBox: () => fakeBox() };
    await settlePower(testEnv(), deps, NOW);
    expect(await env.DB.prepare("SELECT state FROM cloud_home_jobs WHERE id='p-21'").first()).toEqual({ state: "active" }); // not reached yet
    at(NOW + MIN); await settlePower(testEnv(), deps, NOW + MIN);
    expect(await env.DB.prepare("SELECT state FROM cloud_home_jobs WHERE id='p-21'").first()).toEqual({ state: "done" });
  });

  it("a provider that cannot report power actions keeps the reservation inside the window", async () => {
    const without = (db: D1Database): ProviderAdapter => { const p = provider(db); delete p.power_action_status; return p; };
    const ctx = createExecutionContext();
    const w = createWorker(noNetwork, noNetwork, { provider: without }, {}, { notifier }, { jwksFetch, now: () => Date.now() }, { storageBox: () => fakeBox() });
    const res = await w.fetch(new Request("https://auth.murage.test/v1/account/home/reboot", { method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" }, body: "{}" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(202);
    at(NOW + 10 * MIN);
    await sweepSelfService(testEnv(), { b3: { provider: without }, billing: { notifier }, storageBox: () => fakeBox() }, NOW + 10 * MIN);
    expect(await activeJobs()).toEqual([{ kind: "power" }]);
  });
});

describe("SELFSERVICE2 #6 only allowed diagnostic events are kept", () => {
  it("a short private line under an approved source is never stored; allowed events are", async () => {
    expect([...LOG_EVENTS]).toEqual(contract.logEvents);
    for (const kept of contract.logEventsKept) expect(allowedLogMessage(kept)).toBe(kept.trim());
    for (const priv of contract.logEventsPrivate) expect(allowedLogMessage(priv)).toBe("[1 line omitted]");
    const fresh = await token({ aal2: true });
    await call("/v1/account/home/logs/request", fresh, {});
    const [cmd] = await desiredCommands();
    expect((await call("/v1/machines/home-1/logs", machineCredential, { generation, commandId: cmd.id, chunk: 0, final: true, lines: [
      { at: NOW, level: "info", source: "murage", message: 'prompt="diary pin 4321"' },
      { at: NOW + 1, level: "info", source: "murage", message: "server started on port 8799" }] })).status).toBe(200);
    const read = await (await call("/v1/account/home/logs", fresh)).json<{ lines: { message: string }[] }>();
    expect(read.lines.map((l) => l.message)).toEqual(["[1 line omitted]", "server started on port 8799"]);
  });
});

describe("SELFSERVICE2 P2 exports: the key once, the date honest, the archive kept through deletion", () => {
  async function readyArchive(requests = 1) {
    await backupSpace();
    const ids: string[] = [];
    for (let i = 0; i < requests; i++) ids.push((await (await call("/v1/account/export-request", await token({ aal2: true }), {})).json<{ requestId: string }>()).requestId);
    const [cmd] = await desiredCommands();
    const body = "age-encrypted-bytes";
    box.files.set(`homes/home-1-g1/${cmd.payload.path as string}`, body);
    const ready = await call("/v1/machines/home-1/export-ready", machineCredential, { generation, commandId: cmd.id, requestId: cmd.payload.requestId,
      file: cmd.payload.path, format: "tar.zst.age", bytes: body.length, sha256: await sha(body),
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") });
    expect(ready.status).toBe(200);
    return { ids, archive: cmd.payload.requestId as string, availableUntil: (await ready.json<{ availableUntil: number }>()).availableUntil };
  }
  const link = async (requestId: string) => (await call("/v1/account/export/download", await token({ aal2: true }), { requestId }))
    .json<{ url: string; key: string | null; keyShownBefore: boolean }>();

  it("the age identity is shown exactly once per archive, also across requests sharing it; downloads still work", async () => {
    const { ids } = await readyArchive(2);
    const [first, again, other] = [await link(ids[0]), await link(ids[0]), await link(ids[1])];
    expect(first.key).toMatch(/^AGE-SECRET-KEY-1/u);
    expect([again.key, again.keyShownBefore, other.key, other.keyShownBefore]).toEqual([null, true, null, true]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_export_jobs WHERE wrapped_key IS NOT NULL").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await (await call(again.url, null)).text()).toBe("age-encrypted-bytes");
  });

  it("availableUntil is capped at a scheduled deletion (at least a day), and the status shows that date", async () => {
    const hold = await (await call("/v1/account/home/hold", await token({ aal2: true }), { action: "delete", confirm: "home-1" })).json<{ completesAt: number }>();
    const { availableUntil } = await readyArchive();
    expect(availableUntil).toBe(hold.completesAt);
    expect(availableUntil).toBeLessThan(NOW + 7 * DAY);
    const s = await (await call("/v1/account/home", await token())).json<{ export: { availableUntil: number } }>();
    expect(s.export.availableUntil).toBe(hold.completesAt);
    expect(hold.completesAt - NOW).toBeGreaterThanOrEqual(EXPORT_MIN_AVAILABLE_MS);
  });

  it("a ready archive survives the home's backup purge until its date, then is purged with its kept folder", async () => {
    const { ids, archive, availableUntil } = await readyArchive();
    expect(availableUntil).toBe(NOW + 7 * DAY);
    at(NOW + DAY);
    await purgeBackup(env.DB, () => fakeBox(), "home-1", (await getHome()).resource_generation, NOW + DAY);
    expect(box.purged).toEqual(["homes/home-1-g1"]);
    expect([...box.files.keys()]).toEqual([`homes/retained-exports/home-1-g1/exports/${archive}/archive.tar.zst.age`]);
    const l = await link(ids[0]);
    expect(await (await call(l.url, null)).text()).toBe("age-encrypted-bytes");
    at(NOW + 7 * DAY + 1); await sweep();
    expect(box.purged.slice(1)).toEqual([`homes/retained-exports/home-1-g1/exports/${archive}`, "homes/retained-exports/home-1-g1"]);
    expect(box.files.size).toBe(0);
  });

  it("a retained archive still gets links after its home is deleted: by request id and historical ownership (Astra SELFSERVICE3 #4)", async () => {
    const { ids, archive } = await readyArchive();
    await purgeBackup(env.DB, () => fakeBox(), "home-1", (await getHome()).resource_generation, NOW);
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id='home-1'").run();
    expect((await call("/v1/account/home", await token())).status).toBe(404); // no current home
    const listed = await (await call("/v1/account/exports", await token())).json<{ exports: { requestId: string; state: string; availableUntil: number }[] }>();
    expect(listed.exports).toEqual([expect.objectContaining({ requestId: ids[0], state: "ready", availableUntil: NOW + 7 * DAY })]);
    const l = await link(ids[0]);
    expect(l.key).toMatch(/^AGE-SECRET-KEY-1/u);
    expect(await (await call(l.url, null)).text()).toBe("age-encrypted-bytes");
    expect(archive).toBe(ids[0]);
    // Another member cannot, even with the request id.
    const stranger = await token({ sub: OTHER_SUB, email: "someone@example.test", aal2: true });
    expect((await call("/v1/account/export/download", stranger, { requestId: ids[0] })).status).toBe(404);
    expect((await (await call("/v1/account/exports", await token({ sub: OTHER_SUB, email: "someone@example.test" }))).json<{ exports: unknown[] }>()).exports).toEqual([]);
    // After its date it is gone from the list and no link is issued.
    at(NOW + 7 * DAY + 1);
    expect((await (await call("/v1/account/exports", await token())).json<{ exports: unknown[] }>()).exports).toEqual([]);
    expect((await call("/v1/account/export/download", await token({ aal2: true }), { requestId: ids[0] })).status).toBe(409);
  });

  it("a box that cannot keep archives refuses the purge rather than delete a promised download", async () => {
    await readyArchive();
    const plain = (): StorageBoxAdapter => ({ ...fakeBox(), moveDirectory: undefined, makeDirectory: undefined });
    await expect(purgeBackup(env.DB, plain, "home-1", (await getHome()).resource_generation, NOW)).rejects.toThrow("export_retention_unsupported");
    expect(box.purged).toEqual([]);
  });
});

describe("SELFSERVICE2 P2 health and Fix-it on homes that cannot report or run commands", () => {
  it("with no app-health report, a fresh daemon heartbeat is 'unknown', never healthy", async () => {
    await heartbeat();
    const s = await (await call("/v1/account/home", await token())).json<{ health: string; healthy: boolean | null }>();
    expect(s).toMatchObject({ health: "unknown", healthy: null });
  });

  it("Fix-it on a home without the command runner never queues a restart it cannot run: it goes to the reboot", async () => {
    await env.DB.prepare("DELETE FROM cloud_home_runner").run();
    const r = await (await call("/v1/account/home/fix-it", await token(), {})).json<{ fixIt: { step: string; steps: { step: string; outcome: string }[] } }>();
    expect(r.fixIt.step).toBe("reboot");
    expect(r.fixIt.steps.map((x) => `${x.step}:${x.outcome}`)).toEqual(["check:unhealthy", "restart_service:unsupported", "reboot:issued"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_commands").first<{ n: number }>()).toEqual({ n: 0 });
    expect(reboots).toHaveLength(1);
  });
});

describe("the Update button installs only the fleet's promoted sequence, and the home reports its updater", () => {
  const UPDATE = "/v1/account/home/update";
  const report = (body: Record<string, unknown>) => call("/v1/machines/home-1/update-state", machineCredential, { generation, installedSequence: null, lastResult: null, stuck: null, ...body });
  const queued = async () => (await env.DB.prepare("SELECT payload FROM cloud_home_commands WHERE kind='update_software' ORDER BY created_at").all<{ payload: string }>()).results.map((r) => JSON.parse(r.payload));

  it("nothing promoted: refused in plain words, no command, no limit charged", async () => {
    await env.DB.prepare("DELETE FROM cloud_releases").run();
    const t = await token();
    for (let i = 0; i < 6; i++) {
      const res = await call(UPDATE, t, {});
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "up_to_date", message: "You're on the latest version." });
    }
    expect(await queued()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_jobs").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a release that is only rolling, halted, draft or cancelled is never offered to a customer", async () => {
    await env.DB.prepare("DELETE FROM cloud_releases").run();
    for (const [i, state] of (["draft", "rolling", "cancelled"] as const).entries()) {
      await env.DB.prepare("INSERT INTO cloud_releases (id,sequence,manifest_ref,state,wave,created_at,updated_at) VALUES (?,?,?,?,0,?,?)").bind(`r${i}`, 10 + i, "x", state, NOW, NOW).run();
    }
    expect(await errorOf(await call(UPDATE, await token(), {}))).toBe("up_to_date");
    expect(await queued()).toEqual([]);
  });

  it("with a promoted sequence the command carries it, and a newer release still rolling is not what is sent", async () => {
    await env.DB.prepare("INSERT INTO cloud_releases (id,sequence,manifest_ref,state,wave,created_at,updated_at) VALUES ('rel-9',9,'rev-9','rolling',1,?,?)").bind(NOW, NOW).run();
    const res = await call(UPDATE, await token(), {});
    expect(res.status).toBe(202);
    expect(await queued()).toEqual([{ keep: ["files", "settings", "logins"], reason: "customer", sequence: 5 }]);
    expect((await desiredCommands())[0].payload).toEqual({ keep: ["files", "settings", "logins"], reason: "customer", sequence: 5 });
  });

  it("a home that already reported the promoted sequence (or newer) is told it is on the latest version; an older report is offered it", async () => {
    expect((await report({ installedSequence: 5 })).status).toBe(200);
    expect(await errorOf(await call(UPDATE, await token(), {}))).toBe("up_to_date");
    expect((await report({ installedSequence: 6 })).status).toBe(200);
    expect(await errorOf(await call(UPDATE, await token(), {}))).toBe("up_to_date");
    expect((await report({ installedSequence: 4 })).status).toBe(200);
    expect((await call(UPDATE, await token(), {})).status).toBe(202);
  });

  it("an older home that never reports is still offered the promoted sequence", async () => {
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_update_reports").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await call(UPDATE, await token(), {})).status).toBe(202);
  });

  it("update-state: strict body, current generation, the machine credential; the row holds exactly what was reported", async () => {
    const last = { commandId: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", outcome: "done", reason: null };
    expect((await report({ installedSequence: 3, lastResult: last })).status).toBe(200);
    expect(await env.DB.prepare("SELECT installed_sequence,last_command_id,last_outcome,last_reason,stuck,generation FROM cloud_home_update_reports WHERE home_id='home-1'").first())
      .toEqual({ installed_sequence: 3, last_command_id: last.commandId, last_outcome: "done", last_reason: null, stuck: null, generation });
    expect(Object.keys({ generation, installedSequence: 1, lastResult: null, stuck: null }).sort()).toEqual([...contract.homeBodies["update-state"]].sort());
    expect(Object.keys(last).sort()).toEqual([...contract.homeBodies.updateLastResult].sort());
    expect((await report({ extra: 1 })).status).toBe(400);
    expect((await report({ installedSequence: 0 })).status).toBe(400);
    expect((await report({ stuck: "Free text with spaces" })).status).toBe(400);
    expect((await report({ generation: generation + 1 })).status).toBe(409);
    expect((await call("/v1/machines/home-1/update-state", null, { generation, installedSequence: 1, lastResult: null, stuck: null })).status).toBe(401);
    expect((await call("/v1/machines/home-1/update-state", await token(), { generation, installedSequence: 1, lastResult: null, stuck: null })).status).toBe(401);
    expect((await call("/v1/machines/home-1/update-state", machineCredential)).status).toBe(405);
  });

  it("a Stuck updater raises update.stuck once and clears it when the report clears; a rolled-back update raises update.rolled_back once per update", async () => {
    const open = async (kind: string) => (await env.DB.prepare("SELECT severity,detail FROM cloud_alerts WHERE home_id='home-1' AND kind=? AND resolved_at IS NULL").bind(kind).all()).results;
    await report({ installedSequence: 3, stuck: "rollback_stop" });
    await report({ installedSequence: 3, stuck: "rollback_stop" });
    expect(await open("update.stuck")).toHaveLength(1);
    expect((await open("update.stuck"))[0]).toMatchObject({ detail: expect.stringContaining("rollback_stop") });
    await report({ installedSequence: 3, stuck: null });
    expect(await open("update.stuck")).toHaveLength(0);
    const failed = { commandId: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abd", outcome: "failed", reason: "unhealthy" };
    await report({ installedSequence: 3, lastResult: failed });
    await report({ installedSequence: 3, lastResult: failed });
    expect(await open("update.rolled_back")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='update.rolled_back'").first<{ n: number }>()).toEqual({ n: 1 });
    await report({ installedSequence: 5, lastResult: { commandId: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abe", outcome: "done", reason: null } });
    expect(await open("update.rolled_back")).toHaveLength(0);
  });
});
