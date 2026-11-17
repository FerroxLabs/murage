// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the signer's encoding side: the payload bytes equal the Worker's, DER-to-P1363 conversion, entry building, image checks.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "..");
const cli = join(dir, "image-sig-cli.mjs");
const W = await import(join(dir, "image-sig.mjs"));
const C = await import(cli);
const run = (args, input) => { const r = spawnSync("node", [cli, ...args], { input, encoding: "utf8" }); return r; };

const SHA = "a".repeat(64);
const vectors = [
  { imageId: "123456789", createdAt: "2026-10-22T07:40:28+00:00", imageSize: "2.04", env: "prod", checkSha256: SHA, verifiedAt: "20261022T080000Z" },
  { imageId: "1", createdAt: "2026-02-28T23:59:59Z", imageSize: "0.001", env: "staging", checkSha256: "0123456789abcdef".repeat(4), verifiedAt: "20260228T235959Z" },
  { imageId: "999999999999999", createdAt: "2026-10-22T07:40:28.123456+02:00", imageSize: "999999.5", env: "prod", checkSha256: SHA, verifiedAt: "20261231T000000Z" },
];

test("the signer's payload bytes equal the Worker's buildPayload bytes for the same input", () => {
  for (const v of vectors) {
    const r = run(["payload", v.imageId, v.createdAt, v.imageSize, v.env, v.checkSha256, v.verifiedAt]);
    assert.equal(r.status, 0, r.stderr);
    const expected = W.buildPayload({ ...v, verdict: "pass" });
    assert.equal(r.stdout, expected);
    assert.equal(Buffer.from(r.stdout).equals(Buffer.from(expected)), true);
    assert.equal(r.stdout.endsWith("\n"), false);
  }
});

test("golden payload literal", () => {
  const r = run(["payload", "123456789", "2026-10-22T07:40:28+00:00", "2.04", "prod", SHA, "20261022T080000Z"]);
  assert.equal(r.stdout, `{"v":"murage-image-sig/1","image_id":"123456789","created_at":"2026-10-22T07:40:28+00:00","image_size":"2.04","env":"prod","check_sha256":"${SHA}","verdict":"pass","verified_at":"20261022T080000Z"}`);
});

test("the payload builder refuses what the Worker refuses", () => {
  const bad = [
    ["0123", "2026-10-22T07:40:28Z", "2.04", "prod", SHA, "20261022T080000Z"],
    ["1", "2026-02-30T07:40:28Z", "2.04", "prod", SHA, "20261022T080000Z"],
    ["1", "2026-10-22T07:40:28Z", "2.0", "prod", SHA, "20261022T080000Z"],
    ["1", "2026-10-22T07:40:28Z", "2.04", "production", SHA, "20261022T080000Z"],
    ["1", "2026-10-22T07:40:28Z", "2.04", "prod", "A".repeat(64), "20261022T080000Z"],
    ["1", "2026-10-22T07:40:28Z", "2.04", "prod", SHA, "20260230T080000Z"],
  ];
  for (const b of bad) assert.notEqual(run(["payload", ...b]).status, 0, JSON.stringify(b));
});

test("the copied module is byte-identical to the pinned original when supplied", () => {
  const orig = process.env.WORKER_SIG_MJS;
  if (!orig) return;
  assert.equal(readFileSync(orig).equals(readFileSync(join(dir, "image-sig.mjs"))), true);
});

test("sign-image.sh pins the module sha256 of the copy", () => {
  const sh = readFileSync(join(dir, "sign-image.sh"), "utf8");
  const pin = /PINNED_SIG_MODULE_SHA256="([0-9a-f]{64})"/.exec(sh)[1];
  assert.equal(pin, createHash("sha256").update(readFileSync(join(dir, "image-sig.mjs"))).digest("hex"));
  const check = /PINNED_CHECK_SHA256="([0-9a-f]{64})"/.exec(sh)[1];
  assert.equal(check, createHash("sha256").update(readFileSync(join(dir, "image-release-check.sh"))).digest("hex"));
});

test("pinned KMS public key fingerprint is the Worker's trusted one", () => {
  assert.ok(W.TRUSTED_IMAGE_KEY_FPS.includes(C.keyFp()));
  assert.equal(run(["key-fp"]).stdout.trim(), C.keyFp());
});

// ---- DER to P1363 ----
const hex = (h) => Buffer.from(h.replace(/\s/g, ""), "hex");
const N = "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551";
const der = (r, s) => { const i = (x) => Buffer.concat([Buffer.from([0x02, x.length]), x]); const body = Buffer.concat([i(r), i(s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]); };
const one = (n) => Buffer.from(n.toString(16).padStart(2, "0"), "hex");
const toSig = (buf) => run(["der-to-sig"], buf.toString("base64"));

test("DER conversion: fixed vectors", () => {
  // small r and s: 1 byte each
  let r = toSig(der(one(1), one(2)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Buffer.from(W.b64urlDecode(r.stdout.trim())).equals(Buffer.concat([Buffer.alloc(31), one(1), Buffer.alloc(31), one(2)])), true);
  // high bit set needs a leading zero: 33-byte INTEGER
  const hi = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x11)]);
  r = toSig(der(Buffer.concat([Buffer.from([0]), hi]), Buffer.concat([Buffer.from([0]), hi])));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Buffer.from(W.b64urlDecode(r.stdout.trim())).subarray(0, 32).equals(hi), true);
  // 31-byte value is left padded
  const short = Buffer.alloc(31, 0x22);
  r = toSig(der(short, short));
  assert.equal(r.status, 0);
  const raw = Buffer.from(W.b64urlDecode(r.stdout.trim()));
  assert.equal(raw.length, 64);
  assert.equal(raw[0], 0);
  assert.equal(raw.subarray(1, 32).equals(short), true);
});

test("DER conversion: strict refusals", () => {
  const ok = Buffer.alloc(32, 0x33);
  const cases = {
    "negative (no leading zero, high bit)": der(Buffer.from([0x80, 1]), one(1)),
    "non-minimal leading zero": der(Buffer.from([0x00, 0x01]), one(1)),
    "zero r": der(one(0), one(1)),
    "zero s": der(one(1), one(0)),
    "r equal to n": der(Buffer.concat([Buffer.from([0]), hex(N)]), one(1)),
    "r above n": der(Buffer.concat([Buffer.from([0]), hex("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632552")]), one(1)),
    "trailing byte": Buffer.concat([der(ok, ok).subarray(0, 2 + 68), Buffer.from([0])]),
    "long-form length": Buffer.concat([Buffer.from([0x30, 0x81, 0x44]), der(ok, ok).subarray(2)]),
    "wrong outer tag": Buffer.concat([Buffer.from([0x31]), der(ok, ok).subarray(1)]),
    "wrong inner tag": (() => { const d = Buffer.from(der(ok, ok)); d[2] = 0x04; return d; })(),
    "truncated": der(ok, ok).subarray(0, 40),
    "empty integer": Buffer.from([0x30, 0x06, 0x02, 0x00, 0x02, 0x02, 0x00, 0x01]),
    "34-byte integer": der(Buffer.alloc(34, 0x01), one(1)),
  };
  // fix lengths of the hand-edited ones so the right rule fires
  cases["trailing byte"][1] += 1;
  for (const [name, buf] of Object.entries(cases)) assert.notEqual(toSig(buf).status, 0, name);
});

test("DER conversion: 300 random real KMS-style signatures verify after conversion", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  for (let i = 0; i < 300; i++) {
    const msg = Buffer.from(`message ${i} ${Math.random()}`);
    const d = sign("sha256", msg, { key: privateKey, dsaEncoding: "der" });
    const r = toSig(d);
    assert.equal(r.status, 0, r.stderr);
    const raw = Buffer.from(W.b64urlDecode(r.stdout.trim()));
    assert.equal(raw.length, 64);
    assert.equal(r.stdout.trim().length, 86);
    assert.equal(verify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw), true);
  }
});

// ---- entry ----
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { privateKey, spkiB64, fp: createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex") };
}
const payload = Buffer.from(W.buildPayload({ ...vectors[0], verdict: "pass" }));

test("entry: a good signature builds the imageKinds entry the Worker's parser accepts", () => {
  const k = testKey();
  const kms = JSON.stringify({ Signature: sign("sha256", payload, { key: k.privateKey, dsaEncoding: "der" }).toString("base64"), SigningAlgorithm: "ECDSA_SHA_256" });
  const e = C.buildEntry(payload, kms, "1", { spkiB64: k.spkiB64, trustedFps: [k.fp] });
  assert.deepEqual(Object.keys(e), ["kind", "verifiedBy", "checkVersion", "verifiedAt", "createdAt", "imageSize", "env", "checkSha256", "verdict", "keyFp", "sig"]);
  assert.equal(W.parseCustomerEntry(e).ok, true);
  assert.equal(e.keyFp, k.fp);
  assert.equal(verify("sha256", payload, { key: createPublicKey({ key: Buffer.from(k.spkiB64, "base64"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, W.decodeStoredSig(e.sig)), true);
});

test("entry: refusals", () => {
  const k = testKey(); const other = testKey();
  const goodSig = (key, msg = payload) => JSON.stringify({ Signature: sign("sha256", msg, { key, dsaEncoding: "der" }).toString("base64"), SigningAlgorithm: "ECDSA_SHA_256" });
  const opts = { spkiB64: k.spkiB64, trustedFps: [k.fp] };
  assert.throws(() => C.buildEntry(payload, goodSig(other.privateKey), "1", opts), /does not verify/);
  assert.throws(() => C.buildEntry(payload, goodSig(k.privateKey, Buffer.from("other")), "1", opts), /does not verify/);
  assert.throws(() => C.buildEntry(payload, goodSig(k.privateKey), "1", { spkiB64: k.spkiB64, trustedFps: ["0".repeat(64)] }), /TRUSTED_IMAGE_KEY_FPS/);
  assert.throws(() => C.buildEntry(payload, goodSig(k.privateKey), "01", opts), /check version/);
  assert.throws(() => C.buildEntry(Buffer.from(payload.toString().replace('"prod"', '"prod" ')), goodSig(k.privateKey), "1", opts));
  assert.throws(() => C.buildEntry(Buffer.concat([payload, Buffer.from("\n")]), goodSig(k.privateKey), "1", opts), /newline/);
  assert.throws(() => C.buildEntry(payload, JSON.stringify({ Signature: "AAAA" }), "1", opts));
});

// ---- image and server checks ----
const image = (over = {}) => JSON.stringify({ image: { id: 123456789, type: "snapshot", status: "available", deleted: null, description: "mcq-home-abcdef012345", created: "2026-10-22T07:40:28+00:00", image_size: 2.04, disk_size: 40, architecture: "x86", labels: { "murage/role": "image", "murage/env": "prod" }, ...over } });

test("image eligibility", () => {
  const ok = run(["check-image", "123456789", "prod"], image());
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "123456789\t2026-10-22T07:40:28+00:00\t2.04\tsnapshot\tavailable\tx86\t40\n");
  const no = [
    [image({ type: "system" }), "prod"], [image({ status: "creating" }), "prod"], [image({ deleted: "2026-10-22T00:00:00+00:00" }), "prod"],
    [image({ description: "other-1" }), "prod"], [image({ labels: { "murage/role": "image" } }), "prod"], [image({ labels: { "murage/role": "image", "murage/env": "staging" } }), "prod"],
    [image({ labels: { "murage/role": "image", "murage/env": "prod", "murage/image-kind": "staging-ops-ssh" } }), "prod"], [image({ description: "mcq-home-x-stagingssh" }), "prod"],
    [image({ image_size: null }), "prod"], [image({ image_size: 1e7 }), "prod"], [image({ created: "yesterday" }), "prod"], [image({ id: 5 }), "prod"], [image(), "production"],
  ];
  for (const [json, env] of no) assert.notEqual(run(["check-image", "123456789", env], json).status, 0, json.slice(0, 120));
});

test("server type pick and server list", () => {
  const types = JSON.stringify({ server_types: [
    { name: "cx-old", architecture: "x86", disk: 40, deprecation: { announced: "x" }, prices: [{ location: "fsn1", price_hourly: { gross: "0.001" } }] },
    { name: "cx-big", architecture: "x86", disk: 80, deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.01" } }] },
    { name: "cx-fit", architecture: "x86", disk: 40, deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.005" } }] },
    { name: "cx-small", architecture: "x86", disk: 20, deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.001" } }] },
    { name: "cax-fit", architecture: "arm", disk: 40, deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.004" } }] },
  ] });
  assert.equal(run(["pick-type", "x86", "40", "fsn1"], types).stdout.trim(), "cx-fit");
  assert.equal(run(["pick-type", "arm", "40", "fsn1"], types).stdout.trim(), "cax-fit");
  assert.notEqual(run(["pick-type", "x86", "400", "fsn1"], types).status, 0);
  const list = run(["list-servers"], JSON.stringify({ servers: [{ id: 7, name: "mv-verify-1", labels: { "murage/verify-run": "r1" } }, { id: 8, name: "x", labels: {} }] }));
  assert.equal(list.stdout, "7\tmv-verify-1\tr1\n8\tx\t-\n");
});

test("server type pick skips a type retired in the asked location only", () => {
  const price = (loc, gross) => ({ location: loc, price_hourly: { gross } });
  const types = JSON.stringify({ server_types: [
    { name: "cpx11", architecture: "x86", disk: 40, deprecation: null, prices: [price("fsn1", "0.0060"), price("ash", "0.0060")],
      locations: [{ name: "fsn1", deprecation: { announced: "2025-10-16T06:00:00Z", unavailable_after: "2025-12-31T23:59:59Z" } }, { name: "ash", deprecation: null }] },
    { name: "cx23", architecture: "x86", disk: 40, deprecation: null, prices: [price("fsn1", "0.0070"), price("ash", "0.0090")], locations: [{ name: "fsn1", deprecation: null }, { name: "ash", deprecation: null }] },
  ] });
  assert.equal(run(["pick-type", "x86", "40", "fsn1"], types).stdout.trim(), "cx23");
  assert.equal(run(["pick-type", "x86", "40", "ash"], types).stdout.trim(), "cpx11");
});
