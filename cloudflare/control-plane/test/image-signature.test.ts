// SPDX-License-Identifier: AGPL-3.0-or-later
// Signed-image gate: failure-list rows 1-19 and 21-29 against verifyImageForUse, the DER to P1363 vectors, the size vectors, the re-check cache.
// The signing key is generated inside this test process; nothing here reads a real key.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { b64urlEncode, buildPayload, derToP1363, p1363ToDer, imageSizeText, validImageSizeText, parseCustomerEntry } from "../scripts/image-sig.mjs";
import { assertNoProdSshKeys, assertVerifiedImage, ImageRefused, loadVerifyKeys, verifyImageForUse, type ImageTrust, type VerifiedImage } from "../src/image-signature";
import { hetznerAdapter, vultrAdapter } from "../src/b5-provisioner";
import { provisionerConfig, provisionerSchema } from "../src/b5-config";
import { isNotSent } from "../src/dispatch-ledger";
import { CHECK_SHA, CREATED, IMG_KINDS, MAIN_KEY, PUBKEY, SIG_TRUST, hzImage, makeKey, signEntry } from "./image-sig-fixture";

const NOW = 1_000_000; // ms; the fixture signatures sit at the epoch
const DAY = 86_400_000;
const req = (image = "111", arch: "x86" | "arm" = "x86") => ({ provider: "hetzner" as const, image, arch });
const mkEnv = (over: Record<string, unknown> = {}): Env => ({ ...env, B5_IMAGE_VERIFY_PUBKEY: PUBKEY, HCLOUD_TOKEN: "hz-test-token", ...over } as unknown as Env);
type HzOver = Record<string, unknown> | Response | Error | undefined;
function hz(over: (id: string) => HzOver = () => undefined) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const id = url.split("/").pop()!;
    const o = over(id);
    if (o instanceof Error) throw o;
    if (o instanceof Response) return o;
    return new Response(JSON.stringify(hzImage(id, o)), { status: 200 });
  };
  return { fetch, calls };
}
const run = (kinds: unknown, opts: { env?: Env; image?: string; arch?: "x86" | "arm"; now?: number; trust?: ImageTrust; buildEnv?: "production" | "staging"; h?: ReturnType<typeof hz> } = {}) =>
  verifyImageForUse(opts.env ?? mkEnv(), { imageKinds: kinds } as never, req(opts.image ?? "111", opts.arch ?? "x86"), opts.now ?? NOW,
    { fetch: (opts.h ?? hz()).fetch, trust: opts.trust ?? SIG_TRUST, buildEnv: opts.buildEnv ?? "production" });
const refused = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toBeInstanceOf(ImageRefused); await expect(p).rejects.toMatchObject({ code, notSent: true }); };
const alerts = async () => (await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE home_id='platform' ORDER BY kind").all<{ kind: string; severity: string }>()).results;
const cacheRows = async () => (await env.DB.prepare("SELECT env,image_id,arch,checked_at FROM image_recheck").all<{ env: string; image_id: string; arch: string; checked_at: number }>()).results;
const good = () => ({ "111": IMG_KINDS["111"], "222": IMG_KINDS["222"] });

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM image_recheck"), env.DB.prepare("UPDATE image_policy SET epoch=0"),
    env.DB.prepare("DELETE FROM cloud_alerts WHERE home_id='platform'")]);
});

describe("the happy path", () => {
  it("a valid signature, a matching build host image and the right arch mint a capability", async () => {
    const v = await run(good());
    expect(v).toMatchObject({ provider: "hetzner", image: "111", arch: "x86", env: "prod", epoch: 1 });
    expect(Object.isFrozen(v)).toBe(true);
    expect(v.expiresAt).toBe(NOW + 60_000);
    expect((await run(good(), { image: "222", arch: "arm" })).arch).toBe("arm");
  });
});

describe("failure rows 1-5: the entry and the signature", () => {
  it("row 1: a missing entry or a missing sig field is refused", async () => {
    await refused(run({}), "image_kind_unknown");
    await refused(run({ "222": IMG_KINDS["222"] }), "image_kind_unknown");
    const { sig: _sig, ...nosig } = IMG_KINDS["111"] as Record<string, unknown>;
    await refused(run({ "111": nosig }), "image_sig_malformed");
    await refused(run({ "111": { ...IMG_KINDS["111"], keyFp: undefined } }), "image_sig_malformed");
  });
  it("row 2: wrong length, wrong alphabet, a DER stored instead of raw, padding", async () => {
    const e = IMG_KINDS["111"] as { sig: string };
    for (const sig of [e.sig.slice(0, 85), e.sig + "A", e.sig.slice(0, 85) + "=", e.sig.slice(0, 85) + "+", e.sig.slice(0, 85) + "\n",
      b64urlEncode(new Uint8Array(70).fill(0x30)), "", 7 as unknown as string]) {
      await refused(run({ "111": { ...e, sig } }), "image_sig_malformed");
    }
    // 86 characters whose last symbol is not canonical (extra bits set) do not re-encode to themselves
    const last = e.sig[85];
    const alt = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(last) + 1) % 64];
    if (e.sig.slice(0, 85) + alt !== e.sig) {
      const r = parseCustomerEntry({ ...e, sig: e.sig.slice(0, 85) + alt });
      // a different last symbol is either rejected as non-canonical or decodes to a different signature, which the verify then refuses
      if (r.ok) await refused(run({ "111": { ...e, sig: e.sig.slice(0, 85) + alt } }), "image_sig_invalid");
      else expect(r.ok).toBe(false);
    }
  });
  it("row 3: a key that is not loaded, and a loaded key that did not sign", async () => {
    const e = IMG_KINDS["111"] as Record<string, unknown>;
    await refused(run({ "111": { ...e, keyFp: "d".repeat(64) } }), "image_sig_wrong_key");
    const other = await makeKey();
    const trust2: ImageTrust = { ...SIG_TRUST, fps: [MAIN_KEY.fp, other.fp] };
    const forged = await signEntry(other, { imageId: "111" });
    // signed by `other` but naming MAIN_KEY: the named key does not verify it
    await refused(run({ "111": { ...forged, keyFp: MAIN_KEY.fp } }, { env: mkEnv({ B5_IMAGE_VERIFY_PUBKEY: `${PUBKEY},${other.spkiB64}` }), trust: trust2 }), "image_sig_invalid");
    // signed by `other` and naming it, but the other key's fp is not pinned in code
    await refused(run({ "111": forged }, { env: mkEnv({ B5_IMAGE_VERIFY_PUBKEY: `${PUBKEY},${other.spkiB64}` }) }), "image_pubkey_invalid");
  });
  it("row 4: every payload field edited in the entry breaks the signature or fails its own check", async () => {
    const e = IMG_KINDS["111"] as Record<string, unknown>;
    const trust: ImageTrust = { ...SIG_TRUST, checks: [CHECK_SHA, "e".repeat(64)] };
    await refused(run({ "111": { ...e, createdAt: "1969-12-31T23:59:59Z" } }, { trust }), "image_sig_invalid");
    await refused(run({ "111": { ...e, imageSize: "2.85" } }, { trust }), "image_sig_invalid");
    await refused(run({ "111": { ...e, verifiedAt: "19700101T000001Z" } }, { trust }), "image_sig_invalid");
    await refused(run({ "111": { ...e, checkSha256: "e".repeat(64) } }, { trust }), "image_sig_invalid");
    await refused(run({ "111": { ...e, verdict: "fail" } }, { trust }), "image_sig_malformed"); // the schema is the first failing check
    await refused(run({ "111": { ...e, extra: 1 } }, { trust }), "image_sig_malformed"); // strict object
  });
  it("row 5: an entry copied to another image id fails (the id comes from the configured key)", async () => {
    await refused(run({ "333": IMG_KINDS["111"] }, { image: "333" }), "image_sig_invalid");
  });
});

describe("failure rows 6-10: the re-check at the build host", () => {
  it("row 6: a changed created or image_size is image_changed, and the cache row is deleted", async () => {
    await run(good());
    expect(await cacheRows()).toHaveLength(1);
    await refused(run(good(), { now: NOW + 3_600_001, h: hz(() => ({ created: "1970-01-01T00:00:09Z" })) }), "image_changed");
    expect(await cacheRows()).toHaveLength(0);
    await run(good());
    await refused(run(good(), { now: NOW + 3_600_001, h: hz(() => ({ image_size: 2.85 })) }), "image_changed");
    expect(await cacheRows()).toHaveLength(0);
  });
  it("row 7: a deleted image, a 404, or a status that is not available", async () => {
    await refused(run(good(), { h: hz(() => new Response("{}", { status: 404 })) }), "image_recheck_failed");
    await refused(run(good(), { h: hz(() => ({ status: "creating" })) }), "image_recheck_failed");
    await refused(run(good(), { h: hz(() => ({ deleted: "2026-10-01T00:00:00Z" })) }), "image_recheck_failed");
    await refused(run(good(), { h: hz(() => ({ type: "system" })) }), "image_recheck_failed");
    expect(await cacheRows()).toHaveLength(0);
  });
  it("row 8: a re-used id with an old signature replayed has a new created time", async () => {
    await refused(run(good(), { h: hz(() => ({ created: "2026-10-22T09:58:12Z", image_size: 1.5 })) }), "image_changed");
  });
  it("row 9: timeout, 5xx, 429, a network error and bad JSON fail closed and are never cached", async () => {
    for (const over of [new Response("x", { status: 500 }), new Response("x", { status: 429 }), new Response("not json", { status: 200 }),
      new Response("null", { status: 200 }), new Error("network"), Object.assign(new Error("timeout"), { name: "TimeoutError" })]) {
      await refused(run(good(), { h: hz(() => over as HzOver) }), "image_recheck_failed");
      expect(await cacheRows()).toHaveLength(0);
    }
    // the next attempt re-checks and succeeds
    const h = hz();
    await run(good(), { h });
    expect(h.calls).toHaveLength(1);
    // no token: nothing is fetched and the answer is the same refusal (with the cache row from the success above dropped, since a hit skips the fetch by design)
    await env.DB.prepare("DELETE FROM image_recheck").run();
    await refused(run(good(), { env: mkEnv({ HCLOUD_TOKEN: "" }) }), "image_recheck_failed");
  });
  it("row 10: a changed created string format (same instant) is image_changed with a high alert", async () => {
    await refused(run(good(), { h: hz(() => ({ created: "1970-01-01T00:00:00+00:00" })) }), "image_changed");
    expect(await alerts()).toEqual(expect.arrayContaining([{ kind: "image.changed", severity: "high" }]));
  });
});

describe("failure rows 11-13: keys and environments", () => {
  it("row 11: the public key var missing, empty, not base64, not P-256, or a third entry", async () => {
    const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const rsaSpki = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", rsa.publicKey))));
    for (const bad of [undefined, "", "   ", "not base64 !!", rsaSpki, `${PUBKEY},${PUBKEY},${PUBKEY}`, `${PUBKEY},`, ",", btoa("hello")]) {
      await refused(run(good(), { env: mkEnv({ B5_IMAGE_VERIFY_PUBKEY: bad }) }), "image_pubkey_invalid");
    }
    expect(await alerts()).toEqual(expect.arrayContaining([{ kind: "image.pubkey_invalid", severity: "high" }]));
    expect(await loadVerifyKeys(PUBKEY, SIG_TRUST)).toHaveLength(1);
  });
  it("row 12: a var swapped to a key whose fingerprint is not pinned in code", async () => {
    const attacker = await makeKey();
    await refused(run({ "111": await signEntry(attacker, { imageId: "111" }) }, { env: mkEnv({ B5_IMAGE_VERIFY_PUBKEY: attacker.spkiB64 }) }), "image_pubkey_invalid");
  });
  it("row 13: a staging-signed entry is refused in production and a prod-signed one in staging", async () => {
    const stagingSigned = await signEntry(MAIN_KEY, { imageId: "111", env: "staging" });
    await refused(run({ "111": stagingSigned }), "image_env_mismatch");
    await refused(run({ "111": IMG_KINDS["111"] }, { buildEnv: "staging" }), "image_env_mismatch");
    expect((await run({ "111": stagingSigned }, { buildEnv: "staging" })).env).toBe("staging");
    // a production bundle with the staging switch on is a contradiction: every image is refused
    await refused(run(good(), { env: mkEnv({ CLOUD_CP0_STAGING: "1" }) }), "image_env_conflict");
    expect(await alerts()).toEqual(expect.arrayContaining([{ kind: "image.env_conflict", severity: "high" }]));
  });
});

describe("failure rows 14-19: verdict, check hash, age, vultr, rollback, revocation", () => {
  it("row 14: a verdict that is not pass fails at the entry schema", async () => {
    await refused(run({ "111": { ...(IMG_KINDS["111"] as object), verdict: "fail" } }), "image_sig_malformed");
  });
  it("row 15: a check script hash that is not accepted", async () => {
    await refused(run(good(), { trust: { ...SIG_TRUST, checks: ["f".repeat(64)] } }), "image_check_unaccepted");
    await refused(run(good(), { trust: { ...SIG_TRUST, checks: [] } }), "image_check_unaccepted");
  });
  it("row 16: stale (over 180 days), in the future (over 5 minutes), or before created", async () => {
    await refused(run(good(), { now: 180 * DAY + 1 }), "image_sig_stale");
    await refused(run(good(), { now: 181 * DAY }), "image_sig_stale");
    const future = await signEntry(MAIN_KEY, { imageId: "111", verifiedAt: "19700101T001000Z" }); // 10 minutes after the epoch
    await refused(run({ "111": future }, { now: 0 }), "image_sig_stale");
    expect((await run({ "111": future }, { now: 600_000 })).image).toBe("111"); // not in the future any more
    const early = await signEntry(MAIN_KEY, { imageId: "111", createdAt: "1970-01-01T01:00:00Z", verifiedAt: "19700101T000000Z" });
    await refused(run({ "111": early }, { now: NOW }), "image_sig_stale");
    // the boundary: exactly 180 days is still valid
    const v = await run(good(), { now: 180 * DAY, h: hz() });
    expect(v.expiresAt).toBe(180 * DAY); // min(now+60s, now+TTL, verified+180d)
  });
  it("row 16: expiry alerts at 30 days and at 7 days, none before", async () => {
    await run(good(), { now: 149 * DAY });
    expect(await alerts()).toEqual([]);
    await run(good(), { now: 151 * DAY });
    expect((await alerts()).map((a) => a.kind)).toEqual(["image.sig_expiry_30d.111"]);
    await run(good(), { now: 174 * DAY });
    expect((await alerts()).map((a) => a.kind)).toEqual(["image.sig_expiry_30d.111", "image.sig_expiry_7d.111"]);
    expect((await alerts()).find((a) => a.kind.includes("7d"))!.severity).toBe("high");
  });
  it("row 17: a Vultr image is never verifiable, in either environment", async () => {
    for (const buildEnv of ["production", "staging"] as const) {
      await expect(verifyImageForUse(mkEnv(), { imageKinds: good() } as never, { provider: "vultr", image: "111", arch: "x86" }, NOW,
        { fetch: hz().fetch, trust: SIG_TRUST, buildEnv })).rejects.toMatchObject({ code: "image_vultr_unverifiable", notSent: true });
    }
  });
  it("row 18: a config rolled back to imageKinds without signatures", async () => {
    await refused(run({ "111": "customer" }), "image_sig_malformed");
    await refused(run({ "111": { kind: "customer", verifiedBy: "hz-live-rescue", checkVersion: "1", verifiedAt: "20261020T101500Z" } }), "image_sig_malformed");
    await refused(run(undefined), "image_kind_unknown");
    await refused(run(null), "image_kind_unknown");
    await refused(run([IMG_KINDS["111"]]), "image_kind_unknown");
    await refused(run(7), "image_kind_unknown");
  });
  it("row 19: an older validly signed image that is revoked, and an old one past the age limit", async () => {
    await refused(run(good(), { trust: { ...SIG_TRUST, revoked: ["111"] } }), "image_revoked");
    expect((await run(good(), { trust: { ...SIG_TRUST, revoked: ["222"] } })).image).toBe("111");
    await refused(run(good(), { now: 200 * DAY }), "image_sig_stale");
  });
});

describe("failure rows 21-29", () => {
  it("row 21: key rotation, two keys in the var, then the old fingerprint leaves the code", async () => {
    const next = await makeKey();
    const both = mkEnv({ B5_IMAGE_VERIFY_PUBKEY: `${PUBKEY},${next.spkiB64}` });
    const trustBoth: ImageTrust = { ...SIG_TRUST, fps: [MAIN_KEY.fp, next.fp] };
    const resigned = await signEntry(next, { imageId: "111" });
    // both keys loaded: images signed by either verify
    expect((await run(good(), { env: both, trust: trustBoth })).image).toBe("111");
    expect((await run({ "111": resigned }, { env: both, trust: trustBoth })).image).toBe("111");
    // deploy B: the old key leaves code and var; an image still signed by the old key fails, the re-signed one passes
    const after = mkEnv({ B5_IMAGE_VERIFY_PUBKEY: next.spkiB64 });
    const trustNew: ImageTrust = { ...SIG_TRUST, fps: [next.fp] };
    await refused(run(good(), { env: after, trust: trustNew }), "image_sig_wrong_key");
    expect((await run({ "111": resigned }, { env: after, trust: trustNew })).image).toBe("111");
    // the old key still in the var after its fingerprint left code: the whole var is refused
    await refused(run({ "111": resigned }, { env: both, trust: trustNew }), "image_pubkey_invalid");
  });
  it("row 22 (the stored-choice re-verify) is covered in b5-provisioner.test.ts; here the same image fails once revoked, with no fetch", async () => {
    const h = hz();
    await refused(run(good(), { trust: { ...SIG_TRUST, revoked: ["111"] }, h }), "image_revoked");
    expect(h.calls).toHaveLength(0);
  });
  it("row 24: names and non-canonical numbers are not image ids", async () => {
    for (const image of ["ubuntu-24.04", "0123", "1e3", "-1", "", "12 ", " 12", "1\n", "99999999999999999", "0x10", "١٢٣"]) {
      await refused(run({ [image]: IMG_KINDS["111"] }, { image }), "image_id_invalid");
    }
  });
  it("row 25: __proto__ and constructor are never imageKinds keys, and inherited properties do not count", async () => {
    const own = JSON.parse(`{"__proto__": ${JSON.stringify(IMG_KINDS["111"])}, "constructor": ${JSON.stringify(IMG_KINDS["111"])}}`);
    await refused(run(own, { image: "__proto__" }), "image_id_invalid");
    await refused(run(own, { image: "constructor" }), "image_id_invalid");
    await refused(run(Object.create({ "111": IMG_KINDS["111"] })), "image_kind_unknown");
  });
  it("row 26: one malformed entry fails only itself, and parsing never stops cleanup", async () => {
    const kinds = { "111": IMG_KINDS["111"], "222": { garbage: true }, ["x".repeat(10_000)]: 5 };
    expect((await run(kinds)).image).toBe("111");
    await refused(run(kinds, { image: "222", arch: "arm" }), "image_sig_malformed");
    for (const imageKinds of [7, "x", [1], null, { ["k".repeat(10_000)]: {} }, undefined]) {
      const config = provisionerSchema.parse({ images: { hetzner: { x86: "111" }, vultr: {} }, quarantineFirewallId: 1, sshKeyIds: [1], imageKinds });
      expect(config.images.hetzner.x86).toBe("111");
    }
    // the env-level parse, as suspend, fence and delete use it, with a production-style config carrying ssh keys and a garbage key
    const e = mkEnv({ B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: { x86: "111" }, vultr: {} }, quarantineFirewallId: 1, sshKeyIds: [1], imageKinds: { "__proto__x": 1, ["z".repeat(500)]: 2 } }) });
    expect(provisionerConfig(e).sshKeyIds).toEqual([1]);
  });
  it("row 27: build host answers with another image, or an arm image for an x86 rung", async () => {
    await refused(run(good(), { h: hz(() => ({ id: 999 })) }), "image_recheck_failed");
    await refused(run(good(), { h: hz(() => ({ architecture: "arm" })) }), "image_arch_mismatch");
    await refused(run(good(), { arch: "arm" }), "image_arch_mismatch"); // the default answer for 111 is x86
    await refused(run(good(), { h: hz(() => ({ image_size: null })) }), "image_changed");
  });
  it("row 28: an unverified caller of the adapters is refused before any fetch", async () => {
    const real = await run(good());
    const forged = { provider: "hetzner", image: "111", arch: "x86", env: "prod", expiresAt: NOW + 60_000, epoch: 1 } as VerifiedImage;
    const copy = { ...real } as VerifiedImage;
    const want = { provider: "hetzner" as const, now: NOW };
    expect(assertVerifiedImage(real, want)).toBe(real);
    for (const bad of [forged, copy, null, "111", undefined]) expect(() => assertVerifiedImage(bad, want)).toThrow("image_unverified_call");
    expect(() => assertVerifiedImage(real, { ...want, provider: "vultr" })).toThrow("image_unverified_call");
    expect(() => assertVerifiedImage(real, { ...want, env: "staging" })).toThrow("image_unverified_call");
    expect(() => assertVerifiedImage(real, { ...want, now: real.expiresAt + 1 })).toThrow("image_unverified_call");
    expect(() => assertVerifiedImage(real, { ...want, now: real.expiresAt })).not.toThrow(); // the boundary is inclusive
    // "verified 1 ms before expiry, dispatched 50 s later": the dispatch refuses
    const near = await run({ "111": await signEntry(MAIN_KEY, { imageId: "111" }) }, { now: 180 * DAY - 1 });
    expect(near.expiresAt).toBe(180 * DAY);
    expect(() => assertVerifiedImage(near, { provider: "hetzner", now: 180 * DAY - 1 + 50_000 })).toThrow("image_unverified_call");
    // the adapter: every creating call stops before it sends
    const calls: string[] = [];
    const adapter = hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [1] } as never, async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }, () => NOW);
    const input = { name: "n", serverType: "cx23", location: "fsn1", userData: "", labels: {} as never, volumeId: null };
    await expect(adapter.createServer({ ...input, image: forged })).rejects.toThrow("image_unverified_call");
    await expect(adapter.createPoolServer({ name: "n", type: "cx23", location: "fsn1", image: copy, labels: {}, userData: "", firewallIds: [], sshKeyIds: [] })).rejects.toThrow("image_unverified_call");
    await expect(adapter.rebuildServer("5", forged)).rejects.toThrow("image_unverified_call");
    expect(calls).toHaveLength(0);
    // a stale capability is refused at the adapter by its own clock
    const late = hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [1] } as never, async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }, () => real.expiresAt + 1);
    await expect(late.createServer({ ...input, image: real })).rejects.toThrow("image_unverified_call");
    expect(calls).toHaveLength(0);
  });
  it("row 28 (call sites): a string image is a compile error at every creating call, and a build host capability never reaches the Vultr adapter", async () => {
    const real = await run(good());
    const calls: string[] = [];
    const fetcher = async (url: string) => { calls.push(String(url)); return new Response("{}", { status: 200 }); };
    const hz = hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [1] } as never, fetcher, () => NOW);
    const input = { name: "n", serverType: "cx23", location: "fsn1", userData: "", labels: {} as never, volumeId: null };
    // @ts-expect-error a bare image id is not a VerifiedImage (the brand is a compile-time guard)
    await expect(hz.createServer({ ...input, image: "111" })).rejects.toThrow("image_unverified_call");
    // @ts-expect-error a bare image id is not a VerifiedImage
    await expect(hz.createPoolServer({ name: "n", type: "cx23", location: "fsn1", image: "111", labels: {}, userData: "", firewallIds: [], sshKeyIds: [] })).rejects.toThrow("image_unverified_call");
    // @ts-expect-error a bare image id is not a VerifiedImage
    await expect(hz.rebuildServer("5", "111")).rejects.toThrow("image_unverified_call");
    const vu = vultrAdapter("k", { sshKeyIds: ["vk-1"], firewallGroupId: "fwg-home", quarantineFirewallGroupId: "fwg-quar" } as never, fetcher as never);
    await expect(vu.createServer({ ...input, serverType: "vc2-2c-4gb", location: "fra", image: real } as never)).rejects.toThrow("image_unverified_call");
    expect(calls).toHaveLength(0);
    // the refusal is marked not sent, so a retry is safe
    const e = await hz.createServer({ ...input, image: { ...real } as VerifiedImage }).catch((x: unknown) => x);
    expect(isNotSent(e)).toBe(true);
  });
  it("audit High 2: an epoch raised after the capability was minted refuses every dispatch before the POST; a current one records its authorization", async () => {
    const real = await run(good()); // verified at epoch 1 (the real verifier raises the durable epoch to 1)
    expect(real.epoch).toBe(1);
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${url}`); return new Response(JSON.stringify({ server: { id: 7, status: "off", labels: {} }, action: { id: 1, status: "running" } }), { status: 201 }); };
    const hz = hetznerAdapter("tok", { sshKeyIds: [], firewallIds: [1] } as never, fetcher, () => NOW);
    const input = { name: "n", serverType: "cx23", location: "fsn1", userData: "", labels: {} as never, volumeId: null };
    // current epoch: the dispatch goes and its conditional authorization row is recorded with the key, check hash and image
    await hz.createServer({ ...input, image: real });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT epoch,key_fp,check_sha256,image,state,provider_server_id FROM image_dispatch_auth").all()).toMatchObject({ results: [{ epoch: 1, key_fp: MAIN_KEY.fp, check_sha256: CHECK_SHA, image: "111", state: "settled_created", provider_server_id: "7" }] });
    // the durable epoch advances to 2 before dispatch: the capability issued at epoch 1 is refused, nothing is sent, and no authorization is taken
    calls.length = 0;
    await env.DB.prepare("UPDATE image_policy SET epoch=2").run();
    for (const dispatch of [
      () => hz.createServer({ ...input, image: real }),
      () => hz.createPoolServer({ name: "n", type: "cx23", location: "fsn1", image: real, labels: {}, userData: "", firewallIds: [], sshKeyIds: [] }),
      () => hz.rebuildServer("5", real),
    ]) {
      const e = await dispatch().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ImageRefused); expect(e).toMatchObject({ code: "image_policy_rolled_back", notSent: true });
      expect(isNotSent(e)).toBe(true);
    }
    expect(calls).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM image_dispatch_auth").first<{ n: number }>())!.n).toBe(1);
    // a D1 failure of the authorization fails closed too
    await env.DB.prepare("UPDATE image_policy SET epoch=1").run();
    await env.DB.prepare("CREATE TRIGGER no_auth BEFORE INSERT ON image_dispatch_auth BEGIN SELECT RAISE(ABORT,'d1 down'); END").run();
    try { await refused(hz.createServer({ ...input, image: real }), "image_recheck_failed"); } finally { await env.DB.prepare("DROP TRIGGER no_auth").run(); }
    expect(calls).toEqual([]);
  });
  it("row 29: a forged or stale cache row only skips the re-check; steps 1-11 always run", async () => {
    // a cache row for a bad signature does not help
    const bad = { ...(IMG_KINDS["111"] as object), imageSize: "9.99" };
    await env.DB.prepare("INSERT INTO image_recheck (env,image_id,sig_hash,created_at,image_size,arch,checked_at) VALUES ('prod','111','x','1970-01-01T00:00:00Z','9.99','x86',?)").bind(NOW).run();
    await refused(run({ "111": bad }), "image_sig_invalid");
    // a row whose stored time or fields do not fit is ignored and replaced by a real re-check
    const sigHash = async () => { await run(good()); return (await env.DB.prepare("SELECT sig_hash FROM image_recheck").first<{ sig_hash: string }>())!.sig_hash; };
    const sh = await sigHash();
    await env.DB.prepare("UPDATE image_recheck SET created_at='1970-01-01T00:00:09Z' WHERE sig_hash=?").bind(sh).run();
    const h = hz();
    await run(good(), { now: NOW + 5, h });
    expect(h.calls).toHaveLength(1);
    await env.DB.prepare("UPDATE image_recheck SET checked_at=? WHERE sig_hash=?").bind(NOW + 10_000_000, sh).run(); // a time in the future
    const h2 = hz();
    await run(good(), { now: NOW + 6, h: h2 });
    expect(h2.calls).toHaveLength(1);
  });
});

describe("the re-check cache", () => {
  it("audit High 4: a cache hit never extends validity past the ORIGINAL re-check expiry", async () => {
    const h = hz();
    await run(good(), { h });
    const late = NOW + 3_599_999; // verify again 1 ms before the first re-check expired, from the cached row
    const v = await run(good(), { h, now: late });
    expect(h.calls).toHaveLength(1); // a hit
    expect(v.expiresAt).toBe(NOW + 3_600_000); // not late + 60 s
    expect(v.validUntil).toBe(NOW + 3_600_000); // not late + 1 h
    expect(v.validUntil).toBeLessThanOrEqual(NOW + 3_600_000);
  });
  it("a hit within an hour fetches nothing; at exactly an hour it fetches; a failure deletes the row", async () => {
    const h = hz();
    await run(good(), { h });
    expect(h.calls).toHaveLength(1);
    expect(await cacheRows()).toEqual([{ env: "prod", image_id: "111", arch: "x86", checked_at: NOW }]);
    await run(good(), { h, now: NOW + 1 });
    await run(good(), { h, now: NOW + 3_599_999 });
    expect(h.calls).toHaveLength(1); // two hits
    await run(good(), { h, now: NOW + 3_600_000 });
    expect(h.calls).toHaveLength(2); // the hour is up: now - TTL < checked_at is false at the boundary
    expect((await cacheRows())[0].checked_at).toBe(NOW + 3_600_000);
    await refused(run(good(), { h: hz(() => new Response("x", { status: 503 }) as unknown as HzOver), now: NOW + 7_200_000 }), "image_recheck_failed");
    expect(await cacheRows()).toHaveLength(0);
  });
  it("the key includes the arch and the signature: another arch and a re-signed entry miss", async () => {
    const h = hz();
    await run(good(), { h });
    await run(good(), { h, image: "222", arch: "arm" });
    expect(h.calls).toHaveLength(2);
    expect(await cacheRows()).toHaveLength(2);
    const resigned = await signEntry(MAIN_KEY, { imageId: "111", verifiedAt: "19700101T000100Z" });
    await run({ "111": resigned }, { h });
    expect(h.calls).toHaveLength(3);
    expect(await cacheRows()).toHaveLength(3);
  });
  it("a D1 error on the cache fails closed", async () => {
    const broken = mkEnv({ DB: { prepare: () => { throw new Error("d1 down"); } } });
    await expect(run(good(), { env: broken })).rejects.toMatchObject({ notSent: true });
  });
  it("the durable policy epoch: a bundle older than the stored epoch cannot create", async () => {
    await env.DB.prepare("UPDATE image_policy SET epoch=5").run();
    await refused(run(good()), "image_policy_rolled_back");
    expect(await alerts()).toEqual(expect.arrayContaining([{ kind: "image.policy_rolled_back", severity: "high" }]));
    await env.DB.prepare("UPDATE image_policy SET epoch=0").run();
    await run(good());
    expect((await env.DB.prepare("SELECT epoch FROM image_policy WHERE id='current'").first<{ epoch: number }>())!.epoch).toBe(1);
  });
});

describe("production ssh keys", () => {
  it("creation refuses non-empty keys in a production bundle; staging may carry them; parsing never refuses", () => {
    const e = mkEnv();
    expect(() => assertNoProdSshKeys(e, { sshKeyIds: [1] }, { buildEnv: "production" })).toThrow("ssh_keys_prod_forbidden");
    expect(() => assertNoProdSshKeys(e, { sshKeyIds: [], vultr: { sshKeyIds: ["k"] } }, { buildEnv: "production" })).toThrow("ssh_keys_prod_forbidden");
    expect(() => assertNoProdSshKeys(e, { sshKeyIds: [] }, { buildEnv: "production" })).not.toThrow();
    expect(() => assertNoProdSshKeys(e, { sshKeyIds: [1] }, { buildEnv: "staging" })).not.toThrow();
  });
});

// ---- encoding vectors -----------------------------------------------------------------------------------------------------------------

const hexOf = (n: string) => Uint8Array.from(n.match(/../g)!.map((x) => parseInt(x, 16)));
/** A DER SEQUENCE of two INTEGERs given as raw content bytes (the caller decides the padding). */
const der = (r: number[], s: number[], over: { tagR?: number; seqLen?: number; extra?: number[]; lenR?: number } = {}) => {
  const body = [over.tagR ?? 0x02, over.lenR ?? r.length, ...r, 0x02, s.length, ...s, ...(over.extra ?? [])];
  return Uint8Array.from([0x30, over.seqLen ?? body.length, ...body]);
};
const N = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
const bytes32 = (fill: number) => new Array(32).fill(fill);

describe("DER to P1363", () => {
  it("round-trips real WebCrypto signatures through a minimal DER encoding", async () => {
    const key = await makeKey();
    for (let i = 0; i < 40; i++) {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.priv, new TextEncoder().encode(`m${i}`)));
      const enc = (v: Uint8Array) => { let a = Array.from(v); while (a.length > 1 && a[0] === 0) a = a.slice(1); if (a[0] & 0x80) a = [0, ...a]; return a; };
      expect(Array.from(derToP1363(der(enc(raw.slice(0, 32)), enc(raw.slice(32)))))).toEqual(Array.from(raw));
      expect(Array.from(p1363ToDer(raw))).toEqual(Array.from(der(enc(raw.slice(0, 32)), enc(raw.slice(32)))));
    }
  });
  it("a leading 0x00 is stripped when the next byte has the high bit", () => {
    const r = [0, 0x80, ...bytes32(1).slice(1)]; const s = bytes32(2);
    const out = derToP1363(der(r, s));
    expect(out).toHaveLength(64);
    expect(out[0]).toBe(0x80); expect(out[32]).toBe(2);
  });
  it("a short r (31 bytes) is left-padded to 32", () => {
    const out = derToP1363(der(bytes32(7).slice(1), bytes32(9)));
    expect(out[0]).toBe(0); expect(out[1]).toBe(7); expect(out[31]).toBe(7); expect(out[32]).toBe(9);
    const one = derToP1363(der([1], [2]));
    expect(one[31]).toBe(1); expect(one[63]).toBe(2); expect(one.slice(0, 31).every((b) => b === 0)).toBe(true);
  });
  it("strict refusals", () => {
    const ok = bytes32(5);
    const cases: [string, Uint8Array][] = [
      ["der_integer_length", der([0, ...bytes32(0x80), 1], ok)], // 34 bytes
      ["der_integer_too_long", der([1, ...bytes32(1)], ok)], // 33 bytes, no zero prefix
      ["der_not_minimal", der([0, 0x01, ...bytes32(1).slice(1)], ok)], // needless leading zero
      ["der_negative", der([0x80, ...bytes32(1).slice(1)], ok)], // high bit without the zero: a negative number
      ["der_trailing", der(ok, ok, { extra: [0] })],
      ["der_integer_tag", der(ok, ok, { tagR: 0x03 })],
      ["der_sequence", Uint8Array.from([0x31, ...der(ok, ok).slice(1)])],
      ["der_length_form", Uint8Array.from([0x30, 0x81, 70, ...der(ok, ok).slice(2)])],
      ["der_length", der(ok, ok, { seqLen: 10 })],
      ["der_truncated", Uint8Array.from([0x30, 6, 0x02, 40, 1, 2, 3, 4])],
      ["der_sequence", Uint8Array.from([0x30, 0])],
      ["der_range", der([0], ok)], // r = 0
      ["der_range", der(ok, [0])], // s = 0
      ["der_range", der([0, ...hexOf(N)], ok)], // r = n
      ["der_range", der(ok, [0, ...hexOf(N)])], // s = n
    ];
    for (const [why, bad] of cases) {
      try { derToP1363(bad); throw new Error(`accepted: ${why}`); } catch (e) { expect((e as Error).message, why).toMatch(/^der_/); }
    }
    // the named reasons for the clear cases
    expect(() => derToP1363(der([0, ...bytes32(0x80), 1], ok))).toThrow("der_integer_length");
    expect(() => derToP1363(der([1, ...bytes32(1)], ok))).toThrow("der_integer_too_long");
    expect(() => derToP1363(der([0, 0x01, ...bytes32(1).slice(1)], ok))).toThrow("der_not_minimal");
    expect(() => derToP1363(der([0x80, ...bytes32(1).slice(1)], ok))).toThrow("der_negative");
    expect(() => derToP1363(der(ok, ok, { extra: [0] }))).toThrow(/der_(length|trailing)/);
    expect(() => derToP1363(der(ok, ok, { tagR: 0x03 }))).toThrow("der_integer_tag");
    expect(() => derToP1363(der([0], ok))).toThrow("der_range");
    expect(() => derToP1363(der([0, ...hexOf(N)], ok))).toThrow("der_range");
    expect(() => derToP1363(der([0, ...hexOf(N).slice(0, 31), 0x50], ok))).not.toThrow(); // n - 1 is the largest valid value
  });
});

describe("image_size vectors and the payload", () => {
  it("the cross-language size list agrees with ECMAScript number text", () => {
    const vectors: [number, string][] = [[0.001, "0.001"], [0.89, "0.89"], [2.84, "2.84"], [1, "1"], [10, "10"], [123.456789, "123.456789"],
      [999999.999, "999999.999"], [0.1 + 0.2, "0.30000000000000004"]];
    for (const [n, text] of vectors) { expect(imageSizeText(n)).toBe(text); expect(validImageSizeText(text)).toBe(true); }
  });
  it("out of range numbers, exponent forms and non-canonical text are refused", () => {
    for (const n of [0, 0.0009, 1e6, 1e21, 1e-7, -1, NaN, Infinity, "2.84", null, undefined]) expect(imageSizeText(n)).toBeNull();
    for (const t of ["1e3", "01", "1.0", "2.840", ".5", "5.", "1,5", "+1", "0", "1000000", "0.0001", " 1", "1\n", "", "0x10"]) expect(validImageSizeText(t), t).toBe(false);
  });
  it("the payload is the fixed template, parses to eight members, and refuses bad fields", () => {
    const f = { imageId: "123", createdAt: CREATED, imageSize: "2.84", env: "prod" as const, checkSha256: CHECK_SHA, verdict: "pass" as const, verifiedAt: "20261022T101500Z" };
    const p = buildPayload(f);
    expect(p).toBe(`{"v":"murage-image-sig/1","image_id":"123","created_at":"${CREATED}","image_size":"2.84","env":"prod","check_sha256":"${CHECK_SHA}","verdict":"pass","verified_at":"20261022T101500Z"}`);
    expect(Object.keys(JSON.parse(p))).toEqual(["v", "image_id", "created_at", "image_size", "env", "check_sha256", "verdict", "verified_at"]);
    for (const bad of [{ imageId: "0123" }, { imageId: "1\n" }, { createdAt: "2026-02-30T00:00:00Z" }, { createdAt: "x" }, { imageSize: "1e3" }, { env: "dev" },
      { checkSha256: "A".repeat(64) }, { checkSha256: "a".repeat(63) }, { verdict: "fail" }, { verifiedAt: "20260230T101500Z" }, { verifiedAt: "20261022T101500" }]) {
      expect(() => buildPayload({ ...f, ...bad } as never)).toThrow(/^payload_/);
    }
  });
});
