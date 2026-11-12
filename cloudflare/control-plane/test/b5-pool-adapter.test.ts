// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool, lanes L0/L1: the `pool` config block and the provider pool adapter methods, against a recording fake fetch.
import { describe, expect, it } from "vitest";
import { provisionerConfig, provisionerSchema } from "../src/b5-config";
import { hetznerAdapter, HostError, type HostFetch } from "../src/b5-provisioner";
import { SIG_NOW, verifiedImage } from "./image-sig-fixture";

type Call = { method: string; url: URL; body: any; signal?: AbortSignal | null };
function recorder(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: HostFetch = async (url, init) => {
    const c = { method: init?.method ?? "GET", url: new URL(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal };
    calls.push(c);
    return handler(c);
  };
  return { calls, fetcher };
}
const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
const hz = (id: number, extra: Record<string, unknown> = {}) => ({ id, name: `mcq-pool-stg-${id}`, status: "off", image: { id: 222 },
  labels: { "murage/role": "pool" }, public_net: { ipv4: { ip: "203.0.113.9" }, ipv6: null }, ...extra });
const adapter = (f: HostFetch) => hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [] }, f, () => SIG_NOW);

const IMAGES = { hetzner: { x86: "111", arm: "222" }, vultr: { x86: "s" } };
const cls = (types: [string, "x86" | "arm"][]) => ({ rungs: types.map(([serverType, arch]) => ({ serverType, arch })), target: 4, red: 2, max: 8 });
const POOL = {
  env: "staging", monthlyIdleCapEur: 200,
  classes: { starter: cls([["cx23", "x86"], ["cax11", "arm"]]), pro: cls([["cax21", "arm"], ["cx33", "x86"]]) },
  limits: { vcpu: 100, primaryIps: 50, volumeGb: 5000, reserveForLive: { vcpu: 20, primaryIps: 10, volumeGb: 1000 } },
};
const envWith = (config: unknown) => ({ B5_PROVISIONER_CONFIG: JSON.stringify(config) }) as unknown as Env;

describe("pool config block", () => {
  it("is absent by default (pool off) and parses with defaults applied", () => {
    expect(provisionerSchema.parse({ images: IMAGES }).pool).toBeUndefined();
    const p = provisionerSchema.parse({ images: IMAGES, pool: POOL }).pool!;
    expect(p).toMatchObject({ maxCreatesPerTick: 10, maxCreatesPerDay: 150, maxConsecutiveCreateFailures: 5, overTargetRetireAfterH: 72 });
  });
  it("is strict: unknown keys, a missing class, a bad env and out-of-order targets are refused", () => {
    const bad = (pool: unknown) => expect(provisionerSchema.safeParse({ images: IMAGES, pool }).success).toBe(false);
    bad({ ...POOL, extra: 1 });
    bad({ ...POOL, env: "dev" });
    bad({ ...POOL, classes: { starter: POOL.classes.starter } });
    bad({ ...POOL, classes: { ...POOL.classes, max: POOL.classes.starter } });
    bad({ ...POOL, classes: { ...POOL.classes, starter: { ...POOL.classes.starter, target: 9 } } });
    bad({ ...POOL, classes: { ...POOL.classes, starter: { ...POOL.classes.starter, rungs: [] } } });
    bad({ ...POOL, limits: { ...POOL.limits, reserveForLive: { vcpu: 1 } } });
  });
  it("refuses a CPX rung in any pool class (and a configured forbidden prefix) through provisionerConfig", () => {
    const withCpx = { images: IMAGES, pool: { ...POOL, classes: { ...POOL.classes, pro: cls([["cpx31", "x86"]]) } } };
    expect(() => provisionerConfig(envWith(withCpx))).toThrow("server_type_forbidden");
    expect(provisionerConfig(envWith({ images: IMAGES, pool: POOL })).pool?.classes.pro.rungs[0].serverType).toBe("cax21");
    expect(() => provisionerConfig(envWith({ images: IMAGES, forbiddenTypePrefixes: ["cx"], pool: POOL }))).toThrow("server_type_forbidden");
  });
});

describe("hetzner pool adapter", () => {
  it("serverTypes makes exactly one unpaged call and maps stock, cores, arch and net monthly cents", async () => {
    const { calls, fetcher } = recorder(() => j({ server_types: [
      { name: "cx23", cores: 2, disk: 40, architecture: "x86", locations: [{ name: "fsn1", available: true }, { name: "nbg1", available: false }],
        prices: [{ location: "fsn1", price_monthly: { net: "3.4900", gross: "4.15" } }, { location: "nbg1", price_monthly: { net: "3.49" } }] },
      { name: "cax11", cores: 2, architecture: "arm", deprecated: true, locations: [{ name: "hel1" }], prices: [] },
    ] }));
    const types = await adapter(fetcher).serverTypes();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname + calls[0].url.search).toBe("/v1/server_types?per_page=50");
    expect(types).toEqual([
      { name: "cx23", cores: 2, diskGb: 40, arch: "x86", deprecated: false, locations: { fsn1: { available: true, deprecated: false, monthlyNetCents: 349 }, nbg1: { available: false, deprecated: false, monthlyNetCents: 349 } } },
      { name: "cax11", cores: 2, diskGb: null, arch: "arm", deprecated: true, locations: { hel1: { available: true, deprecated: false, monthlyNetCents: null } } },
    ]);
  });

  it("createPoolServer sends start_after_create:false, IPv4 only, no volume, the given firewalls, keys, labels and user data", async () => {
    const { calls, fetcher } = recorder(() => j({ server: hz(7, { status: "initializing" }) }, 201));
    const ac = new AbortController();
    const s = await adapter(fetcher).createPoolServer({ name: "mcq-pool-stg-ab12", type: "cx23", location: "fsn1", image: await verifiedImage("222", "arm"),
      labels: { "murage/role": "pool", "murage/call": "call-1" }, userData: "#include\nhttps://x", firewallIds: [5, 6], sshKeyIds: [9], signal: ac.signal });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v1/servers");
    expect(calls[0].signal).toBe(ac.signal);
    expect(calls[0].body).toEqual({ name: "mcq-pool-stg-ab12", server_type: "cx23", location: "fsn1", image: 222, user_data: "#include\nhttps://x",
      labels: { "murage/role": "pool", "murage/call": "call-1", "murage/dispatch": expect.stringMatching(/^[0-9a-f-]{36}$/) }, automount: false, ssh_keys: [9],
      firewalls: [{ firewall: 5 }, { firewall: 6 }], public_net: { enable_ipv4: true, enable_ipv6: false }, start_after_create: false });
    expect(calls[0].body.volumes).toBeUndefined();
    expect(s).toMatchObject({ id: "7", status: "initializing", imageId: "222", ipv4: "203.0.113.9" });
  });

  it("refuses an invalid label value locally, before any request", async () => {
    const { calls, fetcher } = recorder(() => j({}));
    await expect(adapter(fetcher).createPoolServer({ name: "n", type: "cx23", location: "fsn1", image: await verifiedImage("1"), labels: { "murage/call": "bad value!" },
      userData: "", firewallIds: [1], sshKeyIds: [] })).rejects.toThrow("provider_label_invalid");
    await expect(adapter(fetcher).listByLabel("a b")).rejects.toThrow("provider_label_invalid");
    expect(calls).toHaveLength(0);
  });

  it("maps provider refusals to HostError with status and code", async () => {
    const create = recorder(() => j({ error: { code: "resource_unavailable", message: "no stock" } }, 412));
    const e1 = await adapter(create.fetcher).createPoolServer({ name: "n", type: "cx23", location: "fsn1", image: await verifiedImage("1"), labels: {}, userData: "", firewallIds: [1], sshKeyIds: [] }).catch((x) => x);
    expect(e1).toBeInstanceOf(HostError);
    expect(e1).toMatchObject({ status: 412, code: "resource_unavailable", providerMessage: "no stock" });
    expect((e1 as { notAnAnswer?: boolean }).notAnAnswer).toBeUndefined();
    const rl = recorder(() => j({ error: { code: "rate_limit_exceeded" } }, 429));
    expect(await adapter(rl.fetcher).powerOn("7").catch((x) => x)).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    const bare = recorder(() => new Response("oops", { status: 502 }));
    expect(await adapter(bare.fetcher).getServerDetail("7").catch((x) => x)).toMatchObject({ status: 502, code: "http_502" });
  });

  it("a failed GET is marked as no answer to a create (listing, detail, serverTypes)", async () => {
    const { fetcher } = recorder(() => j({ error: { code: "server_error" } }, 500));
    const a = adapter(fetcher);
    for (const op of [() => a.listByLabel("murage/role=pool"), () => a.getServerDetail("1"), () => a.serverTypes()]) {
      expect(await op().catch((x) => x)).toMatchObject({ notAnAnswer: true, status: 500 });
    }
  });

  it("updateServer PUTs only the fields given", async () => {
    const { calls, fetcher } = recorder(() => j({ server: hz(7, { name: "mcq-home-x", labels: { "murage/home": "h1" } }) }));
    const a = adapter(fetcher);
    const s = await a.updateServer("7", { name: "mcq-home-x", labels: { "murage/home": "h1" } });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { name: "mcq-home-x", labels: { "murage/home": "h1" } } });
    expect(calls[0].url.pathname).toBe("/v1/servers/7");
    expect(s.labels).toEqual({ "murage/home": "h1" });
    await a.updateServer("7", { name: "only-name" });
    expect(calls[1].body).toEqual({ name: "only-name" });
  });

  it("rebuildServer posts the image, returns the action and re-reads the server so a powered-on result is visible; the root password is dropped", async () => {
    const { calls, fetcher } = recorder((c) => c.method === "POST"
      ? j({ action: { id: 55, command: "rebuild", status: "running", started: "t" }, root_password: "SECRET" })
      : j({ server: hz(7, { status: "running" }) }));
    const r = await adapter(fetcher).rebuildServer("7", await verifiedImage("333"));
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/servers/7/actions/rebuild", "GET /v1/servers/7"]);
    expect(calls[0].body).toEqual({ image: 333 });
    expect(r).toMatchObject({ actionId: "55", status: "running", server: { id: "7", status: "running" } });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("powerOn and powerOff post the right action and return its id and status", async () => {
    const { calls, fetcher } = recorder((c) => j({ action: { id: c.url.pathname.endsWith("poweron") ? 1 : 2, command: "x", status: c.url.pathname.endsWith("poweron") ? "success" : "error", started: "t" } }));
    const a = adapter(fetcher);
    expect(await a.powerOn("7")).toEqual({ actionId: "1", status: "success" });
    expect(await a.powerOff("7")).toEqual({ actionId: "2", status: "error" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/servers/7/actions/poweron", "POST /v1/servers/7/actions/poweroff"]);
  });

  it("listByLabel pages through every page with the encoded selector and aborts with the signal", async () => {
    const { calls, fetcher } = recorder((c) => {
      const page = Number(c.url.searchParams.get("page"));
      return j({ servers: [hz(page * 10), hz(page * 10 + 1)], meta: { pagination: { next_page: page < 3 ? page + 1 : null } } });
    });
    const ac = new AbortController();
    const list = await adapter(fetcher).listByLabel("murage/role=pool,murage/env=staging", ac.signal);
    expect(list.map((s) => s.id)).toEqual(["10", "11", "20", "21", "30", "31"]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url.pathname).toBe("/v1/servers");
    expect(calls[0].url.searchParams.get("label_selector")).toBe("murage/role=pool,murage/env=staging");
    expect(calls[2].url.searchParams.get("per_page")).toBe("50");
    expect(calls.every((c) => c.signal === ac.signal)).toBe(true);
    const failing = recorder((c) => c.url.searchParams.get("page") === "1" ? j({ servers: [hz(1)], meta: { pagination: { next_page: 2 } } }) : j({ error: { code: "x" } }, 500));
    await expect(adapter(failing.fetcher).listByLabel("murage/role=pool")).rejects.toMatchObject({ status: 500 });
  });

  it("getServerDetail returns status, image id, labels and ipv4 (null when absent)", async () => {
    const { calls, fetcher } = recorder(() => j({ server: hz(7, { status: "running", image: null, public_net: { ipv4: null } }) }));
    const s = await adapter(fetcher).getServerDetail("7");
    expect(calls[0].url.pathname).toBe("/v1/servers/7");
    expect(s).toEqual({ id: "7", status: "running", name: "mcq-pool-stg-7", imageId: null, labels: { "murage/role": "pool" }, ipv4: null });
  });
});

describe("pool adapter review fixes", () => {
  it("rebuildServer keeps the action when the follow-up GET fails (429, 5xx, abort); a failed POST still throws", async () => {
    for (const get of [() => j({ error: { code: "rate_limit_exceeded" } }, 429), () => j({ error: { code: "x" } }, 503), () => { throw new DOMException("aborted", "AbortError"); }]) {
      const { fetcher } = recorder((c) => c.method === "POST" ? j({ action: { id: 9, command: "rebuild", status: "running", started: "t" } }) : get());
      const r = await adapter(fetcher).rebuildServer("7", await verifiedImage("333"));
      expect(r).toMatchObject({ actionId: "9", status: "running", server: undefined });
      expect(typeof r.serverError).toBe("string");
    }
    const bad = recorder(() => j({ error: { code: "locked" } }, 423));
    await expect(adapter(bad.fetcher).rebuildServer("7", await verifiedImage("333"))).rejects.toMatchObject({ status: 423 });
  });
  it("serverTypes reads per-location deprecation and treats it as unavailable there", async () => {
    const { fetcher } = recorder(() => j({ server_types: [
      { name: "cx23", cores: 2, architecture: "x86", locations: [{ name: "fsn1", available: true, deprecation: { announced: "a", unavailable_after: "b" } }, { name: "nbg1", available: true, deprecation: null }] },
      { name: "old", cores: 1, architecture: "x86", locations: [{ name: "fsn1", available: true, deprecation: { announced: "a" } }] },
    ] }));
    const t = await adapter(fetcher).serverTypes();
    expect(t[0].locations.fsn1).toMatchObject({ available: false, deprecated: true });
    expect(t[0].locations.nbg1).toMatchObject({ available: true, deprecated: false });
    expect(t[0].deprecated).toBe(false);
    expect(t[1].deprecated).toBe(true);
  });
  it("listByLabel accepts set-based selectors, still URL-encoded, and rejects junk", async () => {
    const { calls, fetcher } = recorder(() => j({ servers: [], meta: { pagination: { next_page: null } } }));
    const sel = "murage/role in (pool,home),murage/env=staging,!murage/x,murage/y notin (a,b)";
    await adapter(fetcher).listByLabel(sel);
    expect(calls[0].url.search).toContain(encodeURIComponent(sel));
    expect(calls[0].url.searchParams.get("label_selector")).toBe(sel);
    await expect(adapter(fetcher).listByLabel("a=b;rm")).rejects.toThrow("provider_label_invalid");
  });
});

describe("disk sizes", () => {
  it("imageDiskGb reads disk_size once per image and serverTypeDiskGb reads the type's disk once", async () => {
    const { calls, fetcher } = recorder((c) => c.url.pathname.startsWith("/v1/images/") ? j({ image: { id: 7, disk_size: 80 } }) : j({ server_types: [{ name: "cax11", disk: 40 }] }));
    const a = adapter(fetcher);
    expect(await a.imageDiskGb!("7")).toBe(80);
    expect(await a.imageDiskGb!("7")).toBe(80);
    expect(await a.serverTypeDiskGb!("cax11")).toBe(40);
    expect(await a.serverTypeDiskGb!("cax11")).toBe(40);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/images/7", "/v1/server_types"]);
  });
  it("a missing disk is unknown (null), never zero", async () => {
    const { fetcher } = recorder((c) => c.url.pathname.startsWith("/v1/images/") ? j({ image: { id: 7 } }) : j({ server_types: [{ name: "cax11" }] }));
    const a = adapter(fetcher);
    expect(await a.imageDiskGb!("7")).toBeNull();
    expect(await a.serverTypeDiskGb!("cax11")).toBeNull();
  });
});
