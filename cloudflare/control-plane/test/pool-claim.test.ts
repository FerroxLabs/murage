// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool, lane L3: the atomic claim at payment, the create() pool path in the spike's order, the cloud-config route and fastProvision,
// against an in-memory provider. No network, no credentials.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { classifyEdge } from "../src/edge-limits";
import { fastProvision, providerAnswered } from "../src/b3-control";
import { hetznerAdapter, type HostFetch } from "../src/b5-provisioner";
import { IMG_KINDS, PUBKEY, SIG_TRUST, createLiveProvider, okArch } from "./image-sig-fixture";
import { sha256 } from "../src/installations";
import { claimCloudConfig, claimPoolServer, HARMLESS_CONFIG, POWEROFF_CONFIG, poolCloudConfigRoute, poolClassFor, redactPoolPath,
  failAbandonedClaims, isPoolPath } from "../src/warm-pool-claim";
import { provisionerConfig } from "../src/b5-config";
import type { ProviderAdapter } from "../src/b3-provider";

const IMAGES = { hetzner: { x86: "452016490", arm: "451260442" }, vultr: { x86: "snap-vultr-1" } };
const VERIFIED = { kind: "customer", verifiedBy: "hz-live-rescue", checkVersion: "1", verifiedAt: "20261020T101500Z" };
const IMAGE_KINDS = { "452016490": VERIFIED, "451260442": VERIFIED, "snap-vultr-1": VERIFIED };
const cls = (types: [string, "x86" | "arm"][]) => ({ rungs: types.map(([serverType, arch]) => ({ serverType, arch })), target: 4, red: 2, max: 8 });
const POOL = {
  env: "staging", monthlyIdleCapEur: 200,
  classes: { starter: cls([["cx23", "x86"], ["cax11", "arm"]]), pro: cls([["cax21", "arm"], ["cx33", "x86"]]) },
  limits: { vcpu: 100, primaryIps: 50, volumeGb: 5000, reserveForLive: { vcpu: 20, primaryIps: 10, volumeGb: 1000 } },
};
const KEK = btoa("x".repeat(32));
const e = (extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Env => ({ ...env, CLOUD_KEK_V1: KEK, HCLOUD_TOKEN: "hz-test-token", B5_IMAGE_VERIFY_PUBKEY: PUBKEY,
  B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES, imageKinds: IMG_KINDS, quarantineFirewallId: 77, pool: POOL, ...extra }), ...over } as unknown as Env);
const noSleep = async () => undefined;

// ---- In-memory provider with the pool actions ---------------------------------------------------------------------------------------------
interface Srv { id: number; name: string; status: string; labels: Record<string, string>; image: { id: number }; public_net: { ipv4: { ip: string } }; ticks?: number }
function hetzner(stock: string[] = []) {
  const log: string[] = [];
  const servers = new Map<string, Srv>(); const volumes = new Map<string, any>();
  const created: any[] = [];
  const opts = { refuseRelabel: false, refuseRebuild: false, loseRelabelResponse: false, afterRelabel: undefined as undefined | ((s: Srv) => void),
    beforeRelabel: undefined as undefined | (() => Promise<void>), gone: new Set<string>(),
    onGetServer: undefined as undefined | (() => Promise<void>), beforeRebuild: undefined as undefined | (() => Promise<void>),
    beforePowerOn: undefined as undefined | (() => Promise<void>) };
  const actions = new Map<string, string>();
  const history: { id: number; command: string; status: string; started: string }[] = []; // GET /servers/{id}/actions
  let n = 700;
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  const fetcher: HostFetch = async (url, init) => {
    const u = new URL(url); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined; const p = u.pathname;
    const sel = decodeURIComponent(u.searchParams.get("label_selector") ?? "");
    const match = (labels: any) => sel.split(",").every((kv) => { const [k, v] = kv.split("="); return labels?.[k] === v; });
    if (p === "/v1/server_types") {
      const name = u.searchParams.get("name")!;
      return j({ server_types: [{ name, locations: ["fsn1", "nbg1", "hel1"].map((l) => ({ name: l, available: stock.includes(`${name}:${l}`) })) }] });
    }
    if (p === "/v1/volumes" && method === "POST") {
      const id = ++n; const v = { id, server: null, location: { name: body.location }, labels: body.labels, size: body.size };
      volumes.set(String(id), v); return j({ volume: v }, 201);
    }
    if (p === "/v1/volumes") return j({ volumes: [...volumes.values()].filter((v) => match(v.labels)), meta: { pagination: { next_page: null } } });
    let m = /^\/v1\/volumes\/(\d+)$/.exec(p);
    if (m && method === "GET") return volumes.has(m[1]) ? j({ volume: volumes.get(m[1]) }) : j({ error: { code: "not_found" } }, 404);
    if (m && method === "DELETE") { volumes.delete(m[1]); return j({}); }
    m = /^\/v1\/volumes\/(\d+)\/actions\/attach$/.exec(p);
    if (m) {
      const s = servers.get(String(body.server));
      log.push(`attach:${s?.status}`);
      volumes.get(m[1]).server = body.server; return j({ action: { id: 1, status: "success" } });
    }
    if (p === "/v1/servers" && method === "POST") {
      const id = ++n; created.push(body);
      const s: Srv = { id, name: body.name, status: "running", labels: body.labels, image: { id: Number(body.image) }, public_net: { ipv4: { ip: `203.0.113.${id % 250}` } } };
      servers.set(String(id), s);
      for (const v of body.volumes ?? []) volumes.get(String(v)).server = id;
      log.push("create"); return j({ server: s }, 201);
    }
    if (p === "/v1/servers") return j({ servers: [...servers.values()].filter((s) => match(s.labels)), meta: { pagination: { next_page: null } } });
    m = /^\/v1\/servers\/(\d+)$/.exec(p);
    if (m) {
      const s = servers.get(m[1]);
      if (!s || opts.gone.has(m[1])) return j({ error: { code: "not_found" } }, 404);
      if (method === "GET") {
        if (opts.onGetServer) { const hook = opts.onGetServer; opts.onGetServer = undefined; await hook(); }
        if (s.ticks !== undefined) { s.ticks -= 1; if (s.ticks <= 0) { s.status = "running"; s.ticks = undefined; actions.set("2", "success"); } }
        return j({ server: s });
      }
      if (method === "PUT") {
        log.push("relabel");
        if (opts.beforeRelabel) await opts.beforeRelabel();
        if (opts.refuseRelabel) return j({ error: { code: "invalid_input", message: "no" } }, 422);
        if (body.name !== undefined) s.name = body.name;
        if (body.labels) s.labels = body.labels;
        if (opts.afterRelabel) opts.afterRelabel(s);
        if (opts.loseRelabelResponse) { opts.loseRelabelResponse = false; return j({}, 502); }
        return j({ server: s });
      }
      if (method === "DELETE") { servers.delete(m[1]); log.push("delete"); return j({}); }
    }
    if (/^\/v1\/servers\/\d+\/actions$/.test(p) && method === "GET") return j({ actions: history, meta: { pagination: { next_page: null } } });
    m = /^\/v1\/servers\/(\d+)\/actions\/(poweron|poweroff|rebuild)$/.exec(p);
    if (m) {
      const s = servers.get(m[1])!;
      if (m[2] === "rebuild") {
        if (opts.beforeRebuild) await opts.beforeRebuild();
        if (opts.refuseRebuild) return j({ error: { code: "invalid_input", message: "no" } }, 422);
        log.push("rebuild"); actions.set("2", "running"); s.status = "rebuilding"; s.image = { id: Number(body.image) }; s.ticks = 2;
      } else if (m[2] === "poweron") { if (opts.beforePowerOn) await opts.beforePowerOn(); log.push("poweron"); s.status = "running"; } else { log.push("poweroff"); s.status = "off"; }
      return j({ action: { id: 2, status: "running" } });
    }
    m = /^\/v1\/actions\/(\d+)$/.exec(p);
    if (m) return j({ action: { id: Number(m[1]), command: "rebuild", status: actions.get(m[1]) ?? "success", started: "x" } });
    if (/^\/v1\/firewalls\/\d+\/actions\/apply_to_resources$/.test(p)) { log.push("quarantine"); return j({ action: {} }); }
    m = /^\/v1\/images\/(\d+)$/.exec(p);
    if (m && (method === "GET")) return j({ image: { id: Number(m[1]), type: "snapshot", status: "available" } });
    return j({ error: { code: "unexpected" } }, 500);
  };
  const addPool = (id: number, over: Partial<Srv> = {}) => {
    servers.set(String(id), { id, name: `pool-${id}`, status: "off", labels: { "murage/role": "pool", "murage/env": "staging", "murage/pool": `wp_${id}` },
      image: { id: 452016490 }, public_net: { ipv4: { ip: "203.0.113.50" } }, ...over });
  };
  return { fetcher, log, servers, volumes, created, opts, actions, history, addPool, adapter: () => hetznerAdapter("t", { sshKeyIds: [], firewallIds: [], quarantineFirewallId: 77 }, fetcher) };
}

let seq = 0;
async function seedPool(id: string, over: Record<string, unknown> = {}) {
  const row = { env: "staging", class: "starter", provider: "hetzner", server_type: "cx23", arch: "x86", location: "fsn1", image_id: "452016490", image_digest: "sha256:old",
    state: "ready", server_id: id.replace(/\D/g, ""), ipv4: "203.0.113.50", secret_hash: await sha256(`secret-${id}-xxxxxxxxxxxx`), ready_at: 100, ...over };
  await env.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,server_id,ipv4,secret_hash,create_call_id,
    monthly_cents,vcpus,created_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,349,2,1,?)`)
    .bind(id, row.env, row.class, row.provider, row.server_type, row.arch, row.location, row.image_id, row.image_digest, row.state, row.server_id, row.ipv4,
      row.secret_hash, `call-${id}-${++seq}`, row.ready_at).run();
}
const secretOf = (id: string) => `secret-${id}-xxxxxxxxxxxx`;
const claims = (on: boolean) => env.DB.prepare("UPDATE warm_pool_control SET claims=? WHERE id='pool'").bind(on ? 1 : 0).run();
const plan = (home: string, p: string) => env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,created_at,updated_at) VALUES (?,?,?,1,1)").bind(home, `cus_${home}`, p).run();
const row = (id: string) => env.DB.prepare("SELECT * FROM warm_pool WHERE id=?").bind(id).first<Record<string, any>>();
const choiceOf = (home: string, gen = 1) => env.DB.prepare("SELECT * FROM provision_choices WHERE home_id=? AND resource_generation=?").bind(home, gen).first<Record<string, any>>();

beforeEach(async () => { await claims(true); });
afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM warm_pool"), env.DB.prepare("DELETE FROM warm_pool_deliveries"), env.DB.prepare("DELETE FROM warm_pool_events"),
    env.DB.prepare("DELETE FROM cloud_provision_intents"), env.DB.prepare("DELETE FROM cloud_enrollment_tokens"), env.DB.prepare("DELETE FROM cloud_alerts"),
    env.DB.prepare("DELETE FROM provision_attempts"), env.DB.prepare("DELETE FROM cloud_write_guards"),
    env.DB.prepare("UPDATE warm_pool_control SET claims=0 WHERE id='pool'"),
  ]);
});

const serverInput = (home: string, v: Awaited<ReturnType<ProviderAdapter["create_volume"]>>, key: string, token = "tok-secret") => ({
  homeId: home, resourceGeneration: 1, idempotencyKey: key, type: "ignored", location: "ignored", image: `sha256:${"a".repeat(64)}`,
  labels: { homeId: home, resourceGeneration: "1", role: "home" as const }, volume: v,
  userData: { machineId: home, enrollmentToken: token, controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
    volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: home } } });
const volumeInput = (home: string, key = "k-volume-0000001") => ({ homeId: home, resourceGeneration: 1, idempotencyKey: key, provider: "hetzner" as const });

describe("claim (4.2)", () => {
  it("two homes, one ready server: exactly one wins, the other falls through to the ladder", async () => {
    const hz = hetzner(["cx23:fsn1"]);
    await seedPool("wp_501"); hz.addPool(501);
    await plan("home-1", "starter"); await plan("home-2", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    await Promise.all([p.create_volume(volumeInput("home-1")), p.create_volume(volumeInput("home-2", "k-volume-0000002"))]);
    const a = await choiceOf("home-1"); const b = await choiceOf("home-2");
    expect([a!.pool_id, b!.pool_id].sort()).toEqual([null, "wp_501"].sort());
    const winner = a!.pool_id ? "home-1" : "home-2";
    expect(await row("wp_501")).toMatchObject({ state: "claimed", home_id: winner, resource_generation: 1, claimed_at: 5 });
    const loser = (a!.pool_id ? b : a)!;
    expect(loser).toMatchObject({ provider: "hetzner", server_type: "cx23", location: "fsn1" }); // the ladder's
    expect(JSON.parse(loser.tried)[0].result).toBe("chosen");
    expect(JSON.parse((a!.pool_id ? a : b)!.tried)[0].result).toBe("pool_claim");
    const events = await env.DB.prepare("SELECT kind FROM warm_pool_events WHERE pool_id='wp_501'").all<{ kind: string }>();
    expect(events.results.map((r) => r.kind)).toEqual(["claimed"]);
  });

  it("takes the chosen row's type, location and the CURRENT image of its arch", async () => {
    const hz = hetzner(); await seedPool("wp_502", { class: "pro", server_type: "cax21", arch: "arm", location: "hel1", image_id: "451260442" });
    await plan("home-1", "pro");
    await createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5 }).create_volume(volumeInput("home-1"));
    expect(await choiceOf("home-1")).toMatchObject({ pool_id: "wp_502", provider: "hetzner", server_type: "cax21", location: "hel1", arch: "arm", image: "451260442" });
    expect([...hz.volumes.values()][0]).toMatchObject({ location: { name: "hel1" }, size: 150 });
  });

  it("respects claims=0, the class (starter vs pro, Max shares pro), the env and a non-hetzner row", async () => {
    const hz = hetzner(["cx23:fsn1", "cax21:fsn1"]);
    await seedPool("wp_503"); await seedPool("wp_504", { class: "pro", server_type: "cax21", arch: "arm", image_id: "451260442" });
    await seedPool("wp_505", { env: "production" }); await seedPool("wp_506", { provider: "vultr" });
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5 });
    await claims(false);
    await plan("home-1", "starter"); await p.create_volume(volumeInput("home-1"));
    expect((await choiceOf("home-1"))!.pool_id).toBeNull(); // claims=0
    await claims(true);
    await plan("home-2", "max"); await p.create_volume(volumeInput("home-2", "k-volume-0000002"));
    expect((await choiceOf("home-2"))!.pool_id).toBe("wp_504"); // max -> pro class
    await plan("home-3", "starter"); await p.create_volume(volumeInput("home-3", "k-volume-0000003"));
    expect((await choiceOf("home-3"))!.pool_id).toBe("wp_503"); // starter -> starter class; not the production or vultr rows
    await plan("home-4", "starter"); await p.create_volume(volumeInput("home-4", "k-volume-0000004"));
    expect((await choiceOf("home-4"))!.pool_id).toBeNull(); // nothing left that qualifies
    expect(await row("wp_505")).toMatchObject({ state: "ready" }); expect(await row("wp_506")).toMatchObject({ state: "ready" });
    expect(poolClassFor("starter")).toBe("starter"); expect(poolClassFor("enterprise")).toBeNull();
  });

  it("never takes a stale-image row (no rebuild at claim); current images go by rung order, then the oldest ready_at", async () => {
    const config = provisionerConfig(e());
    await seedPool("wp_511", { image_id: "999", ready_at: 10 });                                  // stale, oldest: never claimed
    await seedPool("wp_512", { server_type: "cax11", arch: "arm", image_id: "451260442", ready_at: 20 }); // current, later rung
    await seedPool("wp_513", { image_id: "452016490", ready_at: 40 });                                  // current, first rung, newer
    await seedPool("wp_514", { image_id: "452016490", ready_at: 30 });                                  // current, first rung, older
    const order: string[] = [];
    for (const h of ["h1", "h2", "h3"]) {
      expect(await claimPoolServer(e(), config, { homeId: h, resourceGeneration: 1, plan: "starter", now: 7 }, okArch)).toBe(true);
      order.push((await choiceOf(h))!.pool_id);
    }
    expect(order).toEqual(["wp_514", "wp_513", "wp_512"]);
    expect(await claimPoolServer(e(), config, { homeId: "h5", resourceGeneration: 1, plan: "starter", now: 7 }, okArch)).toBe(false); // only the stale row is left
    expect(await row("wp_511")).toMatchObject({ state: "ready", home_id: null });
  });

  it("pool_id persists on the choice and a retried attempt reuses it (no second claim, no ladder)", async () => {
    const hz = hetzner(["cx23:fsn1"]); await seedPool("wp_521"); await seedPool("wp_522");
    await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5 });
    const v1 = await p.create_volume(volumeInput("home-1"));
    const v2 = await p.create_volume(volumeInput("home-1"));
    expect(v2.id).toBe(v1.id);
    const first = await choiceOf("home-1");
    expect(first!.pool_id).toBe("wp_521");
    expect((await env.DB.prepare("SELECT id FROM warm_pool WHERE state='claimed'").all()).results).toHaveLength(1);
    expect((await row("wp_522"))!.state).toBe("ready");
  });

  it("a claim for a different generation of the same home is its own claim (unique per home and generation)", async () => {
    const config = provisionerConfig(e()); await seedPool("wp_531"); await seedPool("wp_532");
    expect(await claimPoolServer(e(), config, { homeId: "h", resourceGeneration: 1, plan: "starter", now: 1 }, okArch)).toBe(true);
    expect(await claimPoolServer(e(), config, { homeId: "h", resourceGeneration: 1, plan: "starter", now: 1 }, okArch)).toBe(false); // choice exists
    expect(await claimPoolServer(e(), config, { homeId: "h", resourceGeneration: 2, plan: "starter", now: 1 }, okArch)).toBe(true);
  });
});

describe("claim and the signed-image gate (design 9.1, 9.5, row 23)", () => {
  const revoke = (...ids: string[]) => ({ trust: { ...SIG_TRUST, revoked: ids } });
  const kinds = async (pid: string) => (await env.DB.prepare("SELECT kind FROM warm_pool_events WHERE pool_id=?").bind(pid).all<{ kind: string }>()).results.map((r) => r.kind);
  const alertKinds = async () => (await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE resolved_at IS NULL").all<{ kind: string }>()).results.map((r) => r.kind);
  it("an image revoked after the pool server was built: the claim is skipped (nothing claimed, no event) and the home takes the stock ladder", async () => {
    const hz = hetzner(["cax11:fsn1"]); await seedPool("wp_541"); hz.addPool(541);
    await plan("home-1", "starter");
    await createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, verify: revoke("452016490") }).create_volume(volumeInput("home-1"));
    expect(await row("wp_541")).toMatchObject({ state: "ready", home_id: null });
    expect(await kinds("wp_541")).toEqual([]);
    const c = await choiceOf("home-1");
    expect(c).toMatchObject({ pool_id: null, provider: "hetzner", server_type: "cax11", arch: "arm", image: "451260442" });
    expect(JSON.parse(c!.tried).map((t: { serverType: string; result: string }) => `${t.serverType}:${t.result}`)).toEqual(["cx23:image_refused:image_revoked", "cax11:chosen"]);
  });
  it("only the revoked arch is dropped from the claim: the other arch's ready row is still claimed, the revoked arch's row stays ready", async () => {
    const hz = hetzner(); await seedPool("wp_542"); await seedPool("wp_543", { server_type: "cax11", arch: "arm", image_id: "451260442" });
    await plan("home-1", "starter"); await plan("home-2", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, verify: revoke("451260442") });
    await p.create_volume(volumeInput("home-1"));
    expect((await choiceOf("home-1"))!.pool_id).toBe("wp_542");
    // the x86 row is gone; the arm row cannot be claimed while its image is revoked, and the ladder has no stock: nothing is created for home-2
    await expect(p.create_volume(volumeInput("home-2", "k-volume-0000002"))).rejects.toThrow("no_capacity");
    expect(await row("wp_543")).toMatchObject({ state: "ready", home_id: null });
    expect(await choiceOf("home-2")).toBeNull();
  });
  it("every configured image failing: no claim, the ladder fails closed with no_capacity and one high image.unverified alert", async () => {
    const hz = hetzner(["cx23:fsn1", "cax11:fsn1"]); await seedPool("wp_544"); hz.addPool(544);
    await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, verify: revoke("452016490", "451260442") });
    await expect(p.create_volume(volumeInput("home-1"))).rejects.toThrow("no_capacity");
    expect(await row("wp_544")).toMatchObject({ state: "ready", home_id: null });
    expect(await choiceOf("home-1")).toBeNull();
    expect(await alertKinds()).toContain("image.unverified");
    expect(hz.created).toHaveLength(0);
  });
  it("a build host re-check failure at claim is a skip, not a thrown error: the claim returns false and the ladder is tried", async () => {
    const config = provisionerConfig(e()); await seedPool("wp_545");
    const failing = async (_arch: "x86" | "arm", _image: string) => false;
    expect(await claimPoolServer(e(), config, { homeId: "h", resourceGeneration: 1, plan: "starter", now: 1 }, failing)).toBe(false);
    expect(await row("wp_545")).toMatchObject({ state: "ready", home_id: null });
    expect(await choiceOf("h")).toBeNull();
  });
});

describe("create() pool path (4.3, spike order)", () => {
  async function claimed(hz: ReturnType<typeof hetzner>, poolOver: Record<string, unknown> = {}, srvOver: Partial<Srv> = {}) {
    await seedPool("wp_601", poolOver); hz.addPool(601, srvOver); await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput("home-1"));
    return { p, v };
  }

  it("1019 a claimed server is a customer home: owner=MurageCloud, purpose=customer-home, no expires_at, every murage/* key kept", async () => {
    const hz = hetzner();
    const { p, v } = await claimed(hz, {}, { labels: { "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_601", owner: "MurageCloud", purpose: "staging-warm-pool", expires_at: "2027-02-01" } });
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    const l = hz.servers.get("601")!.labels;
    expect(l).toEqual({ "murage/role": "home", "murage/env": "staging", "murage/pool": "wp_601", "murage/home": "home-1", "murage/generation": "1",
      "murage/call": "k-create-00000001", owner: "MurageCloud", purpose: "customer-home" });
    expect("expires_at" in l).toBe(false);
  });

  it("stores the wrapped payload first, then relabel, attach while OFF, power on (current image: no rebuild)", async () => {
    const hz = hetzner();
    const { p, v } = await claimed(hz);
    let storedBeforeRelabel = false;
    hz.opts.beforeRelabel = async () => {
      const d = await env.DB.prepare("SELECT payload_wrapped,token_hash FROM warm_pool_deliveries WHERE pool_id='wp_601'").first<{ payload_wrapped: string; token_hash: string }>();
      storedBeforeRelabel = !!d && d.payload_wrapped.startsWith("env1:") && !d.payload_wrapped.includes("tok-secret") && d.token_hash === await sha256("tok-secret");
    };
    const s = await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(storedBeforeRelabel).toBe(true);
    expect(hz.log).toEqual(["relabel", "attach:off", "poweron"]);
    expect(hz.created).toHaveLength(0); // no new server
    expect(s.id).toBe("hs-601");
    const srv = hz.servers.get("601")!;
    expect(srv.name).toBe("mcq-home-1-1");
    expect(srv.labels).toEqual({ "murage/role": "home", "murage/env": "staging", "murage/pool": "wp_601", "murage/home": "home-1", "murage/generation": "1",
      "murage/call": "k-create-00000001", owner: "MurageCloud", purpose: "customer-home" });
    expect(s.idempotency_key).toBe("k-create-00000001");
    expect((await p.list_by_tag("home-1", 1, "home")).map((r) => r.id)).toEqual(["hs-601"]);
    expect((await p.volume(v.id)).attachment).toMatchObject({ state: "attached", serverId: "hs-601" });
    await p.attach_volume(v.id, s.id); // provisionOnce's own attach: a no-op now
    expect(hz.log).toEqual(["relabel", "attach:off", "poweron"]);
  });

  it("a stale-image ready row is never claimed or rebuilt: the home takes the stock ladder", async () => {
    const hz = hetzner(["cx23:fsn1"]); await seedPool("wp_601", { image_id: "999" }); hz.addPool(601, { image: { id: 999 } }); await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput("home-1"));
    expect((await choiceOf("home-1"))!.pool_id).toBeNull();
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(hz.log).toEqual(["create"]);
    expect(await row("wp_601")).toMatchObject({ state: "ready", home_id: null });
  });

  it("a refused relabel keeps the relabel marker (a stale refusal can never erase it) and the retry relabels again", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    hz.opts.refuseRelabel = true;
    const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect(providerAnswered(error)).toBe(true);
    expect((await row("wp_601"))!.phase).toBe("relabeling@5");
    hz.opts.refuseRelabel = false;
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(hz.log).toEqual(["relabel", "relabel", "attach:off", "poweron"]);
  });

  it("1019 claim relabel builds from the CURRENT labels: a concurrent writer between the first read and the PUT is kept, expires_at stays dropped", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    // Anchor: the claim's pre-PUT read is the first server GET after the relabel marker is stored. The concurrent writer lands exactly there
    // (after the marker, before that read is served, hence before the PUT).
    let injected = 0;
    const inner = hz.fetcher;
    const fetcher: HostFetch = async (url, init) => {
      if ((init?.method ?? "GET") === "GET" && new URL(url).pathname === "/v1/servers/601" && injected === 0 && (await row("wp_601"))?.phase === "relabeling@5") {
        injected++; const s = hz.servers.get("601")!; s.labels = { ...s.labels, "murage/extra": "late", expires_at: "2026-11-20" };
      }
      return inner(url, init);
    };
    const pp = createLiveProvider(e(), { fetch: fetcher, now: () => 5, sleep: noSleep });
    await pp.create(serverInput("home-1", v, "k-create-00000001"));
    expect(injected).toBe(1);
    const l = hz.servers.get("601")!.labels;
    expect(l["murage/extra"]).toBe("late");
    expect("expires_at" in l).toBe(false);
    expect(l).toMatchObject({ "murage/home": "home-1", "murage/generation": "1", owner: "MurageCloud", purpose: "customer-home" });
  });

  it("1019 read-back finds murage/home missing: the claim fails loudly (claim_labels_incomplete), the row is not claimed done, the relabel marker stays, a retry relabels again", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    hz.opts.afterRelabel = (s) => { delete s.labels["murage/home"]; };
    const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect((error as Error).message).toBe("claim_labels_incomplete");
    expect(hz.log).toEqual(["relabel"]);
    expect((await row("wp_601"))!.phase).toBe("relabeling@5");
    hz.opts.afterRelabel = undefined;
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(hz.log).toEqual(["relabel", "relabel", "attach:off", "poweron"]);
  });

  it("1019 round 2: a read-back that finds expires_at, then a retry through create()'s discovered-server return, relabels again: no expires_at at the end", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    hz.opts.afterRelabel = (s) => { s.labels.expires_at = "2026-11-20"; hz.opts.afterRelabel = undefined; }; // a late writer re-adds it before the read-back
    const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect((error as Error).message).toBe("claim_labels_incomplete");
    expect((await row("wp_601"))!.phase).toBe("relabeling@5");
    await p.create(serverInput("home-1", v, "k-create-00000001")); // prepareServer now finds the server by its home labels
    const l = hz.servers.get("601")!.labels;
    expect("expires_at" in l).toBe(false);
    expect(l).toMatchObject({ "murage/home": "home-1", "murage/generation": "1", purpose: "customer-home" });
    expect(hz.log.filter((x) => x === "relabel")).toHaveLength(2);
  });

  it("1019 round 2: a read-back that finds expires_at, then B3 adoption by label into attach_volume, never finishes the claim with expires_at", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    hz.opts.afterRelabel = (s) => { s.labels.expires_at = "2026-11-20"; hz.opts.afterRelabel = undefined; };
    const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect((error as Error).message).toBe("claim_labels_incomplete");
    await p.attach_volume(v.id, "hs-601"); // B3 adopts the server by label and attaches
    const l = hz.servers.get("601")!.labels;
    expect("expires_at" in l).toBe(false);
    expect(l).toMatchObject({ "murage/home": "home-1", "murage/generation": "1", purpose: "customer-home" });
    expect(await row("wp_601")).toMatchObject({ phase: "powered" });
  });

  it("a lost relabel response is recovered by the murage/call label", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    hz.opts.loseRelabelResponse = true;
    const s = await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(s).toMatchObject({ id: "hs-601", idempotency_key: "k-create-00000001" });
    expect(hz.log).toEqual(["relabel", "attach:off", "poweron"]);
  });

  it("a pool server gone at claim: the row fails and a NORMAL create runs in the same type and location", async () => {
    const hz = hetzner();
    const { p, v } = await claimed(hz, { location: "nbg1" });
    hz.opts.gone.add("601");
    const s = await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(await row("wp_601")).toMatchObject({ state: "failed", fail_reason: "claim_server_gone" });
    expect(hz.created).toHaveLength(1);
    expect(hz.created[0]).toMatchObject({ server_type: "cx23", location: "nbg1", image: 452016490, start_after_create: true });
    expect(hz.created[0].user_data).toContain("murage_enrollment_token: tok-secret"); // the identity goes in cloud-init as today
    expect(hz.log).toEqual(["create"]);
    expect(s.id).not.toBe("hs-601");
  });

  it("a pool server that is not off at claim is fenced, failed and replaced by a normal create", async () => {
    const hz = hetzner();
    const { p, v } = await claimed(hz, {}, { status: "running" });
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(await row("wp_601")).toMatchObject({ state: "failed", fail_reason: "claim_server_not_off" });
    expect(hz.log).toEqual(["quarantine", "poweroff", "create"]);
    expect(hz.log).not.toContain("relabel");
    expect((await env.DB.prepare("SELECT kind,severity FROM cloud_alerts").first())).toMatchObject({ kind: "pool.anomaly", severity: "high" });
  });

  it("an interrupted claim (relabelled, still off, current image) is powered on by the retry's attach", async () => {
    const hz = hetzner(); const { p, v } = await claimed(hz);
    // simulate: relabel done, attach done, power-on lost (a worker died)
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    hz.servers.get("601")!.status = "off"; hz.log.length = 0;
    await p.attach_volume(v.id, "hs-601");
    expect(hz.log).toEqual(["poweron"]);
  });

  it("a home on a normal (ladder) server is untouched by the pool code: one create, no pool calls", async () => {
    const hz = hetzner(["cx23:fsn1"]); await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput("home-1"));
    const s = await p.create(serverInput("home-1", v, "k-create-00000001"));
    expect(hz.created).toHaveLength(1);
    await p.attach_volume(v.id, s.id);
    expect(hz.log).toEqual(["create"]);
  });
});

describe("give-up of a claim: never back to the pool", () => {
  async function homeRow(id: string, state: string, resourceGeneration = 1) {
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,resource_generation,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,'o',?,?,?,'sha256:x','k',1,1)`).bind(id, `inst-${id}`, state, state, resourceGeneration).run();
  }
  afterEach(async () => { await env.DB.prepare("DELETE FROM cloud_homes").run(); });
  const kinds = async (id: string) => (await env.DB.prepare("SELECT kind FROM warm_pool_events WHERE pool_id=? ORDER BY id").bind(id).all<{ kind: string }>()).results.map((r) => r.kind);
  it("fails (claim_abandoned) a claimed row whose home failed, never relabelled; drops the undelivered payload; never ready again", async () => {
    const config = provisionerConfig(e()); await seedPool("wp_701"); await homeRow("home-9", "failed");
    expect(await claimPoolServer(e(), config, { homeId: "home-9", resourceGeneration: 1, plan: "starter", now: 3 }, okArch)).toBe(true);
    await env.DB.prepare("INSERT INTO warm_pool_deliveries (pool_id,home_id,resource_generation,token_hash,payload_wrapped,created_at) VALUES ('wp_701','home-9',1,'h','v1.x.y',1)").run();
    expect(await failAbandonedClaims(e(), 9)).toBe(1);
    expect(await row("wp_701")).toMatchObject({ state: "failed", fail_reason: "claim_abandoned", home_id: "home-9" });
    expect(await env.DB.prepare("SELECT 1 FROM warm_pool_deliveries WHERE pool_id='wp_701'").first()).toBeNull();
    expect(await kinds("wp_701")).toEqual(["claimed", "claim_abandoned"]);
    expect(await failAbandonedClaims(e(), 10)).toBe(0); // idempotent
    expect(await claimPoolServer(e(), config, { homeId: "home-10", resourceGeneration: 1, plan: "starter", now: 11 }, okArch)).toBe(false); // nothing to take
  });
  it("a row whose relabel was started (any phase, no provider read) fails too; a home still provisioning keeps its claim", async () => {
    const config = provisionerConfig(e()); await seedPool("wp_702"); await seedPool("wp_703"); await homeRow("home-8", "failed"); await homeRow("home-7", "provisioning");
    await claimPoolServer(e(), config, { homeId: "home-8", resourceGeneration: 1, plan: "starter", now: 3 }, okArch);
    await claimPoolServer(e(), config, { homeId: "home-7", resourceGeneration: 1, plan: "starter", now: 3 }, okArch);
    await env.DB.prepare("UPDATE warm_pool SET phase='relabeling@1' WHERE home_id='home-8'").run();
    expect(await failAbandonedClaims(e(), 9)).toBe(1);
    expect((await env.DB.prepare("SELECT state FROM warm_pool WHERE home_id='home-8'").first())).toEqual({ state: "failed" });
    expect((await env.DB.prepare("SELECT state FROM warm_pool WHERE home_id='home-7'").first())).toEqual({ state: "claimed" });
  });
  it("fails a claim a re-opened home no longer holds (its resource generation moved on)", async () => {
    const config = provisionerConfig(e()); await seedPool("wp_704"); await homeRow("home-6", "provisioning", 2);
    await claimPoolServer(e(), config, { homeId: "home-6", resourceGeneration: 1, plan: "starter", now: 3 }, okArch);
    expect(await failAbandonedClaims(e(), 9)).toBe(1);
    expect(await row("wp_704")).toMatchObject({ state: "failed", fail_reason: "claim_abandoned" });
  });
  it("round-3 #4: resolved rows never occupy slots: 60 abandoned claims (relabel started, server already deleted by B3) and a later one all resolve in one pass", async () => {
    const config = provisionerConfig(e());
    for (let i = 0; i < 61; i++) {
      await seedPool(`wp_8${String(i).padStart(2, "0")}`, { ready_at: 100 + i }); await homeRow(`home-8${i}`, "deleted");
      await claimPoolServer(e(), config, { homeId: `home-8${i}`, resourceGeneration: 1, plan: "starter", now: 3 }, okArch);
      if (i < 60) await env.DB.prepare("UPDATE warm_pool SET phase='relabeling@1' WHERE home_id=?").bind(`home-8${i}`).run();
    }
    expect(await failAbandonedClaims(e(), 9)).toBe(61);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM warm_pool WHERE state='claimed'").first<{ n: number }>())!.n).toBe(0);
    expect(await failAbandonedClaims(e(), 10)).toBe(0);
  });
});

describe("cloud-config route (5.2, 5.4, spike rules)", () => {
  const SERVER_IP = "203.0.113.50";
  const url = (id: string, secret = secretOf(id)) => `https://cp.murage.test/v1/pool/${id}/cloud-config/${secret}`;
  const get = (id: string, ip = SERVER_IP, secret?: string, method = "GET") => new Request(url(id, secret), { method, headers: { "CF-Connecting-IP": ip } });
  async function delivered(hz = hetzner(), over: { used?: boolean; expires?: number } = {}) {
    await seedPool("wp_801"); hz.addPool(801); await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput("home-1"));
    await p.create(serverInput("home-1", v, "k-create-00000001"));
    const hash = await sha256("tok-secret");
    await env.DB.prepare("INSERT INTO cloud_provision_intents (home_id,cp_generation,resource_generation,token_hash,state,created_at) VALUES ('home-1',1,1,?,'pending',1)").bind(hash).run();
    await env.DB.prepare("INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at,used_at) VALUES (?,?,?,?)").bind(hash, "home-1", over.expires ?? 10_000_000, over.used ? 50 : null).run();
    return { hz, p, v };
  }
  const deps = (hz: ReturnType<typeof hetzner>) => ({ adapter: hz.adapter(), now: () => 1000 });
  const body = async (r: Response) => ({ status: r.status, text: await r.text() });
  const decoded = (config: string, path: string) => {
    const lines = config.split("\n"); const i = lines.findIndex((l) => l === `  - path: ${path}`);
    expect(i).toBeGreaterThan(-1);
    const content = /content: (\S+)/.exec(lines[i + 4])![1];
    return new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
  };

  it("serves the identity to the server's own IP, again on a re-fetch, until the token is used", async () => {
    const { hz } = await delivered();
    const first = await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(hz)))!);
    expect(first.status).toBe(200);
    expect(first.text.startsWith("#cloud-config\n")).toBe(true);
    const userData = decoded(first.text, "/var/lib/cloud/instance/user-data.txt");
    expect(userData).toContain("murage_enrollment_token: tok-secret");
    expect(userData).toContain("murage_home_id: home-1");
    expect(userData).toContain("/etc/murage-home/volume.json");
    expect(decoded(first.text, "/etc/murage-home/claim-user-data")).toBe(userData);
    expect(first.text).toContain("permissions: '0600'");
    expect(first.text.match(/^write_files:$/gm)).toHaveLength(1);      // one write_files key, the user-data's own entries kept
    expect(first.text).toContain("path: /etc/murage-home/volume.json");
    expect(first.text).not.toContain("runcmd:");                        // everything rides in write_files
    const again = await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(hz)))!);
    expect(again.text).toBe(first.text);
    expect(await env.DB.prepare("SELECT fetch_count,first_fetched_at FROM warm_pool_deliveries WHERE pool_id='wp_801'").first()).toMatchObject({ fetch_count: 2, first_fetched_at: 1000 });
    expect(await row("wp_801")).toMatchObject({ state: "claimed" });
    expect(hz.log).not.toContain("quarantine");
  });

  it("claimCloudConfig keeps a single write_files key and refuses a payload without one", () => {
    const ud = "#cloud-config\nmurage_home_id: h\nwrite_files:\n  - path: /a\n    content: 'x'\nruncmd:\n  - [true]\n";
    const out = claimCloudConfig(ud);
    expect(out.match(/^write_files:$/gm)).toHaveLength(1);
    expect(out).toContain("runcmd:");
    expect(() => claimCloudConfig("#cloud-config\nfoo: 1\n")).toThrow("pool_payload_shape");
  });

  it("after the token is used, the same server rebooting gets a harmless config: no poweroff, no quarantine, no alert", async () => {
    const { hz } = await delivered(hetzner(), { used: true });
    const r = await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(hz)))!);
    expect(r).toEqual({ status: 200, text: HARMLESS_CONFIG });
    expect(r.text).toBe("#cloud-config\n{}\n");
    // even once the grabber purged the payload and revoked the secret, the customer's home is left alone
    await env.DB.batch([env.DB.prepare("UPDATE warm_pool SET secret_hash=NULL WHERE id='wp_801'"),
      env.DB.prepare("UPDATE warm_pool_deliveries SET payload_wrapped=NULL,purged_at=9 WHERE pool_id='wp_801'")]);
    for (const secret of [undefined, "a-completely-different-secret"]) {
      expect(await body((await poolCloudConfigRoute(get("wp_801", SERVER_IP, secret), e(), deps(hz)))!)).toEqual({ status: 200, text: HARMLESS_CONFIG });
    }
    expect(await row("wp_801")).toMatchObject({ state: "claimed" });
    expect(hz.log).not.toContain("quarantine"); expect(hz.log).not.toContain("poweroff");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts").first<{ n: number }>())!.n).toBe(0);
    // another address gets nothing (and fences nothing)
    expect((await poolCloudConfigRoute(get("wp_801", "198.51.100.9"), e(), deps(hz)))!.status).toBe(404);
    expect(await row("wp_801")).toMatchObject({ state: "claimed" });
  });

  it("an unclaimed (ready) row that fetches is fenced: poweroff config, failed, quarantined, high alert", async () => {
    const hz = hetzner(); await seedPool("wp_802"); hz.addPool(802);
    const r = await body((await poolCloudConfigRoute(get("wp_802"), e(), deps(hz)))!);
    expect(r).toEqual({ status: 200, text: POWEROFF_CONFIG });
    expect(r.text).toContain("mode: poweroff");
    expect(await row("wp_802")).toMatchObject({ state: "failed", fail_reason: "cloud_config_fetched_while_unclaimed" });
    expect(hz.log).toEqual(["quarantine", "poweroff"]);
    expect(await env.DB.prepare("SELECT kind,severity FROM cloud_alerts").first()).toMatchObject({ kind: "pool.anomaly", severity: "high" });
    // a second fetch is answered the same way without another fence
    hz.log.length = 0;
    expect(await body((await poolCloudConfigRoute(get("wp_802"), e(), deps(hz)))!)).toEqual({ status: 200, text: POWEROFF_CONFIG });
    expect(hz.log).toEqual([]);
  });

  it("a stranger with neither the secret nor the IP learns nothing and fences nothing", async () => {
    const hz = hetzner(); await seedPool("wp_803"); hz.addPool(803);
    const r = (await poolCloudConfigRoute(get("wp_803", "198.51.100.9", "not-the-secret-0000000"), e(), deps(hz)))!;
    expect(r.status).toBe(404);
    expect((await poolCloudConfigRoute(get("wp_nope", "198.51.100.9"), e(), deps(hz)))!.status).toBe(404);
    expect(await row("wp_803")).toMatchObject({ state: "ready" }); expect(hz.log).toEqual([]);
    // the right secret from elsewhere on an unclaimed row: 404 + alert, still no fence
    expect((await poolCloudConfigRoute(get("wp_803", "198.51.100.9"), e(), deps(hz)))!.status).toBe(404);
    expect(await row("wp_803")).toMatchObject({ state: "ready" }); expect(hz.log).toEqual([]);
    expect((await env.DB.prepare("SELECT kind FROM cloud_alerts").first())).toMatchObject({ kind: "pool.secret_misuse" });
  });

  it("the right secret from the wrong IP (a replayed logged URL): 404 and a high alert; NO quarantine, power-off, failed row or revocation", async () => {
    const { hz } = await delivered();
    const r = await body((await poolCloudConfigRoute(get("wp_801", "198.51.100.9"), e(), deps(hz)))!);
    expect(r.status).toBe(404);
    expect(await row("wp_801")).toMatchObject({ state: "claimed", fail_reason: null });
    expect((await row("wp_801"))!.secret_hash).not.toBeNull();
    expect(hz.log).not.toContain("quarantine"); expect(hz.log).not.toContain("poweroff");
    expect(await env.DB.prepare("SELECT kind,severity FROM cloud_alerts").first()).toMatchObject({ kind: "pool.secret_misuse", severity: "high" });
    // the real server still gets its payload
    expect((await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(hz)))!)).text).toContain("murage_enrollment_token: tok-secret");
  });

  it("a wrong secret is a 404 from any IP (alert for a known row), never a fence of a claimed row", async () => {
    const { hz } = await delivered();
    expect((await poolCloudConfigRoute(get("wp_801", "198.51.100.9", "wrong-secret-0000000000"), e(), deps(hz)))!.status).toBe(404);
    expect((await poolCloudConfigRoute(get("wp_801", SERVER_IP, "wrong-secret-0000000000"), e(), deps(hz)))!.status).toBe(404);
    expect(await row("wp_801")).toMatchObject({ state: "claimed" });
    expect(hz.log).toEqual(["relabel", "attach:off", "poweron"]); // only the claim's own calls: no quarantine, no power-off
  });

  it("claimed with the delivery not yet stored gives 404 (cloud-init retries); a token that expired or an intent that is gone gives nothing to hand over", async () => {
    const hz = hetzner(); await seedPool("wp_804"); hz.addPool(804);
    await claimPoolServer(e(), provisionerConfig(e()), { homeId: "home-5", resourceGeneration: 1, plan: "starter", now: 1 }, okArch);
    expect((await poolCloudConfigRoute(get("wp_804"), e(), deps(hz)))!.status).toBe(404);
    expect(await row("wp_804")).toMatchObject({ state: "claimed" });
    const d = await delivered(hetzner(), { expires: 500 }); // now() = 1000: expired
    expect(await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(d.hz)))!)).toEqual({ status: 200, text: HARMLESS_CONFIG });
    await env.DB.prepare("UPDATE cloud_enrollment_tokens SET expires_at=99999999").run();
    await env.DB.prepare("UPDATE cloud_provision_intents SET state='failed'").run();
    expect(await body((await poolCloudConfigRoute(get("wp_801"), e(), deps(d.hz)))!)).toEqual({ status: 200, text: HARMLESS_CONFIG });
  });

  it("a failed or retired row answers poweroff to a caller that holds the secret or the IP, and 404 to others", async () => {
    const hz = hetzner(); await seedPool("wp_805", { state: "failed" });
    expect(await body((await poolCloudConfigRoute(get("wp_805"), e(), deps(hz)))!)).toEqual({ status: 200, text: POWEROFF_CONFIG });
    expect((await poolCloudConfigRoute(get("wp_805", "198.51.100.9", "wrong-secret-0000000000"), e(), deps(hz)))!.status).toBe(404);
  });

  it("only GET on the exact path is this route; the secret segment is redacted for logs; the edge limiter covers it per IP", async () => {
    expect(await poolCloudConfigRoute(get("wp_801", SERVER_IP, undefined, "POST"), e())).toBeNull();
    expect(await poolCloudConfigRoute(new Request("https://cp.murage.test/v1/pool/wp_801/cloud-config/short"), e())).toBeNull();
    expect(await poolCloudConfigRoute(new Request("https://cp.murage.test/v1/pool/wp_801/other/abcdefghijklmnopqrst"), e())).toBeNull();
    expect(redactPoolPath(`/v1/pool/wp_801/cloud-config/${secretOf("wp_801")}`)).toBe("/v1/pool/wp_801/cloud-config/[redacted]");
    expect(classifyEdge(get("wp_801"))).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: `pool:${SERVER_IP}` });
    expect(classifyEdge(get("wp_801", SERVER_IP, undefined, "POST"))).toBeNull();
  });

  it("never logs the secret, the token or the payload", async () => {
    const { hz } = await delivered();
    const seen: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try {
      await poolCloudConfigRoute(get("wp_801"), e(), deps(hz));
      const failing = (await poolCloudConfigRoute(get("wp_801"), e({}, { CLOUD_KEK_V1: btoa("y".repeat(32)) }), deps(hz)))!; // the delivery cannot be unwrapped
      expect(failing.status).toBe(503);
      await poolCloudConfigRoute(get("wp_801", "198.51.100.9"), e(), deps(hz));
    } finally { Object.assign(console, orig); }
    expect(seen.join("\n")).not.toContain(secretOf("wp_801"));
    expect(seen.join("\n")).not.toContain("tok-secret");
  });
});

describe("fastProvision (4.1)", () => {
  const CONFIG = JSON.stringify({ reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: `sha256:${"a".repeat(64)}`, quarantineRelayIP: "192.0.2.20",
    engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true }, capacity: [] });
  const fenv = () => e({}, { CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: CONFIG });
  const home = (id: string, state: string, entitlement: string, updated: number) => env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at) VALUES (?,?,'o',?,?,?,'sha256:x','k',1,?)`)
    .bind(id, `inst-${id}`, state, state, entitlement, updated).run();
  afterEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM cloud_homes"), env.DB.prepare("DELETE FROM provision_attempts")]); });

  it("does nothing when B3 is off", async () => {
    expect(await fastProvision({ ...fenv(), CLOUD_B3_MODE: undefined } as unknown as Env, { provider: () => { throw new Error("no provider"); } })).toBe(0);
  });

  it("gives each paid provisioning home its pass now, oldest first, at most 20, and no other home", async () => {
    await home("h-old", "provisioning", "paid", 5);
    for (let i = 0; i < 22; i++) await home(`h-${String(i).padStart(2, "0")}`, "provisioning", "paid", 100 + i);
    await home("h-unpaid", "provisioning", "pending", 1); await home("h-ready", "ready", "paid", 1);
    const seen: string[] = [];
    const provider = (): ProviderAdapter => ({ list_by_tag: async (id: string) => { seen.push(id); throw new Error("stop_here"); } } as unknown as ProviderAdapter);
    const failures = await fastProvision(fenv(), { provider });
    expect(seen).toHaveLength(20); // one pass per home
    expect(seen.slice(0, 3)).toEqual(["h-old", "h-00", "h-01"]);
    expect(seen).not.toContain("h-unpaid"); expect(seen).not.toContain("h-ready"); expect(seen).not.toContain("h-21");
    expect(failures).toBe(20);
    const attempts = await env.DB.prepare("SELECT home_id,attempts FROM provision_attempts ORDER BY home_id").all<{ home_id: string; attempts: number }>();
    expect(attempts.results).toHaveLength(20);
    expect(attempts.results.every((a) => a.attempts === 1)).toBe(true);
  });

  it("an overlapping pass is held off by the per-home lease (a second call in the same minute makes no second attempt)", async () => {
    await home("h-1", "provisioning", "paid", 5);
    const seen: string[] = [];
    const provider = (): ProviderAdapter => ({ list_by_tag: async (id: string) => { seen.push(id); throw new Error("stop_here"); } } as unknown as ProviderAdapter);
    await fastProvision(fenv(), { provider }); await fastProvision(fenv(), { provider });
    expect(seen).toEqual(["h-1"]);
  });
});

// ---- Astra P3 review (6cc3122a5): each test below failed before its fix ---------------------------------------------------------------------
describe("Astra P3 findings", () => {
  const SERVER_IP = "203.0.113.50";
  const base = () => { const hz = hetzner(); return hz; };
  async function claimedHome(hz: ReturnType<typeof hetzner>, poolOver: Record<string, unknown> = {}, home = "home-1") {
    await seedPool("wp_901", poolOver); hz.addPool(901); await plan(home, "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput(home));
    return { p, v };
  }
  const homeRow = (id: string, state: string, resourceGeneration = 1) => env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,resource_generation,image_digest,home_key,created_at,updated_at) VALUES (?,?,'o',?,?,?,'sha256:x','k',1,1)`)
    .bind(id, `inst-${id}`, state, state, resourceGeneration).run();
  afterEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM cloud_homes"), env.DB.prepare("DELETE FROM provision_attempts")]); vi.useRealTimers(); });

  it("P1-1: a stale claimant (its row released and taken by another home mid-attempt) stops before any provider call and writes nothing of the new owner's", async () => {
    const hz = base(); const { p, v } = await claimedHome(hz);
    hz.opts.onGetServer = async () => { await env.DB.prepare("UPDATE warm_pool SET home_id='home-B',resource_generation=1 WHERE id='wp_901'").run(); };
    const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect((error as Error).message).toBe("pool_ownership_lost");
    expect(hz.log).toEqual([]);                                   // no relabel, attach, rebuild or power-on
    expect(hz.servers.get("901")!.labels["murage/role"]).toBe("pool");
    expect(await row("wp_901")).toMatchObject({ state: "claimed", home_id: "home-B", phase: null });
  });

  it("P1-1: the delivery upsert is guarded by the owner: a stale claimant cannot overwrite the new owner's payload", async () => {
    const hz = base(); const { p, v } = await claimedHome(hz);
    const wrapper = { wrap: async (_h: string, b: Uint8Array<ArrayBuffer>) => {
      // between the claimant's pool read and its upsert, B takes the row and stores its own delivery
      await env.DB.batch([env.DB.prepare("UPDATE warm_pool SET home_id='home-B' WHERE id='wp_901'"),
        env.DB.prepare("INSERT INTO warm_pool_deliveries (pool_id,home_id,resource_generation,token_hash,payload_wrapped,created_at) VALUES ('wp_901','home-B',1,'hB','env1:B',1)")]);
      return `v1.${btoa(String.fromCharCode(...b.slice(0, 8)))}.x`;
    }, unwrap: async () => new Uint8Array(32) as Uint8Array<ArrayBuffer> };
    const p2 = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep, wrapper });
    const error = await p2.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect((error as Error).message).toBe("pool_ownership_lost");
    expect(await env.DB.prepare("SELECT home_id,payload_wrapped FROM warm_pool_deliveries WHERE pool_id='wp_901'").first()).toEqual({ home_id: "home-B", payload_wrapped: "env1:B" });
    expect(hz.log).toEqual([]);
    void p;
  });

  it("P1-2: provision() stamps its lease when it TAKES it, not at the pass's start time", async () => {
    for (const id of ["h-a", "h-b"]) await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,'o','provisioning','provisioning','paid','sha256:x','k',1,?)`).bind(id, `inst-${id}`, id === "h-a" ? 1 : 2).run();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const provider = (): ProviderAdapter => ({ list_by_tag: async (id: string) => { if (id === "h-a") vi.setSystemTime(start + 30_000); throw new Error("stop_here"); } } as unknown as ProviderAdapter);
    await fastProvision(fenv(), { provider });
    const b = await env.DB.prepare("SELECT next_at FROM provision_attempts WHERE home_id='h-b'").first<{ next_at: number }>();
    // the first failure backs h-a off; h-b's lease was taken at start+30 s and must run a full lease from THERE
    expect(b!.next_at).toBeGreaterThan(start + 30_000 + 60_000 - 1);
  });

  it("P1-2: the pass stops taking homes before its 50 s deadline", async () => {
    for (const id of ["h-a", "h-b"]) await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,'o','provisioning','provisioning','paid','sha256:x','k',1,?)`).bind(id, `inst-${id}`, id === "h-a" ? 1 : 2).run();
    vi.useFakeTimers({ toFake: ["Date"] });
    const seen: string[] = [];
    const provider = (): ProviderAdapter => ({ list_by_tag: async (id: string) => { seen.push(id); vi.setSystemTime(Date.now() + 55_000); throw new Error("stop_here"); } } as unknown as ProviderAdapter);
    await fastProvision(fenv(), { provider });
    expect(seen).toEqual(["h-a"]);
  });

  const CONFIG = JSON.stringify({ reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: `sha256:${"a".repeat(64)}`, quarantineRelayIP: "192.0.2.20",
    engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true }, capacity: [] });
  const fenv = () => e({}, { CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: CONFIG });

  it("P2-3 (round 3): fastProvision fails abandoned claims; no provider is read and nothing goes back to ready", async () => {
    const hz = base(); await seedPool("wp_921"); hz.addPool(921); await homeRow("home-921", "failed");
    await claimPoolServer(e(), provisionerConfig(e()), { homeId: "home-921", resourceGeneration: 1, plan: "starter", now: 1 }, okArch);
    await env.DB.prepare("UPDATE warm_pool SET phase='relabeling@1' WHERE id='wp_921'").run();
    await fastProvision(fenv(), { provider: () => ({}) as unknown as ProviderAdapter });
    expect(await row("wp_921")).toMatchObject({ state: "failed", fail_reason: "claim_abandoned" });
    expect(hz.log).toEqual([]);
  });

  it("P2-5: a payload far over the KMS 4096-byte Encrypt limit is stored (envelope) and served", async () => {
    const limited = { wrap: async (_h: string, b: Uint8Array<ArrayBuffer>) => { if (b.length > 4096) throw new Error("kms_plaintext_too_large"); return `v1.${btoa(String.fromCharCode(...b))}.x`; },
      unwrap: async (_h: string, w: string) => Uint8Array.from(atob(w.split(".")[1]), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer> };
    const hz = base(); await seedPool("wp_931"); hz.addPool(931); await plan("home-1", "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep, wrapper: limited });
    const v = await p.create_volume(volumeInput("home-1"));
    const big = "t".repeat(9000); // > 8 KiB
    await p.create(serverInput("home-1", v, "k-create-00000001", big));
    const stored = (await env.DB.prepare("SELECT payload_wrapped FROM warm_pool_deliveries WHERE pool_id='wp_931'").first<{ payload_wrapped: string }>())!.payload_wrapped;
    expect(stored.length).toBeGreaterThan(9000); expect(stored).not.toContain(big);
    const hash = await sha256(big);
    await env.DB.prepare("INSERT INTO cloud_provision_intents (home_id,cp_generation,resource_generation,token_hash,state,created_at) VALUES ('home-1',1,1,?,'pending',1)").bind(hash).run();
    await env.DB.prepare("INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at) VALUES (?,?,?)").bind(hash, "home-1", 10_000_000).run();
    const r = await poolCloudConfigRoute(new Request(`https://cp.murage.test/v1/pool/wp_931/cloud-config/${secretOf("wp_931")}`, { headers: { "CF-Connecting-IP": SERVER_IP } }), e(),
      { adapter: hz.adapter(), now: () => 1000, wrapper: limited });
    expect(r!.status).toBe(200);
    expect(await r!.text()).toContain(`murage_enrollment_token: ${big}`.slice(0, 400));
  });

  it("P2-7: homes backing off (provision_attempts.next_at ahead) do not take the fast pass's slots", async () => {
    for (let i = 0; i < 20; i++) {
      const id = `b-${String(i).padStart(2, "0")}`;
      await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,'o','provisioning','provisioning','paid','sha256:x','k',1,?)`).bind(id, `inst-${id}`, i + 1).run();
      await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,first_at,next_at,attempts) VALUES (?,1,1,?,1)").bind(id, Date.now() + 600_000).run();
    }
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
      VALUES ('h-21','inst-21','o','provisioning','provisioning','paid','sha256:x','k',1,999)`).run();
    const seen: string[] = [];
    await fastProvision(fenv(), { provider: () => ({ list_by_tag: async (id: string) => { seen.push(id); throw new Error("stop_here"); } }) as unknown as ProviderAdapter });
    expect(seen).toEqual(["h-21"]);
  });

  it("P3-8: unknown id, wrong secret and claimed rows do the same D1 reads and answer the same 404; the pool path carries no Server-Timing", async () => {
    const hz = base(); await seedPool("wp_941"); await seedPool("wp_942", { state: "claimed", home_id: "home-x", resource_generation: 1 });
    let n = 0;
    const counting = new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (q: string) => { n++; return t.prepare(q); } : typeof (t as any)[k] === "function" ? (t as any)[k].bind(t) : (t as any)[k]) });
    const cenv = { ...e(), DB: counting } as Env;
    const ask = async (id: string, secret: string) => { n = 0; const r = (await poolCloudConfigRoute(new Request(`https://cp.murage.test/v1/pool/${id}/cloud-config/${secret}`,
      { headers: { "CF-Connecting-IP": "198.51.100.9" } }), cenv, { adapter: hz.adapter(), now: () => 1 }))!; return { status: r.status, text: await r.text(), n }; };
    const unknown = await ask("wp_none", "wrong-secret-0000000000");
    const ready = await ask("wp_941", "wrong-secret-0000000000");
    const claimed = await ask("wp_942", "wrong-secret-0000000000");
    expect([unknown.status, ready.status, claimed.status]).toEqual([404, 404, 404]);
    expect(new Set([unknown.text, ready.text, claimed.text]).size).toBe(1);
    expect([ready.n, claimed.n]).toEqual([unknown.n, unknown.n]);
    expect(isPoolPath("/v1/pool/wp_1/cloud-config/x")).toBe(true);
    const ctx = createExecutionContext();
    const res = await createWorker(async () => { throw new Error("net"); }, async () => { throw new Error("net"); }).fetch(
      new Request("https://cp.murage.test/v1/pool/wp_none/cloud-config/wrong-secret-0000000000", { headers: { "CF-Connecting-IP": "198.51.100.9" } }), e(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("server-timing")).toBeNull();
  });
});

// ---- Astra P3 round 2 (cf5912927): each test below fails on cf5912927 ------------------------------------------------------------------------
describe("Astra P3 round 2", () => {
  const base = () => hetzner();
  async function claimedHome(hz: ReturnType<typeof hetzner>, poolOver: Record<string, unknown> = {}, home = "home-1") {
    await seedPool("wp_901", poolOver); hz.addPool(901, poolOver.image_id === "999" ? { image: { id: 999 } } : {}); await plan(home, "starter");
    const p = createLiveProvider(e(), { fetch: hz.fetcher, now: () => 5, sleep: noSleep });
    const v = await p.create_volume(volumeInput(home));
    return { p, v };
  }
  const homeRow = (id: string, state: string, resourceGeneration = 1) => env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,resource_generation,image_digest,home_key,created_at,updated_at) VALUES (?,?,'o',?,?,?,'sha256:x','k',1,1)`)
    .bind(id, `inst-${id}`, state, state, resourceGeneration).run();
  /** The provisioning lease of a home's attempt, held by `token` (the column only exists from migration 0111). */
  async function lease(home: string, token: string) {
    await env.DB.prepare("INSERT OR IGNORE INTO provision_attempts (home_id,resource_generation,first_at) VALUES (?,1,1)").bind(home).run();
    try { await env.DB.prepare("UPDATE provision_attempts SET lease_token=? WHERE home_id=?").bind(token, home).run(); }
    catch (x) { if (!/no such column/i.test(String(x))) throw x; }
  }
  const fenceOf = (home: string, token: string) => ({ homeId: home, resourceGeneration: 1, token });
  afterEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM cloud_homes"), env.DB.prepare("DELETE FROM provision_attempts"),
    env.DB.prepare("DELETE FROM cloud_resource_dispatch_calls")]); });

  describe("#1 lease fencing", () => {
    it("an attempt that lost the lease and sees the server RUNNING (the new holder booted it) never quarantines or fences it", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz); await lease("home-1", "tok-A");
      hz.opts.onGetServer = async () => { // attempt B takes the lease (new token) and boots the server before A reads it
        await lease("home-1", "tok-B"); hz.servers.get("901")!.status = "running"; };
      const error = await p.create({ ...serverInput("home-1", v, "k-create-00000001"), fence: fenceOf("home-1", "tok-A") }).then(() => null, (x: unknown) => x);
      expect((error as Error).message).toBe("pool_lease_lost");
      expect(hz.log).toEqual([]);                                  // no quarantine, power-off, relabel
      expect(await row("wp_901")).toMatchObject({ state: "claimed", fail_reason: null });
      expect((await env.DB.prepare("SELECT 1 FROM cloud_alerts").first())).toBeNull();
    });
    it("the holder with a live token still fences a running server as before", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz, {}); await lease("home-1", "tok-A"); hz.servers.get("901")!.status = "running";
      await p.create({ ...serverInput("home-1", v, "k-create-00000001"), fence: fenceOf("home-1", "tok-A") });
      expect(await row("wp_901")).toMatchObject({ state: "failed", fail_reason: "claim_server_not_off" });
    });
    it("a lease lost before the relabel: no relabel, no phase written", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz); await lease("home-1", "tok-A");
      hz.opts.onGetServer = async () => { await lease("home-1", "tok-B"); };
      const error = await p.create({ ...serverInput("home-1", v, "k-create-00000001"), fence: fenceOf("home-1", "tok-A") }).then(() => null, (x: unknown) => x);
      expect((error as Error).message).toBe("pool_lease_lost");
      expect(hz.log).toEqual([]);
      expect(await row("wp_901")).toMatchObject({ phase: null });
    });
    it("a lease lost after the relabel stops before the attach, rebuild and power-on", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz); await lease("home-1", "tok-A");
      hz.opts.beforeRelabel = async () => { await lease("home-1", "tok-B"); };
      const error = await p.create({ ...serverInput("home-1", v, "k-create-00000001"), fence: fenceOf("home-1", "tok-A") }).then(() => null, (x: unknown) => x);
      expect((error as Error).message).toBe("pool_lease_lost");
      expect(providerAnswered(error)).toBe(false);
      expect(hz.log).toEqual(["relabel"]);
      expect(hz.servers.get("901")!.status).toBe("off");
    });
    it("a fenced attach_volume of a stale attempt does nothing", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz); await lease("home-1", "tok-A");
      await p.create({ ...serverInput("home-1", v, "k-create-00000001"), fence: fenceOf("home-1", "tok-A") });
      hz.servers.get("901")!.status = "off"; hz.log.length = 0; await env.DB.prepare("UPDATE warm_pool SET phase='relabeling@5' WHERE id='wp_901'").run();
      await lease("home-1", "tok-B");
      await expect(p.attach_volume(v.id, "hs-901", fenceOf("home-1", "tok-A"))).rejects.toThrow("pool_lease_lost");
      expect(hz.log).toEqual([]);
    });
  });

  describe("#4 power-on is verified", () => {
    it("the intent is persisted before the power-on, the action id after; success marks the claim powered", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz);
      let before: string | null = null;
      hz.opts.beforePowerOn = async () => { before = (await row("wp_901"))!.phase; };
      await p.create(serverInput("home-1", v, "k-create-00000001"));
      expect(before).toBe("power_on_sending@5");
      expect((await row("wp_901"))!.phase).toBe("powered");
    });
    it("a power-on action that FAILED is not success: the create fails, the retry powers on again", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz);
      hz.actions.set("2", "error");
      const error = await p.create(serverInput("home-1", v, "k-create-00000001")).then(() => null, (x: unknown) => x);
      expect((error as Error).message).toBe("claim_power_on_failed");
      expect((await row("wp_901"))!.phase).toBe("powering_on@2");
      hz.servers.get("901")!.status = "off"; hz.actions.set("2", "success"); hz.log.length = 0; // a failed power-on leaves the server off
      await p.attach_volume(v.id, "hs-901");
      expect(hz.log).toEqual(["poweron"]);
      expect((await row("wp_901"))!.phase).toBe("powered");
    });
    it("recovery of a power-on still running or failed (server reported starting) is never success", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz);
      await p.create(serverInput("home-1", v, "k-create-00000001"));
      hz.servers.get("901")!.status = "starting";
      await env.DB.prepare("UPDATE warm_pool SET phase='powering_on@9' WHERE id='wp_901'").run();
      hz.actions.set("9", "running");
      await expect(p.attach_volume(v.id, "hs-901")).rejects.toThrow("claim_power_on_in_progress");
      hz.actions.set("9", "error");
      await expect(p.attach_volume(v.id, "hs-901")).rejects.toThrow("claim_power_on_failed");
      hz.actions.set("9", "success");
      await p.attach_volume(v.id, "hs-901");
      expect((await row("wp_901"))!.phase).toBe("powered");
    });
    it("a lost power-on id: only a start action after the intent counts", async () => {
      const hz = base(); const { p, v } = await claimedHome(hz);
      await p.create(serverInput("home-1", v, "k-create-00000001"));
      hz.servers.get("901")!.status = "starting";
      await env.DB.prepare("UPDATE warm_pool SET phase='power_on_sending@10000000000' WHERE id='wp_901'").run();
      await expect(p.attach_volume(v.id, "hs-901")).rejects.toThrow("claim_power_on_unconfirmed");
      hz.history.push({ id: 8, command: "start_server", status: "success", started: new Date(10_000_000_100).toISOString() });
      await p.attach_volume(v.id, "hs-901");
      expect((await row("wp_901"))!.phase).toBe("powered");
    });
  });
});
