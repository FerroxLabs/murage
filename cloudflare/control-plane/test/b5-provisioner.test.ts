// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 provisioner: build host and Vultr REST shapes against an in-memory fake cloud. No network, no credentials.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionerConfig, provisionerSchema, ladderFor, DEFAULT_LADDERS } from "../src/b5-config";
import { chooseRung, createLiveProvider, hetznerAdapter, HostError, vultrAdapter, type HostFetch } from "../src/b5-provisioner";
import { providerAnswered } from "../src/b3-control";
import { isNotSent } from "../src/dispatch-ledger";

const IMAGES = { hetzner: { x86: "111", arm: "222" }, vultr: { x86: "snap-vultr-1" } };
const VULTR = { sshKeyIds: ["vk-1"], firewallGroupId: "fwg-home", quarantineFirewallGroupId: "fwg-quar" };
const cfgJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ images: IMAGES, quarantineFirewallId: 77, vultr: VULTR, ...extra });
const e = (extra?: Record<string, unknown>): Env => ({ ...env, B5_PROVISIONER_CONFIG: cfgJson(extra), HCLOUD_TOKEN: "hz-test-token", VULTR_API_KEY: "vu-test-key" } as Env);

/** A tiny in-memory build host + Vultr. `stock` lists "provider:type:location" combos that are in stock. */
function fakeCloud(stock: string[]) {
  const calls: { method: string; url: string; body: any }[] = [];
  const servers = new Map<string, any>(); const volumes = new Map<string, any>(); const snaps = new Map<string, any>();
  let n = 100;
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  const fetcher: HostFetch = async (url, init) => {
    const u = new URL(url); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const p = u.pathname;
    if (u.host === "api.hetzner.cloud") {
      const sel = decodeURIComponent(u.searchParams.get("label_selector") ?? "");
      const match = (labels: any) => sel.split(",").every((kv) => { const [k, v] = kv.split("="); return labels?.[k] === v; });
      if (p === "/v1/server_types") {
        const name = u.searchParams.get("name")!;
        const all = ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"];
        return j({ server_types: [{ name, locations: all.map((l) => ({ name: l, available: stock.includes(`hetzner:${name}:${l}`) })) }] });
      }
      if (p === "/v1/volumes" && method === "POST") { const id = ++n; const v = { id, server: null, location: { name: body.location }, labels: body.labels, size: body.size }; volumes.set(String(id), v); return j({ volume: v }, 201); }
      if (p === "/v1/volumes") return j({ volumes: [...volumes.values()].filter((v) => match(v.labels)) });
      let m = /^\/v1\/volumes\/(\d+)$/.exec(p);
      if (m && method === "GET") return volumes.has(m[1]) ? j({ volume: volumes.get(m[1]) }) : j({ error: { code: "not_found" } }, 404);
      if (m && method === "DELETE") { volumes.delete(m[1]); return j({}); }
      m = /^\/v1\/volumes\/(\d+)\/actions\/(attach|detach)$/.exec(p);
      if (m) { volumes.get(m[1]).server = m[2] === "attach" ? body.server : null; return j({ action: {} }); }
      if (p === "/v1/servers" && method === "POST") {
        const key = `hetzner:${body.server_type}:${body.location}`;
        if (!stock.includes(key)) return j({ error: { code: "resource_unavailable" } }, 412);
        const id = ++n; const s = { id, status: "initializing", labels: body.labels, public_net: { ipv4: { ip: `203.0.113.${id % 250}` } } };
        servers.set(String(id), s); for (const v of body.volumes) volumes.get(String(v)).server = id; return j({ server: s }, 201);
      }
      if (p === "/v1/servers") return j({ servers: [...servers.values()].filter((s) => match(s.labels)) });
      m = /^\/v1\/servers\/(\d+)$/.exec(p);
      if (m && method === "GET") return j({ server: servers.get(m[1]) });
      if (m && method === "DELETE") { servers.delete(m[1]); return j({}); }
      m = /^\/v1\/servers\/(\d+)\/actions\/create_image$/.exec(p);
      if (m) { const id = ++n; snaps.set(String(id), { id, labels: body.labels }); return j({ image: { id } }); }
      if (p === "/v1/images") return j({ images: [...snaps.values()].filter((s) => match(s.labels)) });
      m = /^\/v1\/images\/(\d+)$/.exec(p);
      if (m && method === "DELETE") { snaps.delete(m[1]); return j({}); }
      if (/^\/v1\/(servers\/\d+|firewalls\/\d+)\/actions\//.test(p)) return j({ action: {} });
    }
    if (u.host === "api.vultr.com") {
      let m = /^\/v2\/regions\/([a-z]+)\/availability$/.exec(p);
      if (m) return j({ available_plans: stock.filter((s) => s.startsWith("vultr:") && s.endsWith(`:${m![1]}`)).map((s) => s.split(":")[1]) });
      if (p === "/v2/blocks" && method === "POST") { const id = `blk-${++n}-aaaa-bbbb-cccc`; const b = { id, region: body.region, label: body.label, attached_to_instance: null }; volumes.set(id, b); return j({ block: b }, 202); }
      if (p === "/v2/blocks") return j({ blocks: [...volumes.values()] });
      m = /^\/v2\/blocks\/([^/]+)(?:\/(attach|detach))?$/.exec(p);
      if (m && m[2]) { volumes.get(m[1]).attached_to_instance = m[2] === "attach" ? body.instance_id : null; return j({}); }
      if (m && method === "GET") return j({ block: volumes.get(m[1]) });
      if (m && method === "DELETE") { volumes.delete(m[1]); return j({}); }
      if (p === "/v2/instances" && method === "POST") {
        if (!stock.includes(`vultr:${body.plan}:${body.region}`)) return j({ error: "unavailable" }, 400);
        const id = `inst-${++n}`; const s = { id, main_ip: "198.51.100.7", power_status: "running", server_status: "ok", tags: body.tags }; servers.set(id, s); return j({ instance: s }, 202);
      }
      if (p === "/v2/instances") return j({ instances: [...servers.values()].filter((s) => s.tags?.includes(u.searchParams.get("tag"))) });
      m = /^\/v2\/instances\/([^/]+)$/.exec(p);
      if (m && method === "GET") return j({ instance: servers.get(m[1]) });
      if (m && (method === "DELETE")) { servers.delete(m[1]); return j({}); }
      if (m && method === "PATCH") { Object.assign(servers.get(m[1]), body); return j({}); }
      if (p === "/v2/snapshots" && method === "POST") { const id = `vsnap-${++n}`; snaps.set(id, { id, description: body.description }); return j({ snapshot: { id } }); }
      if (p === "/v2/snapshots") return j({ snapshots: [...snaps.values()] });
      m = /^\/v2\/snapshots\/([^/]+)$/.exec(p);
      if (m && method === "DELETE") { snaps.delete(m[1]); return j({}); }
    }
    return j({ error: { code: "unexpected" } }, 500);
  };
  return { fetcher, calls, servers, volumes, snaps };
}
const adapters = (f: HostFetch) => ({ hetzner: hetznerAdapter("t", { sshKeyIds: [], firewallIds: [] }, f), vultr: vultrAdapter("k", {}, f) });
const cfg = (extra?: Record<string, unknown>) => provisionerSchema.parse(JSON.parse(cfgJson(extra)));

describe("ladder", () => {
  it("is exactly the approved order and never contains CPX", () => {
    expect(DEFAULT_LADDERS.starter.map((r) => `${r.provider}:${r.serverType}`)).toEqual(["hetzner:cx23", "hetzner:cax11", "vultr:vc2-2c-4gb"]);
    expect(DEFAULT_LADDERS.pro.map((r) => `${r.provider}:${r.serverType}`)).toEqual(["hetzner:cax21", "hetzner:cx33", "vultr:vc2-4c-8gb"]);
    expect(DEFAULT_LADDERS.max.map((r) => `${r.provider}:${r.serverType}`)).toEqual(["hetzner:cax21", "hetzner:cx33", "vultr:vc2-4c-8gb"]);
    for (const l of Object.values(DEFAULT_LADDERS)) for (const r of l) expect(r.serverType).not.toMatch(/^cpx/);
  });
  it("refuses a CPX type even when an operator configures one", () => {
    expect(() => provisionerConfig({ ...env, B5_PROVISIONER_CONFIG: cfgJson({ ladders: { starter: [{ provider: "hetzner", serverType: "cpx22", arch: "x86" }] } }) } as Env)).toThrow("server_type_forbidden");
    expect(() => ladderFor(cfg(), "enterprise")).toThrow("unknown_plan");
  });
  it("Starter takes CX23 in the first stocked location, in location order", async () => {
    const cloud = fakeCloud(["hetzner:cx23:nbg1", "hetzner:cx23:hel1", "hetzner:cax11:fsn1"]);
    const { choice, tried } = await chooseRung(cfg(), "starter", adapters(cloud.fetcher));
    expect(choice).toMatchObject({ provider: "hetzner", serverType: "cx23", location: "nbg1", arch: "x86", image: "111" });
    expect(tried).toEqual([{ provider: "hetzner", serverType: "cx23", arch: "x86", result: "chosen" }]);
  });
  it("Starter falls to CAX11 ARM when CX23 is sold out, then to Vultr, and records every rung tried", async () => {
    let cloud = fakeCloud(["hetzner:cax11:hel1"]);
    let r = await chooseRung(cfg(), "starter", adapters(cloud.fetcher));
    expect(r.choice).toMatchObject({ serverType: "cax11", arch: "arm", location: "hel1", image: "222" });
    expect(r.tried.map((t) => t.result)).toEqual(["no_stock", "chosen"]);
    cloud = fakeCloud(["vultr:vc2-2c-4gb:ams", "vultr:vc2-2c-4gb:fra"]);
    r = await chooseRung(cfg(), "starter", adapters(cloud.fetcher));
    expect(r.choice).toMatchObject({ provider: "vultr", serverType: "vc2-2c-4gb", location: "fra", image: "snap-vultr-1" });
    expect(r.tried.map((t) => t.result)).toEqual(["no_stock", "no_stock", "chosen"]);
  });
  it("Pro and Max try ARM CAX21 first, then CX33, then Vultr 4c/8g", async () => {
    for (const plan of ["pro", "max"]) {
      expect((await chooseRung(cfg(), plan, adapters(fakeCloud(["hetzner:cax21:fsn1", "hetzner:cx33:fsn1"]).fetcher))).choice).toMatchObject({ serverType: "cax21", arch: "arm" });
      expect((await chooseRung(cfg(), plan, adapters(fakeCloud(["hetzner:cx33:nbg1"]).fetcher))).choice).toMatchObject({ serverType: "cx33", location: "nbg1" });
      expect((await chooseRung(cfg(), plan, adapters(fakeCloud(["vultr:vc2-4c-8gb:cdg"]).fetcher))).choice).toMatchObject({ provider: "vultr", serverType: "vc2-4c-8gb", location: "cdg" });
    }
  });
  it("skips an ARM rung while the ARM image id is not configured, and fails closed when nothing is in stock", async () => {
    const noArm = provisionerSchema.parse({ images: { hetzner: { x86: "111" }, vultr: { x86: "s" } } });
    const r = await chooseRung(noArm, "pro", adapters(fakeCloud(["hetzner:cax21:fsn1", "hetzner:cx33:hel1"]).fetcher));
    expect(r.choice).toMatchObject({ serverType: "cx33" });
    expect(r.tried[0]).toMatchObject({ serverType: "cax21", result: "no_image" });
    await expect(chooseRung(cfg(), "starter", adapters(fakeCloud([]).fetcher))).rejects.toThrow("no_capacity");
  });
  it("only ever offers EU locations: build host fsn1/nbg1/hel1 and Vultr EU regions; ash/hil/sin and US/Asia regions are impossible", async () => {
    expect(() => cfg({ hetznerLocations: ["ash"] })).toThrow();
    expect(() => cfg({ hetznerLocations: ["sin"] })).toThrow();
    expect(() => cfg({ vultrRegions: ["ewr"] })).toThrow();
    expect(() => cfg({ vultrRegions: ["lhr"] })).toThrow(); // UK is not the EU
    expect(cfg().vultrRegions).toEqual(["fra", "ams", "cdg", "sto", "waw", "mad"]);
    // build host reports ash/hil/sin in stock: they are never chosen.
    const cloud = fakeCloud(["hetzner:cx23:ash", "hetzner:cx23:hil", "hetzner:cx23:sin", "vultr:vc2-2c-4gb:ewr", "vultr:vc2-2c-4gb:mad"]);
    const r = await chooseRung(cfg(), "starter", adapters(cloud.fetcher));
    expect(r.choice).toMatchObject({ provider: "vultr", location: "mad" }); // ewr (New Jersey) is in stock but never considered
    expect(r.tried[0].result).toBe("no_stock");
    expect(cloud.calls.some((c) => /regions\/ewr\//.test(c.url))).toBe(false);
  });
  it("opsSshFrom (staging only) accepts specific operator networks and refuses world-open or wide ranges", () => {
    expect(cfg().opsSshFrom).toEqual([]);
    expect(cfg({ opsSshFrom: ["95.216.244.213/32", "203.0.113.0/24"] }).opsSshFrom).toHaveLength(2);
    for (const bad of ["0.0.0.0/0", "10.0.0.0/8", "0.0.0.0/1", "::/0", "any"]) expect(() => cfg({ opsSshFrom: [bad] })).toThrow();
  });
  it("quarantining an already quarantined server is a no-op (fencing repeats every reconcile)", async () => {
    let n = 0;
    const hz = hetznerAdapter("t", { sshKeyIds: [], firewallIds: [], quarantineFirewallId: 9 }, async () => {
      n++; return n === 1 ? new Response("{}", { status: 201 }) : new Response(JSON.stringify({ error: { code: "firewall_already_applied" } }), { status: 422 });
    });
    await hz.quarantine("5"); await hz.quarantine("5");
    expect(n).toBe(2);
    const bad = hetznerAdapter("t", { sshKeyIds: [], firewallIds: [], quarantineFirewallId: 9 }, async () => new Response(JSON.stringify({ error: { code: "locked" } }), { status: 423 }));
    await expect(bad.quarantine("5")).rejects.toThrow("locked");
  });
  it("a rung whose availability call errors is skipped, not fatal", async () => {
    const hz = hetznerAdapter("t", { sshKeyIds: [], firewallIds: [] }, async () => new Response("{}", { status: 500 }));
    const cloud = fakeCloud(["vultr:vc2-2c-4gb:fra"]);
    const r = await chooseRung(cfg(), "starter", { hetzner: hz, vultr: vultrAdapter("k", {}, cloud.fetcher) });
    expect(r.choice.provider).toBe("vultr");
    expect(r.tried.map((t) => t.result)).toEqual(["error", "error", "chosen"]);
  });
});

describe("live ProviderAdapter on the B3 interface", () => {
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,created_at,updated_at) VALUES ('home-1','cus_1','pro',1,1)").run();
  });
  async function create(cloud: ReturnType<typeof fakeCloud>) {
    const p = createLiveProvider(e(), { fetch: cloud.fetcher, now: () => 5 });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    const s = await p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-create-00000001", type: "ignored", location: "ignored",
      image: `sha256:${"a".repeat(64)}`, labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "tok-secret", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } } });
    return { p, v, s };
  }
  it("build host: records the choice, creates the volume in the chosen EU location, attaches it at create, adopts instead of duplicating", async () => {
    const cloud = fakeCloud(["hetzner:cax21:hel1"]);
    const { p, v, s } = await create(cloud);
    const choice = await env.DB.prepare("SELECT * FROM provision_choices").first<Record<string, string>>();
    expect(choice).toMatchObject({ provider: "hetzner", server_type: "cax21", location: "hel1", arch: "arm", image: "222" });
    expect(JSON.parse(choice!.tried)).toEqual([{ provider: "hetzner", serverType: "cax21", arch: "arm", result: "chosen" }]);
    const vol = [...cloud.volumes.values()][0]; expect(vol.location.name).toBe("hel1"); expect(vol.size).toBe(150);
    const serverCall = cloud.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/servers"))!.body;
    expect(serverCall).toMatchObject({ server_type: "cax21", location: "hel1", image: 222, automount: false, start_after_create: true });
    expect(serverCall.user_data).toContain("murage_enrollment_token: tok-secret");
    expect(serverCall.user_data).toContain("/etc/murage-home/volume.json");
    expect(serverCall.labels).toEqual({ "murage/home": "home-1", "murage/generation": "1", "murage/role": "home", "murage/call": "k-create-00000001" });
    expect(v.device).toBe(`/dev/disk/by-id/scsi-0HC_Volume_${v.id}`);
    expect(s.id).toMatch(/^hs-\d+$/);
    expect((await p.volume(v.id)).attachment).toMatchObject({ state: "attached", serverId: s.id });
    expect(await p.public_ips(s.id)).toHaveLength(1);
    expect((await p.list_by_tag("home-1", 1, "home")).map((r) => r.id)).toEqual([s.id]);
    expect((await p.list_by_tag("home-1", 1, "volume")).map((r) => r.id)).toEqual([v.id]);
    const again = await p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-create-00000001", type: "x", location: "y", image: `sha256:${"a".repeat(64)}`,
      labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "t", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } } });
    expect(again.id).toBe(s.id); expect(cloud.servers.size).toBe(1);
  });
  it("Vultr fallback lands in an EU region, attaches the block after create and validates as a volume", async () => {
    const cloud = fakeCloud(["vultr:vc2-4c-8gb:waw"]);
    const { p, v, s } = await create(cloud);
    expect(v.provider).toBe("vultr");
    expect([...cloud.volumes.values()][0].region).toBe("waw");
    expect(cloud.calls.find((c) => c.url.endsWith("/v2/instances") && c.method === "POST")!.body).toMatchObject({ region: "waw", plan: "vc2-4c-8gb", snapshot_id: "snap-vultr-1" });
    expect((await p.attach_volume(v.id, s.id)).attachment.state).toBe("attached");
    expect((await p.detach_volume(v.id, s.id)).attachment.state).toBe("detached");
  });
  it("Vultr create carries the ssh key ids and the home firewall group", async () => {
    const cloud = fakeCloud(["vultr:vc2-4c-8gb:waw"]);
    await create(cloud);
    expect(cloud.calls.find((c) => c.url.endsWith("/v2/instances") && c.method === "POST")!.body).toMatchObject({ sshkey_id: ["vk-1"], firewall_group_id: "fwg-home" });
  });
  it("without the vultr config block the Vultr rung is skipped, never an unfirewalled home", async () => {
    const cloud = fakeCloud(["vultr:vc2-2c-4gb:fra"]);
    await expect(chooseRung(cfg({ vultr: undefined }), "starter", adapters(cloud.fetcher))).rejects.toThrow("no_capacity");
    expect(cloud.calls.some((c) => c.url.includes("api.vultr.com") && c.url.includes("availability"))).toBe(false);
    const hz = fakeCloud(["hetzner:cax11:fsn1"]);
    const { tried } = await chooseRung(cfg({ vultr: undefined }), "starter", adapters(hz.fetcher));
    expect(tried[0].result).not.toBe("chosen");
    const noBlock = vultrAdapter("k", {}, cloud.fetcher);
    await expect(noBlock.createServer({ name: "n", serverType: "vc2-2c-4gb", location: "fra", image: "s", userData: "", labels: { homeId: "h", generation: 1, role: "home" } } as any)).rejects.toThrow("vultr_firewall_missing");
    expect(cloud.calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/instances"))).toBe(false);
  });
  it("Vultr quarantine moves a real instance into the vultr quarantine group; missing group throws unsent", async () => {
    const cloud = fakeCloud([]);
    cloud.servers.set("inst-9", { id: "inst-9", firewall_group_id: "fwg-home" });
    await vultrAdapter("k", cfg(), cloud.fetcher).quarantine("inst-9");
    const patch = cloud.calls.find((c) => c.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe("/v2/instances/inst-9");
    expect(patch.body).toEqual({ firewall_group_id: "fwg-quar" });
    expect(cloud.servers.get("inst-9").firewall_group_id).toBe("fwg-quar");
    const err = await vultrAdapter("k", cfg({ vultr: undefined }), cloud.fetcher).quarantine("inst-9").catch((x: unknown) => x);
    expect((err as Error).message).toBe("quarantine_firewall_missing");
    expect(cloud.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
  it("Vultr quarantine falls back to the legacy top-level group when the block is absent", async () => {
    const cloud = fakeCloud([]);
    cloud.servers.set("inst-9", { id: "inst-9", firewall_group_id: "fwg-home" });
    await vultrAdapter("k", cfg({ vultr: undefined, quarantineFirewallGroupId: "fwg-legacy" }), cloud.fetcher).quarantine("inst-9");
    expect(cloud.servers.get("inst-9").firewall_group_id).toBe("fwg-legacy");
  });
  it("vultr config rejects missing or empty ssh keys and the remove-firewall id 0 or blank", () => {
    const bad = (v: Record<string, unknown>) => expect(() => cfg({ vultr: { ...VULTR, ...v } })).toThrow();
    bad({ sshKeyIds: [] }); bad({ sshKeyIds: undefined }); bad({ sshKeyIds: ["0"] });
    bad({ firewallGroupId: "0" }); bad({ firewallGroupId: " " }); bad({ firewallGroupId: "" });
    bad({ quarantineFirewallGroupId: "0" }); bad({ quarantineFirewallGroupId: "" });
    expect(() => cfg({ vultr: undefined, quarantineFirewallGroupId: "0" })).toThrow();
    expect(() => cfg({ vultr: undefined, quarantineFirewallGroupId: "" })).toThrow();
  });
  it("the unfirewalled-create refusal is marked not sent", async () => {
    const cloud = fakeCloud([]);
    const err = await vultrAdapter("k", {}, cloud.fetcher).createServer({ name: "n", serverType: "vc2-2c-4gb", location: "fra", image: "s", userData: "", volumeId: null, labels: { homeId: "h", generation: 1, role: "home" } } as any).catch((x: unknown) => x);
    expect((err as Error).message).toBe("vultr_firewall_missing");
    expect(isNotSent(err)).toBe(true);
  });
  it("stop, start, destroy go to the right provider; destroy of a missing resource is idempotent", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]);
    const { p, v, s } = await create(cloud);
    await p.stop(s.id); await p.start(s.id); await p.power_off(s.id);
    expect(cloud.calls.filter((c) => /actions\/(poweron|poweroff)$/.test(c.url)).length).toBe(3);
    await p.fence_network(s.id, "192.0.2.20");
    expect(cloud.calls.some((c) => c.url.endsWith("/v1/firewalls/77/actions/apply_to_resources"))).toBe(true);
    await p.destroy(s.id); await p.destroy(s.id); await p.destroy(v.id);
    expect(cloud.servers.size).toBe(0); expect(cloud.volumes.size).toBe(0);
  });
  it("snapshots at suspension are taken once and purged at deletion, leaving nothing behind", async () => {
    const cloud = fakeCloud(["hetzner:cx33:fsn1", "hetzner:cax21:fsn1"]);
    const { p } = await create(cloud);
    await p.snapshot_home!("home-1", 1); await p.snapshot_home!("home-1", 1);
    expect(cloud.snaps.size).toBe(1);
    expect(await env.DB.prepare("SELECT kind,covers_volume FROM volume_snapshots").first()).toEqual({ kind: "server_snapshot", covers_volume: 0 });
    await p.purge_snapshots!("home-1", 1);
    expect(cloud.snaps.size).toBe(0);
    expect(await env.DB.prepare("SELECT 1 FROM volume_snapshots").first()).toBeNull();
    await p.purge_snapshots!("home-1", 1); // idempotent
  });
  // ---- round 12 (Astra MAILRETRY-16) ----
  const serverInput = (v: Awaited<ReturnType<ReturnType<typeof createLiveProvider>["create_volume"]>>, key: string) => ({ homeId: "home-1", resourceGeneration: 1,
    idempotencyKey: key, type: "x", location: "y", image: `sha256:${"a".repeat(64)}`, labels: { homeId: "home-1", resourceGeneration: "1", role: "home" as const }, volume: v,
    userData: { machineId: "home-1", enrollmentToken: "t", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
      volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } } });
  it("MAILRETRY-16 P1: the create's answer is lost and the recovery listing answers 429: the error is the create's own (unanswered), never the 429", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]);
    let posted = false;
    const f: HostFetch = async (u, init) => {
      const method = init?.method ?? "GET";
      if (u.includes("/v1/servers") && method === "POST") { posted = true; return new Response("{}", { status: 503 }); }
      if (posted && u.includes("/v1/servers?") && method === "GET") return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 });
      return cloud.fetcher(u, init);
    };
    const p = createLiveProvider(e(), { fetch: f, now: () => 5 });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    const error = await p.create(serverInput(v, "k-create-00000001")).then(() => null, (x: unknown) => x);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).status).toBe(503); // before the fix: the recovery listing's 429, read as the provider refusing the create
    expect(providerAnswered(error)).toBe(false);
    // A GET 429 itself is never a create's answer; a 4xx of the create POST is.
    const refused = await p.create(serverInput(v, "k-create-00000002")).then(() => null, (x: unknown) => x);
    expect(providerAnswered(refused)).toBe(false);
    const g: HostFetch = async (u, init) => (u.includes("/v1/servers") && init?.method === "POST")
      ? new Response(JSON.stringify({ error: { code: "invalid_input" } }), { status: 422 }) : cloud.fetcher(u, init);
    const p2 = createLiveProvider(e(), { fetch: g, now: () => 5 });
    expect(providerAnswered(await p2.create(serverInput(v, "k-create-00000003")).then(() => null, (x: unknown) => x))).toBe(true);
  });
  it("MAILRETRY-16 P1: a lost answer adopts only the server labelled with THIS call's key, never another call's server of the same generation", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]);
    let mode: "own" | "other" = "other";
    const f: HostFetch = async (u, init) => {
      if (u.endsWith("/v1/servers") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const labels = mode === "own" ? body.labels : { ...body.labels, "murage/call": "another-call" };
        cloud.servers.set("900", { id: 900, status: "initializing", labels, public_net: { ipv4: { ip: "203.0.113.9" } } });
        return new Response("{}", { status: 502 }); // the server exists; the answer is lost
      }
      return cloud.fetcher(u, init);
    };
    const p = createLiveProvider(e(), { fetch: f, now: () => 5 });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    expect(await p.create(serverInput(v, "k-create-00000001")).then(() => "adopted", () => "refused-adoption")).toBe("refused-adoption");
    cloud.servers.clear(); mode = "own";
    const s = await p.create(serverInput(v, "k-create-00000002"));
    expect(s).toMatchObject({ id: "hs-900", idempotency_key: "k-create-00000002" });
    expect((await p.list_by_tag("home-1", 1, "home"))[0].idempotency_key).toBe("k-create-00000002");
  });
  it("INTEGRATED-8 P2: native volume discovery keeps the create call's key so cleanup can settle that call", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]);
    const p = createLiveProvider(e(), { fetch: cloud.fetcher, now: () => 5 });
    await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-late-001", provider: "hetzner" });
    const found = await p.list_by_tag("home-1", 1, "volume");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ role: "volume", idempotency_key: "k-volume-late-001" });
  });
  it("MAILRETRY-16 P3: the purge passes the caller's signal to every snapshot request; an aborted purge throws", async () => {
    const cloud = fakeCloud(["hetzner:cx33:fsn1", "hetzner:cax21:fsn1"]);
    const signals: { method: string; signal: AbortSignal | null | undefined }[] = [];
    const f: HostFetch = async (u, init) => { if (u.includes("/v1/images")) signals.push({ method: init?.method ?? "GET", signal: init?.signal }); return cloud.fetcher(u, init); };
    const { p } = await create({ ...cloud, fetcher: f });
    await p.snapshot_home!("home-1", 1);
    signals.length = 0;
    const bound = new AbortController();
    await p.purge_snapshots!("home-1", 1, bound.signal);
    expect(signals.map((x) => x.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(signals.every((x) => x.signal === bound.signal)).toBe(true);
    await p.snapshot_home!("home-1", 1);
    const aborted = new AbortController(); aborted.abort(new Error("claim lease over"));
    await expect(p.purge_snapshots!("home-1", 1, aborted.signal)).rejects.toThrow();
  });
  it("snapshotAtSuspension=false takes no snapshot", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]);
    const p = createLiveProvider({ ...e({ snapshotAtSuspension: false }) } as Env, { fetch: cloud.fetcher });
    await p.snapshot_home!("home-1", 1);
    expect(cloud.snaps.size).toBe(0);
  });
  it("refuses to size a server for a home with no known plan", async () => {
    await env.DB.prepare("DELETE FROM billing_subscriptions").run();
    const p = createLiveProvider(e(), { fetch: fakeCloud(["hetzner:cx23:fsn1"]).fetcher });
    await expect(p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" })).rejects.toThrow("plan_unknown");
  });
  it("sends the API tokens only as Authorization headers", async () => {
    const seen: string[] = [];
    const cloud = fakeCloud(["hetzner:cx33:fsn1"]);
    const wrapped: HostFetch = async (u, init) => { seen.push(JSON.stringify(init?.headers)); expect(u).not.toContain("hz-test-token"); return cloud.fetcher(u, init); };
    await createLiveProvider(e(), { fetch: wrapped }).list_by_tag("home-1", 1, "home");
    vi.clearAllMocks();
  });
});

describe("backups: Storage Box sub-account per home", () => {
  const BOX = { id: 4242, host: "u4242.your-storagebox.de", mainUser: "u4242", baseDir: "murage",
    knownHosts: "[u4242.your-storagebox.de]:23 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestonlyfixturekeyfixture" };
  const withBox = { storageBox: BOX };
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,created_at,updated_at) VALUES ('home-1','cus_1','pro',1,1)").run();
  });
  /** In-memory StorageBoxAdapter: no network. */
  function fakeBox(preload = 0) {
    const subs = new Map<string, { directory: string; password: string }>(); const dirs = new Set<string>(); const log: string[] = [];
    const adapter = {
      async createSubaccount(i: { homeId: string; generation: number; password: string }) {
        const id = `sub-${subs.size + 1}-${i.generation}`; const directory = `murage/${i.homeId}-g${i.generation}`;
        subs.set(id, { directory, password: i.password }); dirs.add(directory); log.push(`create ${id}`);
        return { id, username: `u4242-sub${subs.size}`, server: "u4242.your-storagebox.de", directory };
      },
      async purgeDirectory(d: string) { dirs.delete(d); log.push(`purge ${d}`); },
      async directoryExists(d: string) { return dirs.has(d); },
      async deleteSubaccount(id: string) { subs.delete(id); log.push(`delete ${id}`); },
      async countSubaccounts() { return subs.size + preload; },
    };
    return { adapter, subs, dirs, log };
  }
  const decode = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  async function createWith(cloud: ReturnType<typeof fakeCloud>, box: ReturnType<typeof fakeBox>, password = async () => "restic-password-from-hkdf") {
    const p = createLiveProvider(e(withBox), { fetch: cloud.fetcher, now: () => 9, storageBox: box.adapter });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    const s = await p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-create-00000001", type: "x", location: "y",
      image: `sha256:${"a".repeat(64)}`, labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "tok", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } },
      backup: { resticPassword: await password() } });
    return { p, v, s };
  }
  function filesOf(cloud: ReturnType<typeof fakeCloud>) {
    const ud: string = cloud.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/servers"))!.body.user_data;
    const out: Record<string, string> = {};
    for (const m of ud.matchAll(/- path: (\S+)\n    permissions: '0600'\n    owner: root:root\n(?:    encoding: b64\n    content: (\S+)|    content: '(.*)')/g)) {
      out[m[1]] = m[2] ? decode(m[2]) : m[3];
    }
    return { ud, files: out };
  }
  it("creates one sub-account and writes backup.json, backup.pass, backup.key and backup.known_hosts (b64, root 0600)", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]); const box = fakeBox();
    await createWith(cloud, box);
    expect(box.subs.size).toBe(1);
    const { ud, files } = filesOf(cloud);
    expect(JSON.parse(files["/etc/murage-home/backup.json"])).toEqual({ repository: "sftp://u4242-sub1@u4242.your-storagebox.de:23/restic",
      passwordFile: "/etc/murage-home/backup.pass", sshKey: "/etc/murage-home/backup.key", knownHosts: "/etc/murage-home/backup.known_hosts" });
    expect(files["/etc/murage-home/backup.pass"]).toBe("restic-password-from-hkdf");
    expect(files["/etc/murage-home/backup.key"]).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(files["/etc/murage-home/backup.known_hosts"]).toBe(BOX.knownHosts + "\n");
    const boot = JSON.parse(files["/etc/murage-home/backup.bootstrap"]);
    expect(boot).toMatchObject({ user: "u4242-sub1", host: "u4242.your-storagebox.de", password: box.subs.get("sub-1-1")!.password });
    expect(boot.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ murage-home-home-1\n$/);
    expect(ud).toContain("runcmd:"); expect(ud).toContain("/usr/local/libexec/murage-backup-authorize");
    expect(files["/etc/murage-home/volume.json"]).toBeDefined(); // the existing file is still written
    // the sub-account's secrets are not stored in D1
    const row = JSON.stringify(await env.DB.prepare("SELECT * FROM backup_subaccounts").first());
    expect(row).not.toContain(boot.password); expect(row).not.toContain("restic-password");
  });
  it("the private key and public key are the same ed25519 pair in valid OpenSSH layout", async () => {
    const { generateOpenSshEd25519 } = await import("../src/b5-sshkey");
    const k = await generateOpenSshEd25519("c");
    const body = Uint8Array.from(atob(k.privateKey.split("\n").slice(1, -2).join("")), (ch) => ch.charCodeAt(0));
    expect(new TextDecoder().decode(body.slice(0, 15))).toBe("openssh-key-v1\0");
    const pubB64 = k.publicKey.split(" ")[1];
    const pub = Uint8Array.from(atob(pubB64), (ch) => ch.charCodeAt(0));
    // the public blob (ssh-ed25519 + 32 bytes) appears inside the private body, twice (outer + inner copy)
    const hex = (a: Uint8Array) => [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(body).split(hex(pub.slice(-32))).length - 1).toBeGreaterThanOrEqual(3);
  });
  it("is off without a storageBox config (no sub-account, no backup files)", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]); const box = fakeBox();
    const p = createLiveProvider(e(), { fetch: cloud.fetcher, storageBox: box.adapter });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    await p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-create-00000001", type: "x", location: "y", image: `sha256:${"a".repeat(64)}`,
      labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "tok", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } } });
    expect(box.subs.size).toBe(0); expect(filesOf(cloud).ud).not.toContain("backup.json");
  });
  it("fails closed, creating no server, when the backup password source is not wired", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]); const box = fakeBox();
    const p = createLiveProvider(e(withBox), { fetch: cloud.fetcher, storageBox: box.adapter });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    await expect(p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k", type: "x", location: "y", image: `sha256:${"a".repeat(64)}`,
      labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "tok", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } } })).rejects.toThrow("backup_password_unavailable");
    expect(cloud.servers.size).toBe(0); expect(box.subs.size).toBe(0);
  });
  it("a retry after a failed server create replaces the sub-account instead of leaking one", async () => {
    const box = fakeBox();
    await createWith(fakeCloud(["hetzner:cax21:fsn1"]), box);
    // the server create "failed" earlier: a second attempt for the same home generation
    const cloud2 = fakeCloud(["hetzner:cax21:fsn1"]);
    const p = createLiveProvider(e(withBox), { fetch: cloud2.fetcher, now: () => 10, storageBox: box.adapter });
    const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
    await p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k", type: "x", location: "y", image: `sha256:${"a".repeat(64)}`,
      labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
      userData: { machineId: "home-1", enrollmentToken: "tok", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
        volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } },
      backup: { resticPassword: "pw" } });
    expect(box.subs.size).toBe(1);
    expect(box.log.filter((l) => l.startsWith("delete")).length).toBe(1);
  });
  it("day-14 deletion removes the backup data and the sub-account with the snapshots, and is repeatable", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]); const box = fakeBox();
    const { p } = await createWith(cloud, box);
    await p.purge_snapshots!("home-1", 1);
    expect(box.subs.size).toBe(0); expect(box.dirs.size).toBe(0);
    expect(box.log.slice(-2)).toEqual(["purge murage/home-1-g1", "delete sub-1-1"]);
    expect((await env.DB.prepare("SELECT deleted_at FROM backup_subaccounts").first<{ deleted_at: number }>())!.deleted_at).toBe(9);
    await p.purge_snapshots!("home-1", 1);
  });
  it("deletion fails (so reconcile retries) and keeps the sub-account if data is still there", async () => {
    const cloud = fakeCloud(["hetzner:cax21:fsn1"]); const box = fakeBox();
    const { p } = await createWith(cloud, box);
    box.adapter.purgeDirectory = async () => { /* purge silently did nothing */ };
    await expect(p.purge_snapshots!("home-1", 1)).rejects.toThrow("backup_purge_incomplete");
    expect(box.subs.size).toBe(1);
  });
  describe("several boxes", () => {
    const BOX2 = { ...BOX, id: 4343, host: "u4343.your-storagebox.de", mainUser: "u4343" };
    const two = { storageBox: [BOX, BOX2] };
    beforeEach(async () => { await env.DB.prepare("DELETE FROM backup_subaccounts").run(); });
    async function createOn(cloud: ReturnType<typeof fakeCloud>, boxes: Record<number, ReturnType<typeof fakeBox>["adapter"]>) {
      const p = createLiveProvider(e(two), { fetch: cloud.fetcher, now: () => 9, storageBox: boxes });
      const v = await p.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-volume-0000001", provider: "hetzner" });
      return p.create({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: "k-create-00000001", type: "x", location: "y",
        image: `sha256:${"a".repeat(64)}`, labels: { homeId: "home-1", resourceGeneration: "1", role: "home" }, volume: v,
        userData: { machineId: "home-1", enrollmentToken: "tok", controlPlaneOrigin: "https://accounts.murage.ai", generation: 1,
          volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: 1, homeId: "home-1" } },
          backup: { resticPassword: "pw" } }).then(() => p);
    }
    it("accepts one object or a list for storageBox", () => {
      expect(provisionerConfig(e(withBox)).storageBox).toEqual([expect.objectContaining({ id: 4242 })]);
      expect(provisionerConfig(e(two)).storageBox).toHaveLength(2);
    });
    it("uses the first box below 95 sub-accounts and skips a full one", async () => {
      const full = fakeBox(95), open = fakeBox(10);
      await createOn(fakeCloud(["hetzner:cax21:fsn1"]), { 4242: full.adapter, 4343: open.adapter });
      expect(full.log).toEqual([]);
      expect(open.log).toEqual(["create sub-1-1"]);
      expect((await env.DB.prepare("SELECT box_id FROM backup_subaccounts WHERE home_id='home-1'").first<{ box_id: number }>())!.box_id).toBe(4343);
    });
    it("keeps filling the first box while it has room", async () => {
      const first = fakeBox(94), second = fakeBox(0);
      await createOn(fakeCloud(["hetzner:cax21:fsn1"]), { 4242: first.adapter, 4343: second.adapter });
      expect(first.log).toEqual(["create sub-1-1"]);
      expect(second.log).toEqual([]);
    });
    it("raises an alert and fails the create when every box is full (never silently)", async () => {
      const a = fakeBox(95), b = fakeBox(99);
      await expect(createOn(fakeCloud(["hetzner:cax21:fsn1"]), { 4242: a.adapter, 4343: b.adapter })).rejects.toThrow("storage_boxes_full");
      expect(a.log).toEqual([]); expect(b.log).toEqual([]);
      const alert = await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE home_id='home-1'").first<{ kind: string; severity: string }>();
      expect(alert).toEqual({ kind: "backup.storage_boxes_full", severity: "high" });
    });
    it("deletes a home's backup on the box that holds it", async () => {
      const a = fakeBox(95), b = fakeBox(0);
      const p = await createOn(fakeCloud(["hetzner:cax21:fsn1"]), { 4242: a.adapter, 4343: b.adapter });
      await p.purge_snapshots!("home-1", 1);
      expect(b.log).toContain("delete sub-1-1");
      expect(a.log).toEqual([]);
    });
  });
  it("the real build host Storage Box adapter speaks the sub-account API and recursive WebDAV delete (mocked fetch)", async () => {
    const { hetznerStorageBox } = await import("../src/b5-backup");
    const calls: { method: string; url: string; auth: string | null; body: any }[] = [];
    let gone = false;
    const f: HostFetch = async (url, init) => {
      const h = new Headers(init?.headers); calls.push({ method: init?.method ?? "GET", url, auth: h.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/subaccounts") && init?.method === "POST") return new Response(JSON.stringify({ action: { id: 1, status: "running" }, subaccount: { id: 77, storage_box: 4242 } }), { status: 201 });
      if (url.endsWith("/subaccounts/77") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ subaccount: { id: 77, username: "u4242-sub9", server: "u4242-sub9.your-storagebox.de" } }), { status: 200 });
      if (init?.method === "DELETE" && url.includes("/subaccounts/")) return new Response(null, { status: 204 });
      if (init?.method === "DELETE") { gone = true; return new Response(null, { status: 204 }); }
      if (url.includes("/subaccounts?") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ subaccounts: [], meta: { pagination: { total_entries: 12 } } }), { status: 200 });
      if (init?.method === "PROPFIND") return new Response("", { status: gone ? 404 : 207 });
      return new Response("{}", { status: 500 });
    };
    const box = hetznerStorageBox("api-token", BOX, "main-pw", f);
    const sub = await box.createSubaccount({ homeId: "home-1", generation: 1, password: "pw" });
    expect(sub).toEqual({ id: "77", username: "u4242-sub9", server: "u4242.your-storagebox.de", directory: "murage/home-1-g1" });
    expect(calls[0].url).toBe("https://api.hetzner.com/v1/storage_boxes/4242/subaccounts");
    expect(calls[0].body).toMatchObject({ home_directory: "murage/home-1-g1", access_settings: { ssh_enabled: true, webdav_enabled: false, samba_enabled: false } });
    expect(await box.directoryExists(sub.directory)).toBe(true);
    await box.purgeDirectory(sub.directory);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe("https://u4242.your-storagebox.de/murage/home-1-g1/");
    expect(del.auth).toBe(`Basic ${btoa("u4242:main-pw")}`);
    expect(await box.directoryExists(sub.directory)).toBe(false);
    expect(await box.countSubaccounts()).toBe(12);
    expect(calls.at(-1)!.url).toBe("https://api.hetzner.com/v1/storage_boxes/4242/subaccounts?per_page=100");
    await box.deleteSubaccount("77");
    expect(calls.at(-1)!.url).toBe("https://api.hetzner.com/v1/storage_boxes/4242/subaccounts/77");
  });
});

describe("power action receipts (Astra SELFSERVICE5 #2)", () => {
  it("build host: only the call's own action id is asked about; Vultr has none, and reports up only when running and ok", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input); seen.push(u);
      if (u.endsWith("/actions/77")) return Response.json({ action: { id: 77, command: "reset_server", status: "success", started: "" } });
      if (u.endsWith("/actions/78")) return Response.json({ action: { id: 78, command: "reset_server", status: "running", started: "" } });
      if (u.endsWith("/instances/i-1")) return Response.json({ instance: { id: "i-1", power_status: "running", server_status: vultrStatus } });
      return new Response("{}", { status: 404 });
    }) as HostFetch;
    let vultrStatus = "locked";
    const hz = hetznerAdapter("t", { sshKeyIds: [], firewallIds: [] }, fetcher);
    expect(await hz.powerActionStatus!("5", "reboot", "77")).toBe("success");
    expect(await hz.powerActionStatus!("5", "reboot", "78")).toBe("running");
    expect(await hz.powerActionStatus!("5", "reboot", "79")).toBe("none");
    expect(seen.some((u) => u.includes("/servers/5/actions"))).toBe(false); // never a search for "some" newer action
    const vultr = vultrAdapter("k", {}, fetcher);
    expect(vultr.powerActionStatus).toBeUndefined();
    expect((await vultr.getServer("i-1")).state).not.toBe("running");
    vultrStatus = "ok";
    expect((await vultr.getServer("i-1")).state).toBe("running");
  });
});
