// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool integration: the minute tick (grabber then fastProvision on one 50 s deadline) and the contracts between the grabber (L2) and the claim (L3).
import { env as baseEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostError, type PoolServer } from "../src/b5-provisioner";
import { MINUTE_TICK_DEADLINE_MS, MINUTE_TICK_GRABBER_MS, minuteTick, runGrabber as runGrabberRaw, type PoolHost } from "../src/warm-pool";
import { GRAB_VERIFY, IMG_KINDS_T0, PUBKEY, okArch } from "./image-sig-fixture";
const runGrabber: typeof runGrabberRaw = (e, now, deps = {}) => runGrabberRaw(e, now, { ...deps, verify: GRAB_VERIFY });
import { claimPoolServer, purgeUsedDeliveries } from "../src/warm-pool-claim";
import { provisionerConfig } from "../src/b5-config";

const T0 = 1_800_000_000_000;
const IMAGES = { hetzner: { x86: "111", arm: "222" }, vultr: { x86: "s" } };
const cls = (types: [string, "x86" | "arm"][], target: number) => ({ rungs: types.map(([serverType, arch]) => ({ serverType, arch })), target, red: Math.min(1, target), max: 20 });
const pool = (starter = 0, cap = 500) => ({ env: "staging", monthlyIdleCapEur: cap, maxCreatesPerTick: 10, maxCreatesPerDay: 150, maxConsecutiveCreateFailures: 5,
  classes: { starter: cls([["cx23", "x86"], ["cax11", "arm"]], starter), pro: cls([["cax21", "arm"], ["cx33", "x86"]], 0) },
  limits: { vcpu: 100, primaryIps: 50, volumeGb: 5000, reserveForLive: { vcpu: 20, primaryIps: 10, volumeGb: 1000 } } });
const mkEnv = (starter = 0, cap = 500) => ({ ...baseEnv, HCLOUD_TOKEN: "hz-test-token", B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES, imageKinds: IMG_KINDS_T0, firewallIds: [5], sshKeyIds: [], quarantineFirewallId: 77, pool: pool(starter, cap) }), B5_IMAGE_VERIFY_PUBKEY: PUBKEY }) as unknown as Env;

class Fake {
  servers = new Map<string, PoolServer>();
  calls: string[] = [];
  put(id: string, labels: Record<string, string>, imageId = "111") { this.servers.set(id, { id, status: "off", name: `n-${id}`, imageId, labels, ipv4: "203.0.113.9" } as PoolServer); }
  types: any[] = [];
  creates: string[] = [];
  vcpuPer = 0; // vCPU the project reports per existing server
  async createPoolServer(i: any) { this.creates.push(i.type); this.put(`c${this.creates.length}`, i.labels); return this.servers.get(`c${this.creates.length}`)!; }
  async serverTypes() { return this.types; }
  async listByLabel(sel: string) { const w = sel.split(",").map((p) => p.split("=")); return [...this.servers.values()].filter((s) => w.every(([k, v]) => s.labels[k] === v)); }
  async getServerDetail(id: string) { const s = this.servers.get(id); if (!s) throw new HostError(404, "not_found"); return s; }
  async projectUsage() { return { vcpu: this.vcpuPer * this.servers.size, primaryIps: 0, volumeGb: 0 }; }
  async deleteServer(id: string) { this.calls.push(`delete:${id}`); const gone = !this.servers.has(id); this.servers.delete(id); return { actionId: null, status: "success" as const, gone }; }
  async actionStatus() { return "none" as const; }
  async quarantine(id: string) { this.calls.push(`quarantine:${id}`); }
  async powerOff(id: string) { this.calls.push(`powerOff:${id}`); return { actionId: "1", status: "success" as const }; }
}
let hz: Fake;
let clock = T0;
const asHost = () => hz as unknown as PoolHost;
const tick = (e: Env, mode = "on") => baseEnv.DB.prepare("UPDATE warm_pool_control SET grabber=?,claims=1,targets_override=NULL,lease_holder=NULL,lease_until=NULL WHERE id='pool'").bind(mode).run()
  .then(() => runGrabber(e, (clock += 61_000), { adapter: asHost(), deadline: Date.now() + 60_000 }));
let seq = 0;
async function seed(id: string, over: Record<string, unknown> = {}) {
  const r = { class: "starter", image_id: "111", state: "ready", secret_hash: `hash-${id}`, home_id: null, resource_generation: null, fail_reason: null, ready_at: 100, created_at: 1, ...over };
  await baseEnv.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,server_id,ipv4,secret_hash,create_call_id,monthly_cents,vcpus,
    created_at,ready_at,last_verified_at,home_id,resource_generation,fail_reason,claimed_at) VALUES (?,'staging',?,'hetzner','cx23','x86','fsn1',?,'sha256:d',?,?,'203.0.113.9',?,?,349,2,?,?,?,?,?,?,?)`)
    .bind(id, r.class, r.image_id, r.state, "server_id" in over ? over.server_id : id.replace(/\D/g, ""), r.secret_hash, `call-${id}-${++seq}`, r.created_at, r.ready_at, T0 + 1e9, r.home_id, r.resource_generation, r.fail_reason,
      r.state === "claimed" || r.fail_reason ? 5 : null).run();
}
const poolLabels = (id: string, extra: Record<string, string> = {}) => ({ "murage/role": "pool", "murage/env": "staging", "murage/pool": id, "murage/class": "starter", ...extra });
const withCall = async (id: string) => { const r = await row(id); return { ...poolLabels(id), "murage/call": r.create_call_id }; };
const row = (id: string) => baseEnv.DB.prepare("SELECT * FROM warm_pool WHERE id=?").bind(id).first<Record<string, any>>() as Promise<Record<string, any>>;
const wipe = () => baseEnv.DB.batch(["warm_pool", "warm_pool_deliveries", "warm_pool_events", "cloud_enrollment_tokens", "provision_choices", "cloud_write_guards", "cloud_homes", "cloud_alerts"]
  .map((t) => baseEnv.DB.prepare(`DELETE FROM ${t}`)).concat(baseEnv.DB.prepare("DELETE FROM cloud_ops_state WHERE key LIKE 'pool.%'")));
beforeEach(async () => { hz = new Fake(); clock = T0; await wipe(); });
afterEach(async () => { vi.restoreAllMocks(); await wipe(); });

describe("minuteTick: grabber then fastProvision on one 50 s deadline", () => {
  const empty = { mode: "on" as const, created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors: [] as string[] };
  it("runs both, grabber first, and splits the deadline: grabber at most 30 s, fastProvision the rest", async () => {
    const order: string[] = []; let gdeadline = 0; let fdeadlineMs = -1;
    const t0 = Date.now();
    await minuteTick(mkEnv(), T0, {
      runGrabber: (async (_e: Env, _n: number, d?: { deadline?: number }) => { order.push("grabber"); gdeadline = d!.deadline!; return empty; }) as any,
      fastProvision: (async (_e: Env, _d: unknown, ms: number) => { order.push("fast"); fdeadlineMs = ms; return 0; }) as any,
    });
    expect(order).toEqual(["grabber", "fast"]);
    expect(MINUTE_TICK_GRABBER_MS).toBe(30_000);
    expect(gdeadline - t0).toBeGreaterThanOrEqual(29_900); expect(gdeadline - t0).toBeLessThanOrEqual(30_100);
    expect(fdeadlineMs).toBeLessThanOrEqual(MINUTE_TICK_DEADLINE_MS); expect(fdeadlineMs).toBeGreaterThan(MINUTE_TICK_DEADLINE_MS - 1000);
  });
  it("fastProvision gets what the grabber left of the 50 s", async () => {
    let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    let fms = -1;
    await minuteTick(mkEnv(), T0, {
      runGrabber: (async () => { now += 28_000; return empty; }) as any,
      fastProvision: (async (_e: Env, _d: unknown, ms: number) => { fms = ms; return 0; }) as any,
    });
    expect(fms).toBe(22_000);
    now = 1_000_000; fms = -1;
    await minuteTick(mkEnv(), T0, { runGrabber: (async () => { now += 55_000; return empty; }) as any, fastProvision: (async (_e: Env, _d: unknown, ms: number) => { fms = ms; return 0; }) as any });
    expect(fms).toBe(0);
  });
  it("a failing grabber does not stop fastProvision, and is logged and alerted", async () => {
    let fast = 0; const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await minuteTick(mkEnv(), T0, { runGrabber: (async () => { throw new Error("boom"); }) as any, fastProvision: (async () => { fast++; return 0; }) as any });
    expect(fast).toBe(1);
    expect(r.errors).toEqual(["grabber:boom"]);
    expect(log).toHaveBeenCalled();
    expect((await baseEnv.DB.prepare("SELECT kind FROM cloud_alerts WHERE resolved_at IS NULL").all<{ kind: string }>()).results.map((a) => a.kind)).toContain("pool.tick_grabber");
  });
  it("a failing fastProvision does not lose the grabber's result, and is logged and alerted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await minuteTick(mkEnv(), T0, { runGrabber: (async () => ({ ...empty, created: 3 })) as any, fastProvision: (async () => { throw new Error("b3down"); }) as any });
    expect(r.created).toBe(3);
    expect(r.errors).toEqual(["fast:b3down"]);
    expect((await baseEnv.DB.prepare("SELECT kind FROM cloud_alerts WHERE resolved_at IS NULL").all<{ kind: string }>()).results.map((a) => a.kind)).toContain("pool.tick_fast");
  });
  it("the real pair: grabber off, fastProvision runs against the live database without throwing", async () => {
    await baseEnv.DB.prepare("UPDATE warm_pool_control SET grabber='off',lease_until=NULL WHERE id='pool'").run();
    expect((await minuteTick(mkEnv(), T0)).mode).toBe("off");
  });
});

describe("contract: claim_abandoned rows are cleaned by the grabber by server_id", () => {
  it("a pool-labelled server of an abandoned claim is deleted and the row destroyed", async () => {
    await seed("wp_11", { state: "failed", fail_reason: "claim_abandoned", home_id: "h1", resource_generation: 1, secret_hash: null });
    hz.put("11", poolLabels("wp_11"));
    await tick(mkEnv());
    expect(hz.calls).toContain("delete:11");
    expect((await row("wp_11")).destroyed_at).not.toBeNull();
  });
  it("a home-labelled server is left to B3 (never deleted by the grabber) and the row is destroyed only on a 404", async () => {
    await seed("wp_12", { state: "failed", fail_reason: "claim_abandoned", home_id: "h2", resource_generation: 1, secret_hash: null });
    hz.put("12", poolLabels("wp_12", { "murage/home": "h2" }));
    await tick(mkEnv());
    expect(hz.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect((await row("wp_12")).destroyed_at).toBeNull();
    hz.servers.delete("12"); // B3 destroyed it
    await tick(mkEnv());
    expect((await row("wp_12")).destroyed_at).not.toBeNull();
  });
  it("the grabber's maintenance fails a claimed row whose home is gone (no dependence on B3 being enabled)", async () => {
    await seed("wp_13", { state: "claimed", home_id: "h3", resource_generation: 1 });
    await baseEnv.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,resource_generation,image_digest,home_key,created_at,updated_at)
      VALUES ('h3','inst-h3','o','failed','failed',1,'sha256:x','k',1,1)`).run();
    hz.put("13", poolLabels("wp_13"));
    await tick(mkEnv());
    expect(await row("wp_13")).toMatchObject({ state: "failed", fail_reason: "claim_abandoned" });
    await tick(mkEnv()); // and the next pass deletes the still pool-labelled server
    expect(hz.calls).toContain("delete:13");
  });
});

describe("contract: the grabber never counts or touches claimed rows", () => {
  it("idle spend is ready+warming only; claimed servers are not deleted, quarantined or powered off, in on and drain modes", async () => {
    await seed("wp_21", { state: "ready" }); hz.put("21", await withCall("wp_21"));
    await seed("wp_22", { state: "claimed", home_id: "h4", resource_generation: 1 });
    hz.put("22", { ...poolLabels("wp_22", { "murage/home": "h4" }) }); hz.servers.get("22")!.status = "running";
    await seed("wp_23", { state: "claimed", home_id: "h5", resource_generation: 1 }); // its server is not in the pool listing at all
    const r = await tick(mkEnv());
    expect(r.idleCents).toBe(349);
    expect(r.ready).toBe(1);
    const d = await tick(mkEnv(), "drain");
    expect(d.idleCents).toBe(0);
    for (const id of ["wp_22", "wp_23"]) expect(await row(id)).toMatchObject({ state: "claimed", destroyed_at: null, secret_hash: `hash-${id}` });
    expect(hz.calls.filter((c) => /:(22|23)$/.test(c))).toEqual([]);
  });
});

describe("contract: the claim takes only current-image rows; the grabber retires stale ones", () => {
  it("claim ignores an older stale-image row; the grabber retires the stale row at once", async () => {
    await seed("wp_31", { image_id: "999", ready_at: 1, created_at: 1 }); hz.put("31", await withCall("wp_31"), "999");
    await seed("wp_32", { image_id: "111", ready_at: 500, created_at: 2 }); hz.put("32", await withCall("wp_32"), "111");
    await baseEnv.DB.prepare("UPDATE warm_pool_control SET claims=1 WHERE id='pool'").run();
    const e = mkEnv(1);
    expect(await claimPoolServer(e, provisionerConfig(e), { homeId: "hc1", resourceGeneration: 1, plan: "starter", now: 7 }, okArch)).toBe(true);
    expect((await row("wp_32")).state).toBe("claimed");
    expect((await row("wp_31")).state).toBe("ready"); // never claimed, never rebuilt
    await baseEnv.DB.prepare("DELETE FROM warm_pool_events").run();
    // Only the stale row is left: a second home gets nothing from the pool.
    expect(await claimPoolServer(e, provisionerConfig(e), { homeId: "hc2", resourceGeneration: 1, plan: "starter", now: 8 }, okArch)).toBe(false);
    // The stale row is unclaimable, so it is retired at once whatever the current stock.
    await tick(e);
    expect(await row("wp_31")).toMatchObject({ state: "retired", retire_reason: "stale_image", secret_hash: null });
    await tick(e);
    expect(hz.calls).toContain("delete:31");
    expect(await row("wp_32")).toMatchObject({ state: "claimed", destroyed_at: null });
  });
});

describe("contract: delivery purge and secret revocation after enrollment", () => {
  const token = (hash: string, home: string, used: number | null, expires: number) =>
    baseEnv.DB.prepare("INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at,used_at) VALUES (?,?,?,?)").bind(hash, home, expires, used).run();
  const delivery = (pool_id: string, home: string, hash: string) =>
    baseEnv.DB.prepare("INSERT INTO warm_pool_deliveries (pool_id,home_id,resource_generation,token_hash,payload_wrapped,created_at) VALUES (?,?,1,?,'env1:x',1)").bind(pool_id, home, hash).run();
  const del = (id: string) => baseEnv.DB.prepare("SELECT payload_wrapped,purged_at FROM warm_pool_deliveries WHERE pool_id=?").bind(id).first<Record<string, any>>() as Promise<Record<string, any>>;
  it("a used token drops the payload and revokes the secret; an expired token drops the payload only; a live token changes nothing; idempotent", async () => {
    for (const [id, home] of [["wp_41", "ha"], ["wp_42", "hb"], ["wp_43", "hc"]] as const) await seed(id, { state: "claimed", home_id: home, resource_generation: 1 });
    await token("t41", "ha", 50, T0 + 1e6); await token("t42", "hb", null, 10); await token("t43", "hc", null, T0 + 1e6);
    await delivery("wp_41", "ha", "t41"); await delivery("wp_42", "hb", "t42"); await delivery("wp_43", "hc", "t43");
    expect(await purgeUsedDeliveries(baseEnv, T0)).toEqual({ revoked: 1, purged: 2 });
    expect((await row("wp_41")).secret_hash).toBeNull();
    expect((await row("wp_42")).secret_hash).toBe("hash-wp_42"); // expired, never used: the secret stays (the fence handles it)
    expect((await row("wp_43")).secret_hash).toBe("hash-wp_43");
    expect(await del("wp_41")).toMatchObject({ payload_wrapped: null, purged_at: T0 });
    expect(await del("wp_42")).toMatchObject({ payload_wrapped: null, purged_at: T0 });
    expect(await del("wp_43")).toMatchObject({ payload_wrapped: "env1:x", purged_at: null });
    expect(await purgeUsedDeliveries(baseEnv, T0 + 1)).toEqual({ revoked: 0, purged: 0 });
  });
  it("the grabber's maintenance stage runs it", async () => {
    await seed("wp_44", { state: "claimed", home_id: "hd", resource_generation: 1 });
    await token("t44", "hd", 50, T0 + 1e6); await delivery("wp_44", "hd", "t44");
    await tick(mkEnv());
    expect((await row("wp_44")).secret_hash).toBeNull();
    expect((await del("wp_44")).payload_wrapped).toBeNull();
  });
});

describe("review fixes: deadlines, rotation, create_lost, alerts", () => {
  const alerts = async () => (await baseEnv.DB.prepare("SELECT kind FROM cloud_alerts WHERE resolved_at IS NULL").all<{ kind: string }>()).results.map((a) => a.kind);
  it("minuteTick end to end (30 s grabber budget): a retired row's server is deleted AND a running unclaimed server is quarantined", async () => {
    await baseEnv.DB.prepare("UPDATE warm_pool_control SET grabber='on',lease_holder=NULL,lease_until=NULL WHERE id='pool'").run();
    await seed("wp_51", { state: "retired" }); hz.put("51", poolLabels("wp_51"));
    await seed("wp_52", { state: "ready" }); hz.put("52", await withCall("wp_52")); hz.servers.get("52")!.status = "running";
    await minuteTick(mkEnv(), T0 + 1e6, { grabber: { adapter: asHost() }, fastProvision: (async () => 0) as any });
    expect(hz.calls).toContain("delete:51");
    expect(hz.calls).toContain("quarantine:52");
    expect((await row("wp_51")).destroyed_at).not.toBeNull();
    expect((await row("wp_52")).state).toBe("failed");
  });
  it("image rotation does not deadlock when stale rows fill the spend cap: they are retired, then destroyed", async () => {
    await seed("wp_61", { image_id: "999" }); hz.put("61", await withCall("wp_61"), "999");
    const e = mkEnv(1, 3.5); // cap EUR 3.50: one 349-cent server fits, no replacement does
    await tick(e);
    expect(await row("wp_61")).toMatchObject({ state: "retired", retire_reason: "stale_image" });
    await tick(e);
    expect(hz.calls).toContain("delete:61");
    expect((await row("wp_61")).destroyed_at).not.toBeNull();
  });
  const loc = (cents: number) => ({ fsn1: { available: true, monthlyNetCents: cents } });
  it("stale rows are retired unconditionally, even while the cap has room and current stock is short", async () => {
    await seed("wp_62", { image_id: "999" }); hz.put("62", await withCall("wp_62"), "999");
    await tick(mkEnv(1, 500));
    expect(await row("wp_62")).toMatchObject({ state: "retired", retire_reason: "stale_image" });
  });
  it("a stale Pro row does not strand the shared spend budget: it is retired, destroyed, and the Starter replacement is created next tick", async () => {
    hz.types = [{ name: "cx23", cores: 2, arch: "x86", deprecated: false, locations: loc(399) }];
    await seed("wp_91", { class: "pro", image_id: "999" }); hz.put("91", { ...poolLabels("wp_91"), "murage/class": "pro", "murage/call": (await row("wp_91")).create_call_id }, "999");
    const e = mkEnv(1, 7); // 349 stale + 449 Starter > EUR 7
    await tick(e);
    expect(hz.creates).toEqual([]);
    expect(await row("wp_91")).toMatchObject({ state: "retired", retire_reason: "stale_image" });
    await tick(e);
    expect(hz.calls).toContain("delete:91");
    expect(hz.creates).toEqual(["cx23"]);
  });
  it("rotation does not deadlock at the vCPU limit: the stale row holding the last vCPU is retired, destroyed, then replaced", async () => {
    hz.types = [{ name: "cx23", cores: 2, arch: "x86", deprecated: false, locations: loc(399) }];
    hz.vcpuPer = 80; // the stale server uses all of the 100 - 20 vCPU this env may use
    await seed("wp_92", { image_id: "999" }); hz.put("92", await withCall("wp_92"), "999");
    const e = mkEnv(1, 500);
    await tick(e);
    expect(hz.creates).toEqual([]);
    expect(await row("wp_92")).toMatchObject({ state: "retired", retire_reason: "stale_image" });
    await tick(e);
    expect(hz.creates).toEqual(["cx23"]);
  });
  it("a label match REJECTED for adoption (wrong call label) keeps pool.create_lost_unsettled raised on an aged create_lost row", async () => {
    await seed("wp_93", { state: "failed", fail_reason: "create_lost", server_id: null, created_at: T0 - 31 * 3_600_000, secret_hash: null, ready_at: null });
    hz.put("9300", { ...poolLabels("wp_93"), "murage/call": "someone-else" });
    await tick(mkEnv());
    expect(await row("wp_93")).toMatchObject({ server_id: null, destroyed_at: null });
    expect(await alerts()).toContain("pool.create_lost_unsettled");
  });
  it("create_lost keeps its spend and reservation; a late server is adopted and deleted by id; with no server it is never settled by time", async () => {
    await seed("wp_71", { state: "warming", server_id: null, created_at: T0 - 71 * 60_000, secret_hash: "h", ready_at: null });
    await seed("wp_72", { state: "warming", server_id: null, created_at: T0 - 71 * 60_000, secret_hash: "h", ready_at: null });
    const e = mkEnv();
    clock = T0; await tick(e);
    for (const id of ["wp_71", "wp_72"]) expect(await row(id)).toMatchObject({ state: "failed", fail_reason: "create_lost", destroyed_at: null });
    const open = await baseEnv.DB.prepare("SELECT COUNT(*) AS n FROM warm_pool WHERE destroyed_at IS NULL AND state IN ('warming','ready','failed','retired')").first<{ n: number }>();
    expect(open!.n).toBe(2); // still counted toward idle spend
    clock = T0 + 23 * 3_600_000; await tick(e);
    expect((await row("wp_71")).destroyed_at).toBeNull();
    hz.put("9001", { ...poolLabels("wp_71"), "murage/call": (await row("wp_71")).create_call_id }); // the lost request landed late
    clock += 60_000; await tick(e);
    expect((await row("wp_71")).server_id).toBe("9001");
    clock += 60_000; await tick(e);
    expect(hz.calls).toContain("delete:9001");
    expect((await row("wp_71")).destroyed_at).not.toBeNull();
    expect((await row("wp_72")).destroyed_at).toBeNull(); // 23 h: not yet
    clock = T0 + 25 * 3_600_000; await tick(e);
    // 24 h+ with an empty listing is NOT settlement: the reservation is still held and counted, and an operator is alerted.
    expect(await row("wp_72")).toMatchObject({ state: "failed", fail_reason: "create_lost", destroyed_at: null });
    expect(await alerts()).toContain("pool.create_lost_unsettled");
    const held = await baseEnv.DB.prepare("SELECT COUNT(*) AS n, SUM(monthly_cents) AS c FROM warm_pool WHERE destroyed_at IS NULL AND state IN ('warming','ready','failed','retired')").first<{ n: number; c: number }>();
    expect(held).toMatchObject({ n: 1, c: 349 });
    clock = T0 + 72 * 3_600_000;
    hz.put("9002", { ...poolLabels("wp_72"), "murage/call": (await row("wp_72")).create_call_id }); // it lands three days late
    await tick(e); expect((await row("wp_72")).server_id).toBe("9002");
    await tick(e); expect(hz.calls).toContain("delete:9002");
    expect((await row("wp_72")).destroyed_at).not.toBeNull();
  });
  it("minuteTick clears its alerts only on a clean stage, and keeps or raises them on errors or failures", async () => {
    const g = (errors: string[]) => (async () => ({ mode: "on", created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors })) as any;
    await minuteTick(mkEnv(), T0, { runGrabber: g(["reconcile:boom"]), fastProvision: (async () => 2) as any });
    expect((await alerts()).sort()).toEqual(["pool.tick_fast", "pool.tick_grabber"]);
    await minuteTick(mkEnv(), T0 + 1, { runGrabber: g(["reconcile:boom"]), fastProvision: (async () => 1) as any });
    expect((await alerts()).sort()).toEqual(["pool.tick_fast", "pool.tick_grabber"]);
    await minuteTick(mkEnv(), T0 + 2, { runGrabber: g([]), fastProvision: (async () => 0) as any });
    expect(await alerts()).toEqual([]);
  });
  it("POOL-GRABBER-PERSISTENT: pages once after 2 h of failing ticks, one row per episode, resolved by the clean tick", async () => {
    const g = (errors: string[]) => (async () => ({ mode: "on", created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors })) as any;
    const tickAt = (at: number, errors: string[]) => minuteTick(mkEnv(), at, { runGrabber: g(errors), fastProvision: (async () => 0) as any });
    const pages = async () => (await baseEnv.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='pool.grabber_persistent' ORDER BY raised_at")
      .all<{ id: string; resolved_at: number | null }>()).results;
    const H = 3_600_000, M = 60_000;
    await tickAt(T0, ["reconcile:boom"]);
    await tickAt(T0 + H, ["reconcile:boom"]);
    await tickAt(T0 + 2 * H - M, ["reconcile:boom"]); // 1 h 59: no page
    expect(await pages()).toEqual([]);
    await tickAt(T0 + 2 * H, ["reconcile:boom"]);
    await tickAt(T0 + 2 * H + M, ["reconcile:boom"]);
    await tickAt(T0 + 3 * H, ["reconcile:boom"]);
    expect(await pages()).toEqual([{ id: `pool.grabber_persistent:${T0}`, resolved_at: null }]);
    expect((await alerts()).sort()).toEqual(["pool.grabber_persistent", "pool.tick_grabber"]);
    await tickAt(T0 + 3 * H + M, []); // a clean tick resolves both
    expect(await alerts()).toEqual([]);
    expect((await pages()).map((p) => p.resolved_at)).toEqual([T0 + 3 * H + M]);
    // A new episode: its own id, and its own 2 h.
    const E2 = T0 + 4 * H;
    await tickAt(E2, ["reconcile:boom"]);
    await tickAt(E2 + 2 * H - M, ["reconcile:boom"]);
    expect(await pages()).toHaveLength(1);
    await tickAt(E2 + 2 * H, ["reconcile:boom"]);
    await tickAt(E2 + 2 * H + M, ["reconcile:boom"]);
    expect((await pages()).map((p) => p.id)).toEqual([`pool.grabber_persistent:${T0}`, `pool.grabber_persistent:${E2}`]);
    expect((await pages())[1].resolved_at).toBeNull();
  });
  it("astra-code3: a tick that did no work (lease held, off, no config) is not a clean tick: the episode runs on and the 2 h page fires from the first failure", async () => {
    const g = (mode: string, errors: string[]) => (async () => ({ mode, created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors })) as any;
    const tickAt = (at: number, mode: string, errors: string[]) => minuteTick(mkEnv(), at, { runGrabber: g(mode, errors), fastProvision: (async () => 0) as any });
    const pages = async () => (await baseEnv.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='pool.grabber_persistent'")
      .all<{ id: string; resolved_at: number | null }>()).results;
    const H = 3_600_000, M = 60_000;
    await tickAt(T0, "on", ["reconcile:boom"]);
    await tickAt(T0 + M, "leased", []); // another holder had the lease: no work
    await tickAt(T0 + 2 * M, "off", []);
    await tickAt(T0 + 3 * M, "no_pool_config", []);
    expect((await alerts()).sort()).toEqual(["pool.tick_grabber"]);
    await tickAt(T0 + 4 * M, "on", ["reconcile:boom"]);
    await tickAt(T0 + 2 * H - M, "leased", []);
    expect(await pages()).toEqual([]);
    await tickAt(T0 + 2 * H, "on", ["reconcile:boom"]);
    expect(await pages()).toEqual([{ id: `pool.grabber_persistent:${T0}`, resolved_at: null }]);
    await tickAt(T0 + 2 * H + M, "leased", []);
    expect(await pages()).toEqual([{ id: `pool.grabber_persistent:${T0}`, resolved_at: null }]);
    await tickAt(T0 + 2 * H + 2 * M, "on", []); // a tick that ran clean resolves both
    expect(await alerts()).toEqual([]);
    expect((await pages()).map((p) => p.resolved_at)).toEqual([T0 + 2 * H + 2 * M]);
  });
  it("ITEM4-FIX2 section 3: a failure, then the grabber OFF with no errors: one page at 2 h, none at 1 h 59 m, no second page", async () => {
    const g = (mode: string, errors: string[]) => (async () => ({ mode, created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors })) as any;
    const tickAt = (at: number, mode: string, errors: string[]) => minuteTick(mkEnv(), at, { runGrabber: g(mode, errors), fastProvision: (async () => 0) as any });
    const pages = async () => (await baseEnv.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='pool.grabber_persistent'")
      .all<{ id: string; resolved_at: number | null }>()).results;
    const H = 3_600_000, M = 60_000;
    await tickAt(T0, "on", ["reconcile:boom"]);
    for (let at = T0 + M; at < T0 + 2 * H; at += 10 * M) await tickAt(at, "off", []);
    await tickAt(T0 + 2 * H - M, "off", []); // 1 h 59 m: no page
    expect(await pages()).toEqual([]);
    await tickAt(T0 + 2 * H, "off", []);
    expect(await pages()).toEqual([{ id: `pool.grabber_persistent:${T0}`, resolved_at: null }]);
    await tickAt(T0 + 2 * H + M, "off", []);
    await tickAt(T0 + 3 * H, "off", []);
    expect(await pages()).toEqual([{ id: `pool.grabber_persistent:${T0}`, resolved_at: null }]);
  });
});
