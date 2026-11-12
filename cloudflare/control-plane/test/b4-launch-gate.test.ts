// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-1 #7: the B4 launch gate. With the Flux switch, token and URL configured but the billing hooks a STUB (no router
// capability), NOTHING reaches the router from any of the five dispatch sites; the work stays journaled and a deduped
// flux.pending_capability alert is raised. Qualified hooks open the gate. A source scan holds that b4RouterClient is the only place
// that builds or reads a router client.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPENDING_OFF_STEP_UP_WORDS, changePlan, sweepFlux, stopForBilling, type FluxClient, type FluxDependencies } from "../src/b4-flux";
import { stubFluxHooks } from "../src/b5-billing";
import { createWorker } from "../src/index";
import { authFetch, cloudMember, jwksFetch, supabaseEnv, supabaseToken } from "./cloud-member";
import { checkDeploy, checkProduction } from "../scripts/check-deploy.mjs";
import { FLUX_BASE_VARS, FLUX_SWITCH_VAR, PRODUCTION_FLUX_ORIGINS, PRODUCTION_FLUX_SECRETS, envPolicy, productionFluxOriginProblem } from "../src/env-policy.mjs";
import { assertEnvIsolation } from "../src/env-isolation";
import { envFluxHooks } from "../src/flux-live-hooks";

const HOME = "home-gate";
const HOME_IP = "203.0.113.7";
const FLUX_ACCOUNT = "11111111-2222-3333-4444-555555555555";
const ADMIN = "admin-token-for-flux-tests-0123456789abcdef";
const SERVICE_TOKEN = "s".repeat(40);
const QUALIFIED_HOOKS = { stub: false, capabilities: { reversalTargets: true } } as unknown as NonNullable<FluxDependencies["billingFlux"]>;
const clock = Date.parse("2026-10-09T12:00:00Z");

// A fake FluxClient that records every method call (and answers with an empty object): the gate must keep it at zero calls.
function recordingClient() {
  const calls: string[] = [];
  const client = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); return {}; } }) as unknown as FluxClient;
  return { calls, client };
}

const factors = new Map<string, string>();
const factorOf = (sub: string) => { let f = factors.get(sub); if (!f) { f = crypto.randomUUID(); factors.set(sub, f); } return f; };
const fluxAuthFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: factorOf(c.sub), factor_type: "totp", status: "verified", friendly_name: "" }] });
}) as typeof fetch;

const testEnv = () => ({
  ...env, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...supabaseEnv, CLOUD_ADMIN_TOKEN: ADMIN,
  FLUX_CLOUD_SERVICE_TOKEN: SERVICE_TOKEN, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai",
  FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40), ...envOver,
}) as Env;
let envOver: Record<string, string | undefined> = {};

function workerWith(deps: FluxDependencies) {
  return createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch: fluxAuthFetch }, {}, { ...deps });
}
async function call(worker: ReturnType<typeof workerWith>, method: string, path: string, token: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://auth.murage.test${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body),
  }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
/** A Murage Cloud member with a trusted TOTP factor and a freshly stepped-up token, who owns HOME. */
async function owner() {
  const member = await cloudMember("gate-owner@example.test");
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(member.userId, factorOf(member.sub)).run();
  const token = await supabaseToken(member.sub, "gate-owner@example.test", (s) => ({ aal: "aal2", mfa_factor_id: factorOf(member.sub),
    amr: [{ method: "totp", timestamp: s - 10 }, { method: "otp", timestamp: s - 60 }] }));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
      VALUES (?,?,1,'active',NULL,?,?,?,?)`).bind(HOME, HOME, JSON.stringify([HOME_IP]), now, "https://h.murage.test", "https://admin.murage.test"),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(HOME, `inst-${HOME}`, member.userId, now, now),
    env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at)
      VALUES (?, 'starter', 0, 'none', 30000000, 0, ?)`).bind(HOME, now),
    env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at) VALUES (?,?,?)").bind(member.userId, FLUX_ACCOUNT, now),
  ]);
  return { token, userId: member.userId, signIn: member.token }; // signIn: sign-in only (aal1), no step-up
}
const queueOp = (opId: string, kind: string) => env.DB.prepare(
  "INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,attempts,created_at,updated_at) VALUES (?,?,?,?,'{}','queued',0,?,?)")
  .bind(opId, HOME, Math.floor(Math.random() * 1e6), kind, clock, clock).run();
const alertRows = () => env.DB.prepare("SELECT id FROM cloud_alerts WHERE home_id=? AND kind='flux.pending_capability'").bind(HOME).all<{ id: string }>();
const openOps = () => env.DB.prepare("SELECT op_id,state FROM flux_home_ops WHERE home_id=? AND state IN ('queued','running')").bind(HOME).all<{ op_id: string; state: string }>();

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; envOver = {}; envFluxHooks.mode.on = false; });

describe.each([
  // No billingFlux with the switch on is no longer a closed gate: the worker then runs the real hooks (flux-live-hooks.ts, test/flux-live-hooks.test.ts).
  ["stubFluxHooks", { billingFlux: stubFluxHooks }],
] as [string, Partial<FluxDependencies>][])("B4 launch gate closed: %s", (_name, hooks) => {
  it("owner cap, Stop and subkey routes send nothing, keep the work and raise the alert", async () => {
    const { calls, client } = recordingClient();
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { sent.push(String(input instanceof Request ? input.url : input)); return new Response("{}"); }) as typeof fetch;
    const worker = workerWith({ fluxClient: () => client, now: () => clock, ...hooks });
    const { token } = await owner();
    expect((await call(worker, "POST", `/v1/homes/${HOME}/flux/subkey`, token, {})).status).toBe(410); // 8b: the owner mint is retired, with or without the gate
    await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { capUsd: 55.5 });
    await call(worker, "POST", `/v1/homes/${HOME}/flux/stop`, token, {});
    expect(calls).toEqual([]);                                   // the gate sits above the client
    expect(sent.filter((u) => u.includes("fluxrouter"))).toEqual([]); // and nothing left the worker for the router
    expect((await alertRows()).results).toEqual([{ id: `alert:flux_pending_capability:${HOME}` }]);
    // (A stop on a home holding no key may complete locally: no router call is needed for it. The proof is the zero calls above.)
  });

  it("sweepFlux with queued ops claims nothing, sends nothing and leaves every op queued", async () => {
    const { calls, client } = recordingClient();
    await owner();
    await queueOp("op-gate-stop", "stop");
    await queueOp("op-gate-cap", "cap");
    await sweepFlux(testEnv(), { fluxClient: () => client, now: () => clock, ...hooks });
    expect(calls).toEqual([]);
    expect((await openOps()).results.map((r) => [r.op_id, r.state]).sort()).toEqual([["op-gate-cap", "queued"], ["op-gate-stop", "queued"]]);
    expect((await env.DB.prepare("SELECT attempts FROM flux_home_ops WHERE op_id='op-gate-stop'").first<{ attempts: number }>())!.attempts).toBe(0);
    expect((await alertRows()).results).toHaveLength(1);
    await sweepFlux(testEnv(), { fluxClient: () => client, now: () => clock, ...hooks }); // deduped
    expect((await alertRows()).results).toHaveLength(1);
  });

  it("changePlan (plan push) and stopForBilling send nothing and journal the work", async () => {
    const { calls, client } = recordingClient();
    await owner();
    const deps = { fluxClient: () => client, now: () => clock, ...hooks };
    await changePlan(testEnv(), { homeId: HOME, plan: "pro" }, deps).catch((e) => e);
    await stopForBilling(testEnv(), HOME, deps).catch((e) => e);
    expect(calls).toEqual([]);
    expect((await alertRows()).results).toHaveLength(1);
    expect((await openOps()).results.length).toBeGreaterThan(0); // the plan's cap push / the Stop are queued, not lost
    expect((await env.DB.prepare("SELECT billing_hold FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ billing_hold: number }>())!.billing_hold).toBe(1);
  });
});

describe("B4 launch gate open (positive control)", () => {
  it("with qualified billing hooks the same Stop reaches the client", async () => {
    const { calls, client } = recordingClient();
    await owner();
    await stopForBilling(testEnv(), HOME, { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock }).catch((e) => e);
    expect(calls.length).toBeGreaterThan(0);
    expect((await alertRows()).results).toHaveLength(0);
  });

  it("with qualified hooks the sweep runs (it does not return before the claim)", async () => {
    const { client } = recordingClient();
    await owner();
    await queueOp("op-gate-open", "stop");
    await sweepFlux(testEnv(), { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock }).catch((e) => e);
    expect((await alertRows()).results).toHaveLength(0);
  });
});

describe("B4 router client has ONE construction site (source scan)", () => {
  // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
  const SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  /** Code only: block comments and line comments dropped, so prose that names the symbol is not a use. */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const USE = /createFluxClient\s*\(|\.fluxClient\b/;

  it("createFluxClient( and .fluxClient appear only inside b4RouterClient (plus the createFluxClient definition)", () => {
    const b4Key = Object.keys(SOURCES).find((k) => k.endsWith("/b4-flux.ts"))!;
    expect(b4Key).toBeTruthy();
    const offenders = Object.entries(SOURCES).filter(([k]) => k !== b4Key && USE.test(code(SOURCES[k]))).map(([k]) => k);
    expect(offenders).toEqual([]);

    let b4 = code(SOURCES[b4Key]);
    const start = b4.indexOf("export function b4RouterClient(");
    const end = b4.indexOf("export interface FluxDependencies");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const router = b4.slice(start, end);
    expect(router).toMatch(/\.fluxClient/); // the one read of the injected client
    expect(router).toMatch(/createFluxClient/); // and the one construction
    b4 = b4.slice(0, start) + b4.slice(end);
    // The definition itself is the only other mention.
    const rest = b4.replace(/export function createFluxClient\s*\(/, "");
    expect(rest.match(USE)).toBeNull();
  });
});

describe("PRODFLUX: switched on with a Flux credential missing, nothing new is activated or issued (Astra HIGH 2)", () => {
  const credentialAlert = (code: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL")
    .bind(`credit.${code}`).first<{ n: number }>().then((r) => r!.n);
  it.each([["FLUX_CLOUD_SERVICE_TOKEN", "flux_service_token_absent"]])(
    "%s absent: no key op (Stop, cap, subkey), no route activation, the sweep claims nothing and alerts; journals kept", async (secret, code) => {
      envOver = { [secret]: undefined };
      const { calls, client } = recordingClient();
      const sent: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => { sent.push(String(input instanceof Request ? input.url : input)); return new Response("{}"); }) as typeof fetch;
      const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
      const { token } = await owner();
      // Billing's Stop on qualified hooks: journaled, never sent (the positive control below, both tokens set, does reach the client).
      await stopForBilling(testEnv(), HOME, deps).catch((e) => e);
      expect(calls).toEqual([]);
      expect((await openOps()).results.length).toBeGreaterThan(0);
      // The customer routes answer as Flux off: nothing reaches the client or the router.
      const worker = workerWith(deps);
      const subkey = await call(worker, "POST", `/v1/homes/${HOME}/flux/subkey`, token, {});
      expect(subkey.status).toBe(404);
      expect(calls).toEqual([]);
      expect(sent.filter((u) => u.includes("fluxrouter"))).toEqual([]);
      // A pending B4 grant and a queued op: the sweep claims nothing, consumes no attempt, opens no dispatch, and raises ONE alert.
      await env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,created_at) VALUES ('inv:in_cred_001','k-cred',?,?,?,?,?,?,0,?)")
        .bind(HOME, "starter", 10_000_000, clock - 1000, clock + 86_400_000, clock + 40 * 86_400_000, clock).run();
      await queueOp("op-cred-cap", "cap");
      await sweepFlux(testEnv(), deps);
      await sweepFlux(testEnv(), deps);
      expect(calls).toEqual([]);
      expect(await env.DB.prepare("SELECT status,attempts,claim_id FROM flux_grants WHERE grant_id='inv:in_cred_001'").first())
        .toEqual({ status: "pending", attempts: 0, claim_id: null });
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE grant_id='inv:in_cred_001'").first<{ n: number }>())!.n).toBe(0);
      expect((await env.DB.prepare("SELECT state,attempts FROM flux_home_ops WHERE op_id='op-cred-cap'").first())).toEqual({ state: "queued", attempts: 0 });
      expect(await credentialAlert(code)).toBe(1);
      // The token is back: the journaled billing Stop goes out, once (MurageMain: held, never dropped).
      envOver = {};
      const later = { ...deps, now: () => clock + 10 * 60_000 };
      await sweepFlux(testEnv(), later);
      await sweepFlux(testEnv(), later);
      expect(calls.filter((c) => c === "stop")).toEqual(["stop"]);
    });

  // MurageMain: a Stop must never depend on a token it does not use. Stop and revokeKey send FLUX_CLOUD_SERVICE_TOKEN only (createFluxClient),
  // so with only FLUX_CLOUD_GRANTS_TOKEN missing every revocation is dispatched and everything that issues stays held.
  it("FLUX_CLOUD_GRANTS_TOKEN absent: billing Stop, owner Stop and key compensations are sent; mint, cap and grants stay held", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client } = recordingClient();
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { sent.push(String(input instanceof Request ? input.url : input)); return new Response("{}"); }) as typeof fetch;
    const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const { token } = await owner();
    // Billing's Stop (a cancellation) is dispatched now.
    expect(await stopForBilling(testEnv(), HOME, deps)).toEqual({ state: "stopped", opId: expect.any(String) });
    expect(calls).toEqual(["stop"]);
    // Activation routes answer as Flux off; the owner's Stop is a revocation and is served.
    const worker = workerWith(deps);
    expect((await call(worker, "POST", `/v1/homes/${HOME}/flux/subkey`, token, {})).status).toBe(404);
    expect((await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { capUsd: 55.5 })).status).not.toBe(404);
    expect(calls).toEqual(["stop"]);
    const stop = await call(worker, "POST", `/v1/homes/${HOME}/flux/stop`, token, {});
    expect(stop.status).toBe(200);
    expect(calls).toEqual(["stop", "stop"]);
    // The sweep drains a compensation and a crashed mint (both revocations) and leaves a cap push and a pending grant held.
    await env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,created_at) VALUES ('inv:in_cred_002','k-cred2',?,?,?,?,?,?,0,?)")
      .bind(HOME, "starter", 10_000_000, clock - 1000, clock + 86_400_000, clock + 40 * 86_400_000, clock).run();
    await queueOp("op-rev-cap", "cap");
    await env.DB.prepare("INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,attempts,created_at,updated_at) VALUES (?,?,?,?,?,'queued',0,?,?)")
      .bind("op-rev-comp", HOME, 9_000_001, "compensate", JSON.stringify({ generation: 7, lifecycleVersion: 1 }), clock, clock).run();
    await env.DB.prepare("INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,attempts,created_at,updated_at) VALUES (?,?,?,?,?,'queued',0,?,?)")
      .bind("op-rev-mint", HOME, 9_000_002, "mint", JSON.stringify({ generation: 8, lifecycleVersion: 1 }), clock, clock).run();
    await sweepFlux(testEnv(), deps);
    // 8b fix r1 (Astra H2): the stopped home's status is read once (the stopped-live repair); this client reports nothing live, so no repair Stop.
    expect(calls).toEqual(["stop", "stop", "status", "revokeKey", "revokeKey"]);
    expect(await env.DB.prepare("SELECT state,attempts FROM flux_home_ops WHERE op_id='op-rev-cap'").first()).toEqual({ state: "queued", attempts: 0 });
    expect(await env.DB.prepare("SELECT state FROM flux_home_ops WHERE op_id IN ('op-rev-comp','op-rev-mint') ORDER BY op_id").all().then((r) => r.results))
      .toEqual([{ state: "done" }, { state: "done" }]);
    expect(await env.DB.prepare("SELECT status,attempts,claim_id FROM flux_grants WHERE grant_id='inv:in_cred_002'").first())
      .toEqual({ status: "pending", attempts: 0, claim_id: null });
    expect(sent.filter((u) => u.includes("fluxrouter"))).toEqual([]);
    expect(await credentialAlert("grants_token_absent")).toBe(1);
  });
});

describe("PRODFLUX: production Flux hosts are EXACT per variable, at deploy and through the Worker's own entry points", () => {
  // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
  const RAW = import.meta.glob("../wrangler.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const text = () => Object.values(RAW)[0] as string;
  const block = (name: string): Record<string, any> => JSON.parse(text().split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")).env[name];
  const prodVars = (): Record<string, string | undefined> => ({ ...block("production").vars, MURAGE_ENV: "live" });
  const isolation = (vars: Record<string, string | undefined>): string => {
    try { assertEnvIsolation(vars as unknown as Env); return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
  };
  const viaFetch = async (vars: Record<string, string | undefined>): Promise<string> => {
    const res = await createWorker().fetch(new Request("https://cp.test/healthz"), { DB: env.DB, ...vars } as unknown as Env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    const body = await res.text();
    return res.status === 503 && body.includes("env_mixed") ? "env_mixed" : `status ${res.status}`;
  };
  const viaScheduled = (vars: Record<string, string | undefined>): string => {
    try {
      createWorker().scheduled({ cron: "*/5 * * * *", scheduledTime: clock, noRetry() {} } as unknown as ScheduledController, { DB: env.DB, ...vars } as unknown as Env,
        { waitUntil(p: Promise<unknown>) { void Promise.resolve(p).catch(() => undefined); }, passThroughOnException() {} } as unknown as ExecutionContext);
      return "ran";
    } catch (e) { return (e as { code?: string }).code ?? String(e); }
  };
  const fluxRefusals = (mutate: (q: Record<string, any>) => void): string => {
    const q = JSON.parse(JSON.stringify(block("production")));
    mutate(q);
    return checkProduction(q).filter((m: string) => /FLUX/.test(m)).join("\n");
  };

  it("the exact map is the one shipped, and the shipped production config passes deploy and every runtime entry", async () => {
    expect(PRODUCTION_FLUX_ORIGINS).toEqual({ FLUX_API_BASE: "https://api.fluxrouter.ai", FLUX_CLOUD_GRANTS_URL: "https://api.fluxrouter.ai", FLUX_APP_BASE: "https://fluxrouter.ai" });
    expect([...FLUX_BASE_VARS].sort()).toEqual(["FLUX_API_BASE", "FLUX_APP_BASE", "FLUX_CLOUD_GRANTS_URL"]);
    const p = block("production");
    // ch1-g2d (Sean 11-10): production ships with Flux OFF (switch absent, the two Flux secrets not yet required); the switch-on is a later commit.
    expect(p.vars).not.toHaveProperty(FLUX_SWITCH_VAR);
    for (const k of FLUX_BASE_VARS) expect(p.vars[k], k).toBe(PRODUCTION_FLUX_ORIGINS[k]);
    for (const s of PRODUCTION_FLUX_SECRETS) { expect(p.secrets.required, s).not.toContain(s); expect(p.vars).not.toHaveProperty(s); }
    expect(fluxRefusals(() => undefined)).toBe("");
    // The switch-on commit (switch "1" plus both secrets required) passes deploy and the runtime policy too.
    expect(fluxRefusals((q) => { q.vars[FLUX_SWITCH_VAR] = "1"; q.secrets.required.push(...PRODUCTION_FLUX_SECRETS); })).toBe("");
    expect(envPolicy({ ...prodVars(), [FLUX_SWITCH_VAR]: "1" }).problems).toEqual([]);
    expect(envPolicy(prodVars()).problems).toEqual([]);
    expect(isolation(prodVars())).toBe("ok");
    expect(await viaFetch(prodVars())).not.toBe("env_mixed");
  });

  const API_BAD = [
    "https://preview.fluxrouter.ai", "https://api-dev.fluxrouter.ai", "https://api-stage.fluxrouter.ai", "https://api-staging.fluxrouter.ai",
    "https://x.staging.fluxrouter.ai", "https://evil.fluxrouter.ai", "https://xn--pi-6kc.fluxrouter.ai", "https://xn--pi-j1a.fluxrouter.ai",
    "https://foo..fluxrouter.ai", "https://fluxrouter.ai", "https://evilfluxrouter.ai", "https://fluxrouter.ai.evil.com",
    "https://api.fluxrouter.ai.evil.example", "https://user:pw@api.fluxrouter.ai", "https://api.fluxrouter.ai@evil.com", "https://api.fluxrouter.ai.",
    "https://api.fluxrouter.ai/", "https://api.fluxrouter.ai?x=1", "https://api.fluxrouter.ai#x", "https://api.fluxrouter.ai/internal",
    "https://api.fluxrouter.ai:443", "https://api.fluxrouter.ai:8443", "https://API.fluxrouter.ai", "HTTPS://api.fluxrouter.ai",
    "http://api.fluxrouter.ai", " https://api.fluxrouter.ai", "https://api.fluxrouter.ai ", "https://аpi.fluxrouter.ai", "",
  ];
  const APP_BAD = [
    "https://api.fluxrouter.ai", "https://app.fluxrouter.ai", "https://app-staging.fluxrouter.ai", "https://www.fluxrouter.ai",
    "https://preview.fluxrouter.ai", "https://fluxrouter.ai/", "https://fluxrouter.ai.", "https://xn--fluxrouter-xyz.ai", "https://fluxrouter.ai:443", "http://fluxrouter.ai",
  ];
  const CASES: [string, string][] = [
    ...API_BAD.flatMap((v) => [["FLUX_API_BASE", v], ["FLUX_CLOUD_GRANTS_URL", v]] as [string, string][]),
    ...APP_BAD.map((v) => ["FLUX_APP_BASE", v] as [string, string]),
  ];
  it.each(CASES)("refused everywhere: %s=%j (deploy on and off, envPolicy, assertEnvIsolation, fetch, scheduled)", async (k, v) => {
    const want = PRODUCTION_FLUX_ORIGINS[k as keyof typeof PRODUCTION_FLUX_ORIGINS];
    expect(productionFluxOriginProblem(k, v)).toBe(`must be exactly ${want}`);
    // Production ships Flux off (ch1-g2d), so the "on" cases switch it on explicitly.
    expect(fluxRefusals((q) => { q.vars[FLUX_SWITCH_VAR] = "1"; q.secrets.required.push(...PRODUCTION_FLUX_SECRETS); q.vars[k] = v; })).toContain(`vars.${k}: must be exactly ${want}`);
    expect(fluxRefusals((q) => { delete q.vars[FLUX_SWITCH_VAR]; q.vars[k] = v; })).toContain(`vars.${k}: must be exactly ${want}`); // off too
    const vars = { ...prodVars(), [FLUX_SWITCH_VAR]: "1", [k]: v };
    expect(envPolicy(vars).problems).toContain(`live: ${k} must be exactly ${want}`);
    expect(isolation(vars)).toBe("env_mixed");
    expect(await viaFetch(vars)).toBe("env_mixed");
    expect(viaScheduled(vars)).toBe("env_mixed");
  });
  it.each(["FLUX_API_BASE", "FLUX_CLOUD_GRANTS_URL", "FLUX_APP_BASE"])("no config turns production Flux on without %s: deploy and every runtime entry refuse", async (k) => {
    expect(fluxRefusals((q) => { q.vars[FLUX_SWITCH_VAR] = "1"; delete q.vars[k]; })).toContain(`vars.${k}: must be set while Flux is on`);
    const vars = { ...prodVars(), [FLUX_SWITCH_VAR]: "1", [k]: undefined };
    expect(envPolicy(vars).problems).toContain(`live: ${k} must be set while Flux is on`);
    expect(isolation(vars)).toBe("env_mixed");
    expect(await viaFetch(vars)).toBe("env_mixed");
    expect(viaScheduled(vars)).toBe("env_mixed");
    // Switched off, an absent host is fine (Flux is not in use).
    expect(isolation({ ...vars, [FLUX_SWITCH_VAR]: undefined })).toBe("ok");
  });
  it.each(["FLUX_CLOUD_SERVICE_TOKEN", "FLUX_CLOUD_GRANTS_TOKEN"])("no config turns production Flux on without %s in secrets.required", (s) => {
    expect(fluxRefusals((q) => { q.vars[FLUX_SWITCH_VAR] = "1"; q.secrets.required = q.secrets.required.filter((x: string) => x !== s); }))
      .toContain(`secrets.required: must name ${s} while Flux is on`);
  });
  it("an odd switch value or a Flux token written as a var is refused, at deploy and at run time", async () => {
    expect(fluxRefusals((q) => { q.vars[FLUX_SWITCH_VAR] = "true"; })).toContain('absent (Flux off) or exactly "1"');
    const odd = { ...prodVars(), [FLUX_SWITCH_VAR]: "true" };
    expect(envPolicy(odd).problems).toContain(`live: ${FLUX_SWITCH_VAR} must be absent or exactly "1"`);
    expect(isolation(odd)).toBe("env_mixed");
    expect(await viaFetch(odd)).toBe("env_mixed");
    expect(fluxRefusals((q) => { q.vars.FLUX_CLOUD_GRANTS_TOKEN = "g".repeat(40); })).toContain("is a secret");
  });
  it("staging keeps deploying with its staging Flux hosts (the exact rule is production-only)", () => {
    const st = block("staging");
    expect(st.vars.FLUX_API_BASE).toBe("https://api-staging.fluxrouter.ai");
    expect(checkDeploy(text(), "staging").filter((m: string) => /FLUX/.test(m))).toEqual([]);
    expect(envPolicy({ ...st.vars, MURAGE_ENV: "staging" }).problems.filter((m: string) => /FLUX/.test(m))).toEqual([]);
    expect(isolation({ MURAGE_ENV: "staging", [FLUX_SWITCH_VAR]: "1", FLUX_API_BASE: st.vars.FLUX_API_BASE, FLUX_APP_BASE: st.vars.FLUX_APP_BASE,
      FLUX_CLOUD_GRANTS_URL: st.vars.FLUX_CLOUD_GRANTS_URL })).toBe("ok");
  });
});

// ---- PRODFLUX round 3 (plan r4 C and D, items 4' and 5) --------------------------------------------------------------------------------------
const opRow = (where: string) => env.DB.prepare(`SELECT state,attempts,last_error FROM flux_home_ops WHERE home_id=? AND ${where} ORDER BY seq DESC LIMIT 1`).bind(HOME)
  .first<{ state: string; attempts: number; last_error: string | null }>();
const stopOps = () => env.DB.prepare(`SELECT SUM(state IN ('queued','running')) AS open,MAX(attempts) AS maxAttempts,
  SUM(last_error='flux_pending_capability') AS held FROM flux_home_ops WHERE home_id=? AND kind='stop'`).bind(HOME).first<{ open: number; maxAttempts: number; held: number }>();
const keyRow = () => env.DB.prepare("SELECT spending_off,cap_microcents,state FROM flux_home_keys WHERE home_id=?").bind(HOME)
  .first<{ spending_off: number; cap_microcents: number; state: string }>();
const READINESS: [string, Record<string, string | undefined>][] = [
  ["both Flux secrets set (serving)", {}],
  ["FLUX_CLOUD_SERVICE_TOKEN absent", { FLUX_CLOUD_SERVICE_TOKEN: undefined }],
  ["FLUX_CLOUD_GRANTS_TOKEN absent (revoke-only)", { FLUX_CLOUD_GRANTS_TOKEN: undefined }],
];

describe("PRODFLUX r4 C: switched on with the real hooks, cap OFF and Stop need the step-up in every readiness state", () => {
  it.each(READINESS)("%s: sign-in only is refused for Stop and both OFF bodies; stepped up, each journals a real Stop", async (_name, over) => {
    envOver = over;
    const serviceAbsent = "FLUX_CLOUD_SERVICE_TOKEN" in over;
    const { calls, client } = recordingClient();
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { sent.push(String(input instanceof Request ? input.url : input)); return new Response("{}"); }) as typeof fetch;
    const worker = workerWith({ fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    const { token, signIn } = await owner();
    for (const [path, body] of [["stop", {}], ["cap", { enabled: false }], ["cap", { capUsd: 0 }]] as const) {
      const r = await call(worker, "POST", `/v1/homes/${HOME}/flux/${path}`, signIn, body);
      expect([path, body, r.status, (await r.json<{ error?: string }>()).error]).toEqual([path, body, 403, "step_up_required"]);
    }
    expect(calls).toEqual([]);
    expect((await openOps()).results).toEqual([]);
    expect((await keyRow())!.spending_off).toBe(0);
    // Stepped up: cap OFF stores the off state and journals the owner's Stop (sent now, or held with no attempt counted).
    const off = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual(serviceAbsent ? { capUsd: 0, enabled: false, pending: true } : { capUsd: 0, enabled: false });
    expect((await keyRow())!.spending_off).toBe(1);
    expect(await opRow("kind='stop'")).toMatchObject(serviceAbsent ? { state: "queued", attempts: 0 } : { state: "done" });
    const stop = await call(worker, "POST", `/v1/homes/${HOME}/flux/stop`, token, {});
    if (serviceAbsent) {
      expect([stop.status, await stop.json()]).toEqual([202, { state: "stopping" }]);
      expect(await stopOps()).toEqual({ open: 2, maxAttempts: 0, held: 1 }); // both journaled, none counted; the first one tried says why
      expect(calls).toEqual([]);
    } else {
      expect([stop.status, await stop.json()]).toEqual([200, { state: "stopped" }]);
      expect(calls.filter((c) => c === "stop").length).toBe(2);
    }
    expect(calls).not.toContain("setCap");
    expect(sent.filter((u) => u.includes("fluxrouter"))).toEqual([]);
    if (serviceAbsent) {
      // The token is back: the journaled Stops go out, and nothing else.
      envOver = {};
      await sweepFlux(testEnv(), { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock + 10 * 60_000 });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c === "stop")).toBe(true);
      expect((await openOps()).results).toEqual([]);
    }
  });

  it.each(READINESS.slice(1))("%s: a cap raise or switch-on never goes out (the unavailable answer, nothing written or queued)", async (_name, over) => {
    envOver = over;
    const { calls, client } = recordingClient();
    const worker = workerWith({ fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    const { token } = await owner();
    for (const body of [{ capUsd: 500 }, { enabled: true }, { enabled: true, capUsd: 900 }, { capUsd: 5 }]) {
      const r = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, body);
      expect([body, r.status, await r.json<Record<string, unknown>>()]).toEqual([body, 200, expect.objectContaining({ state: "flux_unavailable", changed: false })]);
    }
    expect(calls).toEqual([]);
    expect((await openOps()).results).toEqual([]);
    expect(await keyRow()).toEqual({ spending_off: 0, cap_microcents: 30_000_000, state: "none" });
  });
});

// ---- Astra r3 HIGH: cap OFF commits spending off and its Stop together; the revoke-only sweep repairs an OFF home still active ---------------
const SPENDING_OFF_PROMPT = "To turn spending off, we'll email you a code. This also pauses your bots' Flux key until you turn spending back on.";
/** A recording client whose Stop fails while `down.on` is set (the router unreachable). */
function flakyStopClient() {
  const calls: string[] = [];
  const down = { on: false };
  const client = new Proxy({}, { get: (_t, name) => async () => {
    calls.push(String(name));
    if (name === "stop" && down.on) throw new Error("router unreachable");
    return {};
  } }) as unknown as FluxClient;
  return { calls, client, down };
}
const homeKey = () => env.DB.prepare("SELECT spending_off,state,lifecycle_version FROM flux_home_keys WHERE home_id=?").bind(HOME)
  .first<{ spending_off: number; state: string; lifecycle_version: number }>();
const allOps = () => env.DB.prepare("SELECT kind,state FROM flux_home_ops WHERE home_id=? ORDER BY seq").bind(HOME).all<{ kind: string; state: string }>()
  .then((r) => r.results);
const activeKey = () => env.DB.prepare("UPDATE flux_home_keys SET state='active',generation=1 WHERE home_id=?").bind(HOME).run();

describe("Astra r3 HIGH: cap OFF never records spending off without its Stop", () => {
  it("the Stop insert fails: nothing is committed and the route answers 5xx; sign-in only gets the spending-off prompt", async () => {
    const { calls, client } = recordingClient();
    const worker = workerWith({ fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    const { token, signIn } = await owner();
    await activeKey();
    const refused = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, signIn, { enabled: false });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "step_up_required", message: SPENDING_OFF_PROMPT });
    const before = await homeKey();
    await env.DB.prepare(`CREATE TRIGGER capoff_stop_fails BEFORE INSERT ON flux_home_ops WHEN NEW.kind='stop'
      BEGIN SELECT RAISE(ABORT, 'injected stop insert failure'); END`).run();
    try {
      const off = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { enabled: false });
      expect(off.status).toBeGreaterThanOrEqual(500);
      expect(await off.text()).not.toContain("pending");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS capoff_stop_fails").run();
    }
    expect(await homeKey()).toEqual(before); // spending still on, the lifecycle unmoved
    expect(before).toMatchObject({ spending_off: 0, state: "active" });
    expect(await allOps()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("revoke-only: an OFF home whose key is still active with no Stop op is repaired by the sweep and its key revoked, once", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client } = recordingClient();
    const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    await owner();
    // The state an OFF written before this fix could leave: spending off, the key active, no Stop journaled.
    await env.DB.prepare("UPDATE flux_home_keys SET state='active',generation=1,spending_off=1,spending_off_at=?,cap_custom=1 WHERE home_id=?").bind(clock - 60_000, HOME).run();
    await sweepFlux(testEnv(), deps);
    // 8b fix r1 (Astra H2): the now stopped home's status is read by the stopped-live repair; nothing live is reported, so nothing more is sent.
    expect(calls).toEqual(["stop", "status"]);
    expect(await homeKey()).toMatchObject({ spending_off: 1, state: "stopped" });
    expect(await allOps()).toEqual([{ kind: "stop", state: "done" }]);
    await sweepFlux(testEnv(), { ...deps, now: () => clock + 60 * 60_000 });
    expect(calls).toEqual(["stop", "status", "status"]);
  });

  it("grants token missing: an OFF whose Stop cannot be sent yet answers pending, and ends revoked once the token returns", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client, down } = flakyStopClient();
    const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const worker = workerWith(deps);
    const { token } = await owner();
    await activeKey();
    down.on = true;
    const off = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { enabled: false });
    expect([off.status, await off.json()]).toEqual([200, { capUsd: 0, enabled: false, pending: true }]);
    expect(await homeKey()).toMatchObject({ spending_off: 1, state: "stopping" });
    expect((await openOps()).results).toHaveLength(1); // the Stop is journaled with the OFF
    envOver = {};
    down.on = false;
    await sweepFlux(testEnv(), { ...deps, now: () => clock + 2 * 60 * 60_000 });
    expect(await homeKey()).toMatchObject({ spending_off: 1, state: "stopped" });
    expect((await openOps()).results).toEqual([]);
    expect(calls.filter((c) => c !== "stop")).not.toContain("setCap");
    expect(calls.filter((c) => c === "stop").length).toBeGreaterThanOrEqual(2); // the failed try, then the one that landed
  });
});

// ---- CAPOFF-REPAIR-RACE: the sweep's repair of an OFF home is one conditional batch, stamped after it, and every failure is logged -------
const offActive = () => env.DB.prepare("UPDATE flux_home_keys SET state='active',generation=1,spending_off=1,spending_off_at=?,cap_custom=1 WHERE home_id=?")
  .bind(clock - 60_000, HOME).run();
const checkedAt = () => env.DB.prepare("SELECT spending_off_checked_at AS c FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ c: number | null }>()
  .then((r) => r?.c ?? null);
/** The test env with hooks run once each: `afterList` right after the sweep's list of OFF homes is read, `afterRead` right after the
 *  repair's eligibility read (before its Stop write). */
function racedEnv(hooks: { afterList?: () => Promise<unknown>; afterRead?: () => Promise<unknown> }): Env {
  const base = testEnv();
  const stages = [
    { match: "COALESCE(k.spending_off_checked_at,0)<=?", method: "all", hook: hooks.afterList, fired: false },
    { match: "SELECT spending_off AS o, state AS s FROM flux_home_keys", method: "first", hook: hooks.afterRead, fired: false },
  ];
  const db = new Proxy(base.DB, { get(target, name) {
    if (name === "prepare") return (sql: string) => {
      const stmt = target.prepare(sql);
      const stage = stages.find((x) => x.hook && !x.fired && sql.includes(x.match));
      if (!stage) return stmt;
      return { bind: (...args: unknown[]) => {
        const bound = stmt.bind(...args) as unknown as Record<string, () => Promise<unknown>>;
        return { [stage.method]: async () => {
          const result = await bound[stage.method]();
          if (!stage.fired) { stage.fired = true; await stage.hook!(); }
          return result;
        } };
      } };
    };
    const value = Reflect.get(target, name);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...base, DB: db } as Env;
}
/** A meeting point for `n` concurrent sweeps: each waits until all have arrived. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => { open = resolve; });
  return () => { arrived += 1; if (arrived === n) open(); return all; };
}
const errorsLike = (spy: { mock: { calls: unknown[][] } }, words: string) =>
  spy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(words));

describe("CAPOFF-REPAIR-RACE: the sweep repairs an OFF home only while it is still OFF, active and without an open Stop", () => {
  it("(a) the race: a cap ON lands between the eligibility read and the Stop write: spending stays on, not stopped, no Stop journaled", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client } = recordingClient();
    await owner();
    await offActive();
    const before = await homeKey();
    const raced = racedEnv({ afterRead: async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET spending_off=0,spending_off_at=NULL,cap_version=cap_version+1 WHERE home_id=?").bind(HOME).run();
    } });
    await sweepFlux(raced, { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(await homeKey()).toEqual({ spending_off: 0, state: "active", lifecycle_version: before!.lifecycle_version });
    expect(await allOps()).toEqual([]);
    expect(calls).not.toContain("stop");
  });

  it("(b) two overlapping sweeps journal and send exactly ONE Stop", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client } = recordingClient();
    const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    await owner();
    await offActive();
    // Two sweeps at once: both read the list of OFF homes, then both make the eligibility read, before either writes its Stop.
    const listed = barrier(2);
    const read = barrier(2);
    await Promise.all([0, 1].map(() => sweepFlux(racedEnv({ afterList: listed, afterRead: read }), deps)));
    expect(await allOps()).toEqual([{ kind: "stop", state: "done" }]);
    expect(calls.filter((c) => c === "stop")).toEqual(["stop"]);
    expect(await homeKey()).toMatchObject({ spending_off: 1, state: "stopped" });
  });

  it("(c) a Stop write that throws is logged, not retried in the same sweep, left unstamped, and retried by the next sweep", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { calls, client } = recordingClient();
    await owner();
    await offActive();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await env.DB.prepare(`CREATE TRIGGER repair_stop_fails BEFORE INSERT ON flux_home_ops WHEN NEW.kind='stop'
        BEGIN SELECT RAISE(ABORT, 'injected stop insert failure'); END`).run();
      try {
        await sweepFlux(testEnv(), { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
      } finally {
        await env.DB.prepare("DROP TRIGGER IF EXISTS repair_stop_fails").run();
      }
      const logged = errorsLike(errors, "flux spending off repair: writing the Stop failed");
      expect(logged).toHaveLength(1); // one try in this sweep: no inline retry
      expect(JSON.parse(logged[0])).toMatchObject({ homeId: HOME });
      expect(await homeKey()).toMatchObject({ spending_off: 1, state: "active" });
      expect(await allOps()).toEqual([]);
      expect(await checkedAt()).toBeNull(); // not stamped: the next sweep picks it up, not 15 minutes later
      expect(calls).toEqual([]);
      await sweepFlux(testEnv(), { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock + 5 * 60_000 });
      expect(await homeKey()).toMatchObject({ spending_off: 1, state: "stopped" });
      expect(await allOps()).toEqual([{ kind: "stop", state: "done" }]);
      expect(calls).toEqual(["stop", "status"]); // 8b fix r1 (Astra H2): the stopped-live repair reads the stopped home's status; nothing live
      expect(errorsLike(errors, "flux spending off repair")).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("cap OFF: a Stop send that fails after the commit is logged", async () => {
    envOver = { FLUX_CLOUD_GRANTS_TOKEN: undefined };
    const { client, down } = flakyStopClient();
    const worker = workerWith({ fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    const { token } = await owner();
    await activeKey();
    down.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const off = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, token, { enabled: false });
      expect([off.status, await off.json()]).toEqual([200, { capUsd: 0, enabled: false, pending: true }]);
      const logged = errorsLike(errors, "flux cap off: sending the Stop failed");
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0])).toEqual({ message: "flux cap off: sending the Stop failed, the sweep sends it", homeId: HOME });
    } finally {
      errors.mockRestore();
    }
  });
});

describe("PRODFLUX r3 (4'): a billing Stop with the service token absent is journaled, not counted, and goes out once the token is back", () => {
  it("stopForBilling answers stopping with attempts 0; the sweep sends it once when the token returns", async () => {
    envOver = { FLUX_CLOUD_SERVICE_TOKEN: undefined };
    const { calls, client } = recordingClient();
    const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    await owner();
    expect(await stopForBilling(testEnv(), HOME, deps)).toEqual({ state: "stopping", opId: expect.any(String) });
    expect(await stopForBilling(testEnv(), HOME, deps)).toEqual({ state: "stopping", opId: expect.any(String) }); // a repeat is still pending, never "failed"
    expect(calls).toEqual([]);
    expect(await stopOps()).toMatchObject({ maxAttempts: 0, held: 1 });
    expect((await stopOps())!.open).toBeGreaterThan(0);
    expect((await env.DB.prepare("SELECT billing_hold FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ billing_hold: number }>())!.billing_hold).toBe(1);
    await sweepFlux(testEnv(), deps);
    expect(calls).toEqual([]);
    expect((await env.DB.prepare("SELECT MAX(attempts) AS a FROM flux_home_ops WHERE home_id=?").bind(HOME).first<{ a: number }>())!.a).toBe(0);
    envOver = {};
    await sweepFlux(testEnv(), { ...deps, now: () => clock + 10 * 60_000 });
    expect(calls.filter((c) => c === "stop").length).toBeGreaterThan(0);
    expect((await openOps()).results).toEqual([]);
  });
});

describe("PRODFLUX r4 D: the token-absent pages resolve on the healthy sweep", () => {
  it.each([["FLUX_CLOUD_SERVICE_TOKEN", "flux_service_token_absent"], ["FLUX_CLOUD_GRANTS_TOKEN", "grants_token_absent"]])(
    "%s missing raises the page; both set again resolves it (resolve notice due); missing again opens it again", async (secret, code) => {
      const page = () => env.DB.prepare("SELECT resolved_at,resolve_notice_due FROM cloud_alerts WHERE id=?").bind(`alert:credit.${code}`)
        .first<{ resolved_at: number | null; resolve_notice_due: number | null }>();
      const { client } = recordingClient();
      const deps = { fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock };
      envOver = { [secret]: undefined };
      await sweepFlux(testEnv(), deps);
      expect(await page()).toEqual({ resolved_at: null, resolve_notice_due: null });
      envOver = {};
      await sweepFlux(testEnv(), { ...deps, now: () => clock + 60_000 });
      expect(await page()).toEqual({ resolved_at: clock + 60_000, resolve_notice_due: 1 });
      envOver = { [secret]: undefined };
      await sweepFlux(testEnv(), { ...deps, now: () => clock + 120_000 });
      expect(await page()).toMatchObject({ resolved_at: null });
      await env.DB.prepare("DELETE FROM cloud_alerts").run();
    });
});

describe("PRODFLUX r3 (5): a COMPLETE production fixture stays healthy and runs a durable billing pass with each Flux secret removed in turn", () => {
  // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
  const RAW = import.meta.glob("../wrangler.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const prod = (): Record<string, any> => JSON.parse((Object.values(RAW)[0] as string).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")).env.production;
  const long = (c: string) => `${c}`.repeat(48);
  async function fixture(): Promise<Record<string, unknown>> {
    const p = prod();
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    // Every secret production requires, each with a value of its real shape (never a real value).
    const secrets: Record<string, string> = {
      BETTER_AUTH_SECRET: long("b"), CLOUDFLARE_API_TOKEN: `cfat_${long("c")}`, SENDLANE_API_KEY: long("l"), SENDLANE_HASH_KEY: long("h"),
      CLOUD_ADMIN_TOKEN: ADMIN, CHECKOUT_DISCLOSURE_TOKEN_SECRET: long("d"), CANCELLATION_MAIL_KEY: long("m"), NOTICE_MAIL_KEY: long("n"),
      REFUND_KEY_SECRET: long("r"), STRIPE_SECRET_KEY: `sk_live_${"x".repeat(32)}`, STRIPE_WEBHOOK_SECRET: `whsec_${"w".repeat(32)}`,
      CLOUD_HOME_API_TOKEN: long("t"), AWS_ACCESS_KEY_ID: `AKIA${"A".repeat(16)}`, AWS_SECRET_ACCESS_KEY: long("a"), HCLOUD_TOKEN: long("z"),
      STORAGEBOX_API_TOKEN: long("q"), STORAGEBOX_MAIN_PASSWORD: long("p"), CLOUD_B3_SIGNING_JWK: JSON.stringify(jwk),
      SUPABASE_URL: supabaseEnv.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: supabaseEnv.SUPABASE_PUBLISHABLE_KEY,
      FIRSTPROMOTER_API_KEY: long("f"), FIRSTPROMOTER_ACCOUNT_ID: "acct123", FLUX_CLOUD_SERVICE_TOKEN: SERVICE_TOKEN, FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40),
    };
    // Production ships Flux off (ch1-g2d); this fixture is the Flux-ON production (the switch-on commit): the shipped list plus the two Flux secrets.
    expect(Object.keys(secrets).sort()).toEqual([...p.secrets.required, ...PRODUCTION_FLUX_SECRETS].sort()); // complete: shipped list + Flux secrets
    // The bindings the Worker runs with (D1, limiters, mail, services), minus anything production forbids.
    const bindings = Object.fromEntries(Object.entries(env as unknown as Record<string, unknown>)
      .filter(([k, v]) => typeof v === "object" && v !== null && !["MAIL_SINK", "STAGING_MAIL_SINK", "TEST_MIGRATIONS"].includes(k)));
    return { ...bindings, DB: env.DB, ...p.vars, [FLUX_SWITCH_VAR]: "1", MURAGE_ENV: "live", STRIPE_ALLOW_LIVE: "1", ...secrets };
  }
  const ctxOf = () => {
    const work: Promise<unknown>[] = [];
    return { work, ctx: { waitUntil(q: Promise<unknown>) { work.push(Promise.resolve(q).catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext };
  };
  const health = async (vars: Record<string, unknown>) => {
    const { ctx } = ctxOf();
    const res = await createWorker().fetch(new Request("https://cp.test/healthz"), vars as unknown as Env, ctx);
    return [res.status, await res.json()];
  };
  /** One five-minute scheduled run of the real Worker: every registered piece of work awaited (including continuations it registers). */
  const scheduled = async (vars: Record<string, unknown>) => {
    const { work, ctx } = ctxOf();
    createWorker().scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, vars as unknown as Env, ctx);
    for (let i = 0; i < work.length; i++) await work[i];
  };
  const seedRevoke = async (id: string) => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(HOME, `inst-${HOME}`, "owner-prod-fixture", now, now),
      env.DB.prepare(`INSERT OR IGNORE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at) VALUES (?,'starter',1,'active',30000000,0,?)`).bind(HOME, now),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,?,'external_revoke_required',?,?)")
        .bind(id, HOME, "owner-prod-fixture", JSON.stringify({ flux: true }), now),
    ]);
  };
  const receipt = async (id: string) => {
    const r = await env.DB.prepare("SELECT completed_at,receipt FROM cloud_outbox WHERE id=?").bind(id).first<{ completed_at: number | null; receipt: string | null }>();
    return r?.completed_at == null ? null : JSON.parse(r.receipt!);
  };

  it("both secrets set: envPolicy clean, /healthz 200", async () => {
    const vars = await fixture();
    expect(envPolicy(vars as Record<string, string | undefined>).problems).toEqual([]);
    expect(await health(vars)).toEqual([200, { ok: true, service: "murage-control-plane" }]);
  });

  it.each([
    ["FLUX_CLOUD_SERVICE_TOKEN", { fluxStopped: false, fluxState: "stopping" }, 0],
    ["FLUX_CLOUD_GRANTS_TOKEN", { fluxStopped: true }, 1],
  ] as [string, Record<string, unknown>, number][])("%s removed: /healthz 200 and the scheduled billing pass completes the cancellation Stop (receipt from its state)", async (secret, want, sends) => {
    const vars = { ...(await fixture()), [secret]: undefined };
    expect(await health(vars)).toEqual([200, { ok: true, service: "murage-control-plane" }]);
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      sent.push(url);
      // Production Flux answers a key revoke; every other provider is down (its sweep fails in isolation, retried next run).
      return url === "https://api.fluxrouter.ai/internal/cloud-home/subkeys/revoke" ? Response.json({}) : new Response("{}", { status: 503 });
    }) as typeof fetch;
    await seedRevoke(`rv-prod-${secret}`);
    await scheduled(vars);
    expect(await receipt(`rv-prod-${secret}`)).toEqual(want);
    // The Stop is journaled either way; it went out only where the service token is set, and nothing that issues was sent.
    expect(sent.filter((u) => u.startsWith("https://api.fluxrouter.ai/internal/cloud-home/subkeys/revoke")).length).toBe(sends);
    // 8b fix r1 (Astra H2): besides the revoke, the one router call is the stopped home's status read (the stopped-live repair), never an issue.
    expect(sent.filter((u) => u.startsWith("https://api.fluxrouter.ai") && !u.endsWith("/subkeys/revoke")
      && u !== `https://api.fluxrouter.ai/internal/cloud-home/homes/${HOME}/status`)).toEqual([]);
    expect(sent.filter((u) => u.endsWith(`/homes/${HOME}/status`)).length).toBe(sends);
    expect(await env.DB.prepare("SELECT state,attempts FROM flux_home_ops WHERE home_id=? AND kind='stop' ORDER BY seq DESC LIMIT 1").bind(HOME).first())
      .toEqual(sends ? { state: "done", attempts: 0 } : { state: "queued", attempts: 0 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL")
      .bind(`credit.${secret === "FLUX_CLOUD_SERVICE_TOKEN" ? "flux_service_token_absent" : "grants_token_absent"}`).first<{ n: number }>())!.n).toBe(1);
    envFluxHooks.mode.on = false;
  });
});

// ---- ITEM8-CAPOFF-STEPUP-GUARD (MurageMain 11-03): the integrated head keeps item 2's fluxCapStepUpExempt -------------------------------------
// Switched on with real (non-stub) hooks, fluxSwitchedOnLive refuses any step-up exemption for cap OFF and Stop, in every readiness state. A
// sign-in-only cap OFF gets 403 step_up_required with the spending-off prompt (SPENDING_OFF_STEP_UP_WORDS); a sign-in-only Stop gets 403
// step_up_required. Nothing is written, queued or sent. Proven to fail with the fluxSwitchedOnLive line removed from fluxCapStepUpExempt.
describe("ITEM8-CAPOFF-STEPUP-GUARD: switched on with real hooks, cap OFF and Stop are never step-up exempt", () => {
  it.each(READINESS)("%s: sign-in only, cap OFF (both bodies) gets 403 with the spending-off words and Stop gets 403", async (_name, over) => {
    envOver = over;
    const { calls, client } = recordingClient();
    const worker = workerWith({ fluxClient: () => client, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    const { signIn } = await owner();
    for (const body of [{ enabled: false }, { capUsd: 0 }]) {
      const r = await call(worker, "POST", `/v1/homes/${HOME}/flux/cap`, signIn, body);
      expect([body, r.status, await r.json<Record<string, unknown>>()])
        .toEqual([body, 403, expect.objectContaining({ error: "step_up_required", message: SPENDING_OFF_STEP_UP_WORDS })]);
    }
    const stop = await call(worker, "POST", `/v1/homes/${HOME}/flux/stop`, signIn, {});
    expect([stop.status, (await stop.json<{ error?: string }>()).error]).toEqual([403, "step_up_required"]);
    expect(calls).toEqual([]);
    expect((await openOps()).results).toEqual([]);
    expect((await keyRow())!.spending_off).toBe(0);
  });
});
