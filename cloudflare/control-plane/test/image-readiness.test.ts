// SPDX-License-Identifier: AGPL-3.0-or-later
// Image readiness for sales (KMS signing design 9.8, 10.5, 12.3): the writer, the inline recompute, the hold rules, and the freeze vars.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPACITY_LINE } from "../src/self-service";
import { ImageRefused, verifyImageForUse } from "../src/image-signature";
import { INLINE_BUDGET_MS, READINESS_STALE_MS, assertSalesImagesReady, currentKey, setImageReadinessForTests, sweepImageReadiness } from "../src/image-readiness";
import { IMG_KINDS, PUBKEY, SIG_TRUST, hzImage } from "./image-sig-fixture";
import { rigReadiness } from "./setup";
import cloudMachinesSrc from "../src/cloud-machines.ts?raw";
import b3ControlSrc from "../src/b3-control.ts?raw";
import selfServiceSrc from "../src/self-service.ts?raw";

const NOW = 5; // the fixture signatures sit at the epoch
const MIN = 60_000;
const X86 = "452016490"; const ARM = "451260442";
const IMAGES = { hetzner: { x86: X86, arm: ARM }, vultr: { x86: "s" } };
const cfgText = (extra: Record<string, unknown> = {}) => JSON.stringify({ images: IMAGES, imageKinds: IMG_KINDS, quarantineFirewallId: 77, vultr: { sshKeyIds: [], firewallGroupId: "f", quarantineFirewallGroupId: "q" }, ...extra });
const mkEnv = (over: Record<string, unknown> = {}, cfg = cfgText()): Env => ({ ...env, MURAGE_ENV: "staging", B5_PROVISIONER_CONFIG: cfg, B5_IMAGE_VERIFY_PUBKEY: PUBKEY, HCLOUD_TOKEN: "hz-test-token", ...over } as unknown as Env);

let hetznerUp = true;
const fetchHz = async (url: string) => {
  if (!hetznerUp) return new Response("down", { status: 500 });
  return new Response(JSON.stringify(hzImage(url.split("/").pop()!)), { status: 200 });
};
const real = (over: { buildEnv?: "production" | "staging" } = {}) => setImageReadinessForTests({ verify: { trust: SIG_TRUST, fetch: fetchHz, buildEnv: over.buildEnv ?? "production" } });
const row = () => env.DB.prepare("SELECT * FROM image_readiness").first<Record<string, number | string>>();
const held = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 503, code: "sales_closed", extra: { notice: CAPACITY_LINE } });

beforeEach(() => { hetznerUp = true; real(); });
afterEach(() => rigReadiness());

describe("the readiness row: missing, stale, mismatched, failing", () => {
  it("audit High 5: CLOUD_FREEZE true or CLOUD_PROVISIONING_OPEN false holds admission even with a fresh positive row", async () => {
    await assertSalesImagesReady(mkEnv(), NOW); // fresh positive row
    expect(await row()).toMatchObject({ usable_x86: 1, usable_arm: 1 });
    setImageReadinessForTests({ check: async () => { throw new Error("must not run"); }, bundleEpoch: SIG_TRUST.epoch });
    await assertSalesImagesReady(mkEnv(), NOW + MIN); // still open with no switch
    await held(assertSalesImagesReady(mkEnv({ CLOUD_FREEZE: "true" }), NOW + MIN));
    await held(assertSalesImagesReady(mkEnv({ CLOUD_PROVISIONING_OPEN: "false" }), NOW + MIN));
    // Lifted: "false" / "true" are the normal values; the hold ends on the next admission (the switches are in config_hash, so the held row is not reused).
    real();
    await assertSalesImagesReady(mkEnv({ CLOUD_FREEZE: "false", CLOUD_PROVISIONING_OPEN: "true" }), NOW + MIN);
  });
  it("audit High 5: even a fresh positive row stamped for the very same config (hash and epoch match) never outvotes a switch", async () => {
    for (const over of [{ CLOUD_FREEZE: "true" }, { CLOUD_PROVISIONING_OPEN: "false" }]) {
      await assertSalesImagesReady(mkEnv(), NOW);
      await env.DB.prepare("UPDATE image_readiness SET config_hash=?").bind((await currentKey(mkEnv(over))).hash).run();
      expect(await row()).toMatchObject({ usable_x86: 1, usable_arm: 1, zero_runs: 0 }); // fresh, positive, and matching this env's key
      setImageReadinessForTests({ check: async () => { throw new Error("must not run"); }, bundleEpoch: SIG_TRUST.epoch });
      await held(assertSalesImagesReady(mkEnv(over), NOW + MIN));
      expect(await row()).toMatchObject({ usable_x86: 1, usable_arm: 1, checked_at: NOW }); // it was held from the row, with no recompute
      real();
      await env.DB.prepare("DELETE FROM image_readiness").run();
    }
  });
  it("audit High 5: the two switches are part of config_hash", async () => {
    const base = (await currentKey(mkEnv())).hash;
    expect((await currentKey(mkEnv({ CLOUD_FREEZE: "true" }))).hash).not.toBe(base);
    expect((await currentKey(mkEnv({ CLOUD_PROVISIONING_OPEN: "false" }))).hash).not.toBe(base);
  });
  it("a missing row is computed inline, stored with valid_until per arch, and sales go on", async () => {
    expect(await row()).toBeNull();
    await assertSalesImagesReady(mkEnv(), NOW);
    expect(await row()).toMatchObject({ epoch: 1, usable_x86: 1, usable_arm: 1, zero_runs: 0, checked_at: NOW, valid_until_x86: NOW + 60 * MIN, valid_until_arm: NOW + 60 * MIN });
    expect((await row())!.config_hash).toBe((await currentKey(mkEnv())).hash);
  });
  it("a fresh row matching the config is used without recomputing", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    hetznerUp = false; setImageReadinessForTests({ check: async () => { throw new Error("must not run"); }, bundleEpoch: SIG_TRUST.epoch });
    await assertSalesImagesReady(mkEnv(), NOW + 29 * MIN);
    expect((await row())!.checked_at).toBe(NOW);
  });
  it("a row older than 30 minutes is recomputed inline", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    const later = NOW + READINESS_STALE_MS + 1;
    await assertSalesImagesReady(mkEnv(), later);
    expect((await row())!.checked_at).toBe(later);
  });
  it("a changed config text or verify-key text (config_hash) is recomputed at once, inside the 30 minutes", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    const before = (await row())!.config_hash;
    await assertSalesImagesReady(mkEnv({}, `${cfgText()} `), NOW + MIN);
    expect(await row()).toMatchObject({ checked_at: NOW + MIN });
    expect((await row())!.config_hash).not.toBe(before);
    await assertSalesImagesReady(mkEnv({ B5_IMAGE_VERIFY_PUBKEY: `${PUBKEY} ` }, `${cfgText()} `), NOW + 2 * MIN);
    expect(await row()).toMatchObject({ checked_at: NOW + 2 * MIN });
  });
  it("a bundle epoch that differs from the row's is recomputed (and the stored epoch follows the bundle)", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    setImageReadinessForTests({ verify: { trust: { ...SIG_TRUST, epoch: 2 }, fetch: fetchHz, buildEnv: "production" } });
    await assertSalesImagesReady(mkEnv(), NOW + MIN);
    expect(await row()).toMatchObject({ epoch: 2, checked_at: NOW + MIN });
    expect(await env.DB.prepare("SELECT epoch FROM image_policy").first()).toEqual({ epoch: 2 });
  });
  it("an unreadable row (a corrupt value) is recomputed; a row stamped in the future is not fresh", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    await env.DB.prepare("UPDATE image_readiness SET checked_at=?").bind(NOW + 10 * 60 * MIN).run();
    await assertSalesImagesReady(mkEnv(), NOW + MIN);
    expect((await row())!.checked_at).toBe(NOW + MIN);
  });
  it("an inline failure holds sales (fail closed) and stores nothing", async () => {
    setImageReadinessForTests({ check: async () => { throw new Error("boom"); } });
    await held(assertSalesImagesReady(mkEnv(), NOW));
    expect(await row()).toBeNull();
    expect(INLINE_BUDGET_MS).toBe(5_000);
  });
  it("an inline budget overrun holds sales", async () => {
    setImageReadinessForTests({ check: () => new Promise(() => undefined) });
    const t0 = Date.now();
    await held(assertSalesImagesReady(mkEnv(), NOW));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(INLINE_BUDGET_MS - 100);
  }, 15_000);
  it("an unreadable D1 holds", async () => {
    const dead = new Proxy(env.DB, { get(t, p) { if (p === "prepare" || p === "batch") return () => { throw new Error("d1 down"); }; const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
    await held(assertSalesImagesReady({ ...mkEnv(), DB: dead } as Env, NOW));
  });
});

describe("hold rules: two zero runs, a config fault at once, valid_until", () => {
  it("a zero that comes from the build host re-check holds only on the second consecutive run", async () => {
    hetznerUp = false;
    await assertSalesImagesReady(mkEnv(), NOW); // run 1: zero, but sales are not held yet
    expect(await row()).toMatchObject({ usable_x86: 0, usable_arm: 0, zero_runs: 1 });
    await sweepImageReadiness(mkEnv(), NOW + MIN); // run 2
    expect(await row()).toMatchObject({ zero_runs: 2 });
    await held(assertSalesImagesReady(mkEnv(), NOW + 2 * MIN));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='image.sales_hold'").first<{ n: number }>())!.n).toBe(1);
  });
  it("a good run resets the count and lifts the hold", async () => {
    hetznerUp = false;
    await sweepImageReadiness(mkEnv(), NOW); await sweepImageReadiness(mkEnv(), NOW + MIN);
    await held(assertSalesImagesReady(mkEnv(), NOW + 2 * MIN));
    hetznerUp = true; await env.DB.prepare("DELETE FROM image_recheck").run();
    await sweepImageReadiness(mkEnv(), NOW + 3 * MIN);
    expect(await row()).toMatchObject({ usable_x86: 1, zero_runs: 0 });
    await assertSalesImagesReady(mkEnv(), NOW + 4 * MIN);
  });
  it("a config fault (steps 1-11) holds on the first run", async () => {
    await held(assertSalesImagesReady(mkEnv({ B5_IMAGE_VERIFY_PUBKEY: "not-a-key" }), NOW));
    expect(await row()).toMatchObject({ usable_x86: 0, usable_arm: 0, zero_runs: 2 });
  });
  it("config faults: unparseable config, revoked images, no image configured, unsigned kinds", async () => {
    for (const [i, e] of ([mkEnv({}, "{not json"), mkEnv({}, cfgText({ imageKinds: {} })), mkEnv({}, cfgText({ images: { hetzner: {}, vultr: {} } }))] as Env[]).entries()) {
      await env.DB.prepare("DELETE FROM image_readiness").run();
      await held(assertSalesImagesReady(e, NOW)); expect((await row())!.zero_runs, String(i)).toBe(2);
    }
    setImageReadinessForTests({ verify: { trust: { ...SIG_TRUST, revoked: [X86, ARM] }, fetch: fetchHz, buildEnv: "production" } });
    await env.DB.prepare("DELETE FROM image_readiness").run();
    await held(assertSalesImagesReady(mkEnv(), NOW)); expect((await row())!.zero_runs).toBe(2);
  });
  it("production ssh keys (prod or vultr) are a prerequisite fault; staging keeps them", async () => {
    await held(assertSalesImagesReady(mkEnv({}, cfgText({ sshKeyIds: [1] })), NOW));
    await env.DB.prepare("DELETE FROM image_readiness").run();
    await held(assertSalesImagesReady(mkEnv({}, cfgText({ vultr: { sshKeyIds: ["k"] } })), NOW));
    await env.DB.prepare("DELETE FROM image_readiness").run();
    real({ buildEnv: "staging" }); // staging signs with env=staging; the fixture entries are prod-signed, so only the prerequisite is checked here
    await sweepImageReadiness(mkEnv({}, cfgText({ sshKeyIds: [1] })), NOW);
    expect((await row())!.zero_runs).toBeGreaterThanOrEqual(1);
  });
  it("a rolled-back bundle (stored epoch above its own) is a fault and holds at once", async () => {
    await env.DB.prepare("UPDATE image_policy SET epoch=7").run();
    await held(assertSalesImagesReady(mkEnv(), NOW));
    expect(await row()).toMatchObject({ zero_runs: 2 });
  });
  it("a row past valid_until for every arch holds at once, with no two-run wait", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    await env.DB.prepare("UPDATE image_readiness SET valid_until_x86=100, valid_until_arm=100").run();
    await assertSalesImagesReady(mkEnv(), 99); // still inside it
    await held(assertSalesImagesReady(mkEnv(), 101));
    expect(await row()).toMatchObject({ usable_x86: 1, zero_runs: 0 });
  });
  it("one arch still valid keeps sales open", async () => {
    await assertSalesImagesReady(mkEnv(), NOW);
    await env.DB.prepare("UPDATE image_readiness SET valid_until_x86=100, valid_until_arm=?").bind(NOW + 60 * MIN).run();
    await assertSalesImagesReady(mkEnv(), 101);
  });
  it("valid_until is min(signature expiry, re-check expiry)", async () => {
    // a signature that expires 10 minutes after NOW: verified_at = 180 days minus 10 minutes before NOW is not representable at the epoch,
    // so use the clock: now = 180 days - 10 min, the fixture verifiedAt (epoch) expires at 180 days.
    const day = 86_400_000; const now = 180 * day - 10 * MIN;
    await sweepImageReadiness(mkEnv(), now);
    expect(await row()).toMatchObject({ usable_x86: 1, valid_until_x86: 180 * day, valid_until_arm: 180 * day });
  });
});

describe("existing customers never read the row", () => {
  it("the existing-customer modules do not import the readiness or admission code", () => {
    for (const src of [cloudMachinesSrc, b3ControlSrc, selfServiceSrc]) {
      expect(src).not.toContain("image-readiness");
      expect(src).not.toContain("image-admission");
      expect(src).not.toContain("assertImageEpochCurrent");
    }
  });
  it("a held row changes nothing for a home that already exists: its image gate state is untouched", async () => {
    await held(assertSalesImagesReady(mkEnv({ B5_IMAGE_VERIFY_PUBKEY: "bad" }), NOW));
    // verifyImageForUse (creation only) is what refuses; reading the status of a home does not go through either
    const fn = await import("../src/image-admission");
    expect(Object.keys(fn).sort()).toEqual(["assertImageEpochCurrent", "epochHold"]);
  });
});

describe("the freeze vars (CLOUD_PROVISIONING_OPEN, CLOUD_FREEZE)", () => {
  it("CLOUD_FREEZE=true is the FROZEN prerequisite: usable 0 and the hold is ON at once; anything else is not", async () => {
    await held(assertSalesImagesReady(mkEnv({ CLOUD_FREEZE: "true" }), NOW));
    expect(await row()).toMatchObject({ usable_x86: 0, usable_arm: 0, zero_runs: 2 });
    for (const v of [undefined, "false", "", "1"]) {
      await env.DB.prepare("DELETE FROM image_readiness").run();
      await assertSalesImagesReady(mkEnv(v === undefined ? {} : { CLOUD_FREEZE: v }), NOW);
    }
  });
  it("CLOUD_FREEZE holds with the stubbed rig probe too (it is checked around the probe)", async () => {
    rigReadiness();
    await held(assertSalesImagesReady(mkEnv({ CLOUD_FREEZE: "true" }), NOW));
  });
  it("CLOUD_PROVISIONING_OPEN=false refuses every creation before any provider call; absent or other values behave as today", async () => {
    const cfg = { imageKinds: IMG_KINDS } as never;
    const go = (e: Env) => verifyImageForUse(e, cfg, { provider: "hetzner", image: X86, arch: "x86" }, NOW, { trust: SIG_TRUST, fetch: fetchHz, buildEnv: "production" });
    let calls = 0;
    const counting = async (u: string) => { calls++; return fetchHz(u); };
    const closed = verifyImageForUse(mkEnv({ CLOUD_PROVISIONING_OPEN: "false" }), cfg, { provider: "hetzner", image: X86, arch: "x86" }, NOW, { trust: SIG_TRUST, fetch: counting, buildEnv: "production" });
    await expect(closed).rejects.toBeInstanceOf(ImageRefused);
    await expect(closed).rejects.toMatchObject({ code: "provisioning_closed", notSent: true });
    expect(calls).toBe(0);
    for (const v of [undefined, "true", "", "0"]) await go(mkEnv(v === undefined ? {} : { CLOUD_PROVISIONING_OPEN: v }));
  });
  it("provisioning off also holds sales (no home could be built)", async () => {
    await held(assertSalesImagesReady(mkEnv({ CLOUD_PROVISIONING_OPEN: "false" }), NOW));
  });
});
