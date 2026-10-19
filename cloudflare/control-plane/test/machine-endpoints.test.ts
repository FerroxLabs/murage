// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudflareAPI, MANAGED_CLOUD_HOME_ORIGIN_URL, MANAGED_COMPANION_ORIGIN_URL, type CloudflareFetch } from "../src/cloudflare-api";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { PROVISION_MAX_MS } from "../src/b3-control";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const KEK = btoa("x".repeat(32));
const IP = "203.0.113.10";
const IMAGE = `sha256:${"a".repeat(64)}`;
const CONNECTOR_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-only-machine-connector-token.signature";
const HOME_ACCOUNT = "a".repeat(32);
const HOME_ZONE = "b".repeat(32);
const HOME_TOKEN = "test-only-cloud-home-api-token-no-real-access";
const HOME_SUFFIX = "homes.example.test";
const HOME_VARS = {
  CLOUD_HOME_HOST_SUFFIX: HOME_SUFFIX, CLOUD_HOME_ZONE_ID: HOME_ZONE,
  CLOUD_HOME_ACCOUNT_ID: HOME_ACCOUNT, CLOUD_HOME_API_TOKEN: HOME_TOKEN,
};
// Machine endpoints are on their own domain, never the companion one.
const SUFFIX = () => HOME_SUFFIX;
let homeOverride: Record<string, string> = HOME_VARS;
const noNetwork = async () => { throw new Error("attempted network transport"); };
let signingJwk: JsonWebKey;

function jsonResult(result: unknown, status = 200): Response {
  return Response.json({ errors: [], messages: [], result, success: true }, { status });
}
function jsonNotFound(): Response {
  return Response.json({ errors: [{ code: 1_003, message: "not found" }], messages: [], result: null, success: false }, { status: 404 });
}

interface FakeTunnel { id: string; name: string }
interface FakeDNS { content: string; id: string; name: string; proxied: boolean; type: string }

/** Fake Cloudflare API, same wire shapes as the desktop endpoint tests use. */
class FakeCloudflare {
  readonly calls: Array<{ authorization: string | null; body: unknown; method: string; url: string }> = [];
  readonly configurations = new Map<string, unknown>();
  readonly dns = new Map<string, FakeDNS>();
  readonly failures = new Set<string>();
  readonly tunnels = new Map<string, FakeTunnel>();
  /** Number of secret rolls per tunnel id; the issued connector token embeds it. */
  readonly rolls = new Map<string, number>();
  private counter = 1;
  private gate: { operation: string; wait: Promise<void>; entered: () => void } | null = null;

  /** Pauses the next call of `operation` until `release()`; `entered` resolves when it is reached. */
  pauseNext(operation: string): { entered: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { operation, wait, entered: markEntered };
    return { entered, release };
  }

  private async before(operation: string): Promise<Response | null> {
    if (this.gate?.operation === operation) {
      const gate = this.gate;
      this.gate = null;
      gate.entered();
      await gate.wait;
    }
    if (this.failures.has(operation)) {
      return Response.json({ errors: [{ code: 10_000, message: "boom" }], messages: [], result: null, success: false }, { status: 500 });
    }
    return null;
  }

  readonly fetch: CloudflareFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    this.calls.push({ authorization: new Headers(init.headers).get("authorization"), body, method, url: url.toString() });
    const named = body as { name?: string; content?: string; config?: unknown } | null;

    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel")) {
      const failed = await this.before("list_tunnels");
      if (failed) return failed;
      const tunnel = this.tunnels.get(url.searchParams.get("name") ?? "");
      return jsonResult(tunnel ? [{ ...tunnel, config_src: "cloudflare", deleted_at: null }] : []);
    }
    if (method === "GET" && /\/cfd_tunnel\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      const tunnel = [...this.tunnels.values()].find((candidate) => candidate.id === id);
      return tunnel ? jsonResult({ ...tunnel, config_src: "cloudflare", deleted_at: null }) : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/cfd_tunnel")) {
      const tunnel = { id: `10000000-0000-4000-8000-${(this.counter++).toString(16).padStart(12, "0")}`, name: named?.name ?? "" };
      this.tunnels.set(tunnel.name, tunnel);
      return jsonResult({ ...tunnel, config_src: "cloudflare", deleted_at: null });
    }
    if (method === "PATCH" && /\/cfd_tunnel\/[^/]+$/.test(url.pathname)) {
      const failed = await this.before("roll_tunnel");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1) ?? "";
      const tunnel = [...this.tunnels.values()].find((candidate) => candidate.id === id);
      if (!tunnel || typeof (body as { tunnel_secret?: unknown } | null)?.tunnel_secret !== "string") return jsonNotFound();
      this.rolls.set(id, (this.rolls.get(id) ?? 0) + 1);
      return jsonResult({ ...tunnel, config_src: "cloudflare", deleted_at: null });
    }
    if (method === "PUT" && url.pathname.endsWith("/configurations")) {
      this.configurations.set(url.pathname.split("/").at(-2) ?? "", body);
      return jsonResult({ config: named?.config });
    }
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const record = this.dns.get(url.searchParams.get("name.exact") ?? "");
      return jsonResult(record ? [record] : []);
    }
    if (method === "GET" && url.pathname.includes("/dns_records/")) {
      const id = url.pathname.split("/").at(-1);
      const record = [...this.dns.values()].find((candidate) => candidate.id === id);
      return record ? jsonResult(record) : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      const record: FakeDNS = { content: named?.content ?? "", id: `dns-${this.counter++}`, name: named?.name ?? "", proxied: true, type: "CNAME" };
      this.dns.set(record.name, record);
      return jsonResult(record);
    }
    if (method === "GET" && url.pathname.endsWith("/token")) {
      const failed = await this.before("get_token");
      if (failed) return failed;
      const rolls = this.rolls.get(url.pathname.split("/").at(-2) ?? "") ?? 0;
      return jsonResult(rolls === 0 ? CONNECTOR_TOKEN : `${CONNECTOR_TOKEN}.roll${rolls}`);
    }
    if (method === "DELETE" && url.pathname.includes("/dns_records/")) {
      const failed = await this.before("delete_dns");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, record] of this.dns) if (record.id === id) this.dns.delete(name);
      return Response.json({ result: { id } });
    }
    if (method === "DELETE" && url.pathname.includes("/cfd_tunnel/")) {
      const failed = await this.before("delete_tunnel");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, tunnel] of this.tunnels) if (tunnel.id === id) this.tunnels.delete(name);
      return jsonResult({ id });
    }
    throw new Error(`unexpected Cloudflare request: ${method} ${url.pathname}`);
  };
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
});

const b3Config = {
  reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "hel-available", projectId: "project-2", location: "hel1", serverType: "cpx32", outcome: "available" }],
};
/** The per-IP edge limiters are real workerd bindings that outlive a test; the round 8c journeys (many enrolments from one IP) run without them. */
let edgeLimits = true;
function testEnv(b3 = false): Env {
  return { ...env, ...homeOverride, ...(edgeLimits ? {} : { MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }), CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: "1", CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk),
    ...(b3 ? { CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(b3Config) } : {}) } as Env;
}

async function call(cloudflare: FakeCloudflare, method: string, path: string, options: {
  b3?: boolean; body?: unknown; ip?: string; token?: string; provider?: (db: D1Database) => ProviderAdapter; db?: D1Database;
} = {}) {
  const headers = new Headers({ "CF-Connecting-IP": options.ip ?? IP });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const ctx = createExecutionContext();
  const response = await createWorker(cloudflare.fetch, noNetwork, options.provider ? { provider: options.provider } : {}).fetch(new Request(`https://admin.murage.test${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), { ...testEnv(options.b3), ...(options.db ? { DB: options.db } : {}) } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Wrap a D1 binding so a test can act just before the FIRST statement or batch whose SQL matches (one-shot): it chooses the moment
 *  another pass runs; everything runs through the real functions. */
function hookDb(db: D1Database, match: RegExp, before: () => Promise<void>): D1Database {
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  let fired = false;
  const around = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    if (!fired && match.test(sql)) { fired = true; await before(); }
    return run();
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, {
    get(target, prop) {
      if (prop === "__real") return target;
      if (prop === "__sql") return sql;
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return (...args: unknown[]) => around(sql, async () => (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args));
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (statements: Stmt[]) => around(statements.map((s) => s.__sql ?? "").join(";\n"), () => target.batch(statements.map((s) => s.__real ?? s)));
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function sweep(cloudflare: FakeCloudflare, b3 = false) {
  const ctx = createExecutionContext();
  await createWorker(cloudflare.fetch, noNetwork).scheduled(
    createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() }), testEnv(b3), ctx);
  await waitOnExecutionContext(ctx);
}

interface Created { machineId: string; enrollmentToken: string; generation: number; publicOrigin?: string; hostname?: string }
async function createMachine(cloudflare: FakeCloudflare, homeId: string, extra: Record<string, unknown> = { managed_endpoint: true }) {
  return call(cloudflare, "POST", "/v1/machines", { token: ADMIN,
    body: { homeId, serverId: "server-1", boundIps: [IP], ...extra } });
}
async function enrol(cloudflare: FakeCloudflare, id: string, token: string) {
  const response = await call(cloudflare, "POST", `/v1/machines/${id}/enroll`, { body: { token } });
  expect(response.status).toBe(200);
  return response.json<{ machineCredential: string; publicOrigin: string; generation: number }>();
}
/** A managed machine, enrolled and holding its credential. */
async function managedMachine(cloudflare: FakeCloudflare, homeId = "mhome-1") {
  const response = await createMachine(cloudflare, homeId);
  expect(response.status).toBe(201);
  const created = await response.json<Created>();
  const enrolled = await enrol(cloudflare, homeId, created.enrollmentToken);
  return { created, credential: enrolled.machineCredential, enrolled };
}
const provision = (cloudflare: FakeCloudflare, id: string, credential: string, generation = 1, ip = IP) =>
  call(cloudflare, "POST", `/v1/machines/${id}/endpoint`, { body: { generation }, token: credential, ip });
const endpointRowFor = (id: string) => env.DB.prepare("SELECT * FROM machine_endpoints WHERE machine_id=?").bind(id).first<Record<string, unknown>>();

beforeEach(() => { homeOverride = HOME_VARS; });

describe("cloud-home domain configuration", () => {
  it("uses the cloud-home account, zone, token and suffix for machine endpoints, never the desktop ones", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential } = await managedMachine(cloudflare);
    expect(created.hostname?.endsWith(`.${HOME_SUFFIX}`)).toBe(true);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    expect(cloudflare.calls.length).toBeGreaterThan(0);
    for (const entry of cloudflare.calls) {
      expect(entry.authorization).toBe(`Bearer ${HOME_TOKEN}`);
      expect(entry.url).not.toContain(env.CLOUDFLARE_ACCOUNT_ID);
      expect(entry.url).not.toContain(env.CLOUDFLARE_ZONE_ID);
      expect(entry.url.includes(`/accounts/${HOME_ACCOUNT}/`) || entry.url.includes(`/zones/${HOME_ZONE}/`)).toBe(true);
    }
    expect(cloudflare.calls.some((entry) => entry.url.includes(`/accounts/${HOME_ACCOUNT}/`))).toBe(true);
    expect(cloudflare.calls.some((entry) => entry.url.includes(`/zones/${HOME_ZONE}/`))).toBe(true);
    // Cleanup uses the same cloud-home credentials.
    await env.DB.prepare("UPDATE cloud_machines SET state='fenced' WHERE id='mhome-1'").run();
    const before = cloudflare.calls.length;
    await sweep(cloudflare);
    const cleanup = cloudflare.calls.slice(before);
    expect(cleanup.length).toBeGreaterThan(0);
    for (const entry of cleanup) expect(entry.authorization).toBe(`Bearer ${HOME_TOKEN}`);
  });

  it("refuses managed_endpoint creation with 503 when none of the four are set, and creates nothing", async () => {
    homeOverride = { CLOUD_HOME_HOST_SUFFIX: "", CLOUD_HOME_ZONE_ID: "", CLOUD_HOME_ACCOUNT_ID: "", CLOUD_HOME_API_TOKEN: "" };
    const cloudflare = new FakeCloudflare();
    const response = await createMachine(cloudflare, "off-1");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("cloud_home_endpoints_disabled");
    expect(await env.DB.prepare("SELECT id FROM cloud_machines WHERE id='off-1'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT machine_id FROM machine_endpoints").first()).toBeNull();
    // A machine with its own origin is unaffected.
    expect((await createMachine(cloudflare, "off-2", { publicOrigin: "https://home.murage.test" })).status).toBe(201);
    expect(cloudflare.calls).toHaveLength(0);
  });

  for (const missing of Object.keys(HOME_VARS)) {
    it(`fails closed with 503 when only ${missing} is missing (partial set)`, async () => {
      const cloudflare = new FakeCloudflare();
      const { credential } = await managedMachine(cloudflare);
      homeOverride = { ...HOME_VARS, [missing]: "" };
      const created = await createMachine(cloudflare, "partial-1");
      expect(created.status).toBe(503);
      expect(await created.text()).toContain("cloud_home_endpoints_misconfigured");
      expect(await env.DB.prepare("SELECT id FROM cloud_machines WHERE id='partial-1'").first()).toBeNull();
      const provisioned = await provision(cloudflare, "mhome-1", credential);
      expect(provisioned.status).toBe(503);
      expect(await provisioned.text()).toContain("cloud_home_endpoints_misconfigured");
      expect(cloudflare.calls).toHaveLength(0);
    });
  }

  it("treats an invalid suffix as misconfigured and never falls back to the desktop zone", async () => {
    homeOverride = { ...HOME_VARS, CLOUD_HOME_HOST_SUFFIX: "Homes.Example.Test" };
    const cloudflare = new FakeCloudflare();
    const response = await createMachine(cloudflare, "bad-suffix");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("cloud_home_endpoints_misconfigured");
    expect(cloudflare.calls).toHaveLength(0);
  });
});

describe("managed endpoint hostname allocation", () => {
  it("allocates h-<32 hex> at creation, derives public_origin from it, and never changes it", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential, enrolled } = await managedMachine(cloudflare);
    expect(created.hostname).toMatch(/^h-[0-9a-f]{32}\./);
    expect(created.hostname?.slice(35)).toBe(SUFFIX());
    expect(created.publicOrigin).toBe(`https://${created.hostname}`);
    expect(enrolled.publicOrigin).toBe(created.publicOrigin);
    const machine = await env.DB.prepare("SELECT public_origin FROM cloud_machines WHERE id='mhome-1'").first<{ public_origin: string }>();
    expect(machine?.public_origin).toBe(created.publicOrigin);
    const before = await endpointRowFor("mhome-1");
    expect(before).toMatchObject({ hostname: created.hostname, status: "pending", tunnel_id: null });

    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    // Rotation, re-enrolment and further reconciles keep the hostname, tunnel name and origin.
    const rotated = await (await call(cloudflare, "POST", "/v1/machines/mhome-1/rotate", { token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string; generation: number }>();
    const second = await enrol(cloudflare, "mhome-1", rotated.enrollmentToken);
    expect(second.publicOrigin).toBe(created.publicOrigin);
    expect((await provision(cloudflare, "mhome-1", second.machineCredential, 2)).status).toBe(200);
    const after = await endpointRowFor("mhome-1");
    expect(after).toMatchObject({ hostname: before?.hostname, tunnel_name: before?.tunnel_name });
    expect((await env.DB.prepare("SELECT public_origin FROM cloud_machines WHERE id='mhome-1'").first<{ public_origin: string }>())?.public_origin)
      .toBe(created.publicOrigin);
  });

  it("rejects managed_endpoint together with a caller public_origin, and missing both, with 400", async () => {
    const cloudflare = new FakeCloudflare();
    const both = await createMachine(cloudflare, "both", { managed_endpoint: true, publicOrigin: "https://home.murage.test" });
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({ error: "invalid_request" });
    expect((await createMachine(cloudflare, "neither", {})).status).toBe(400);
    expect((await createMachine(cloudflare, "false-neither", { managed_endpoint: false })).status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM cloud_machines WHERE id IN ('both','neither','false-neither')").first()).toBeNull();
    expect(await env.DB.prepare("SELECT machine_id FROM machine_endpoints").first()).toBeNull();
  });

  it("without the flag behaves as before: caller origin, no endpoint row, endpoint route 404", async () => {
    const cloudflare = new FakeCloudflare();
    const response = await createMachine(cloudflare, "plain", { publicOrigin: "https://plain.murage.test" });
    expect(response.status).toBe(201);
    expect(Object.keys(await response.json<object>()).sort()).toEqual(["enrollmentToken", "generation", "homeId", "machineId"]);
    expect(await endpointRowFor("plain")).toBeNull();
    // Rotation is the only way to a second enrolment token; it bumps the generation to 2.
    const rotated = await (await call(cloudflare, "POST", "/v1/machines/plain/rotate", { token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string }>();
    const enrolled = await enrol(cloudflare, "plain", rotated.enrollmentToken);
    expect(enrolled.publicOrigin).toBe("https://plain.murage.test");
    expect((await provision(cloudflare, "plain", enrolled.machineCredential, 2)).status).toBe(404);
    expect(cloudflare.calls).toHaveLength(0);
  });
});

describe("machine endpoint route authentication", () => {
  it("refuses a wrong credential, a missing credential, a wrong source IP and a wrong generation, with no provider call", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    expect((await provision(cloudflare, "mhome-1", "wrong-credential")).status).toBe(401);
    expect((await call(cloudflare, "POST", "/v1/machines/mhome-1/endpoint", { body: { generation: 1 } })).status).toBe(401);
    expect((await call(cloudflare, "GET", "/v1/machines/mhome-1/endpoint")).status).toBe(401);
    expect((await provision(cloudflare, "mhome-1", credential, 1, "198.51.100.7")).status).toBe(403);
    expect((await call(cloudflare, "GET", "/v1/machines/mhome-1/endpoint", { token: credential, ip: "198.51.100.7" })).status).toBe(403);
    const stale = await provision(cloudflare, "mhome-1", credential, 2);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_generation" });
    expect((await call(cloudflare, "POST", "/v1/machines/mhome-1/endpoint", { body: {}, token: credential })).status).toBe(400);
    expect((await provision(cloudflare, "unknown-machine", credential)).status).toBe(401);
    expect(cloudflare.calls).toHaveLength(0);
  });

  it("an installation or account style bearer cannot read or provision, and the old credential dies on rotation", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    const installationShaped = `murage_install_${"a".repeat(22)}.${"b".repeat(43)}`;
    expect((await provision(cloudflare, "mhome-1", installationShaped)).status).toBe(401);
    expect((await call(cloudflare, "POST", "/v1/machines/mhome-1/endpoint", { token: ADMIN, body: { generation: 1 } })).status).toBe(401);
    await call(cloudflare, "POST", "/v1/machines/mhome-1/rotate", { token: ADMIN, body: {} });
    expect((await provision(cloudflare, "mhome-1", credential, 1)).status).toBe(401);
    expect(cloudflare.calls).toHaveLength(0);
  });

  it("a machine whose state forbids service is told so and never gets a connector token", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    await env.DB.prepare("UPDATE cloud_machines SET state='fenced' WHERE id='mhome-1'").run();
    const response = await provision(cloudflare, "mhome-1", credential);
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("home_inactive");
    expect(text).not.toContain(CONNECTOR_TOKEN);
    expect(cloudflare.calls).toHaveLength(0);
    expect((await endpointRowFor("mhome-1"))?.status).toBe("pending");
  });
});

describe("machine endpoint provisioning", () => {
  it("creates the tunnel, a proxied CNAME and ingress to the cloud-home origin, and returns the token", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential } = await managedMachine(cloudflare);
    const response = await provision(cloudflare, "mhome-1", credential);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json<{ connectorToken: string; endpoint: { generation: number; hostname: string; status: string; url: string } }>();
    expect(payload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(payload.endpoint).toMatchObject({ hostname: created.hostname, url: created.publicOrigin, status: "ready", generation: 1 });
    const tunnel = [...cloudflare.tunnels.values()][0];
    if (!tunnel) throw new Error("fake tunnel missing");
    expect(tunnel.name).toMatch(/^murage-h-[0-9a-f]{32}$/);
    expect(tunnel.name.slice("murage-".length)).toBe((created.hostname as string).split(".")[0]);
    expect(MANAGED_CLOUD_HOME_ORIGIN_URL).toBe("http://127.0.0.1:8830");
    expect(cloudflare.configurations.get(tunnel.id)).toEqual({
      config: { ingress: [{ hostname: created.hostname, service: "http://127.0.0.1:8830" }, { service: "http_status:404" }] },
    });
    expect(cloudflare.dns.get(created.hostname as string)).toMatchObject({ content: `${tunnel.id}.cfargotunnel.com`, proxied: true, type: "CNAME" });
    const stored = await endpointRowFor("mhome-1");
    expect(stored).toMatchObject({ status: "ready", tunnel_id: tunnel.id });
    expect(JSON.stringify(stored)).not.toContain(CONNECTOR_TOKEN);

    // Idempotent: a second reconcile adopts the same resources and bumps only the endpoint generation.
    const again = await provision(cloudflare, "mhome-1", credential);
    expect(again.status).toBe(200);
    expect((await again.json<{ endpoint: { generation: number } }>()).endpoint.generation).toBe(2);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);

    // Status read: authenticated, no token.
    const status = await call(cloudflare, "GET", "/v1/machines/mhome-1/endpoint", { token: credential });
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain(CONNECTOR_TOKEN);
    expect(JSON.parse(statusText)).toMatchObject({ endpoint: { hostname: created.hostname, status: "ready" } });
    expect((await call(cloudflare, "GET", "/v1/machines/mhome-1/endpoint?generation=9", { token: credential })).status).toBe(409);
  });

  it("verifies the ingress read-back against the kind's own origin", async () => {
    const config = readConfig(env).cloudflare;
    const echo = (service: string): CloudflareFetch => async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { config: { ingress: Array<{ hostname?: string; service: string }> } };
      const ingress = body.config.ingress.map((rule) => (rule.hostname ? { ...rule, service } : rule));
      return jsonResult({ config: { ingress } });
    };
    // Desktop keeps 8812; a different value read back is refused for each kind.
    await expect(new CloudflareAPI(config, echo(MANAGED_COMPANION_ORIGIN_URL))
      .configureTunnel("t", "h.example", MANAGED_COMPANION_ORIGIN_URL)).resolves.toBeUndefined();
    await expect(new CloudflareAPI(config, echo(MANAGED_COMPANION_ORIGIN_URL))
      .configureTunnel("t", "h.example", MANAGED_CLOUD_HOME_ORIGIN_URL)).rejects.toMatchObject({ code: "cf_invalid_response" });
    await expect(new CloudflareAPI(config, echo(MANAGED_CLOUD_HOME_ORIGIN_URL))
      .configureTunnel("t", "h.example", MANAGED_COMPANION_ORIGIN_URL)).rejects.toMatchObject({ code: "cf_invalid_response" });
    expect(MANAGED_COMPANION_ORIGIN_URL).toBe("http://127.0.0.1:8812");
  });

  it("withholds the token when the credential rotates mid-flight, then adopts the resources for the new credential", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    const paused = cloudflare.pauseNext("get_token");
    const inflight = provision(cloudflare, "mhome-1", credential);
    await paused.entered;
    const rotated = await (await call(cloudflare, "POST", "/v1/machines/mhome-1/rotate", { token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string }>();
    const next = await enrol(cloudflare, "mhome-1", rotated.enrollmentToken);
    paused.release();
    const response = await inflight;
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(CONNECTOR_TOKEN);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ status: "error", last_error_code: "installation_credential_inactive" });
    expect(cloudflare.tunnels.size).toBe(1); // retained for adoption, not deleted
    const retried = await provision(cloudflare, "mhome-1", next.machineCredential, 2);
    expect(retried.status).toBe(200);
    // The rotation owed a secret roll, so the adopted tunnel hands out a NEW token.
    expect((await retried.json<{ connectorToken: string }>()).connectorToken).toBe(`${CONNECTOR_TOKEN}.roll1`);
    expect(cloudflare.tunnels.size).toBe(1);
  });

  it("rotation cuts off the old connector token: the next claim rolls the tunnel secret, same hostname, new token", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential } = await managedMachine(cloudflare);
    const first = await provision(cloudflare, "mhome-1", credential);
    expect(first.status).toBe(200);
    const issued = await first.json<{ connectorToken: string; endpoint: { hostname: string } }>();
    expect(issued.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ token_roll_due: 0 });

    const rotated = await (await call(cloudflare, "POST", "/v1/machines/mhome-1/rotate", { token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string }>();
    expect(await endpointRowFor("mhome-1")).toMatchObject({ token_roll_due: 1 });
    const next = await enrol(cloudflare, "mhome-1", rotated.enrollmentToken);
    const second = await provision(cloudflare, "mhome-1", next.machineCredential, 2);
    expect(second.status).toBe(200);
    const reissued = await second.json<{ connectorToken: string; endpoint: { hostname: string } }>();
    expect(reissued.connectorToken).not.toBe(issued.connectorToken);
    expect(reissued.endpoint.hostname).toBe(created.hostname);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.calls.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ token_roll_due: 0, hostname: created.hostname, status: "ready" });

    // The roll is paid once: a further reconcile returns the same (new) token.
    const third = await (await provision(cloudflare, "mhome-1", next.machineCredential, 2)).json<{ connectorToken: string }>();
    expect(third.connectorToken).toBe(reissued.connectorToken);
    expect(cloudflare.calls.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
  });

  it("a failed secret roll withholds every token and stays owed until it succeeds", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    const rotated = await (await call(cloudflare, "POST", "/v1/machines/mhome-1/rotate", { token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string }>();
    const next = await enrol(cloudflare, "mhome-1", rotated.enrollmentToken);

    cloudflare.failures.add("roll_tunnel");
    const tokenCallsBefore = cloudflare.calls.filter((entry) => entry.url.endsWith("/token")).length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await provision(cloudflare, "mhome-1", next.machineCredential, 2);
      expect(failed.status).toBe(502);
      expect(await failed.text()).not.toContain(CONNECTOR_TOKEN);
      expect(await endpointRowFor("mhome-1")).toMatchObject({ token_roll_due: 1, status: "error" });
    }
    // No token was even fetched while the roll was owed.
    expect(cloudflare.calls.filter((entry) => entry.url.endsWith("/token")).length).toBe(tokenCallsBefore);
    expect(cloudflare.tunnels.size).toBe(1);

    cloudflare.failures.delete("roll_tunnel");
    const retried = await provision(cloudflare, "mhome-1", next.machineCredential, 2);
    expect(retried.status).toBe(200);
    expect((await retried.json<{ connectorToken: string }>()).connectorToken).toBe(`${CONNECTOR_TOKEN}.roll1`);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ token_roll_due: 0, status: "ready" });
  });

  it("limits reconciles to 20 per hour per machine", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    }
    const limited = await provision(cloudflare, "mhome-1", credential);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // Another machine has its own budget.
    const other = await managedMachine(cloudflare, "mhome-2");
    expect((await provision(cloudflare, "mhome-2", other.credential)).status).toBe(200);
  });
});

describe("machine endpoint cleanup", () => {
  it("deletes the tunnel and DNS record when the machine is fenced, with retry backoff", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential } = await managedMachine(cloudflare);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    await sweep(cloudflare);
    expect(cloudflare.tunnels.size).toBe(1); // an active machine is left alone
    await env.DB.prepare("UPDATE cloud_machines SET state='fenced',credential_hash=NULL WHERE id='mhome-1'").run();
    cloudflare.failures.add("delete_tunnel");
    await sweep(cloudflare);
    expect(cloudflare.dns.has(created.hostname as string)).toBe(false);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ status: "deleting", cleanup_attempts: 1 });
    // Inside the backoff window nothing is retried.
    cloudflare.failures.clear();
    const callsBefore = cloudflare.calls.length;
    await sweep(cloudflare);
    expect(cloudflare.calls.length).toBe(callsBefore);
    await env.DB.prepare("UPDATE machine_endpoints SET last_cleanup_attempt_at=? WHERE machine_id='mhome-1'")
      .bind(Date.now() - 6 * 60 * 1_000).run();
    await sweep(cloudflare);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ status: "deleted", tunnel_id: null, dns_record_id: null });
  });

  it("cleans up when the machine row is gone", async () => {
    const cloudflare = new FakeCloudflare();
    const { credential } = await managedMachine(cloudflare);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    await env.DB.prepare("DELETE FROM cloud_machines WHERE id='mhome-1'").run();
    await sweep(cloudflare);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.dns.size).toBe(0);
    expect((await endpointRowFor("mhome-1"))?.status).toBe("deleted");
  });
});

describe("B3 reserve with a managed endpoint", () => {
  const reserve = (cloudflare: FakeCloudflare, extra: Record<string, unknown>) => call(cloudflare, "POST", "/v1/fake-b3/reserve", {
    b3: true, token: ADMIN,
    body: { homeId: "bhome-1", installationId: "12345678-1234-4123-8123-123456789012", ownerId: "b3-owner",
      idempotencyKey: "reserve-key-bhome-1-0001", ...extra } });
  const seed = () => env.DB.batch([
    env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt)
      VALUES ('b3-owner','B3 owner','b3@example.test',1,1,1)`),
    env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
      VALUES ('12345678-1234-4123-8123-123456789012','b3-owner','bhome','B3 test','linux',1,1)`),
  ]);

  it("allocates the hostname at reserve, rejects a caller origin with it, and keeps replays identical", async () => {
    const cloudflare = new FakeCloudflare();
    await seed();
    expect((await reserve(cloudflare, { managed_endpoint: true, publicOrigin: "https://x.murage.test" })).status).toBe(400);
    expect((await reserve(cloudflare, {})).status).toBe(400);
    const first = await reserve(cloudflare, { managed_endpoint: true });
    expect(first.status).toBe(201);
    const body = await first.json<{ hostname: string; publicOrigin: string }>();
    expect(body.hostname).toMatch(/^h-[0-9a-f]{32}\./);
    expect(body.publicOrigin).toBe(`https://${body.hostname}`);
    expect(await endpointRowFor("bhome-1")).toMatchObject({ hostname: body.hostname, status: "pending" });
    const replay = await reserve(cloudflare, { managed_endpoint: true });
    expect(await replay.json()).toMatchObject({ hostname: body.hostname, publicOrigin: body.publicOrigin });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM machine_endpoints").first<{ n: number }>())?.n).toBe(1);
  });

  it("provisions for the home's machine, then removes tunnel and DNS when the home is quarantined", async () => {
    const cloudflare = new FakeCloudflare();
    await seed();
    const body = await (await reserve(cloudflare, { managed_endpoint: true })).json<{ hostname: string; publicOrigin: string }>();
    expect((await call(cloudflare, "POST", "/v1/fake-b3/payments", { b3: true, token: ADMIN,
      body: { eventId: "evt-1", homeId: "bhome-1", version: 1, status: "paid", paymentId: "payment-bhome-1" } })).status).toBe(202);
    expect((await call(cloudflare, "POST", "/v1/fake-b3/reconcile", { b3: true, token: ADMIN, body: {} })).status).toBe(200);
    const rotated = await (await call(cloudflare, "POST", "/v1/machines/bhome-1/rotate", { b3: true, token: ADMIN, body: {} }))
      .json<{ enrollmentToken: string; generation: number }>();
    const enrolled = await call(cloudflare, "POST", "/v1/machines/bhome-1/enroll", { b3: true, body: { token: rotated.enrollmentToken } });
    expect(enrolled.status).toBe(200);
    const credential = await enrolled.json<{ machineCredential: string; publicOrigin: string; generation: number }>();
    expect(credential.publicOrigin).toBe(body.publicOrigin);
    const issued = await call(cloudflare, "POST", "/v1/machines/bhome-1/endpoint", { b3: true, token: credential.machineCredential,
      body: { generation: credential.generation } });
    expect(issued.status).toBe(200);
    expect((await issued.json<{ endpoint: { hostname: string } }>()).endpoint.hostname).toBe(body.hostname);
    expect(cloudflare.tunnels.size).toBe(1);

    const stopped = await call(cloudflare, "POST", "/v1/fake-b3/homes/bhome-1/action", { b3: true, token: ADMIN,
      body: { generation: credential.generation, idempotencyKey: "action-key-bhome-1-0001", action: "quarantine" } });
    expect(stopped.status).toBe(202);
    const fenced = await call(cloudflare, "POST", "/v1/machines/bhome-1/endpoint", { b3: true, token: credential.machineCredential,
      body: { generation: credential.generation } });
    expect(fenced.status).toBe(401);
    await sweep(cloudflare, true);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.dns.size).toBe(0);
    expect((await endpointRowFor("bhome-1"))?.status).toBe("deleted");
  });
});

describe("round 8c: a home given up and paid again gets its endpoint back for the new resource generation", () => {
  const HOME_ID = "rhome-1";
  const INSTALLATION = "22345678-1234-4123-8123-123456789012";
  let clock = 0;
  beforeEach(() => { edgeLimits = false; clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock); });
  afterEach(() => { edgeLimits = true; vi.restoreAllMocks(); });
  const seed = () => env.DB.batch([
    env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('r-owner','R owner','r@example.test',1,1,1)`),
    env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
      VALUES (?,'r-owner','rhome','R test','linux',1,1)`).bind(INSTALLATION),
  ]);
  // The enrollment token each server is created with (the fake provider's userData), as the booted machine would read it.
  let tokens: string[] = [];
  const provider = (db: D1Database): ProviderAdapter => { const p = fakeProvider(db); return { ...p,
    async create(...a: Parameters<ProviderAdapter["create"]>) { tokens.push(a[0].userData.enrollmentToken); return p.create(...a); } }; };
  beforeEach(() => { tokens = []; });
  const admin = (cloudflare: FakeCloudflare, path: string, body: unknown) => call(cloudflare, "POST", path, { b3: true, token: ADMIN, body, provider });
  const reconcile = async (cloudflare: FakeCloudflare) => expect((await admin(cloudflare, "/v1/fake-b3/reconcile", {})).status).toBe(200);
  const pay = async (cloudflare: FakeCloudflare, n: number) => expect((await admin(cloudflare, "/v1/fake-b3/payments",
    { eventId: `evt-r${n}`, homeId: HOME_ID, version: n, status: "paid", paymentId: `payment-r${n}` })).status).toBe(202);
  const home = () => env.DB.prepare("SELECT desired_state,entitlement,resource_generation FROM cloud_homes WHERE id=?").bind(HOME_ID).first();
  const budget = () => env.DB.prepare("SELECT gave_up_at FROM provision_attempts WHERE home_id=?").bind(HOME_ID).first<{ gave_up_at: number | null }>();
  /** Reserve with a managed endpoint, pay, set up: the home is 'checking' at resource generation 1. Returns the hostname. */
  async function setUp(cloudflare: FakeCloudflare): Promise<string> {
    await seed();
    const reserved = await admin(cloudflare, "/v1/fake-b3/reserve", { homeId: HOME_ID, installationId: INSTALLATION, ownerId: "r-owner",
      idempotencyKey: "reserve-key-rhome-1-0001", managed_endpoint: true });
    expect(reserved.status).toBe(201);
    await pay(cloudflare, 1); await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "checking", resource_generation: 1 });
    return (await reserved.json<{ hostname: string }>()).hostname;
  }
  /** The machine enrols with the token its server was created with and asks for its endpoint. */
  async function connect(cloudflare: FakeCloudflare) {
    const enrolled = await call(cloudflare, "POST", `/v1/machines/${HOME_ID}/enroll`, { b3: true, body: { token: tokens.at(-1) } });
    expect(enrolled.status).toBe(200);
    const credential = await enrolled.json<{ machineCredential: string; generation: number }>();
    const issued = await call(cloudflare, "POST", `/v1/machines/${HOME_ID}/endpoint`, { b3: true, token: credential.machineCredential,
      body: { generation: credential.generation } });
    return { credential, issued };
  }
  const giveUp = async (cloudflare: FakeCloudflare) => {
    clock += PROVISION_MAX_MS + 1; await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
  };
  const deletes = (cloudflare: FakeCloudflare, what: "cfd_tunnel" | "dns_records", id?: string) => cloudflare.calls
    .filter((c) => c.method === "DELETE" && c.url.includes(`/${what}/${id ?? ""}`)).length;
  const tunnelCreates = (cloudflare: FakeCloudflare) => cloudflare.calls.filter((c) => c.method === "POST" && c.url.endsWith("/cfd_tunnel")).length;

  it("live endpoint: the reopen waits for the old tunnel and CNAME to be deleted (once), then the new generation gets the same hostname on a new tunnel; its own give-up deletes its own", async () => {
    const cloudflare = new FakeCloudflare();
    const hostname = await setUp(cloudflare);
    const first = await connect(cloudflare);
    expect(first.issued.status).toBe(200);
    const oldTunnel = [...cloudflare.tunnels.values()][0]!.id;
    expect(cloudflare.dns.get(hostname)?.content).toBe(`${oldTunnel}.cfargotunnel.com`);
    await giveUp(cloudflare);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", hostname });
    // A new payment while the old endpoint is still being deleted: nothing re-opened, the 'deleting' row never claimed, no new tunnel.
    await pay(cloudflare, 2); await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "provisioning", entitlement: "paid", resource_generation: 1 });
    expect((await budget())?.gave_up_at).not.toBeNull();
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", tunnel_id: oldTunnel });
    expect(tunnelCreates(cloudflare)).toBe(1);
    expect((await call(cloudflare, "POST", `/v1/machines/${HOME_ID}/endpoint`, { b3: true, token: first.credential.machineCredential,
      body: { generation: first.credential.generation } })).status).toBe(401);
    // The sweep (B3 reconcile, then the endpoint cleanup) deletes the old tunnel and CNAME; the next pass re-opens the home.
    await sweep(cloudflare, true);
    expect(cloudflare.tunnels.size).toBe(0); expect(cloudflare.dns.size).toBe(0);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleted", tunnel_id: null, dns_record_id: null });
    expect(await home()).toMatchObject({ resource_generation: 1 });
    await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "pending", hostname, tunnel_id: null, dns_record_id: null,
      cleanup_attempts: 0, delete_requested_at: null });
    // The new machine's ordinary claim: the same hostname, a NEW tunnel, the CNAME pointing at it.
    const second = await connect(cloudflare);
    expect(second.issued.status).toBe(200);
    expect((await second.issued.json<{ endpoint: { hostname: string } }>()).endpoint.hostname).toBe(hostname);
    const newTunnel = [...cloudflare.tunnels.values()][0]!.id;
    expect(newTunnel).not.toBe(oldTunnel); expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.get(hostname)?.content).toBe(`${newTunnel}.cfargotunnel.com`);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "ready", tunnel_id: newTunnel });
    expect(deletes(cloudflare, "cfd_tunnel", oldTunnel)).toBe(1); expect(deletes(cloudflare, "dns_records")).toBe(1);
    // The new generation is given up too: its own endpoint is deleted (once); the old tunnel is never touched again.
    await giveUp(cloudflare);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", tunnel_id: newTunnel });
    await sweep(cloudflare, true);
    expect(cloudflare.tunnels.size).toBe(0); expect(cloudflare.dns.size).toBe(0);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleted", hostname });
    expect(deletes(cloudflare, "cfd_tunnel", newTunnel)).toBe(1); expect(deletes(cloudflare, "cfd_tunnel", oldTunnel)).toBe(1);
    expect(deletes(cloudflare, "dns_records")).toBe(2);
    await sweep(cloudflare, true);
    expect(deletes(cloudflare, "cfd_tunnel")).toBe(2);
  });

  it("the old endpoint's deletion keeps failing: the new generation waits (never claims the 'deleting' row), the cleanup is asked for again after the backoff, and the home opens once it succeeds", async () => {
    const cloudflare = new FakeCloudflare();
    const hostname = await setUp(cloudflare);
    expect((await connect(cloudflare)).issued.status).toBe(200);
    const oldTunnel = [...cloudflare.tunnels.values()][0]!.id;
    await giveUp(cloudflare);
    await pay(cloudflare, 2);
    cloudflare.failures.add("delete_tunnel");
    await sweep(cloudflare, true);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", cleanup_attempts: 1, last_error_code: expect.any(String) });
    expect(cloudflare.tunnels.size).toBe(1); expect(cloudflare.dns.size).toBe(0);
    for (const step of [0, 1]) {
      await reconcile(cloudflare);
      expect(await home()).toMatchObject({ desired_state: "provisioning", resource_generation: 1 });
      expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", tunnel_id: oldTunnel });
      if (step === 0) {
        // Inside the backoff: left as it is (at most one Cloudflare attempt per backoff step).
        expect((await endpointRowFor(HOME_ID))?.last_cleanup_attempt_at).not.toBeNull();
        clock += 6 * 60_000;
      } else {
        // Past it: due again at the next sweep.
        expect((await endpointRowFor(HOME_ID))?.last_cleanup_attempt_at).toBeNull();
      }
    }
    expect(tunnelCreates(cloudflare)).toBe(1);
    cloudflare.failures.delete("delete_tunnel");
    await sweep(cloudflare, true);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleted" });
    await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "checking", resource_generation: 2 });
    const second = await connect(cloudflare);
    expect(second.issued.status).toBe(200);
    expect(cloudflare.dns.get(hostname)?.content).toBe(`${[...cloudflare.tunnels.values()][0]!.id}.cfargotunnel.com`);
    // The CNAME was deleted once (first attempt); the tunnel delete failed once and succeeded once.
    expect(deletes(cloudflare, "dns_records")).toBe(1); expect(deletes(cloudflare, "cfd_tunnel", oldTunnel)).toBe(2);
  });

  it("Astra MAILRETRY-13 P1-2: a reopen pass that read the old endpoint resumes after the new generation's endpoint is ready: it marks nothing, and the new tunnel is never deleted", async () => {
    const cloudflare = new FakeCloudflare();
    const hostname = await setUp(cloudflare);
    expect((await connect(cloudflare)).issued.status).toBe(200);
    const oldTunnel = [...cloudflare.tunnels.values()][0]!.id;
    await giveUp(cloudflare);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleting", tunnel_id: oldTunnel, delete_resource_generation: 1 });
    await pay(cloudflare, 2);
    let newTunnel = "";
    // Pass X reads the old endpoint as held and is about to ask for its cleanup. Meanwhile: the sweep deletes the old tunnel and CNAME,
    // pass Y re-opens the home at generation 2, and the new machine claims the row: ready, on a new tunnel.
    const db = hookDb(env.DB, /UPDATE machine_endpoints SET status='deleting',delete_requested_at=COALESCE\(delete_requested_at,\?\)/, async () => {
      await sweep(cloudflare, true);
      expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleted", tunnel_id: null });
      await reconcile(cloudflare);
      expect(await home()).toMatchObject({ desired_state: "checking", resource_generation: 2 });
      expect((await connect(cloudflare)).issued.status).toBe(200);
      newTunnel = [...cloudflare.tunnels.values()][0]!.id;
      expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "ready", tunnel_id: newTunnel });
    });
    expect((await call(cloudflare, "POST", "/v1/fake-b3/reconcile", { b3: true, token: ADMIN, body: {}, provider, db })).status).toBe(200);
    expect(newTunnel).not.toBe(""); expect(newTunnel).not.toBe(oldTunnel);
    // X's request was a compare-and-set on the row it read (status, lease generation, tunnel and DNS ids) and on generation 1: nothing written
    // (before the fix: B's ready row was marked 'deleting' and the next sweep deleted its tunnel and CNAME).
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "ready", tunnel_id: newTunnel, delete_requested_at: null, delete_resource_generation: null });
    await sweep(cloudflare, true);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.get(hostname)?.content).toBe(`${newTunnel}.cfargotunnel.com`);
    expect(deletes(cloudflare, "cfd_tunnel", newTunnel)).toBe(0);
    expect(deletes(cloudflare, "cfd_tunnel", oldTunnel)).toBe(1);
  });

  it("given up before the machine ever asked for its endpoint: the row is released at once with no Cloudflare call; a row an earlier build deleted comes back with the same hostname", async () => {
    const cloudflare = new FakeCloudflare();
    const hostname = await setUp(cloudflare);
    const tunnelName = (await endpointRowFor(HOME_ID))?.tunnel_name;
    await giveUp(cloudflare);
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "deleted", hostname, tunnel_id: null, dns_record_id: null });
    expect(cloudflare.calls).toHaveLength(0);
    // What the earlier build's give-up did to a never-claimed row: deleted it outright.
    await env.DB.prepare("DELETE FROM machine_endpoints WHERE machine_id=?").bind(HOME_ID).run();
    await pay(cloudflare, 2); await reconcile(cloudflare);
    expect(await home()).toMatchObject({ desired_state: "checking", resource_generation: 2 });
    expect(await endpointRowFor(HOME_ID)).toMatchObject({ status: "pending", hostname, tunnel_name: tunnelName });
    const second = await connect(cloudflare);
    expect(second.issued.status).toBe(200);
    expect((await second.issued.json<{ endpoint: { hostname: string } }>()).endpoint.hostname).toBe(hostname);
    expect(cloudflare.tunnels.get(tunnelName as string)).toBeDefined();
  });
});

describe("staging machine retire", () => {
  const retire = (cloudflare: FakeCloudflare, id: string) => call(cloudflare, "POST", `/v1/machines/${id}/retire`, { token: ADMIN, body: {} });
  it("retire fences the machine, then the sweep deletes tunnel and DNS; old credential gets 401; twice is fine", async () => {
    const cloudflare = new FakeCloudflare();
    const { created, credential } = await managedMachine(cloudflare);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(200);
    expect(cloudflare.tunnels.size).toBe(1);
    const first = await retire(cloudflare, "mhome-1");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ machineId: "mhome-1", state: "fenced" });
    const generation = (await env.DB.prepare("SELECT generation FROM cloud_machines WHERE id='mhome-1'").first<{ generation: number }>())?.generation;
    expect((await retire(cloudflare, "mhome-1")).status).toBe(200);
    expect((await env.DB.prepare("SELECT generation FROM cloud_machines WHERE id='mhome-1'").first<{ generation: number }>())?.generation).toBe(generation);
    expect((await provision(cloudflare, "mhome-1", credential)).status).toBe(401);
    await sweep(cloudflare);
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.dns.has(created.hostname as string)).toBe(false);
    expect(cloudflare.dns.size).toBe(0);
    expect(await endpointRowFor("mhome-1")).toMatchObject({ status: "deleted", tunnel_id: null, dns_record_id: null });
    expect((await retire(cloudflare, "mhome-1")).status).toBe(200);
  });
  it("kills unused enrollment tokens and 404s an unknown id", async () => {
    const cloudflare = new FakeCloudflare();
    const response = await createMachine(cloudflare, "mhome-9");
    const created = await response.json<Created>();
    expect((await retire(cloudflare, "mhome-9")).status).toBe(200);
    expect((await call(cloudflare, "POST", "/v1/machines/mhome-9/enroll", { body: { token: created.enrollmentToken } })).status).toBe(401);
    expect((await retire(cloudflare, "nope-1")).status).toBe(404);
  });
});
