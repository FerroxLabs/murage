import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { CloudflareFetch } from "../src/cloudflare-api";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";

// B99 (re-scoped upstream bfed2e16b, b2d64f39b): a tunnel-create 429 at the account's tunnel limit is capacity (503 endpoint_capacity,
// Retry-After 600, a ten-minute gate, a 90% alert); a tunnel that provisioning created and never published is reclaimed under a CAS.

const BASE_URL = "https://auth.murage.test";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-only-connector-token.signature";
const LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

type Worker = ReturnType<typeof createWorker>;

function ok(result: unknown): Response {
  return Response.json({ errors: [], messages: [], result, success: true });
}

class FakeCloudflare {
  calls: string[] = [];
  createStatus: number | null = null;
  readonly tunnels = new Map<string, { id: string; name: string }>();
  readonly dns = new Map<string, { content: string; id: string; name: string; proxied: boolean; type: string }>();
  private counter = 1;
  private pause: { op: string; entered: () => void; wait: Promise<void> } | null = null;

  pauseNext(op: string): { entered: Promise<void>; release: () => void } {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const enteredP = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.pause = { op, entered, wait };
    return { entered: enteredP, release };
  }

  addTunnel(name: string): { id: string; name: string } {
    const tunnel = { id: `20000000-0000-4000-8000-${(this.counter++).toString(16).padStart(12, "0")}`, name };
    this.tunnels.set(name, tunnel);
    return tunnel;
  }

  readonly fetch: CloudflareFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const op = `${method} ${url.pathname.replace(/^.*\/(cfd_tunnel|dns_records)/, "$1")}`;
    this.calls.push(op);
    if (this.pause && op.startsWith(this.pause.op)) {
      const p = this.pause;
      this.pause = null;
      p.entered();
      await p.wait;
    }
    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel")) {
      const t = this.tunnels.get(url.searchParams.get("name") ?? "");
      return ok(t ? [{ ...t, config_src: "cloudflare", deleted_at: null }] : []);
    }
    if (method === "GET" && /\/cfd_tunnel\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      const t = [...this.tunnels.values()].find((c) => c.id === id);
      return t ? ok({ ...t, config_src: "cloudflare", deleted_at: null })
        : Response.json({ errors: [{ code: 1_003, message: "not found" }], messages: [], result: null, success: false }, { status: 404 });
    }
    if (method === "POST" && url.pathname.endsWith("/cfd_tunnel")) {
      if (this.createStatus !== null) {
        return Response.json({ errors: [{ code: 1_013, message: "too many" }], messages: [], result: null, success: false },
          { status: this.createStatus });
      }
      const t = this.addTunnel(String(body.name));
      return ok({ ...t, config_src: "cloudflare", deleted_at: null });
    }
    if (method === "PUT" && url.pathname.endsWith("/configurations")) return ok({ config: body.config });
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const r = this.dns.get(url.searchParams.get("name.exact") ?? "");
      return ok(r ? [r] : []);
    }
    if (method === "GET" && url.pathname.includes("/dns_records/")) {
      const id = url.pathname.split("/").at(-1);
      const r = [...this.dns.values()].find((c) => c.id === id);
      return r ? ok(r) : Response.json({ errors: [{ code: 1_003, message: "nf" }], messages: [], result: null, success: false }, { status: 404 });
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      const r = { content: String(body.content), id: `dns-${this.counter++}`, name: String(body.name), proxied: true, type: "CNAME" };
      this.dns.set(r.name, r);
      return ok(r);
    }
    if (method === "GET" && url.pathname.endsWith("/token")) return ok(TOKEN);
    if (method === "DELETE" && url.pathname.includes("/dns_records/")) {
      const id = url.pathname.split("/").at(-1);
      for (const [k, r] of this.dns) if (r.id === id) this.dns.delete(k);
      return Response.json({ result: { id } });
    }
    if (method === "DELETE" && url.pathname.includes("/cfd_tunnel/")) {
      const id = url.pathname.split("/").at(-1);
      for (const [k, t] of this.tunnels) if (t.id === id) this.tunnels.delete(k);
      return ok({ id });
    }
    throw new Error(`unexpected Cloudflare request: ${op}`);
  };
}

async function call(worker: Worker, path: string, token: string, method = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body), headers, method,
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function installation(worker: Worker, tag: string): Promise<{ credential: string; id: string }> {
  const email = `b99-${tag}@example.com`;
  const actx = createExecutionContext();
  const auth = createAuth(env, actx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(actx);
  const sctx = createExecutionContext();
  const signIn = await worker.fetch(new Request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
    body: JSON.stringify({ email, name: "B99", otp }), headers: { "content-type": "application/json" }, method: "POST",
  }), env, sctx);
  await waitOnExecutionContext(sctx);
  expect(signIn.status).toBe(200);
  const account = signIn.headers.get("set-auth-token") ?? "";
  const created = await call(worker, "/v1/installations", account, "POST", { clientInstanceId: `b99-${tag}`, name: "B99 Mac", platform: "darwin" });
  expect(created.status).toBe(201);
  const value = await created.json<{ credential: string; installation: { id: string } }>();
  return { credential: value.credential, id: value.installation.id };
}

const provision = (worker: Worker, credential: string) => call(worker, "/v1/installations/self/endpoint", credential, "POST");

/** Tunnels we already hold: `n` rows with a tunnel id (installation_endpoints has no foreign key to installations). */
async function holdTunnels(n: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
    INSERT INTO installation_endpoints (installation_id, hostname, tunnel_name, tunnel_id, status, last_reconciled_at, created_at, updated_at)
    SELECT 'b99-held-' || i, 'c-held' || i || '.companion.murage.test', 'murage-c-held' || i, 'held-tunnel-' || i, 'ready', ?, ?, ? FROM k`)
    .bind(n, now, now, now).run();
}

async function runSweep(worker: Worker): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function endpoint(id: string) {
  return env.DB.prepare(`SELECT status, tunnel_id, generation, last_error_code, last_reconciled_at FROM installation_endpoints WHERE installation_id = ?`)
    .bind(id).first<{ generation: number; last_error_code: string | null; last_reconciled_at: number | null; status: string; tunnel_id: string | null }>();
}

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM installation_endpoints`),
    env.DB.prepare(`DELETE FROM installation_action_rate_limits`),
    env.DB.prepare(`DELETE FROM cloud_alerts WHERE kind = 'endpoints.tunnel_capacity'`),
  ]);
});

describe("B99 capacity: a tunnel-create 429 at the account's tunnel limit", () => {
  it("answers 503 endpoint_capacity with Retry-After 600, gates new tunnels for ten minutes without calling Cloudflare, and raises a redacted alert", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const ready = await installation(worker, "cap-ready");
    expect((await provision(worker, ready.credential)).status).toBe(200);
    await holdTunnels(LIMIT - 1);
    cloudflare.createStatus = 429;
    const a = await installation(worker, "cap-a");
    const first = await provision(worker, a.credential);
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("600");
    expect(await first.json()).toEqual({ error: "endpoint_capacity" });
    expect(await endpoint(a.id)).toMatchObject({ status: "error", last_error_code: "endpoint_capacity", tunnel_id: null });

    const b = await installation(worker, "cap-b");
    const before = cloudflare.calls.length;
    const gated = await provision(worker, b.credential);
    expect(gated.status).toBe(503);
    expect(Number(gated.headers.get("retry-after"))).toBeGreaterThan(590);
    expect(Number(gated.headers.get("retry-after"))).toBeLessThanOrEqual(600);
    expect(cloudflare.calls.length).toBe(before);

    // An endpoint that already holds its tunnel is never held back by the gate.
    cloudflare.createStatus = null;
    expect((await provision(worker, ready.credential)).status).toBe(200);

    const alert = await env.DB.prepare(`SELECT home_id, severity, detail FROM cloud_alerts WHERE kind = 'endpoints.tunnel_capacity'`).first();
    expect(alert).toEqual({ home_id: "ops", severity: "high", detail: "Cloudflare tunnels in use: 1000 of 1000" });

    // Ten minutes on, the gate is open again.
    await env.DB.prepare(`UPDATE installation_endpoints SET updated_at = updated_at - 600001 WHERE installation_id = ?`).bind(a.id).run();
    expect((await provision(worker, b.credential)).status).toBe(200);
  });

  it("a 429 below the limit stays the ordinary failure: no 503, no gate", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    await holdTunnels(10);
    cloudflare.createStatus = 429;
    const a = await installation(worker, "below-a");
    const first = await provision(worker, a.credential);
    expect(first.status).toBe(502);
    expect((await endpoint(a.id))?.last_error_code).not.toBe("endpoint_capacity");
    cloudflare.createStatus = null;
    const b = await installation(worker, "below-b");
    expect((await provision(worker, b.credential)).status).toBe(200);
    expect(await env.DB.prepare(`SELECT 1 FROM cloud_alerts WHERE kind = 'endpoints.tunnel_capacity'`).first()).toBeNull();
  });

  it("alerts once the account passes 90% of its tunnels on a successful create", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    await holdTunnels(899);
    const a = await installation(worker, "alert-a");
    expect((await provision(worker, a.credential)).status).toBe(200);
    expect((await env.DB.prepare(`SELECT detail FROM cloud_alerts WHERE kind = 'endpoints.tunnel_capacity'`).first())?.detail)
      .toBe("Cloudflare tunnels in use: 900 of 1000");
  });
});

describe("B99 reclaim: only tunnels that were never published", () => {
  /** A row as a provisioning request that stopped leaves it: tunnel recorded, lease expired, never ready. */
  async function stalled(worker: Worker, cloudflare: FakeCloudflare, tag: string, opts: { reconciledAt?: number; ageMs?: number; status?: string } = {}) {
    const inst = await installation(worker, tag);
    const opaque = tag.replace(/[^a-z0-9]/g, "");
    const tunnelName = `murage-c-${opaque}`;
    const tunnel = cloudflare.addTunnel(tunnelName);
    const at = Date.now() - (opts.ageMs ?? DAY_MS + 60_000);
    await env.DB.prepare(`INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, tunnel_id, status, generation, last_reconciled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?)`)
      .bind(inst.id, `c-${opaque}.companion.murage.test`, tunnelName, tunnel.id, opts.status ?? "provisioning", opts.reconciledAt ?? null, at, at).run();
    return { inst, tunnel, tunnelName };
  }

  it("deletes a never-published tunnel left in provisioning or error once the row has been quiet a day", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const p = await stalled(worker, cloudflare, "reclaim-p");
    const e = await stalled(worker, cloudflare, "reclaim-e", { status: "error" });
    await runSweep(worker);
    expect(cloudflare.tunnels.has(p.tunnelName)).toBe(false);
    expect(cloudflare.tunnels.has(e.tunnelName)).toBe(false);
    expect(await endpoint(p.inst.id)).toMatchObject({ status: "deleted", tunnel_id: null });
    expect(await endpoint(e.inst.id)).toMatchObject({ status: "deleted", tunnel_id: null });
    // The owner can still provision afterwards: a fresh tunnel.
    expect((await provision(worker, p.inst.credential)).status).toBe(200);
  });

  it("never reclaims a once-ready endpoint back in provisioning, a recent row, or a tunnel whose id and name disagree", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const wasReady = await stalled(worker, cloudflare, "keep-ready", { reconciledAt: Date.now() - 2 * DAY_MS });
    const recent = await stalled(worker, cloudflare, "keep-recent", { ageMs: 60 * 60 * 1_000 });
    const swapped = await stalled(worker, cloudflare, "keep-swap");
    // Cloudflare's tunnel of that name is now another one: the identity check refuses the delete.
    cloudflare.tunnels.delete(swapped.tunnelName);
    const other = cloudflare.addTunnel(swapped.tunnelName);
    cloudflare.tunnels.set("stray-holder", swapped.tunnel);
    await runSweep(worker);
    expect(cloudflare.tunnels.get(wasReady.tunnelName)?.id).toBe(wasReady.tunnel.id);
    expect(cloudflare.tunnels.get(recent.tunnelName)?.id).toBe(recent.tunnel.id);
    expect(cloudflare.tunnels.get(swapped.tunnelName)?.id).toBe(other.id);
    expect(cloudflare.tunnels.get("stray-holder")?.id).toBe(swapped.tunnel.id);
    expect(await endpoint(wasReady.inst.id)).toMatchObject({ status: "provisioning", tunnel_id: wasReady.tunnel.id });
    expect(await endpoint(recent.inst.id)).toMatchObject({ status: "provisioning", tunnel_id: recent.tunnel.id });
    expect((await endpoint(swapped.inst.id))?.status).toBe("deleting");
  });

  it("a publication racing the reclaim cannot be undone: the reclaim holds the lease, the owner waits (409), nothing ready is deleted", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const s = await stalled(worker, cloudflare, "race");
    const paused = cloudflare.pauseNext("GET cfd_tunnel/");
    const sweep = runSweep(worker);
    await paused.entered;
    const raced = await provision(worker, s.inst.credential);
    expect(raced.status).toBe(409);
    paused.release();
    await sweep;
    expect(await endpoint(s.inst.id)).toMatchObject({ status: "deleted", last_reconciled_at: expect.any(Number) });
    // Published after the reclaim: a new tunnel, ready, and the next sweep leaves it alone.
    expect((await provision(worker, s.inst.credential)).status).toBe(200);
    const live = await endpoint(s.inst.id);
    await env.DB.prepare(`UPDATE installation_endpoints SET updated_at = updated_at - ? WHERE installation_id = ?`).bind(2 * DAY_MS, s.inst.id).run();
    await runSweep(worker);
    expect(await endpoint(s.inst.id)).toMatchObject({ status: "ready", tunnel_id: live?.tunnel_id });
  });
});
