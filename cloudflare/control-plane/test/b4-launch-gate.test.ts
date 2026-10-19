// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-1 #7: the B4 launch gate. With the Flux switch, token and URL configured but the billing hooks a STUB (no router
// capability), NOTHING reaches the router from any of the five dispatch sites; the work stays journaled and a deduped
// flux.pending_capability alert is raised. Qualified hooks open the gate. A source scan holds that b4RouterClient is the only place
// that builds or reads a router client.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { changePlan, sweepFlux, stopForBilling, type FluxClient, type FluxDependencies } from "../src/b4-flux";
import { stubFluxHooks } from "../src/b5-billing";
import { createWorker } from "../src/index";
import { authFetch, cloudMember, jwksFetch, supabaseEnv, supabaseToken } from "./cloud-member";

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
}) as Env;

function workerWith(deps: FluxDependencies) {
  return createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch: fluxAuthFetch }, {}, deps);
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
  return { token, userId: member.userId };
}
const queueOp = (opId: string, kind: string) => env.DB.prepare(
  "INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,attempts,created_at,updated_at) VALUES (?,?,?,?,'{}','queued',0,?,?)")
  .bind(opId, HOME, Math.floor(Math.random() * 1e6), kind, clock, clock).run();
const alertRows = () => env.DB.prepare("SELECT id FROM cloud_alerts WHERE home_id=? AND kind='flux.pending_capability'").bind(HOME).all<{ id: string }>();
const openOps = () => env.DB.prepare("SELECT op_id,state FROM flux_home_ops WHERE home_id=? AND state IN ('queued','running')").bind(HOME).all<{ op_id: string; state: string }>();

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe.each([
  ["no billingFlux (absent)", {}],
  ["stubFluxHooks", { billingFlux: stubFluxHooks }],
] as [string, Partial<FluxDependencies>][])("B4 launch gate closed: %s", (_name, hooks) => {
  it("owner cap, Stop and subkey routes send nothing, keep the work and raise the alert", async () => {
    const { calls, client } = recordingClient();
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { sent.push(String(input instanceof Request ? input.url : input)); return new Response("{}"); }) as typeof fetch;
    const worker = workerWith({ fluxClient: () => client, now: () => clock, ...hooks });
    const { token } = await owner();
    await call(worker, "POST", `/v1/homes/${HOME}/flux/subkey`, token, {});
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

describe("INTEGRATED-10 Flux-off gate: the deployed configuration", () => {
  // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
  const RAW = import.meta.glob("../wrangler.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  it("INTEGRATED-10 neither production nor staging switches Flux on or requires its token: the gate (fluxOn) stays closed at launch", () => {
    const text = Object.values(RAW)[0];
    expect(text).toBeTruthy();
    const code = text.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
    expect(code).not.toMatch(/"CLOUD_FLUX_ROUTES_ENABLED"\s*:/);
    expect(code).not.toMatch(/"FLUX_CLOUD_SERVICE_TOKEN"/);
  });
});
