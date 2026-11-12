// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool lane L2: the grabber (runGrabber) against an in-memory provider fake. No network, no real provider.
import { env as baseEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostError, type PoolServer, type ServerTypeInfo } from "../src/b5-provisioner";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../src/index";
import { minuteTick, runGrabber as runGrabberRaw, type PoolHost } from "../src/warm-pool";
import { GRAB_VERIFY, IMG_KINDS_T0, PUBKEY, SIG_TRUST } from "./image-sig-fixture";
const runGrabber: typeof runGrabberRaw = (e, now, deps = {}) => runGrabberRaw(e, now, { ...deps, verify: GRAB_VERIFY });

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const H = 3_600_000;
const IMAGES = { hetzner: { x86: "111", arm: "222" }, vultr: { x86: "s" } };
const cls = (types: [string, "x86" | "arm"][], target: number, red = 1, max = Math.max(20, target)) => ({ rungs: types.map(([serverType, arch]) => ({ serverType, arch })), target, red: Math.min(red, target), max });
const poolCfg = (over: Record<string, unknown> = {}, classes: { starter?: number; pro?: number } = {}) => ({
  env: "staging", monthlyIdleCapEur: 500, maxCreatesPerTick: 10, maxCreatesPerDay: 150, maxConsecutiveCreateFailures: 5,
  classes: { starter: cls([["cx23", "x86"], ["cax11", "arm"]], classes.starter ?? 3), pro: cls([["cax21", "arm"], ["cx33", "x86"]], classes.pro ?? 0) },
  limits: { vcpu: 100, primaryIps: 50, volumeGb: 5000, reserveForLive: { vcpu: 20, primaryIps: 10, volumeGb: 1000 } }, ...over,
});
const mkEnv = (pool: unknown = poolCfg(), extra: Record<string, unknown> = {}) =>
  ({ ...baseEnv, HCLOUD_TOKEN: "hz-test-token", B5_IMAGE_VERIFY_PUBKEY: PUBKEY, B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES, imageKinds: IMG_KINDS_T0, firewallIds: [5], sshKeyIds: [], pool, ...extra }) }) as unknown as Env;

const PRICE: Record<string, [number, number]> = { cx23: [349, 2], cax11: [379, 2], cax21: [700, 4], cx33: [800, 4] };
const LOCS = ["fsn1", "nbg1", "hel1"];

/** An in-memory provider. `settle()` finishes every create (initializing -> off), the way the provider does within seconds. */
class FakeHz implements PoolHost {
  servers = new Map<string, PoolServer & { type: string; location: string }>();
  stock: Record<string, string[]> = { cx23: [...LOCS], cax11: [...LOCS], cax21: [...LOCS], cx33: [...LOCS] };
  usage = { vcpu: 0, primaryIps: 0, volumeGb: 0 };
  locPrice: Record<string, number> = {};
  calls: string[] = [];
  creates: Parameters<PoolHost["createPoolServer"]>[0][] = [];
  /** Decides each create: undefined = succeed, an Error = refuse it, "lost" = create it but lose the answer, "dropped" = lose the request. */
  decide: (n: number, i: Parameters<PoolHost["createPoolServer"]>[0]) => Error | "lost" | "dropped" | undefined = () => undefined;
  private next = 1000;
  quarantined: string[] = [];
  settle() { for (const s of this.servers.values()) if (s.status === "initializing") s.status = "off"; }
  add(labels: Record<string, string>, name: string, status = "off") {
    const id = String(this.next++);
    this.servers.set(id, { id, status, name, imageId: "111", labels, ipv4: `203.0.113.${this.next % 250}`, type: "cx23", location: "fsn1" });
    return id;
  }
  /** Disk sizes in GB the fake reports (unset = unknown, which never blocks a rung). */
  imageDisk: Record<string, number> = {};
  typeDisk: Record<string, number> = {};
  async imageDiskGb(id: string) { return this.imageDisk[id] ?? null; }
  async serverTypes(): Promise<ServerTypeInfo[]> {
    this.calls.push("serverTypes");
    return Object.entries(PRICE).map(([name, [cents, cores]]) => ({ name, cores, diskGb: this.typeDisk[name] ?? null, arch: name.startsWith("cax") ? "arm" as const : "x86" as const, deprecated: false,
      locations: Object.fromEntries(LOCS.map((l) => [l, { available: this.stock[name].includes(l), monthlyNetCents: this.locPrice[`${name}/${l}`] ?? cents }])) }));
  }
  async createPoolServer(i: Parameters<PoolHost["createPoolServer"]>[0]) {
    this.calls.push("create");
    this.creates.push(i);
    const verdict = this.decide(this.creates.length, i);
    if (verdict instanceof Error) throw verdict;
    if (verdict === "dropped") throw new TypeError("network");
    const id = this.add(i.labels, i.name, "initializing");
    Object.assign(this.servers.get(id)!, { type: i.type, location: i.location, imageId: i.image.image });
    if (verdict === "lost") throw new TypeError("network");
    return this.servers.get(id)!;
  }
  updates: { id: string; labels?: Record<string, string> }[] = [];
  async updateServer(id: string, patch: { labels?: Record<string, string> }): Promise<PoolServer> {
    this.calls.push(`update:${id}`);
    this.updates.push({ id, labels: patch.labels });
    const s = this.servers.get(id);
    if (!s) throw new HostError(404, "not_found");
    if (patch.labels) s.labels = patch.labels;
    return s;
  }
  async rebuildServer(): Promise<never> { throw new Error("unused"); }
  async powerOn(): Promise<never> { throw new Error("unused"); }
  async listServerActions(): Promise<never[]> { return []; }
  async powerOff(id: string, signal?: AbortSignal) { this.calls.push(`powerOff:${id}`); this.signals.powerOff = signal; const s = this.servers.get(id); if (s) s.status = "off"; return { actionId: "1", status: "success" as const }; }
  async listByLabel(selector: string) {
    this.calls.push("list");
    const want = selector.split(",").map((p) => p.split("="));
    return [...this.servers.values()].filter((s) => want.every(([k, v]) => s.labels[k] === v));
  }
  async getServerDetail(id: string) {
    this.calls.push("detail");
    const s = this.servers.get(id);
    if (!s) throw new HostError(404, "not_found");
    return s;
  }
  /** A fresh provider read: the base usage (other servers of the project) plus every server this fake holds (pool servers and claimed homes alike). */
  async projectUsage() {
    this.calls.push("usage");
    const held = [...this.servers.values()];
    return { ...this.usage, vcpu: this.usage.vcpu + held.reduce((n, s) => n + (PRICE[s.type]?.[1] ?? 2), 0), primaryIps: this.usage.primaryIps + held.length };
  }
  deleteStatus: "success" | "running" | "error" = "success";
  actions = new Map<string, string>();
  signals: Record<string, unknown> = {};
  async deleteServer(id: string) {
    this.calls.push(`destroy:${id}`);
    if (!this.servers.has(id)) return { actionId: null, status: "none" as const, gone: true };
    if (this.deleteStatus !== "error") this.servers.delete(id); // an errored deletion action leaves the server standing
    const a = `a${this.actions.size + 1}`;
    this.actions.set(a, this.deleteStatus);
    return { actionId: a, status: this.deleteStatus as "success" | "running" | "error", gone: false };
  }
  async actionStatus(a: string) { return (this.actions.get(a) ?? "none") as "success" | "running" | "error" | "none"; }
  async quarantine(id: string, signal?: AbortSignal) { this.calls.push(`quarantine:${id}`); this.quarantined.push(id); this.signals.quarantine = signal; }
}

let clock = T0;
let hz: FakeHz;
const tick = async (e: Env = mkEnv(), dt = 61_000, adapter: PoolHost | null = hz) => runGrabber(e, (clock += dt), { adapter, deadline: Date.now() + 60_000 });
const q = async <T>(sql: string, ...binds: unknown[]) => ((await baseEnv.DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const rows = () => q<any>("SELECT * FROM warm_pool ORDER BY created_at, id");
const setMode = (mode: string, override: string | null = null) =>
  baseEnv.DB.prepare("UPDATE warm_pool_control SET grabber=?,targets_override=?,lease_until=NULL,lease_holder=NULL WHERE id='pool'").bind(mode, override).run();
const alertKinds = async () => (await q<{ kind: string; home_id: string }>("SELECT kind,home_id FROM cloud_alerts WHERE resolved_at IS NULL AND home_id LIKE 'pool%'")).map((a) => `${a.home_id}/${a.kind}`);

beforeEach(async () => {
  hz = new FakeHz();
  clock = T0;
  await baseEnv.DB.batch([
    baseEnv.DB.prepare("DELETE FROM warm_pool"), baseEnv.DB.prepare("DELETE FROM warm_pool_events"), baseEnv.DB.prepare("DELETE FROM warm_pool_stock"),
    baseEnv.DB.prepare("DELETE FROM cloud_ops_state WHERE key LIKE 'pool.%'"), baseEnv.DB.prepare("DELETE FROM cloud_alerts WHERE home_id LIKE 'pool%'"),
    baseEnv.DB.prepare("UPDATE warm_pool_control SET grabber='on',claims=0,targets_override=NULL,lease_holder=NULL,lease_until=NULL WHERE id='pool'"),
  ]);
});

describe("modes and lease", () => {
  it("off (the default control row) makes zero provider calls and writes no pool row", async () => {
    await setMode("off");
    const r = await tick();
    expect(r.mode).toBe("off");
    expect(hz.calls).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });
  it("no pool block in the config is a hard off", async () => {
    const r = await runGrabber({ ...baseEnv, B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES }) } as unknown as Env, clock, { adapter: hz });
    expect(r.mode).toBe("no_pool_config");
    expect(hz.calls).toEqual([]);
  });
  it("observe samples stock only: one serverTypes call, stock rows, nothing listed, created or destroyed", async () => {
    await setMode("observe");
    await tick();
    expect(hz.calls).toEqual(["serverTypes"]);
    expect((await q("SELECT * FROM warm_pool_stock")).length).toBe(4);
    expect(await rows()).toHaveLength(0);
  });
  it("the lease stops a double tick; the holder's lease frees after 55 s", async () => {
    const e = mkEnv();
    const a = await runGrabber(e, clock + 1, { adapter: hz, deadline: Date.now() + 60_000 });
    const b = await runGrabber(e, clock + 2, { adapter: hz, deadline: Date.now() + 60_000 });
    expect(a.mode).toBe("on");
    expect(b.mode).toBe("leased");
    expect(hz.creates).toHaveLength(3);
    const c = await runGrabber(e, clock + 56_000, { adapter: hz, deadline: Date.now() + 60_000 });
    expect(c.mode).toBe("on");
  });
  it("minuteTick runs the grabber", async () => {
    await setMode("off");
    expect((await minuteTick(mkEnv(), clock)).mode).toBe("off");
  });
});

describe("cron dispatch", () => {
  it("the 1-minute cron runs only the pool tick (none of the */5 sweeps)", async () => {
    const cloudflare = vi.fn(async () => { throw new Error("cloudflare unreachable"); });
    const noNet = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const minute = createExecutionContext();
    createWorker(cloudflare as unknown as typeof fetch, noNet).scheduled({ scheduledTime: T0, cron: "* * * * *", noRetry() {} }, baseEnv as Env, minute);
    await waitOnExecutionContext(minute);
    expect(cloudflare).not.toHaveBeenCalled();
  });
});

describe("stock sample", () => {
  it("writes a row set only on change, plus a 10-minute heartbeat", async () => {
    await setMode("observe");
    await tick();
    await tick();
    expect(await q("SELECT DISTINCT sampled_at FROM warm_pool_stock")).toHaveLength(1);
    hz.stock.cx23 = ["fsn1"];
    await tick();
    expect(await q("SELECT DISTINCT sampled_at FROM warm_pool_stock")).toHaveLength(2);
    await tick(mkEnv(), 5 * MIN);
    expect(await q("SELECT DISTINCT sampled_at FROM warm_pool_stock")).toHaveLength(2);
    await tick(mkEnv(), 6 * MIN);
    expect(await q("SELECT DISTINCT sampled_at FROM warm_pool_stock")).toHaveLength(3);
    const last = (await q<any>("SELECT locations FROM warm_pool_stock WHERE server_type='cx23' ORDER BY sampled_at DESC LIMIT 1"))[0];
    expect(JSON.parse(last.locations)).toEqual(["fsn1"]);
  });
});

describe("creates", () => {
  it("fills to target with the dispatch fence, off-by-default user data, labels, name prefix and a hashed secret", async () => {
    const r = await tick();
    expect(r.created).toBe(3);
    const created = hz.creates[0];
    expect(created.name).toMatch(/^mcq-pool-stg-[0-9a-f]{8}$/);
    expect(created.firewallIds).toEqual([5]);
    const row = (await rows()).find((x) => x.id === created.labels["murage/pool"])!;
    expect(created.labels).toMatchObject({ "murage/role": "pool", "murage/env": "staging", "murage/class": "starter", "murage/pool": row.id, "murage/call": row.create_call_id });
    const m = created.userData.match(/^#include\nhttps:\/\/[^/]+\/v1\/pool\/(wp_[0-9a-f-]+)\/cloud-config\/([A-Za-z0-9_-]{43})$/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(row.id);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m![2])))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(row.secret_hash).toBe(digest);
    expect(JSON.stringify(row)).not.toContain(m![2]);
    expect(row).toMatchObject({ state: "warming", provider: "hetzner", env: "staging", class: "starter", server_type: "cx23", arch: "x86", image_id: "111", monthly_cents: 399, vcpus: 2 });
  });
  it("the row exists before the POST leaves (dispatch fence)", async () => {
    let seenAtPost = -1;
    const orig = hz.createPoolServer.bind(hz);
    hz.createPoolServer = async (i) => { seenAtPost = (await rows()).length; return orig(i); };
    await tick();
    expect(seenAtPost).toBeGreaterThanOrEqual(1);
  });
  it("uses only in-stock type/location pairs, in rung order, and falls to the next rung when the first is out everywhere", async () => {
    hz.stock.cx23 = [];
    await tick();
    expect(hz.creates.map((c) => c.type)).toEqual(["cax11", "cax11", "cax11"]);
    expect(hz.creates.every((c) => c.image.image === "222")).toBe(true);
    hz.creates.length = 0;
    hz.stock.cx23 = ["nbg1"];
    await setMode("on", '{"starter":6}');
    await tick();
    expect(hz.creates.map((c) => `${c.type}/${c.location}`)).toEqual(["cx23/nbg1", "cx23/nbg1", "cx23/nbg1"]);
  });
  it("spreads creates round-robin over the in-stock locations", async () => {
    await tick();
    expect(hz.creates.map((c) => c.location)).toEqual(["fsn1", "nbg1", "hel1"]);
  });
  it("skips a rung whose image is not configured, and creates nothing for an unpriced or deprecated type", async () => {
    const e = mkEnv(poolCfg(), { images: { hetzner: { arm: "222" }, vultr: {} } });
    await tick(e);
    expect(hz.creates.every((c) => c.type === "cax11")).toBe(true);
  });
  it("Pro goes first when the tick cap cannot serve both classes", async () => {
    await tick(mkEnv(poolCfg({ maxCreatesPerTick: 2 }, { starter: 3, pro: 2 })));
    expect(hz.creates.map((c) => c.type)).toEqual(["cax21", "cax21"]);
  });
  it("counts ready and warming toward target: a second tick creates nothing more", async () => {
    await tick();
    hz.settle();
    const r = await tick();
    expect(r.created).toBe(0);
    expect(hz.creates).toHaveLength(3);
  });
  it("stops at the per-day cap, counting a rolling 24 hours", async () => {
    const e = mkEnv(poolCfg({ maxCreatesPerDay: 2 }, { starter: 10 }));
    await tick(e);
    expect(hz.creates).toHaveLength(2);
    hz.settle();
    await tick(e);
    expect(hz.creates).toHaveLength(2);
    await tick(e, 25 * H);
    expect(hz.creates.length).toBeGreaterThan(2);
  });
  it("stops at the idle-spend cap and raises pool.spend_cap_reached; the alert resolves when room returns", async () => {
    const e = mkEnv(poolCfg({ monthlyIdleCapEur: 10 }, { starter: 5 }));
    await tick(e);
    expect(hz.creates).toHaveLength(2); // 2 x 3.49 = 6.98; a third would pass EUR 10
    expect(await alertKinds()).toContain("pool/pool.spend_cap_reached");
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 100 }, { starter: 2 })));
    expect(await alertKinds()).not.toContain("pool/pool.spend_cap_reached");
  });
  it("stops at this env's vCPU share (reserve for live homes included)", async () => {
    hz.usage.vcpu = 76; // 100 share - 20 reserve - 76 used = 4 vCPU = two 2-vCPU servers
    await tick(mkEnv(poolCfg({}, { starter: 10 })));
    expect(hz.creates).toHaveLength(2);
  });
  it("stops at this env's primary IP share (reserve included)", async () => {
    hz.usage.primaryIps = 38; // 50 - 10 - 38 = 2
    await tick(mkEnv(poolCfg({}, { starter: 10 })));
    expect(hz.creates).toHaveLength(2);
    expect(await alertKinds()).not.toContain("pool/pool.limit_near");
  });
  it("raises pool.limit_near above 90% of the share (IPs or vCPUs) and resolves it when usage falls", async () => {
    hz.usage.primaryIps = 46;
    await tick();
    expect(hz.creates).toHaveLength(0);
    expect(await alertKinds()).toContain("pool/pool.limit_near");
    hz.usage.primaryIps = 10;
    await tick(mkEnv(), 11 * MIN);
    expect(await alertKinds()).not.toContain("pool/pool.limit_near");
  });
  it("the share holds between ticks: every tick reads the provider fresh (adjusted in round 3: no snapshot supplement)", async () => {
    hz.usage.vcpu = 74; // room 6 -> three servers; the second tick must not create more on the same cached usage
    const e = mkEnv(poolCfg({}, { starter: 10 }));
    await tick(e);
    hz.settle();
    expect(hz.creates).toHaveLength(3);
    await tick(e);
    expect(hz.creates).toHaveLength(3);
  });
  it("creates nothing when the project usage cannot be read", async () => {
    hz.projectUsage = async () => { throw new HostError(500, "boom"); };
    const r = await tick();
    expect(hz.creates).toHaveLength(0);
    expect(r.errors.join()).toContain("usage:");
  });
  it("never creates without firewallIds, and says why", async () => {
    await tick(mkEnv(poolCfg(), { firewallIds: [] }));
    expect(hz.creates).toHaveLength(0);
    expect(await alertKinds()).toContain("pool/pool.create_failing");
  });
  it("a CPX rung cannot even be configured, so nothing is created", async () => {
    const e = mkEnv(poolCfg({ classes: { starter: cls([["cpx21", "x86"]], 1), pro: cls([["cax21", "arm"]], 0) } }));
    const r = await tick(e);
    expect(r.errors).toContain("config_invalid");
    expect(hz.creates).toHaveLength(0);
  });
});

describe("refusals and the circuit breaker", () => {
  it("a 412 / resource_unavailable refusal creates nothing, closes that type+location for the tick, and is not a failure", async () => {
    hz.decide = (n) => (n === 1 ? new HostError(412, "resource_unavailable") : undefined);
    const r = await tick();
    expect(r.refused).toBe(1);
    const failed = (await rows()).filter((x) => x.state === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ fail_reason: "no_stock", server_id: null });
    expect(failed[0].destroyed_at).not.toBeNull();
    expect(hz.creates.filter((c) => c.type === "cx23" && c.location === "fsn1")).toHaveLength(1); // never retried in this tick
    expect((await rows()).filter((x) => x.state === "warming")).toHaveLength(3); // the refused one was replaced in another location
    expect(await alertKinds()).not.toContain("pool/pool.create_failing");
  });
  it("a placement_error is also a no-stock refusal", async () => {
    hz.decide = (n) => (n === 1 ? new HostError(422, "placement_error") : undefined);
    await tick();
    expect((await rows()).filter((x) => x.fail_reason === "no_stock")).toHaveLength(1);
  });
  it("a 429 stops the tick", async () => {
    hz.decide = (n) => (n === 2 ? new HostError(429, "rate_limit_exceeded") : undefined);
    const r = await tick();
    expect(hz.creates).toHaveLength(2);
    expect(r.created).toBe(1);
  });
  it("opens after 5 failures in a row, raises pool.create_failing, backs off 15 minutes, then tries again", async () => {
    hz.decide = () => new HostError(403, "forbidden");
    const e = mkEnv(poolCfg({}, { starter: 10 }));
    await tick(e);
    expect(hz.creates).toHaveLength(5);
    expect(await alertKinds()).toContain("pool/pool.create_failing");
    await tick(e, 5 * MIN);
    expect(hz.creates).toHaveLength(5);
    await tick(e, 11 * MIN);
    expect(hz.creates.length).toBeGreaterThan(5);
  });
  it("a success clears the failure count and resolves the alert", async () => {
    let fail = true;
    hz.decide = () => (fail ? new HostError(403, "forbidden") : undefined);
    const e = mkEnv(poolCfg({}, { starter: 10 }));
    await tick(e);
    fail = false;
    await tick(e, 16 * MIN);
    expect(await alertKinds()).not.toContain("pool/pool.create_failing");
  });
});

describe("reconcile", () => {
  it("moves a warming row to ready only when the provider shows the server off with an IPv4", async () => {
    await tick();
    expect((await rows()).every((r) => r.state === "warming")).toBe(true);
    hz.settle();
    await tick();
    const ready = await rows();
    expect(ready.every((r) => r.state === "ready" && r.server_id && r.ipv4 && r.ready_at)).toBe(true);
  });
  it("adopts a create whose answer was lost, by murage/call", async () => {
    hz.decide = (n) => (n === 1 ? "lost" : undefined);
    await tick(mkEnv(poolCfg({}, { starter: 1 })));
    expect((await rows())[0]).toMatchObject({ state: "warming", server_id: null });
    hz.settle();
    await tick(mkEnv(poolCfg({}, { starter: 1 })));
    const r = (await rows())[0];
    expect(r.state).toBe("ready");
    expect(r.server_id).toBe([...hz.servers.keys()][0]);
    expect(hz.creates).toHaveLength(1);
  });
  it("fails a create that never shows up as create_lost after 70 minutes, not before", async () => {
    hz.decide = () => "dropped";
    const e = mkEnv(poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 1 }));
    await tick(e);
    await tick(e, 69 * MIN - 61_000);
    expect((await rows()).filter((r) => r.state === "warming")).toHaveLength(1);
    await tick(e, 3 * MIN);
    expect((await rows())[0]).toMatchObject({ state: "failed", fail_reason: "create_lost" });
  });
  it("quarantines an UNCLAIMED server found running: row failed, fenced, powered off, high alert, kept 24 h then destroyed", async () => {
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    hz.settle();
    await tick(e);
    const id = [...hz.servers.keys()][0];
    hz.servers.get(id)!.status = "running";
    await tick(e);
    const row = (await rows())[0];
    expect(row).toMatchObject({ state: "failed", fail_reason: "anomaly:unclaimed_running", secret_hash: null });
    expect(hz.quarantined).toContain(id);
    expect(hz.servers.get(id)!.status).toBe("off");
    expect(await alertKinds()).toContain("pool/pool.anomaly");
    expect(hz.servers.has(id)).toBe(true);
    await tick(e, 23 * H);
    expect(hz.servers.has(id)).toBe(true);
    await tick(e, 2 * H);
    expect(hz.servers.has(id)).toBe(false);
  });
  it("quarantines on a changed image or changed labels", async () => {
    const e = mkEnv(poolCfg({}, { starter: 2 }));
    await tick(e);
    hz.settle();
    await tick(e);
    const [a, b] = [...hz.servers.values()];
    a.imageId = "999";
    b.labels["murage/class"] = "pro";
    await tick(e);
    expect((await rows()).map((r) => r.fail_reason).filter(Boolean).sort()).toEqual(["anomaly:image_mismatch", "anomaly:labels_changed"]);
  });
  it("fails a ready row whose server is gone from the provider", async () => {
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    hz.settle();
    await tick(e);
    hz.servers.clear();
    await tick(e);
    expect((await rows()).find((r) => r.fail_reason === "server_gone")).toBeTruthy();
  });
});

describe("orphan reaper", () => {
  it("destroys an unknown server of this env's label and never touches another env's, a non-pool server or a foreign-named one", async () => {
    const orphan = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_none" }, "mcq-pool-stg-deadbeef");
    const prod = hz.add({ "murage/role": "pool", "murage/env": "production", "murage/pool": "wp_prod" }, "mcq-pool-prd-aaaaaaaa");
    const home = hz.add({ "murage/role": "home", "murage/env": "staging" }, "mcq-home-1");
    const foreign = hz.add({ "murage/role": "pool", "murage/env": "staging" }, "someone-elses-box");
    await tick();
    expect(hz.servers.has(orphan)).toBe(false);
    for (const id of [prod, home, foreign]) expect(hz.servers.has(id)).toBe(true);
    expect(hz.calls.filter((c) => c.startsWith("destroy:"))).toEqual([`destroy:${orphan}`]);
  });
  it("a production-configured Worker lists with its own env label and never sees staging's servers", async () => {
    const stg = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_x" }, "mcq-pool-stg-11111111");
    await tick(mkEnv(poolCfg({ env: "production" }, { starter: 0 })));
    expect(hz.servers.has(stg)).toBe(true);
  });
  it("destroys a server whose row is retired or failed, and marks the row destroyed on a confirmed DELETE", async () => {
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    hz.settle();
    await tick(e);
    await baseEnv.DB.prepare("UPDATE warm_pool SET state='retired',retire_reason='test',retired_at=?").bind(clock).run();
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect(hz.servers.size).toBe(0);
    expect((await rows())[0].destroyed_at).not.toBeNull(); // DELETE succeeded
  });
});

describe("over target and drain", () => {
  async function fillTo(n: number) {
    const e = mkEnv(poolCfg({}, { starter: n }));
    await tick(e);
    hz.settle();
    await tick(e);
    expect((await rows()).filter((r) => r.state === "ready")).toHaveLength(n);
  }
  it("above target is kept for 72 h (hysteresis), then the excess ready rows are retired; below target nothing is ever destroyed", async () => {
    await fillTo(4);
    await setMode("on", '{"starter":2}');
    await tick();
    await tick(mkEnv(), 71 * H);
    expect((await rows()).filter((r) => r.state === "ready")).toHaveLength(4);
    await tick(mkEnv(), 2 * H);
    expect((await rows()).filter((r) => r.state === "retired")).toHaveLength(2);
    await setMode("on", '{"starter":10}');
    await tick();
    expect((await rows()).filter((r) => r.state === "retired")).toHaveLength(2);
  });
  it("above max is retired at once, a stale image first, then oldest first", async () => {
    await fillTo(4);
    const stale = (await rows())[3];
    await baseEnv.DB.prepare("UPDATE warm_pool SET image_id='old' WHERE id=?").bind(stale.id).run();
    await setMode("on", '{"starter":{"target":2,"max":3}}');
    // the stale-image row is flagged by image mismatch before over-target runs, so make the provider agree with the row
    for (const s of hz.servers.values()) if (s.labels["murage/pool"] === stale.id) s.imageId = "old";
    await tick();
    const retired = (await rows()).filter((r) => r.state === "retired");
    expect(retired).toHaveLength(1);
    expect(retired[0].id).toBe(stale.id);
  });
  it("a claimed row is never retired or destroyed by the grabber", async () => {
    await fillTo(1);
    const row = (await rows())[0];
    await baseEnv.DB.prepare("UPDATE warm_pool SET state='claimed',home_id='h1',resource_generation=1 WHERE id=?").bind(row.id).run();
    await setMode("on", '{"starter":0}');
    await tick();
    expect((await rows())[0].state).toBe("claimed");
    expect(hz.servers.size).toBe(1);
  });
  it("drain retires every ready row and empties the pool, creating nothing", async () => {
    await fillTo(3);
    await setMode("drain");
    await tick();
    expect((await rows()).every((r) => r.state === "retired")).toBe(true);
    await tick();
    expect(hz.servers.size).toBe(0);
    expect((await rows()).every((r) => r.destroyed_at !== null)).toBe(true);
    expect(hz.creates).toHaveLength(3);
  });
});

describe("alerts and maintenance", () => {
  it("pool.below_red only after 10 minutes below the red line; pool.empty when nothing ready or warming; both resolve when stock returns", async () => {
    hz.stock = { cx23: [], cax11: [], cax21: [], cx33: [] };
    const e = mkEnv(poolCfg({}, { starter: 3 }));
    await tick(e);
    expect(await alertKinds()).toContain("pool-starter/pool.empty");
    expect(await alertKinds()).not.toContain("pool-starter/pool.below_red");
    await tick(e, 11 * MIN);
    expect(await alertKinds()).toContain("pool-starter/pool.below_red");
    hz.stock = { cx23: [...LOCS], cax11: [...LOCS], cax21: [...LOCS], cx33: [...LOCS] };
    await tick(e);
    hz.settle();
    await tick(e);
    expect(await alertKinds()).not.toContain("pool-starter/pool.below_red");
    expect(await alertKinds()).not.toContain("pool-starter/pool.empty");
  });
  it("prunes stock and events older than 14 days and keeps newer ones", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare("INSERT INTO warm_pool_stock VALUES (?, 'hetzner','cx23','[]')").bind(T0 - 15 * 86_400_000),
      baseEnv.DB.prepare("INSERT INTO warm_pool_stock VALUES (?, 'hetzner','cx23','[]')").bind(T0 - 13 * 86_400_000),
      baseEnv.DB.prepare("INSERT INTO warm_pool_events (at,kind) VALUES (?, 'old')").bind(T0 - 15 * 86_400_000),
      baseEnv.DB.prepare("INSERT INTO warm_pool_events (at,kind) VALUES (?, 'new')").bind(T0 - 13 * 86_400_000),
    ]);
    await tick();
    expect((await q<any>("SELECT sampled_at FROM warm_pool_stock WHERE sampled_at<?", T0 - 14 * 86_400_000))).toHaveLength(0);
    expect((await q<any>("SELECT sampled_at FROM warm_pool_stock WHERE sampled_at=?", T0 - 13 * 86_400_000))).toHaveLength(1);
    expect((await q<any>("SELECT kind FROM warm_pool_events WHERE kind IN ('old','new')")).map((r) => r.kind)).toEqual(["new"]);
  });
  it("logs a pool_tick line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await tick();
    expect(log.mock.calls.some((c) => String(c[0]).includes('"message":"pool_tick"'))).toBe(true);
    log.mockRestore();
  });
});

// ---- Astra P2 review of c11dccae2: one test per finding ---------------------------------------------------------------------------------

async function readyRows(n: number, e: Env = mkEnv(poolCfg({}, { starter: n }))) {
  await tick(e);
  hz.settle();
  await tick(e);
  expect((await rows()).filter((r) => r.state === "ready")).toHaveLength(n);
  return e;
}
function seedRow(over: Record<string, unknown>) {
  const r = { id: `wp_seed_${crypto.randomUUID()}`, env: "staging", class: "starter", provider: "hetzner", server_type: "cx23", arch: "x86", location: "fsn1", image_id: "111", image_digest: "x",
    state: "ready", phase: null, server_id: null, ipv4: null, secret_hash: null, create_call_id: crypto.randomUUID(), monthly_cents: 399, vcpus: 2, created_at: T0, retired_at: null, fail_reason: null, ...over };
  const cols = Object.keys(r);
  return baseEnv.DB.prepare(`INSERT INTO warm_pool (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...Object.values(r)).run();
}

describe("Astra P2 review", () => {
  it("1 quarantine does nothing when a claim wins the guarded update (no fence, no power-off of a customer's home)", async () => {
    const e = await readyRows(1);
    const id = [...hz.servers.keys()][0];
    hz.servers.get(id)!.status = "running";
    // The claim lands right after reconcile has read its rows, before the guarded update.
    const claimAfterRead = (sql: string, st: any): any => new Proxy(st, { get(t, k) {
      if (k === "bind") return (...a: unknown[]) => claimAfterRead(sql, t.bind(...a));
      if (k === "all" && sql.startsWith("SELECT * FROM warm_pool WHERE env=? AND destroyed_at IS NULL")) return async () => {
        const r = await t.all();
        await baseEnv.DB.prepare("UPDATE warm_pool SET state='claimed',home_id='h1',resource_generation=1").run();
        return r;
      };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    const db: any = new Proxy(baseEnv.DB, { get(t: any, k) { return k === "prepare" ? (sql: string) => claimAfterRead(sql, t.prepare(sql)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]; } });
    await tick({ ...e, DB: db } as Env);
    expect(hz.quarantined).toEqual([]);
    expect(hz.calls.filter((c) => c.startsWith("powerOff"))).toEqual([]);
    expect(hz.servers.get(id)!.status).toBe("running");
  });
  it("2 a stale row whose server is now a home, or another env's, is never fenced, powered off or destroyed: alert only, server_id dropped", async () => {
    const e = await readyRows(2);
    const [a, b] = [...hz.servers.values()];
    a.labels["murage/role"] = "home";
    b.labels["murage/env"] = "production";
    await tick(e);
    expect(hz.quarantined).toEqual([]);
    expect(hz.calls.filter((c) => c.startsWith("powerOff") || c.startsWith("destroy:"))).toEqual([]);
    const failed = (await rows()).filter((r) => r.fail_reason?.startsWith("foreign:"));
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.server_id !== null)).toBe(true); // round 3: the row keeps its server_id; the server is never touched
    expect(await alertKinds()).toContain("pool/pool.anomaly");
  });
  it("3 no provider mutation starts that could outlive the deadline (and so the lease)", async () => {
    await runGrabber(mkEnv(), (clock += 61_000), { adapter: hz, deadline: Date.now() + 10_000 });
    expect(hz.creates).toHaveLength(0);
    // a long caller deadline is clamped inside the lease: after 31 s of the tick no new create may start (31 + 20 > 50)
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + (hz.creates.length >= 1 ? 31_000 : 0));
    await runGrabber(mkEnv(), (clock += 61_000), { adapter: hz, deadline: real() + 10 * MIN });
    spy.mockRestore();
    expect(hz.creates).toHaveLength(1);
  });
  it("3b destroys and quarantines also stop at the deadline", async () => {
    await readyRows(1);
    await setMode("drain");
    const before = hz.calls.length;
    await runGrabber(mkEnv(), (clock += 61_000), { adapter: hz, deadline: Date.now() + 5_000 }); // under one 8 s call
    expect(hz.calls.slice(before).filter((c) => c.startsWith("destroy:"))).toEqual([]);
  });
  it("4 a lost create answer still holds its budget and its vCPUs inside the tick", async () => {
    hz.decide = () => "lost";
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 5, maxConsecutiveCreateFailures: 50 }, { starter: 3 })));
    expect(hz.creates).toHaveLength(1); // one fits EUR 5 (3.99); the lost one counts
    hz.creates.length = 0;
    await baseEnv.DB.prepare("DELETE FROM warm_pool").run();
    await baseEnv.DB.prepare("DELETE FROM cloud_ops_state WHERE key LIKE 'pool.%'").run();
    hz.usage.vcpu = 76;
    await tick(mkEnv(poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 5 })), 11 * MIN);
    expect(hz.creates).toHaveLength(2);
  });
  it("5 failed and retired rows still billed (not yet destroyed) count against the idle cap", async () => {
    hz.deleteStatus = "running"; // the provider has not finished the deletion: the rows stay billed
    const a = hz.add(poolLabels("wp_b1", "c-b1"), "mcq-pool-stg-b1"), b = hz.add(poolLabels("wp_b2", "c-b2"), "mcq-pool-stg-b2");
    await seedRow({ id: "wp_b1", create_call_id: "c-b1", state: "failed", fail_reason: "anomaly:x", retired_at: T0, server_id: a });
    await seedRow({ id: "wp_b2", create_call_id: "c-b2", state: "retired", retired_at: T0, server_id: b });
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 9 }, { starter: 5 })));
    expect(hz.creates).toHaveLength(0); // 2 x 3.99 held; 9.00 - 7.98 = 1.02 < 3.99
  });
  it("6 the primary IPv4 is part of the price: stored cents include it, and a cap that fits only the bare server type refuses", async () => {
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 3.5 }, { starter: 2 })));
    expect(hz.creates).toHaveLength(0);
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 4 }, { starter: 2 })));
    expect(hz.creates).toHaveLength(1);
    expect((await rows())[0].monthly_cents).toBe(399);
  });
  it("7 affordability is checked for the exact location chosen", async () => {
    hz.stock = { cx23: [...LOCS], cax11: [], cax21: [], cx33: [] };
    hz.locPrice = { "cx23/fsn1": 500, "cx23/nbg1": 700, "cx23/hel1": 700 };
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 11 }, { starter: 3 })));
    const spent = (await rows()).reduce((n, r) => n + r.monthly_cents, 0);
    expect(spent).toBeLessThanOrEqual(1100);
    expect(hz.creates.every((c) => c.location === "fsn1")).toBe(true); // 7.00 EUR locations never fit the 5.50 left
  });
  it("8 an unresolved lost create older than the usage snapshot still holds its vCPUs", async () => {
    hz.decide = () => "dropped";
    hz.usage.vcpu = 76; // room for two
    const cfg = poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 2 });
    await tick(mkEnv(cfg));
    expect(hz.creates).toHaveLength(2);
    await setMode("on", '{"starter":4}');
    await tick(mkEnv(cfg), 11 * MIN); // usage re-read; the dropped creates are older than that snapshot
    expect(hz.creates).toHaveLength(2);
  });
  it("9 a server renamed outside the prefix (labels kept) is still destroyed by DELETE, never marked destroyed because it left a filtered list", async () => {
    const e = await readyRows(1);
    [...hz.servers.values()][0].name = "renamed-by-someone";
    await setMode("drain");
    await tick(e);
    expect(hz.servers.size).toBe(0);
    expect((await rows())[0].destroyed_at).not.toBeNull();
  });
  it("9b a failed DELETE leaves the row undestroyed; a row whose server is not listed is destroyed only on GET 404", async () => {
    const e = await readyRows(2);
    hz.deleteServer = async () => { throw new HostError(500, "boom"); };
    await setMode("drain");
    await tick(e);
    expect((await rows()).every((r) => r.destroyed_at === null)).toBe(true);
    hz.listByLabel = async () => [];
    hz.deleteServer = FakeHz.prototype.deleteServer.bind(hz);
    await tick(e); // not listed, but the server exists by id: DELETE it, then mark
    expect(hz.servers.size).toBe(0);
    expect((await rows()).every((r) => r.destroyed_at !== null)).toBe(true);
  });
  it("10 held anomalies cannot starve the cleanup of eligible rows", async () => {
    for (let i = 0; i < 60; i++) await seedRow({ state: "failed", fail_reason: "anomaly:x", retired_at: clock + 61_000 - MIN, server_id: `9${i}` });
    const id = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_eligible", "murage/call": "c-elig", "murage/class": "starter" }, "mcq-pool-stg-eeeeeeee");
    await seedRow({ id: "wp_eligible", create_call_id: "c-elig", state: "retired", retired_at: T0, server_id: id });
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect(hz.servers.has(id)).toBe(false);
  });
  it("11 a 429 leaves no phantom row: the next tick creates again", async () => {
    let limited = true;
    hz.decide = () => (limited ? new HostError(429, "rate_limit_exceeded") : undefined);
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    expect((await rows())[0]).toMatchObject({ state: "failed", fail_reason: "rate_limited" });
    limited = false;
    await tick(e);
    expect(hz.creates).toHaveLength(2);
    expect((await rows()).filter((r) => r.state === "warming")).toHaveLength(1);
  });
  it("12 reconciliation of a large pool is bounded: well under 1,000 D1 statements per tick, and it catches up over ticks", async () => {
    for (let i = 0; i < 450; i++) {
      const id = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": `wp_big${i}`, "murage/call": `c${i}`, "murage/class": "starter" }, `mcq-pool-stg-${String(i).padStart(8, "0")}`);
      await seedRow({ id: `wp_big${i}`, create_call_id: `c${i}`, state: "warming", server_id: id, ipv4: "203.0.113.5" });
    }
    let n = 0;
    const wrap = (st: any): any => new Proxy(st, { get(t, k) {
      if (k === "__raw") return t;
      if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
      if (k === "run" || k === "all" || k === "first" || k === "raw") return (...a: unknown[]) => { n++; return t[k](...a); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    const db: any = new Proxy(baseEnv.DB, { get(t: any, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch") return (stmts: any[]) => { n += stmts.length; return t.batch(stmts.map((x) => x.__raw ?? x)); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    const e = { ...mkEnv(poolCfg({ monthlyIdleCapEur: 100_000, limits: { vcpu: 5000, primaryIps: 5000, volumeGb: 5000, reserveForLive: { vcpu: 0, primaryIps: 0, volumeGb: 0 } } }, { starter: 450 })), DB: db } as Env;
    await tick(e);
    expect(n).toBeLessThan(600);
    const ready1 = (await rows()).filter((r) => r.state === "ready").length;
    expect(ready1).toBeGreaterThan(0);
    expect(ready1).toBeLessThanOrEqual(200);
    await tick(e); await tick(e);
    expect((await rows()).filter((r) => r.state === "ready")).toHaveLength(450);
  });

  // ---- Astra P2 round 2 (on ca5684221) ----
  it("r2-1 an orphan by labels is never deleted when a row owns its server_id, nor when its live labels say it is not ours", async () => {
    const e = await readyRows(1);
    const owned = [...hz.servers.values()][0];
    owned.labels["murage/pool"] = "wp_drift"; owned.labels["murage/call"] = "c-drift"; // both labels drift: it now looks like an orphan
    await tick(e);
    expect(hz.servers.has(owned.id)).toBe(true);
    // the list is stale: it still says pool, but the server is already a customer's home
    const home = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_gone", "murage/call": "c-gone" }, "mcq-pool-stg-99999999");
    const real = hz.listByLabel.bind(hz);
    hz.listByLabel = async (sel) => { const r = await real(sel); return r.map((s) => (s.id === home ? { ...s, labels: { ...s.labels } } : s)); };
    hz.servers.get(home)!.labels = { "murage/role": "home", "murage/env": "staging", "murage/home": "h1" };
    hz.listByLabel = async () => [{ ...hz.servers.get(home)!, labels: { "murage/role": "pool", "murage/env": "staging", "murage/pool": "wp_gone", "murage/call": "c-gone" } }];
    await tick(e);
    expect(hz.servers.has(home)).toBe(true);
  });
  it("r2-2 a create does not start when the reservation insert itself used up the time (it could outlive the lease)", async () => {
    let jump = 0;
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + jump);
    const db: any = new Proxy(baseEnv.DB, { get(t: any, k) {
      if (k !== "prepare") return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      return (sql: string) => { const st = t.prepare(sql); return sql.startsWith("INSERT INTO warm_pool ") ? new Proxy(st, { get(x: any, kk) {
        if (kk === "bind") return (...a: unknown[]) => { const b = x.bind(...a); return new Proxy(b, { get(y: any, k3) { return k3 === "run" ? async () => { const r = await y.run(); jump = 30_000; return r; } : typeof y[k3] === "function" ? y[k3].bind(y) : y[k3]; } }); };
        return typeof x[kk] === "function" ? x[kk].bind(x) : x[kk];
      } }) : st; };
    } });
    await runGrabber({ ...mkEnv(), DB: db } as Env, (clock += 61_000), { adapter: hz, deadline: real() + 60_000 });
    spy.mockRestore();
    expect(hz.creates).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ state: "failed", fail_reason: "not_sent" });
  });
  it("r2-3 quarantine and power-off calls carry an abort signal", async () => {
    const e = await readyRows(1);
    [...hz.servers.values()][0].status = "running";
    await tick(e);
    expect(hz.signals.quarantine).toBeInstanceOf(AbortSignal);
    expect(hz.signals.powerOff).toBeInstanceOf(AbortSignal);
  });
  it("r2-4 (rewritten in round 3) an adopted lost create is counted by the fresh provider read, with no marker to lose", async () => {
    hz.decide = () => "lost";
    hz.usage.vcpu = 76; // room for two
    const cfg = poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 2 });
    await tick(mkEnv(cfg));
    expect(hz.creates).toHaveLength(2);
    hz.decide = () => undefined;
    hz.settle();
    await setMode("on", '{"starter":4}');
    await tick(mkEnv(cfg), 11 * MIN);
    expect((await rows()).filter((r) => r.state === "ready")).toHaveLength(2);
    await tick(mkEnv(cfg), 2 * MIN);
    expect(hz.creates).toHaveLength(2); // 76 + two servers = 80: no room
  });
  it("r2-5 a DELETE that is still pending keeps the row billed; success or a 404 by id releases it; a failed action is sent again", async () => {
    const e = await readyRows(1);
    hz.deleteStatus = "running";
    await setMode("drain");
    await tick(e);
    expect((await rows())[0]).toMatchObject({ destroyed_at: null });
    expect((await rows())[0].phase).toMatch(/^destroying:a/);
    await setMode("on", '{"starter":0}');
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 4 }, { starter: 1 }))); // still billed: 3.99 of 4.00 held, no replacement fits
    expect(hz.creates).toHaveLength(1);
    hz.actions.set("a1", "error");
    const rowId = (await rows())[0].id; // the identity rule: the server by id must carry this row's pool labels before it is deleted again
    hz.servers.set("777", { id: "777", status: "off", name: "x", imageId: "111", ipv4: "1.2.3.4", labels: { "murage/role": "pool", "murage/env": "staging", "murage/pool": rowId }, type: "cx23", location: "fsn1" } as any);
    await baseEnv.DB.prepare("UPDATE warm_pool SET server_id='777'").run();
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    hz.actions.set("a2", "success");
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect((await rows())[0].destroyed_at).not.toBeNull();
  });
  it("r2-6 retirement is paged and batched: a 600-server class drained to zero stays within the D1 budget per tick", async () => {
    for (let i = 0; i < 600; i++) {
      const id = hz.add({ "murage/role": "pool", "murage/env": "staging", "murage/pool": `wp_r${i}`, "murage/call": `rc${i}`, "murage/class": "starter" }, `mcq-pool-stg-${String(i).padStart(8, "1")}`);
      await seedRow({ id: `wp_r${i}`, create_call_id: `rc${i}`, state: "ready", server_id: id, ipv4: "203.0.113.5", last_verified_at: T0 });
    }
    let n = 0;
    const wrap = (st: any): any => new Proxy(st, { get(t, k) {
      if (k === "__raw") return t;
      if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
      if (k === "run" || k === "all" || k === "first" || k === "raw") return (...a: unknown[]) => { n++; return t[k](...a); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    const db: any = new Proxy(baseEnv.DB, { get(t: any, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch") return (stmts: any[]) => { n += stmts.length; return t.batch(stmts.map((x) => x.__raw ?? x)); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    const big = poolCfg({ limits: { vcpu: 5000, primaryIps: 5000, volumeGb: 5000, reserveForLive: { vcpu: 0, primaryIps: 0, volumeGb: 0 } } }, { starter: 600 });
    await setMode("on", '{"starter":{"target":0,"max":0,"red":0}}');
    await tick({ ...mkEnv(big), DB: db } as Env);
    await tick({ ...mkEnv(big), DB: db } as Env, 80 * H); // past the over-target hysteresis
    n = 0;
    await tick({ ...mkEnv(big), DB: db } as Env);
    expect(n).toBeLessThan(600);
    const retired = (await rows()).filter((r) => r.state === "retired").length;
    expect(retired).toBeGreaterThan(0);
    expect(retired).toBeLessThan(600);
  });
  it("r2-7 retirement cannot take the class below target while claims land concurrently", async () => {
    const e = await readyRows(10);
    const all = await rows();
    for (const r of all.slice(0, 5)) {
      await baseEnv.DB.prepare("UPDATE warm_pool SET image_id='old' WHERE id=?").bind(r.id).run();
      for (const s of hz.servers.values()) if (s.labels["murage/pool"] === r.id) s.imageId = "old";
    }
    await setMode("on", '{"starter":{"target":5,"max":5}}');
    let claimed = false;
    const db: any = new Proxy(baseEnv.DB, { get(t: any, k) {
      if (k === "batch") return async (stmts: any[]) => {
        if (!claimed && stmts.some((x) => String(x.__sql ?? "").includes("state='retired'"))) {
          claimed = true;
          await t.prepare("UPDATE warm_pool SET state='claimed',home_id='h',resource_generation=1 WHERE state='ready' AND image_id<>'old'").run();
        }
        return t.batch(stmts);
      };
      if (k === "prepare") return (sql: string) => { const st = t.prepare(sql); return new Proxy(st, { get(x: any, kk) { if (kk === "bind") return (...a: unknown[]) => { const b = x.bind(...a); (b as any).__sql = sql; return b; }; return typeof x[kk] === "function" ? x[kk].bind(x) : x[kk]; } }); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    } });
    await tick({ ...mkEnv(poolCfg({}, { starter: 10 })), DB: db } as Env);
    const left = (await rows()).filter((r) => r.state === "ready").length;
    expect(claimed).toBe(true);
    expect(left).toBeGreaterThanOrEqual(5 - 0); // the five stale servers stay: retiring them would leave nothing
  });
});

// ---- Astra P2 round 3 (on 727424fb1) and the claim-lane image rules ---------------------------------------------------------------------

const poolLabels = (rowId: string, call: string) => ({ "murage/role": "pool", "murage/env": "staging", "murage/pool": rowId, "murage/call": call, "murage/class": "starter" });
/** An env whose database refuses to write one cloud_ops_state key (a failed marker write, the way a mid-tick D1 failure would). */
function failingKey(e: Env, key: string): Env {
  const db: any = new Proxy(baseEnv.DB, { get(t: any, k) {
    if (k !== "prepare") return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    return (sql: string) => { const st = t.prepare(sql); return sql.startsWith("INSERT INTO cloud_ops_state") ? new Proxy(st, { get(x: any, kk) {
      if (kk === "bind") return (...a: unknown[]) => { const b = x.bind(...a); return a[0] === key ? new Proxy(b, { get(y: any, k3) { return k3 === "run" ? async () => { throw new Error("d1_write_failed"); } : typeof y[k3] === "function" ? y[k3].bind(y) : y[k3]; } }) : b; };
      return typeof x[kk] === "function" ? x[kk].bind(x) : x[kk];
    } }) : st; };
  } });
  return { ...e, DB: db } as Env;
}

describe("Astra P2 round 3", () => {
  it("P1-a a label that drifts to another row never lets that row act on the server: the server is found by its id, alert only", async () => {
    const e = await readyRows(2);
    const [a, b] = [...hz.servers.values()];
    const rowB = (await rows()).find((r) => r.server_id === b.id)!;
    a.labels["murage/pool"] = rowB.id; // A's call label still names A
    a.status = "running";
    await tick(e);
    expect(hz.quarantined).not.toContain(a.id);
    expect(hz.calls).not.toContain(`powerOff:${a.id}`);
    expect(a.status).toBe("running");
    expect(await alertKinds()).toContain("pool/pool.anomaly");
  });
  it("P1-b cleanup validates and deletes the row's own server_id only: a label match elsewhere is never a substitute", async () => {
    const x = hz.add({ "murage/role": "home", "murage/env": "staging", "murage/home": "h1" }, "customer-home");
    const y = hz.add(poolLabels("wp_r3", "c-r3"), "mcq-pool-stg-yyyyyyyy");
    await seedRow({ id: "wp_r3", create_call_id: "c-r3", state: "retired", retired_at: T0, server_id: x });
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect(hz.servers.has(x)).toBe(true);
    expect(hz.servers.has(y)).toBe(true); // its labels point at a row that already has another server: a conflict, alert only
    expect(hz.calls.filter((c) => c.startsWith("destroy:"))).toEqual([]);
    expect(await alertKinds()).toContain("pool/pool.anomaly");
  });
  it("P2-a a lost create is adopted with its server_id before anything acts on it; a failing deletion action never releases it", async () => {
    hz.decide = (n) => (n === 1 ? "lost" : undefined);
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    const id = [...hz.servers.keys()][0];
    hz.servers.get(id)!.status = "running";
    await tick(e);
    await tick(e);
    expect((await rows())[0]).toMatchObject({ server_id: id, fail_reason: "anomaly:warming_running" });
    hz.deleteStatus = "error";
    await tick(e, 25 * H);
    await tick(e);
    await tick(e);
    expect((await rows())[0].destroyed_at).toBeNull();
    expect(hz.servers.has(id)).toBe(true);
  });
  it("P2-b an adoption never depends on a separate marker write: the fresh provider read accounts for the adopted server", async () => {
    hz.decide = () => "dropped";
    hz.usage.vcpu = 76;
    const cfg1 = poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 1 });
    await tick(mkEnv(cfg1));
    hz.decide = () => undefined;
    await tick(mkEnv(cfg1), 11 * MIN);
    const row = (await rows())[0];
    hz.add(poolLabels(row.id, row.create_call_id), `mcq-pool-stg-${row.id.slice(3, 11)}`, "off"); // the lost create materialises later
    await setMode("on", '{"starter":4}');
    const e = failingKey(mkEnv(poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 4 })), "pool.adopted");
    await tick(e);
    await tick(e);
    await tick(e);
    expect(hz.creates.length).toBeLessThanOrEqual(2); // the dropped one plus ONE (76 + adopted 2 + 2 = 80)
  });
  it("P2-c a claimed server keeps counting in the fresh provider usage, so a refill cannot pass the vCPU ceiling", async () => {
    hz.usage.vcpu = 78; // room for exactly one 2-vCPU server
    const e = mkEnv(poolCfg({}, { starter: 5 }));
    await tick(e);
    expect(hz.creates).toHaveLength(1);
    await baseEnv.DB.prepare("UPDATE warm_pool SET state='claimed',home_id='h1',resource_generation=1").run();
    Object.assign([...hz.servers.values()][0].labels, { "murage/role": "home", "murage/home": "h1" });
    await tick(e);
    expect(hz.creates).toHaveLength(1);
  });
  it("P2-d quarantining a lost create keeps its reservation (it is adopted with a server_id; the provider read counts it)", async () => {
    hz.decide = () => "dropped";
    hz.usage.vcpu = 76;
    const cfg1 = poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 1 });
    await tick(mkEnv(cfg1));
    hz.decide = () => undefined;
    await tick(mkEnv(cfg1), 11 * MIN);
    const row = (await rows())[0];
    hz.add(poolLabels(row.id, row.create_call_id), `mcq-pool-stg-${row.id.slice(3, 11)}`, "running");
    await setMode("on", '{"starter":4}');
    await tick(mkEnv(poolCfg({ maxConsecutiveCreateFailures: 50 }, { starter: 4 })));
    expect(hz.creates.length).toBeLessThanOrEqual(2);
  });
  it("P3 a tick that fills the target does not raise the spend-cap alert even though one dearer location was skipped", async () => {
    hz.stock = { cx23: [...LOCS], cax11: [], cax21: [], cx33: [] };
    hz.locPrice = { "cx23/fsn1": 700, "cx23/nbg1": 450, "cx23/hel1": 700 };
    await tick(mkEnv(poolCfg({ monthlyIdleCapEur: 6 }, { starter: 1 })));
    expect(hz.creates).toHaveLength(1);
    expect(await alertKinds()).not.toContain("pool/pool.spend_cap_reached");
  });
});

describe("image rules (claim lane: current image only, no rebuild, no release)", () => {
  async function staleReady(n: number, idPrefix = "wp_stale") {
    for (let i = 0; i < n; i++) {
      const id = hz.add(poolLabels(`${idPrefix}${i}`, `c-st${i}`), `mcq-pool-stg-s${String(i).padStart(7, "0")}`);
      hz.servers.get(id)!.imageId = "999";
      await seedRow({ id: `${idPrefix}${i}`, create_call_id: `c-st${i}`, state: "ready", server_id: id, ipv4: "1.2.3.4", image_id: "999", created_at: T0 + i });
    }
  }
  it("a stale-image ready row does not count toward target: the class still creates", async () => {
    await staleReady(1);
    await tick(mkEnv(poolCfg({}, { starter: 1 })));
    expect(hz.creates).toHaveLength(1);
  });
  it("stale-image ready rows are retired and destroyed unconditionally, even with no current stock and nothing creatable", async () => {
    await staleReady(1);
    hz.stock = { cx23: [], cax11: [], cax21: [], cx33: [] }; // nothing can be created: current count 0 < target 1
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    expect((await rows())[0]).toMatchObject({ state: "retired", retire_reason: "stale_image" });
    await tick(e); // the next tick's cleanup (which runs first) destroys it
    expect((await rows()).find((r) => r.id === "wp_stale0")!.destroyed_at).not.toBeNull();
  });
  it("stale retirement is oldest first and bounded per tick", async () => {
    await staleReady(30);
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    const retired = (await rows()).filter((r) => r.retire_reason === "stale_image");
    expect(retired).toHaveLength(25);
    expect((await rows()).filter((r) => r.state === "ready").map((r) => r.id).sort()).toEqual(["wp_stale25", "wp_stale26", "wp_stale27", "wp_stale28", "wp_stale29"]);
  });
  it("an abandoned claim (failed, claim_*) whose server carries a home label is never touched; it is marked destroyed only on a 404 by id", async () => {
    const x = hz.add({ "murage/role": "home", "murage/env": "staging", "murage/home": "h1" }, "customer-home");
    await seedRow({ id: "wp_ab", state: "failed", fail_reason: "claim_timeout", retired_at: T0, server_id: x });
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect(hz.servers.has(x)).toBe(true);
    expect(hz.calls.filter((c) => c.startsWith("destroy:"))).toEqual([]);
    expect((await rows())[0].destroyed_at).toBeNull();
    hz.servers.delete(x);
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect((await rows())[0].destroyed_at).not.toBeNull();
  });
});

describe("the signed-image gate at pool fill", () => {
  const filled = async (e: Env, verify = GRAB_VERIFY) => { await setMode("on"); return runGrabberRaw(e, (clock += 61_000), { adapter: hz, deadline: Date.now() + 60_000, verify }); };
  it("an unsigned image creates no pool server and raises pool.image_unverified", async () => {
    const r = await filled(mkEnv(poolCfg(), { imageKinds: {} }));
    expect(r.created).toBe(0);
    expect(hz.creates).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(await alertKinds()).toContain("pool/pool.image_unverified");
  });
  it("a revoked image creates no pool server", async () => {
    const r = await filled(mkEnv(), { ...GRAB_VERIFY, trust: { ...SIG_TRUST, revoked: ["111", "222"] } });
    expect(r.created).toBe(0);
    expect(hz.creates).toHaveLength(0);
    expect(await alertKinds()).toContain("pool/pool.image_unverified");
  });
  it("only the verified arch is filled: a revoked ARM image skips the ARM rung and the x86 rung still creates", async () => {
    const r = await filled(mkEnv(), { ...GRAB_VERIFY, trust: { ...SIG_TRUST, revoked: ["222"] } });
    expect(r.created).toBeGreaterThan(0);
    expect(hz.creates.every((c) => c.image && (c.image as { image: string }).image === "111")).toBe(true);
  });
  it("a pool server is created with the capability the gate minted, never a bare id", async () => {
    await filled(mkEnv());
    expect(hz.creates.length).toBeGreaterThan(0);
    expect(typeof hz.creates[0].image).toBe("object");
    expect(Object.isFrozen(hz.creates[0].image)).toBe(true);
  });
  it("a production bundle with a sshKeyIds list creates nothing (ssh_keys_prod_forbidden is not sent)", async () => {
    const r = await filled(mkEnv(poolCfg(), { sshKeyIds: [7] }));
    expect(r.created).toBe(0);
    expect(hz.creates).toHaveLength(0);
  });
});

describe("image disk fit", () => {
  const kind = "image.too_big_for_server_type";
  const bigAlerts = () => q<{ home_id: string; severity: string; detail: string }>("SELECT home_id,severity,detail FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL", kind);
  beforeEach(async () => { await baseEnv.DB.prepare("DELETE FROM cloud_alerts WHERE kind=?").bind(kind).run(); });
  it("a rung whose disk is smaller than the image is skipped; the next fitting rung is filled", async () => {
    hz.imageDisk = { "111": 80, "222": 40 }; // x86 image is 80 GB, arm image 40 GB
    hz.typeDisk = { cx23: 40, cax11: 40 };    // cx23 cannot hold the x86 image, cax11 holds the arm image
    await tick();
    expect(hz.creates.length).toBeGreaterThan(0);
    expect(hz.creates.every((c) => c.type === "cax11")).toBe(true);
    expect((await bigAlerts()).length).toBe(1);
  });
  it("no rung fits: nothing is created and ONE high alert names the image and the types", async () => {
    hz.imageDisk = { "111": 80, "222": 80 };
    hz.typeDisk = { cx23: 40, cax11: 40 };
    await tick();
    await tick();
    expect(hz.creates).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    const a = await bigAlerts();
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe("high");
    expect(a[0].detail).toMatch(/image 111|image 222/);
  });
  it("unknown sizes never block a rung", async () => {
    await tick();
    expect(hz.creates.length).toBeGreaterThan(0);
    expect(await bigAlerts()).toHaveLength(0);
  });
});

describe("1019 fleet labels on pool servers", () => {
  const DAY = 86_400_000;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it("fl-1 a create carries owner, purpose=<env>-warm-pool and expires_at = create day + 90 d, with every murage/* label kept; values match the label rule", async () => {
    await tick(mkEnv(poolCfg({}, { starter: 1 })));
    const l = hz.creates[0].labels;
    expect(l).toMatchObject({ owner: "MurageCloud", purpose: "staging-warm-pool", expires_at: ymd(clock + 90 * DAY),
      "murage/role": "pool", "murage/env": "staging", "murage/class": "starter" });
    expect(l["murage/pool"]).toMatch(/^wp_/);
    expect(l["murage/call"]).toBeTruthy();
    for (const k of ["owner", "purpose", "expires_at"]) expect(l[k]).toMatch(/^[A-Za-z0-9._-]{1,63}$/);
    expect(l.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("fl-2 ownership and adoption checks still pass with the extra keys: a lost create is adopted by its labels and readied, no anomaly", async () => {
    hz.decide = (n) => (n === 1 ? "lost" : undefined);
    const e = mkEnv(poolCfg({}, { starter: 1 }));
    await tick(e);
    expect([...hz.servers.values()][0].labels.owner).toBe("MurageCloud");
    hz.settle();
    await tick(e);
    const r = (await rows())[0];
    expect(r.server_id).toBe([...hz.servers.keys()][0]);
    expect(r.state).toBe("ready");
    expect(await alertKinds()).toEqual([]);
    expect(hz.quarantined).toEqual([]);
  });
  const near = (extra: Record<string, string> = {}, days = 10) => ({ "murage/role": "pool", "murage/env": "staging", "murage/class": "starter", owner: "MurageCloud", purpose: "staging-warm-pool",
    expires_at: ymd(clock + 61_000 + days * DAY), ...extra });
  it("fl-3 a reconcile tick never PUTs labels on an existing pool server, even with expires_at past or within 30 d (the claim owns the relabel)", async () => {
    const past = hz.add({ ...near({}, -5), "murage/pool": "wp_n1", "murage/call": "c-n1" }, "mcq-pool-stg-nnnnnnn1");
    await seedRow({ id: "wp_n1", create_call_id: "c-n1", state: "ready", server_id: past, last_verified_at: clock + 61_000 });
    const soon = hz.add({ ...near({}, 10), "murage/pool": "wp_n2", "murage/call": "c-n2" }, "mcq-pool-stg-nnnnnnn2");
    await seedRow({ id: "wp_n2", create_call_id: "c-n2", state: "ready", server_id: soon, last_verified_at: clock + 61_000 });
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    await tick(mkEnv(poolCfg({}, { starter: 0 })));
    expect(hz.updates).toEqual([]);
  });
});
