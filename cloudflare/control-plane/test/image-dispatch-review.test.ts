// SPDX-License-Identifier: AGPL-3.0-or-later
// KMS design 10.6 / 13 / 13.1: the dispatch states, the activation marking, the trust diff, the sweep, migration 0125 and the W of the new cron kind.
// Real D1 (the migrations), the real provider adapter over an in-memory provider; nothing under test is mocked.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hetznerAdapter } from "../src/b5-provisioner";
import { authorizeDispatch, settleDispatch, type ImageTrust } from "../src/image-signature";
import { SWEEP_ROWS, sweepDispatchReview, trustDiff } from "../src/image-dispatch-review";
import { createWorker } from "../src/index";
import { activateEpoch } from "../scripts/deploy.mjs";
import { CHECK_SHA, IMG_KINDS, MAIN_KEY, PUBKEY, SIG_NOW, SIG_TRUST, verifiedImage } from "./image-sig-fixture";
import ddl0124 from "../migrations/0124_image_dispatch_auth.sql?raw";
import ddl0125 from "../migrations/0125_image_dispatch_review.sql?raw";

const NOW = SIG_NOW;
const HZ = "https://api.hetzner.cloud/v1";
const IMAGES = { hetzner: { x86: "111", arm: "222" }, vultr: { x86: "s" } };
const cfgText = (kinds: Record<string, unknown> = IMG_KINDS) => JSON.stringify({ images: IMAGES, imageKinds: kinds, quarantineFirewallId: 77, vultr: { sshKeyIds: [], firewallGroupId: "f", quarantineFirewallGroupId: "q" } });
const mkEnv = (kinds?: Record<string, unknown>, over: Record<string, unknown> = {}): Env =>
  ({ ...env, MURAGE_ENV: "staging", B5_PROVISIONER_CONFIG: cfgText(kinds), B5_IMAGE_VERIFY_PUBKEY: PUBKEY, HCLOUD_TOKEN: "hz-test-token", ...over } as unknown as Env);

interface Row { dispatch_id: string; epoch: number; key_fp: string; check_sha256: string; image: string; created_at: number; state: string; provider_server_id: string | null; settled_at: number | null; review_reason: string | null }
const rows = async () => (await env.DB.prepare("SELECT * FROM image_dispatch_auth ORDER BY created_at, dispatch_id").all<Row>()).results;
const row = async (id: string) => (await env.DB.prepare("SELECT * FROM image_dispatch_auth WHERE dispatch_id=?").bind(id).first<Row>())!;
const states = async () => Object.fromEntries((await rows()).map((r) => [r.dispatch_id, r.state]));
const seed = (id: string, o: Partial<Row> = {}) => env.DB.prepare(
  "INSERT INTO image_dispatch_auth (dispatch_id,epoch,key_fp,check_sha256,image,created_at,state,provider_server_id,settled_at,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .bind(id, o.epoch ?? 1, o.key_fp ?? MAIN_KEY.fp, o.check_sha256 ?? CHECK_SHA, o.image ?? "111", o.created_at ?? 100, o.state ?? "needs_review", o.provider_server_id ?? null, o.settled_at ?? null,
    o.review_reason ?? (o.state === undefined || o.state === "needs_review" ? "image" : null)).run();
const alertsOf = async (kind?: string) => (await env.DB.prepare("SELECT home_id,kind,subject,detail,resolved_at FROM cloud_alerts WHERE kind LIKE 'image.%' ORDER BY subject").all<{ home_id: string; kind: string; subject: string; detail: string; resolved_at: number | null }>())
  .results.filter((a) => kind === undefined || a.kind === kind);
const policy = () => env.DB.prepare("SELECT epoch,accepted_fps,accepted_checks,accepted_images,trust_hash FROM image_policy WHERE id='current'").first<{ epoch: number; accepted_fps: string | null; accepted_checks: string | null; accepted_images: string | null; trust_hash: string | null }>();

afterEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM image_dispatch_auth"), env.DB.prepare("DELETE FROM cloud_alerts WHERE kind LIKE 'image.%'"),
    env.DB.prepare("UPDATE image_policy SET accepted_fps=NULL,accepted_checks=NULL,accepted_images=NULL,trust_hash=NULL"),
    env.DB.prepare("DELETE FROM image_readiness"), env.DB.prepare("DELETE FROM cloud_provision_intents WHERE home_id LIKE 'rv-%'"), env.DB.prepare("DROP TRIGGER IF EXISTS rv_swallow"), env.DB.prepare("DROP TRIGGER IF EXISTS rv_nosettle")]);
});

/** An in-memory provider that records every call and can fail. */
class Hz {
  servers = new Map<string, Record<string, string>>();
  calls: string[] = [];
  mode: "ok" | "5xx" | "net" | "422" | "408" = "ok";
  delayMs = 0;
  /** Runs on every call, before it answers: a deterministic test advances its fake clock here instead of sleeping. */
  onCall: (() => void) | null = null;
  onPost: (() => Promise<void>) | null = null;
  next = 7;
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.replace(HZ, "");
    this.calls.push(`${method} ${path}`);
    this.onCall?.();
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (method === "POST" && this.onPost) await this.onPost();
    if (this.mode === "net") throw new TypeError("network down");
    if (this.mode === "5xx") return new Response("{}", { status: 502 });
    if (this.mode === "408") return new Response(JSON.stringify({ error: { code: "timeout" } }), { status: 408 });
    if (this.mode === "422") return new Response(JSON.stringify({ error: { code: "invalid_input", message: "no" } }), { status: 422 });
    if (method === "POST" && path === "/servers") {
      const body = JSON.parse(String(init?.body));
      const id = String(this.next++);
      this.servers.set(id, body.labels);
      return new Response(JSON.stringify({ server: { id: Number(id), status: "off", labels: body.labels } }), { status: 201 });
    }
    if (method === "POST" && /\/actions\/rebuild$/.test(path)) return new Response(JSON.stringify({ action: { id: 1, status: "running" } }), { status: 201 });
    const one = /^\/servers\/(\d+)$/.exec(path);
    if (method === "GET" && one) {
      const labels = this.servers.get(one[1]);
      return labels ? new Response(JSON.stringify({ server: { id: Number(one[1]), status: "off", labels } }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "not_found", message: "gone" } }), { status: 404 });
    }
    if (method === "GET" && path.startsWith("/servers?")) {
      const sel = decodeURIComponent(new URL(url).searchParams.get("label_selector") ?? "");
      const want = sel.split("=")[1];
      const list = [...this.servers].filter(([, l]) => l["murage/dispatch"] === want).map(([id, labels]) => ({ id: Number(id), status: "off", labels }));
      return new Response(JSON.stringify({ servers: list, meta: { pagination: { next_page: null } } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  adapter = () => hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [1] } as never, this.fetch, () => NOW);
  nonGet = () => this.calls.filter((c) => !c.startsWith("GET "));
}
const input = { name: "n", serverType: "cx23", location: "fsn1", userData: "", labels: { homeId: "h", generation: 1, role: "home" } as never, volumeId: null };
const poolInput = async (image: Awaited<ReturnType<typeof verifiedImage>>) => ({ name: "n", type: "cx23", location: "fsn1", image, labels: { "murage/role": "pool" }, userData: "", firewallIds: [], sshKeyIds: [] });

describe("13 states: the dispatch path", () => {
  it("createServer: the row id is the murage/dispatch label; the answer settles it as settled_created with the server id", async () => {
    const hz = new Hz();
    await hz.adapter().createServer({ ...input, image: await verifiedImage() });
    const [r] = await rows();
    expect(r).toMatchObject({ state: "settled_created", provider_server_id: "7", settled_at: NOW, epoch: 1, image: "111" });
    expect(hz.servers.get("7")!["murage/dispatch"]).toBe(r.dispatch_id);
  });
  it("createPoolServer carries the same label and settles the same way (13.1 H1: BOTH create paths)", async () => {
    const hz = new Hz();
    await hz.adapter().createPoolServer(await poolInput(await verifiedImage()));
    const [r] = await rows();
    expect(r).toMatchObject({ state: "settled_created", provider_server_id: "7" });
    expect(hz.servers.get("7")!["murage/dispatch"]).toBe(r.dispatch_id);
  });
  it("a rebuild records provider_server_id AT THE INSERT (before the POST) and needs no label", async () => {
    const hz = new Hz();
    let atPost: Row[] = [];
    hz.onPost = async () => { atPost = await rows(); };
    hz.servers.set("5", {});
    await hz.adapter().rebuildServer("5", await verifiedImage());
    expect(atPost).toHaveLength(1);
    expect(atPost[0]).toMatchObject({ state: "open", provider_server_id: "5" });
    expect(await rows()).toMatchObject([{ state: "settled_created", provider_server_id: "5" }]);
  });
  it("settled_failed is a PARSED provider refusal only: a 4xx body settles it, a timeout, a network error, a 5xx or a 408 leave the row open (13.1 H4)", async () => {
    for (const [mode, want] of [["422", "settled_failed"], ["net", "open"], ["5xx", "open"], ["408", "open"]] as const) {
      await env.DB.prepare("DELETE FROM image_dispatch_auth").run();
      const hz = new Hz(); hz.mode = mode;
      await expect(hz.adapter().createServer({ ...input, image: await verifiedImage() })).rejects.toBeDefined();
      const [r] = await rows();
      expect(r.state, mode).toBe(want);
      expect(r.provider_server_id, mode).toBeNull();
    }
  });
  it("every transition is conditional on the prior state: a second settle cannot move a settled row; a row marked needs_review mid-POST keeps that state but still records the server id", async () => {
    const v = await verifiedImage();
    const id = await authorizeDispatch(v, NOW);
    await settleDispatch(v, id, { created: "11" }, NOW);
    await settleDispatch(v, id, { refused: true }, NOW + 1);
    await settleDispatch(v, id, { created: "12" }, NOW + 2);
    expect(await row(id)).toMatchObject({ state: "settled_created", provider_server_id: "11", settled_at: NOW });
    const id2 = await authorizeDispatch(v, NOW);
    await env.DB.prepare("UPDATE image_dispatch_auth SET state='needs_review',review_reason='epoch' WHERE dispatch_id=?").bind(id2).run(); // an activation lands while the POST is out
    await settleDispatch(v, id2, { created: "13" }, NOW);
    expect(await row(id2)).toMatchObject({ state: "needs_review", review_reason: "epoch", provider_server_id: "13", settled_at: null });
  });
  it("a settle that cannot write never fails the create (the row stays open for the sweep)", async () => {
    const hz = new Hz();
    const v = await verifiedImage();
    hz.onPost = async () => { await env.DB.prepare("CREATE TRIGGER rv_nosettle BEFORE UPDATE ON image_dispatch_auth BEGIN SELECT RAISE(ABORT,'settle blocked'); END").run(); };
    try {
      const server = await hz.adapter().createServer({ ...input, image: v });
      expect(server.id).toBe("7");
      expect(await rows()).toMatchObject([{ state: "open", provider_server_id: null }]);
    } finally { await env.DB.prepare("DROP TRIGGER IF EXISTS rv_nosettle").run(); }
  });
});

describe("13 (a): activation marks in the epoch batch", () => {
  const d1 = async (sql: string) => {
    const parts = sql.split(/;\s+(?=UPDATE |INSERT )/);
    if (parts.length === 1 && /^SELECT/.test(sql)) return { results: (await env.DB.prepare(sql).all()).results as Record<string, unknown>[] };
    const out = await env.DB.batch(parts.map((p) => env.DB.prepare(p)));
    return { results: out[0].results as Record<string, unknown>[] };
  };
  it("marks ONLY open rows of a lower epoch; settled_*, needs_review, resolved_* and equal-epoch rows are left alone", async () => {
    await env.DB.prepare("UPDATE image_policy SET epoch=1").run();
    await seed("open-old", { epoch: 1, state: "open" }); await seed("open-new", { epoch: 3, state: "open" });
    await seed("sc", { epoch: 1, state: "settled_created", provider_server_id: "1" }); await seed("sf", { epoch: 1, state: "settled_failed" });
    await seed("nr", { epoch: 1, state: "needs_review", review_reason: "key" }); await seed("ra", { epoch: 1, state: "resolved_absent" }); await seed("rl", { epoch: 1, state: "resolved_alerted" });
    expect(await activateEpoch({ d1, bundleEpoch: "export const IMAGE_POLICY_EPOCH = 3;" }, "staging", "db")).toEqual([]);
    expect(await states()).toEqual({ "open-old": "needs_review", "open-new": "open", sc: "settled_created", sf: "settled_failed", nr: "needs_review", ra: "resolved_absent", rl: "resolved_alerted" });
    expect((await row("open-old")).review_reason).toBe("epoch");
    expect((await row("nr")).review_reason).toBe("key");
    expect((await policy())!.epoch).toBe(3);
  });
  it("the epoch write and the marking are ONE runner call (one D1 batch)", async () => {
    const seen: string[] = [];
    await activateEpoch({ d1: async (sql: string) => { seen.push(sql); return { results: [{ epoch: 3 }] }; }, bundleEpoch: "export const IMAGE_POLICY_EPOCH = 3;" }, "staging", "db");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/INSERT INTO image_policy[\s\S]*UPDATE image_dispatch_auth SET state='needs_review',review_reason='epoch' WHERE epoch < 3 AND state = 'open'/);
  });
});

describe("13.1 H2: the trust diff", () => {
  const trust = (over: Partial<ImageTrust> = {}): ImageTrust => ({ ...SIG_TRUST, ...over });
  const seedAll = async () => {
    for (const [id, st] of [["a-open", "open"], ["a-sc", "settled_created"], ["a-sf", "settled_failed"], ["a-ra", "resolved_absent"], ["a-rl", "resolved_alerted"], ["a-nr", "needs_review"]] as const)
      await seed(id, { state: st, image: "111", key_fp: "K1", check_sha256: "C1", provider_server_id: st === "settled_created" ? "9" : null, review_reason: st === "needs_review" ? "epoch" : null });
    await seed("b-open", { state: "open", image: "222", key_fp: "K2", check_sha256: "C2" });
  };
  const base = () => trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K1", "K2"], checks: ["C1", "C2"] }) });
  it("the first run stores the baseline from DEFAULT_TRUST and the config and marks nothing; a second run with nothing changed writes nothing", async () => {
    await seedAll();
    expect(await policy()).toMatchObject({ trust_hash: null, accepted_fps: null });
    await base();
    const p = (await policy())!;
    expect(p.trust_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(p.accepted_fps!)).toEqual(["K1", "K2"]);
    expect(JSON.parse(p.accepted_images!)).toEqual(["1", "111", "222", "333", "451260442", "452016490"]);
    expect((await states())["a-open"]).toBe("open");
    await base();
    expect(await policy()).toEqual(p);
  });
  it("revoking an IMAGE (the revoked list) marks every matching row whatever its status, except resolved_* and rows already under review; others untouched; image_readiness is not involved", async () => {
    await seedAll(); await base();
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K1", "K2"], checks: ["C1", "C2"], revoked: ["111"] }) });
    expect(await states()).toEqual({ "a-open": "needs_review", "a-sc": "needs_review", "a-sf": "needs_review", "a-ra": "resolved_absent", "a-rl": "resolved_alerted", "a-nr": "needs_review", "b-open": "open" });
    expect((await row("a-sc")).review_reason).toBe("image");
    expect((await row("a-nr")).review_reason).toBe("epoch");
    expect((await row("a-sc")).provider_server_id).toBe("9");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM image_readiness").first<{ n: number }>())!.n).toBe(0);
  });
  it("an image removed from imageKinds is a revocation too", async () => {
    await seedAll();
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K1", "K2"], checks: ["C1", "C2"] }) });
    const { "111": _gone, ...rest } = IMG_KINDS;
    await trustDiff(mkEnv(rest, { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: { arm: "222" }, vultr: { x86: "s" } }, imageKinds: rest, quarantineFirewallId: 77, vultr: { sshKeyIds: [], firewallGroupId: "f", quarantineFirewallGroupId: "q" } }) }), NOW,
      { trust: trust({ fps: ["K1", "K2"], checks: ["C1", "C2"] }) });
    expect((await states())["a-sc"]).toBe("needs_review");
    expect((await states())["b-open"]).toBe("open");
  });
  it("revoking a KEY (fingerprint removed) marks its rows with reason 'key'", async () => {
    await seedAll(); await base();
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K2"], checks: ["C1", "C2"] }) });
    const s = await states();
    expect(s["a-open"]).toBe("needs_review"); expect(s["b-open"]).toBe("open");
    expect((await row("a-open")).review_reason).toBe("key");
  });
  it("revoking a CHECK hash marks its rows with reason 'check'", async () => {
    await seedAll(); await base();
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K1", "K2"], checks: ["C2"] }) });
    const s = await states();
    expect(s["a-sf"]).toBe("needs_review"); expect(s["b-open"]).toBe("open");
    expect((await row("a-sf")).review_reason).toBe("check");
  });
  it("adding trust marks nothing; the stored sets advance", async () => {
    await seedAll(); await base();
    const before = (await policy())!.trust_hash;
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K1", "K2", "K3"], checks: ["C1", "C2", "C3"] }) });
    expect(Object.values(await states()).filter((x) => x === "needs_review")).toHaveLength(1); // only the pre-existing one
    expect((await policy())!.trust_hash).not.toBe(before);
  });
  it("the marks and the advance are ONE batch: when the batch fails nothing is marked and the sets stay", async () => {
    await seedAll(); await base();
    const before = await policy();
    const failing = { ...env, DB: new Proxy(env.DB, { get: (t, k) => (k === "batch" ? async () => { throw new Error("d1 down"); } : typeof (t as never)[k] === "function" ? ((t as never)[k] as Function).bind(t) : (t as never)[k]) }) };
    await trustDiff(mkEnv(undefined, { DB: failing.DB }), NOW, { trust: trust({ fps: ["K2"], checks: ["C1", "C2"], revoked: ["111"] }) });
    expect(await policy()).toEqual(before);
    expect((await states())["a-open"]).toBe("open");
    await trustDiff(mkEnv(), NOW, { trust: trust({ fps: ["K2"], checks: ["C1", "C2"], revoked: ["111"] }) }); // the next run does it
    expect((await states())["a-open"]).toBe("needs_review");
  });
  it("Fable note 2: when another Worker advanced trust_hash between the read and the batch, the marking UPDATEs mark nothing (they carry the same guard)", async () => {
    await seedAll(); await base();
    const racing = new Proxy(env.DB, { get: (t, k) => {
      if (k === "batch") return async (s: D1PreparedStatement[]) => { await t.prepare("UPDATE image_policy SET trust_hash='someone-else' WHERE id='current'").run(); return t.batch(s); };
      const v = (t as never)[k]; return typeof v === "function" ? (v as Function).bind(t) : v;
    } });
    await trustDiff(mkEnv(undefined, { DB: racing }), NOW, { trust: trust({ fps: ["K2"], checks: ["C1", "C2"], revoked: ["111"] }) });
    expect((await policy())!.trust_hash).toBe("someone-else");
    expect(Object.values(await states()).filter((x) => x === "needs_review")).toHaveLength(1);
  });
  it("two concurrent diffs mark and advance exactly once", async () => {
    await seedAll(); await base();
    const t = trust({ fps: ["K2"], checks: ["C1", "C2"], revoked: ["111"] });
    await Promise.all([trustDiff(mkEnv(), NOW, { trust: t }), trustDiff(mkEnv(), NOW, { trust: t })]);
    expect((await row("a-open")).review_reason).toBe("key");
    expect(Object.values(await states()).filter((x) => x === "needs_review")).toHaveLength(4);
  });
  it("an unreadable config diffs nothing and changes nothing", async () => {
    await seedAll(); await base();
    const before = await policy();
    await trustDiff(mkEnv(undefined, { B5_PROVISIONER_CONFIG: "not json" }), NOW, { trust: trust({ fps: [], checks: [] }) });
    expect(await policy()).toEqual(before);
  });
  it("it is the FIRST act of the 5-minute cron: the first D1 statement of the invocation is the trust diff's read, before every sweep and the readiness store", async () => {
    const seen: string[] = [];
    const record = new Proxy(env.DB, { get: (t, k) => {
      if (k === "prepare") return (sql: string) => { seen.push(sql); return t.prepare(sql); };
      const v = (t as never)[k]; return typeof v === "function" ? (v as Function).bind(t) : v;
    } });
    const noNet = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const ctx = createExecutionContext();
    const approved = JSON.stringify({ images: { hetzner: { x86: "452016490", arm: "451260442" }, vultr: { x86: "s" } }, imageKinds: IMG_KINDS, quarantineFirewallId: 77, vultr: { sshKeyIds: [], firewallGroupId: "f", quarantineFirewallGroupId: "q" } });
    createWorker(noNet, noNet).scheduled({ scheduledTime: NOW, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, mkEnv(undefined, { DB: record, B5_PROVISIONER_CONFIG: approved }), ctx);
    await waitOnExecutionContext(ctx);
    expect(seen[0]).toContain("accepted_fps");
    expect(seen.findIndex((s) => s.includes("image_readiness"))).toBeGreaterThan(0);
    expect((await policy())!.trust_hash).not.toBeNull();
  });
});

describe("13 (c): the sweep", () => {
  const run = (hz: Hz, over: { deadline?: number; env?: Env; clock?: () => number } = {}) => sweepDispatchReview(over.env ?? mkEnv(), NOW,
    { adapter: hz.adapter(), ...(over.deadline === undefined ? {} : { deadline: over.deadline }), ...(over.clock ? { clock: over.clock } : {}) });
  const onlyReads = (hz: Hz) => expect(hz.nonGet(), "the sweep never creates, deletes, stops or rebuilds").toEqual([]);

  it("a server that is ABSENT (404 by exact id) closes the row as resolved_absent", async () => {
    const hz = new Hz();
    await seed("r1", { provider_server_id: "500" });
    await run(hz);
    expect(await row("r1")).toMatchObject({ state: "resolved_absent", settled_at: NOW });
    expect(hz.calls).toEqual(["GET /servers/500"]);
    expect(await alertsOf()).toEqual([]);
    onlyReads(hz);
  });
  it("a server that is PRESENT raises ONE alert (subject = the server id, naming the dispatch, image, reason and owning home), then resolved_alerted; the next run neither alerts nor reads again", async () => {
    const hz = new Hz(); hz.servers.set("600", {});
    await env.DB.prepare(`INSERT INTO cloud_provision_intents (home_id,resource_generation,cp_generation,token_hash,volume_phase,server_phase,server_id,state,created_at) VALUES ('rv-home',1,1,'t','created','created','600','bound',1)`).run();
    await seed("r2", { provider_server_id: "600", review_reason: "key" });
    await run(hz);
    expect(await row("r2")).toMatchObject({ state: "resolved_alerted" });
    const a = await alertsOf("image.revoked_server_present");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ home_id: "rv-home", subject: "600", resolved_at: null });
    expect(a[0].detail).toContain("dispatch r2"); expect(a[0].detail).toContain("image 111"); expect(a[0].detail).toContain("key"); expect(a[0].detail).toContain("rv-home");
    const reads = hz.calls.length;
    await run(hz);
    expect(await alertsOf("image.revoked_server_present")).toHaveLength(1);
    expect(hz.calls).toHaveLength(reads);
    onlyReads(hz);
  });
  it("a provider error (5xx, network) leaves the row needs_review and raises nothing; never resolved_absent on an error; the next healthy run resolves it", async () => {
    const hz = new Hz();
    await seed("r3", { provider_server_id: "700" }); await seed("r3b", { provider_server_id: null, created_at: 101 });
    for (const mode of ["5xx", "net"] as const) {
      hz.mode = mode; await run(hz);
      expect(await states()).toEqual({ r3: "needs_review", r3b: "needs_review" });
      expect(await alertsOf()).toEqual([]);
    }
    hz.mode = "ok"; await run(hz);
    expect((await states()).r3).toBe("resolved_absent");
    onlyReads(hz);
  });
  it("no server id: the label lookup finds the servers (one alert each, then resolved_alerted)", async () => {
    const hz = new Hz(); hz.servers.set("801", { "murage/dispatch": "r4" }); hz.servers.set("802", { "murage/dispatch": "r4" }); hz.servers.set("803", { "murage/dispatch": "other" });
    await seed("r4", { provider_server_id: null });
    await run(hz);
    expect((await row("r4")).state).toBe("resolved_alerted");
    expect((await alertsOf("image.revoked_server_present")).map((x) => x.subject)).toEqual(["801", "802"]);
    expect(hz.calls[0]).toContain("/servers?label_selector=");
    onlyReads(hz);
  });
  it("no server id and no label match stays needs_review (never resolved_absent): ONE unresolved alert for a person, and the row is not picked again", async () => {
    const hz = new Hz();
    await seed("r5", { provider_server_id: null });
    await run(hz);
    expect((await row("r5")).state).toBe("needs_review");
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(1);
    const reads = hz.calls.length;
    await run(hz);
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(1);
    expect(hz.calls).toHaveLength(reads);
    expect((await row("r5")).state).toBe("needs_review");
    onlyReads(hz);
  });
  it("a refused create (settled_failed, then marked by a revocation) with no label match closes as resolved_absent and alerts nobody", async () => {
    const hz = new Hz(); hz.servers.set("803", { "murage/dispatch": "other" });
    await seed("rf", { provider_server_id: null, settled_at: 50 });
    await run(hz);
    expect(await row("rf")).toMatchObject({ state: "resolved_absent", settled_at: NOW });
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(0);
    expect(hz.calls[0]).toContain("/servers?label_selector=");
    onlyReads(hz);
  });
  it("a refused create whose label DOES match a server still alerts it (the refusal is not trusted over the provider's own list)", async () => {
    const hz = new Hz(); hz.servers.set("804", { "murage/dispatch": "rg" });
    await seed("rg", { provider_server_id: null, settled_at: 50 });
    await run(hz);
    expect((await row("rg")).state).toBe("resolved_alerted");
    expect((await alertsOf("image.revoked_server_present")).map((x) => x.subject)).toEqual(["804"]);
    onlyReads(hz);
  });
  it("the image rotation case end to end: a refused create on an image that is then removed is marked by the trust diff and closed by the sweep, no alert", async () => {
    const t: ImageTrust = { ...SIG_TRUST, fps: ["K1", "K2"], checks: ["C1", "C2"] };
    await trustDiff(mkEnv(), NOW, { trust: t });
    await seed("rot", { state: "settled_failed", provider_server_id: null, settled_at: 50, image: "111", review_reason: null });
    const { "111": _gone, ...rest } = IMG_KINDS;
    const rotated = mkEnv(rest, { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: { arm: "222" }, vultr: { x86: "s" } }, imageKinds: rest, quarantineFirewallId: 77, vultr: { sshKeyIds: [], firewallGroupId: "f", quarantineFirewallGroupId: "q" } }) });
    await trustDiff(rotated, NOW, { trust: t });
    expect(await row("rot")).toMatchObject({ state: "needs_review", review_reason: "image" });
    const hz = new Hz();
    await sweepDispatchReview(rotated, NOW, { adapter: hz.adapter() });
    expect((await row("rot")).state).toBe("resolved_absent");
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(0);
    onlyReads(hz);
  });
  it("an alerted unresolved row is not re-alerted after its alert is RESOLVED either (any alert for the subject counts)", async () => {
    const hz = new Hz();
    await seed("r5b", { provider_server_id: null });
    await run(hz);
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(1);
    await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE kind='image.dispatch_unresolved'").bind(NOW).run();
    const reads = hz.calls.length;
    await run(hz); await run(hz);
    expect(await alertsOf("image.dispatch_unresolved")).toHaveLength(1);
    expect(hz.calls).toHaveLength(reads);
    expect((await row("r5b")).state).toBe("needs_review");
  });
  it("the cron marks still-open rows of a lower epoch (epoch raised, rows left open) before the sweep, idempotently, and leaves current-epoch rows", async () => {
    const hz = new Hz(); hz.servers.set("900", { "murage/dispatch": "eo" });
    const before = (await policy())!.epoch;
    await seed("eo", { epoch: before, state: "open", provider_server_id: "900", review_reason: null });
    await seed("en", { epoch: before + 1, state: "open", provider_server_id: null, review_reason: null });
    try {
      await env.DB.prepare("UPDATE image_policy SET epoch=? WHERE id='current'").bind(before + 1).run(); // raised without the deploy batch's marking
      expect((await row("eo")).state).toBe("open");
      await run(hz);
      expect(await row("eo")).toMatchObject({ review_reason: "epoch", state: "resolved_alerted" }); // marked, then swept in the same run
      expect((await row("en")).state).toBe("open");
      await run(hz); // idempotent
      expect(await states()).toEqual({ eo: "resolved_alerted", en: "open" });
    } finally { await env.DB.prepare("UPDATE image_policy SET epoch=? WHERE id='current'").bind(before).run(); }
    onlyReads(hz);
  });
  it("a row from before the label (migration 'prelabel') with no server id is manual: it is never picked and costs no provider read", async () => {
    const hz = new Hz();
    await seed("r6", { provider_server_id: null, review_reason: "prelabel" });
    await run(hz);
    expect(hz.calls).toEqual([]);
    expect((await row("r6")).state).toBe("needs_review");
  });
  it("13.1 H3: the row closes only when the alert row exists; an alert insert that does not land leaves it needs_review, and the next run completes it", async () => {
    const hz = new Hz(); hz.servers.set("900", {});
    await seed("r7", { provider_server_id: "900" });
    await env.DB.prepare("CREATE TRIGGER rv_swallow BEFORE INSERT ON cloud_alerts WHEN NEW.kind='image.revoked_server_present' BEGIN SELECT RAISE(IGNORE); END").run();
    await run(hz);
    expect((await row("r7")).state).toBe("needs_review");
    expect(await alertsOf("image.revoked_server_present")).toEqual([]);
    await env.DB.prepare("DROP TRIGGER rv_swallow").run();
    await run(hz);
    expect((await row("r7")).state).toBe("resolved_alerted");
    expect(await alertsOf("image.revoked_server_present")).toHaveLength(1);
  });
  it("two sweeps at once on the same row: one alert, one transition (the conditional UPDATE)", async () => {
    const hz = new Hz(); hz.servers.set("950", {});
    await seed("r8", { provider_server_id: "950" });
    await Promise.all([run(hz), run(hz)]);
    expect((await row("r8")).state).toBe("resolved_alerted");
    expect(await alertsOf("image.revoked_server_present")).toHaveLength(1);
  });
  it("each run takes at most 20 rows, oldest first, and makes at most 20 provider reads", async () => {
    const hz = new Hz();
    for (let i = 0; i < 25; i++) await seed(`c${String(i).padStart(2, "0")}`, { provider_server_id: String(1000 + i), created_at: 100 + i });
    await run(hz);
    expect(hz.calls).toHaveLength(SWEEP_ROWS);
    const s = await states();
    expect(Object.values(s).filter((x) => x === "resolved_absent")).toHaveLength(20);
    expect(s.c19).toBe("resolved_absent"); expect(s.c20).toBe("needs_review");
    await run(hz);
    expect(Object.values(await states()).filter((x) => x === "needs_review")).toHaveLength(0);
  });
  /** The deadline against an injected clock that the fake provider advances: no wall-clock time is involved. */
  async function deadlineScenario() {
    const hz = new Hz();
    for (let i = 0; i < 5; i++) await seed(`d${i}`, { provider_server_id: String(2000 + i), created_at: 100 + i });
    let t = 1_000_000;
    const clock = () => t;
    await run(hz, { deadline: t - 1, clock });
    expect(hz.calls).toEqual([]);                                  // a deadline already past makes no read
    hz.onCall = () => { t += 40; };                                // each provider read takes 40 ms of the fake clock
    await run(hz, { deadline: t + 20, clock });
    expect(hz.calls).toHaveLength(1);                              // the deadline passes mid-run: exactly one read
    expect(Object.values(await states()).filter((x) => x === "needs_review")).toHaveLength(4);
  }
  it("it honours the invocation deadline: a deadline already past makes no read; a deadline that passes mid-run stops before the next row (injected clock)", async () => {
    await deadlineScenario();
  });
  it("the deadline does not depend on wall-clock jitter: a stalled Date.now (it jumps 100 ms on every read) changes nothing", async () => {
    let skew = 0;
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + (skew += 100));
    try { await deadlineScenario(); } finally { spy.mockRestore(); }
  });
  it("without a build host token or with an unreadable config it does nothing and throws nothing", async () => {
    await seed("e1", { provider_server_id: "3000" });
    await sweepDispatchReview(mkEnv(undefined, { HCLOUD_TOKEN: undefined }), NOW);
    await sweepDispatchReview(mkEnv(undefined, { B5_PROVISIONER_CONFIG: "nope" }), NOW);
    expect((await row("e1")).state).toBe("needs_review");
  });
});

describe("13.1 H4: migration 0125", () => {
  /** Runs the table-rebuild half of 0125 (the image_policy ALTERs are already applied in the test database). */
  const rebuild = async () => {
    const sql = ddl0125.split("ALTER TABLE image_policy")[0].replace(/^--.*$/gm, "");
    await env.DB.batch(sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  };
  it("rebuilds image_dispatch_auth: 'open' rows survive, any other 0124 row becomes needs_review/'prelabel'; the new CHECK takes the six states and refuses the old 'settled'", async () => {
    await env.DB.batch([env.DB.prepare("DROP TABLE image_dispatch_auth"), ...ddl0124.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s))]);
    await env.DB.prepare("INSERT INTO image_dispatch_auth (dispatch_id,epoch,key_fp,check_sha256,image,created_at,state) VALUES ('o',1,'k','c','111',5,'open'),('s',1,'k','c','111',6,'settled'),('n',1,'k','c','111',7,'needs_review')").run();
    await rebuild();
    expect(await rows()).toMatchObject([
      { dispatch_id: "o", state: "open", provider_server_id: null, review_reason: null },
      { dispatch_id: "s", state: "needs_review", review_reason: "prelabel" },
      { dispatch_id: "n", state: "needs_review", review_reason: "prelabel" },
    ]);
    for (const st of ["open", "settled_created", "settled_failed", "needs_review", "resolved_absent", "resolved_alerted"]) await seed(`ok-${st}`, { state: st });
    await expect(seed("bad", { state: "settled" })).rejects.toThrow();
    const idx = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='image_dispatch_auth'").all<{ name: string }>()).results.map((x) => x.name);
    expect(idx).toEqual(expect.arrayContaining(["image_dispatch_auth_open", "image_dispatch_auth_review"]));
  });
  it("image_policy gains the four trust columns, NULL until the first cron run records the baseline", async () => {
    expect(await policy()).toMatchObject({ accepted_fps: null, accepted_checks: null, accepted_images: null, trust_hash: null });
  });
});

describe("the W of the new cron kind", () => {
  /** W = D1 statements prepared by one run (every statement is a D1 round trip or a statement of a batch). */
  const counting = () => {
    const counts = { statements: 0, batches: 0 };
    const db = new Proxy(env.DB, { get: (t, k) => {
      if (k === "prepare") return (sql: string) => { counts.statements++; return t.prepare(sql); };
      if (k === "batch") return (s: D1PreparedStatement[]) => { counts.batches++; return t.batch(s); };
      const v = (t as never)[k]; return typeof v === "function" ? (v as Function).bind(t) : v;
    } });
    return { counts, db };
  };
  it("worst case: a full run of 20 present servers costs 2 D1 statements per row plus 3 for the run; the trust diff costs at most 5", async () => {
    const hz = new Hz();
    for (let i = 0; i < 25; i++) { hz.servers.set(String(4000 + i), {}); await seed(`w${String(i).padStart(2, "0")}`, { provider_server_id: String(4000 + i), created_at: 100 + i }); }
    const a = counting();
    await sweepDispatchReview(mkEnv(undefined, { DB: a.db }), NOW, { adapter: hz.adapter() });
    expect(hz.calls).toHaveLength(20);
    expect(a.counts.statements).toBe(3 + 2 * 20); // the epoch marking UPDATE (Fable 10.6 a), the row read, the owner read, then an alert INSERT and the closing UPDATE per row
    expect(a.counts.batches).toBe(20);
    await trustDiff(mkEnv(), NOW, { trust: SIG_TRUST });
    const b = counting();
    await trustDiff(mkEnv(undefined, { DB: b.db }), NOW, { trust: { ...SIG_TRUST, revoked: ["111", "222"], fps: [], checks: [] } });
    expect(b.counts.statements).toBeLessThanOrEqual(5);
    expect(b.counts.batches).toBeLessThanOrEqual(1);
    console.log(`W image-dispatch-review: sweep ${a.counts.statements} statements in ${a.counts.batches + 2} round trips for 20 rows; trust diff ${b.counts.statements} statements in ${b.counts.batches + 1} round trips`);
  });
});
