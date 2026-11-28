// Rings B7 witnesses (designs/RINGS-DESIGN.md sections 5-6, B7). Owner: rings BUILD lane.
//
//   node --test scripts/release-rings.node-test.mjs
//
// Entry point: runRingOp, the function behind the fixed guard commands `release-guard.mjs ring-op` and
// `ring-publish-internal` (release.yml assemble `Ring operation` and `Name the published prerelease in the internal
// ring`), with the guard's own GitHub writers (ringWriters: promote flip, pinLatest, rings branch commit), and
// pinLatest behind `ring-op` RING_OP=pin-latest.
// GitHub is a recorded double holding releases, releases/latest, and the rings branch through the contents and git
// data APIs. Signing uses a TEST key made here; every manifest written is read back with the client's own parser
// (shared/rings-manifest.mjs + electron/update-signature.mjs verifyDetachedSignature) and that test key, and
// ringTarget says what a client in each ring would be offered. No token, network or release is used.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { runRingOp } from "./release-rings.mjs";
import * as guard from "./release-guard.mjs";
import { activeKills, parseRingsManifest, ringTarget } from "../shared/rings-manifest.mjs";
import { KILL_SWITCH_IDS } from "../shared/kill-switch-ids.mjs";
import { verifyDetachedSignature } from "../electron/update-signature.mjs";

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const packet = (tag, body) => Buffer.concat([Buffer.from([0xc0 | tag, 255]), u32(body.length), body]);
const mpi = (value) => {
  let b = Buffer.from(value);
  while (b.length && b[0] === 0) b = b.subarray(1);
  return Buffer.concat([u16(b.length ? (b.length - 1) * 8 + 32 - Math.clz32(b[0]) : 0), b]);
};
function armor(kind, bytes) {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  const check = Buffer.from([(crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]).toString("base64");
  return `-----BEGIN PGP ${kind}-----\n\n${bytes.toString("base64").match(/.{1,64}/g).join("\n")}\n=${check}\n-----END PGP ${kind}-----\n`;
}
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const body = Buffer.concat([Buffer.from([4]), u32(1700000000), Buffer.from([22, 9]), Buffer.from("2b06010401da470f01", "hex"), mpi(Buffer.concat([Buffer.from([0x40]), raw]))]);
  const fingerprint = createHash("sha1").update(Buffer.concat([Buffer.from([0x99]), u16(body.length), body])).digest();
  return { privateKey, fingerprint, publicKey: armor("PUBLIC KEY BLOCK", packet(6, body)) };
}
function signed(data, key) {
  const subpackets = Buffer.concat([Buffer.from([22, 33, 4]), key.fingerprint, Buffer.from([5, 2]), u32(1700000001)]);
  const prefix = Buffer.concat([Buffer.from([4, 0, 22, 8]), u16(subpackets.length), subpackets]);
  const digest = createHash("sha256").update(data).update(prefix).update(Buffer.concat([Buffer.from([4, 255]), u32(prefix.length)])).digest();
  const sig = sign(null, digest, key.privateKey);
  return armor("SIGNATURE", packet(2, Buffer.concat([prefix, u16(0), digest.subarray(0, 2), mpi(sig.subarray(0, 32)), mpi(sig.subarray(32))])));
}
const publisher = keypair();
const attacker = keypair();

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-28T10:00:00Z");
const FEEDS = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];

/** Recorded GitHub: releases by tag, releases/latest, and the rings branch (files + commit count). */
function github({ releases = {}, latest = "1.0.24", manifest = null, failRefUpdate = 0, beforeFlip = null, failFlip = false } = {}) {
  const state = { releases: {}, latest, files: {}, commits: 0, writes: [], patches: [], failRefUpdate, pending: {} };
  let id = 100;
  for (const [v, r] of Object.entries(releases)) state.releases[v] = { id: id++, tag_name: `v${v}`, draft: false, prerelease: false, assets: FEEDS.map((name) => ({ name, state: "uploaded", digest: `sha256:${"a".repeat(64)}` })), ...r };
  if (manifest) { const bytes = Buffer.from(JSON.stringify(manifest)); state.files["rings/rings.json"] = bytes; state.files["rings/rings.json.asc"] = Buffer.from(signed(bytes, publisher)); state.commits = 1; }
  const ok = (body) => ({ status: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}` });
  const missing = { status: 1, stdout: "HTTP/2.0 404 Not Found\r\n\r\n{}" };
  const byId = (rid) => Object.values(state.releases).find((r) => r.id === rid);
  const fields = (args) => args.filter((a) => /^[a-z_\][]+=/.test(a)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]);
  const run = (command, args) => {
    assert.equal(command, "gh");
    const method = args[args.indexOf("--method") + 1], endpoint = args.find((a) => a.startsWith("repos/"));
    if (method === "GET") {
      let m;
      if (endpoint.endsWith("/releases/latest")) return ok(state.releases[state.latest] ?? { tag_name: `v${state.latest}` });
      if ((m = /\/releases\/tags\/v(.+)$/.exec(endpoint))) return state.releases[m[1]] ? ok(state.releases[m[1]]) : missing;
      if ((m = /\/contents\/(.+)\?ref=(rings|commit\d+)$/.exec(endpoint))) return state.files[m[1]] ? ok({ encoding: "base64", content: state.files[m[1]].toString("base64") }) : missing;
      if (endpoint.endsWith("/git/ref/heads/rings")) return state.commits ? ok({ object: { sha: `commit${state.commits}` } }) : missing;
      if (/\/git\/commits\//.test(endpoint)) return ok({ tree: { sha: `tree${state.commits}` } });
      throw new Error(`unrecorded GET ${endpoint}`);
    }
    const f = fields(args);
    if (method === "PATCH" && /\/releases\/\d+$/.test(endpoint)) {
      const release = byId(Number(endpoint.split("/").at(-1)));
      if (beforeFlip && f.some(([k, v]) => k === "make_latest" && v === "true")) { const hook = beforeFlip; beforeFlip = null; hook(); }
      if (failFlip && f.some(([k, v]) => k === "make_latest" && v === "true")) return { status: 1, stderr: "HTTP 502", stdout: "" };
      state.patches.push([release.tag_name, Object.fromEntries(f)]);
      for (const [k, v] of f) {
        if (k === "prerelease") release.prerelease = v === "true";
        if (k === "make_latest" && v === "true") state.latest = release.tag_name.slice(1);
      }
      return { status: 0, stdout: "{}" };
    }
    if (method === "POST" && endpoint.endsWith("/git/blobs")) {
      const sha = `blob${Object.keys(state.pending).length}`;
      state.pending[sha] = Buffer.from(Object.fromEntries(f).content, "base64");
      return { status: 0, stdout: JSON.stringify({ sha }) };
    }
    if (method === "POST" && endpoint.endsWith("/git/trees")) {
      const paths = f.filter(([k]) => k === "tree[][path]").map(([, v]) => v), shas = f.filter(([k]) => k === "tree[][sha]").map(([, v]) => v);
      state.tree = Object.fromEntries(paths.map((p, i) => [p, state.pending[shas[i]]]));
      return { status: 0, stdout: JSON.stringify({ sha: "newtree" }) };
    }
    if (method === "POST" && endpoint.endsWith("/git/commits")) {
      state.newParent = Object.fromEntries(f)["parents[]"] ?? null;
      return { status: 0, stdout: JSON.stringify({ sha: "newcommit" }) };
    }
    if ((method === "PATCH" && endpoint.endsWith("/git/refs/heads/rings")) || (method === "POST" && endpoint.endsWith("/git/refs"))) {
      if (state.failRefUpdate-- > 0) return { status: 1, stderr: "HTTP 502", stdout: "" };
      // GitHub refuses a force=false update that is not a fast-forward of the current head.
      if ((state.newParent ?? null) !== (state.commits ? `commit${state.commits}` : null)) return { status: 1, stderr: "HTTP 422 Update is not a fast forward", stdout: "" };
      Object.assign(state.files, state.tree); state.commits += 1; state.writes.push(Object.keys(state.tree).sort());
      state.pending = {};
      return { status: 0, stdout: JSON.stringify({ ref: "refs/heads/rings" }) };
    }
    throw new Error(`unrecorded ${method} ${endpoint}`);
  };
  const apiGet = (endpoint, { allow404 = false } = {}) => {
    const result = run("gh", ["api", "--include", "--method", "GET", endpoint]);
    if (result.status !== 0) { if (allow404) return null; throw new Error("GitHub lookup failed (HTTP 404)"); }
    return JSON.parse(result.stdout.split("\r\n\r\n")[1]);
  };
  const checked = (command, args) => { const r = run(command, args); if (r.status !== 0) throw new Error(`${command} ${args[0]} failed`); return r.stdout; };
  const read = () => state.files["rings/rings.json"] && parseRingsManifest(state.files["rings/rings.json"], state.files["rings/rings.json.asc"].toString(), { publicKey: publisher.publicKey, verify: verifyDetachedSignature });
  return { state, read, run, deps: (now, key = publisher) => ({ apiGet, checked, run, now, publicKey: publisher.publicKey, sign: (bytes) => signed(bytes, key), writers: guard.ringWriters?.(run) }) };
}

const manifest = ({ seq = 10, internal = "1.0.25", beta = "1.0.24", all = "1.0.24", since = {}, halted = {}, kill = [] } = {}) => ({
  schema: 1, seq, issuedAt: new Date(T0 - HOUR).toISOString(), expiresAt: new Date(T0 + 71 * HOUR).toISOString(),
  rings: {
    internal: { version: internal, since: since.internal ?? new Date(T0).toISOString(), halted: halted.internal ?? false },
    beta: { version: beta, since: since.beta ?? new Date(T0 - 48 * HOUR).toISOString(), halted: halted.beta ?? false },
    all: { version: all, since: since.all ?? new Date(T0 - 96 * HOUR).toISOString(), halted: halted.all ?? false } },
  kill });
const RECEIPTS = ["BANNERGATE abc1234 1.0.25 PASS", "RING0-MAC 1.0.25 PASS", "RING0-WIN 1.0.25 PASS"];
const prerelease = { "1.0.25": { prerelease: true }, "1.0.24": {} };
const offered = (m, membership) => ringTarget(m, membership, T0 + 30 * HOUR);

test("B7(a) advance-beta on the same UTC date as internal.since is refused, nothing written", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ since: { internal: "2026-11-28T00:30:00Z" } }) });
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.25", receipts: RECEIPTS }, gh.deps(Date.parse("2026-11-28T21:00:00Z"))), /later UTC date/);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(b) advance-beta on a later date but under 20 h is refused", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ since: { internal: "2026-11-28T23:00:00Z" } }) });
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.25", receipts: RECEIPTS }, gh.deps(Date.parse("2026-11-29T10:00:00Z"))), /needs 20 h/);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(c) advance-beta with internal != v is refused", () => {
  const gh = github({ releases: { ...prerelease, "1.0.26": { prerelease: true } }, manifest: manifest() });
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.26", receipts: RECEIPTS.map((r) => r.replace("1.0.25", "1.0.26")) }, gh.deps(T0 + 30 * HOUR)), /internal holds 1\.0\.25, not 1\.0\.26/);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(d) advance-beta without the three PASS receipts naming v is refused", () => {
  const gh = github({ releases: prerelease, manifest: manifest() });
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.25", receipts: RECEIPTS.slice(0, 2) }, gh.deps(T0 + 30 * HOUR)), /RING0-WIN missing/);
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.25", receipts: [...RECEIPTS.slice(0, 2), "RING0-WIN 1.0.24 PASS"] }, gh.deps(T0 + 30 * HOUR)), /does not name 1\.0\.25/);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(e) advance-beta after the gates: one commit with both files; beta clients are offered v, all clients are not", () => {
  const gh = github({ releases: prerelease, manifest: manifest() });
  runRingOp("advance-beta", { version: "1.0.25", receipts: RECEIPTS }, gh.deps(T0 + 30 * HOUR));
  assert.deepEqual(gh.state.writes, [["rings/rings.json", "rings/rings.json.asc"]]);
  const m = gh.read();
  assert.equal(m.seq, 11);
  assert.equal(offered(m, { beta: true }), "1.0.25");
  assert.equal(offered(m, {}), "1.0.24");
  assert.equal(m.expiresAt, T0 + 30 * HOUR + 72 * HOUR);
});

test("B7(f) promote-all with beta != v is refused (beta.since belongs to an older version); GitHub is not flipped", () => {
  const gh = github({ releases: prerelease, manifest: manifest() }); // beta still holds 1.0.24 since 2 days ago
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR)), /beta holds 1\.0\.24, not 1\.0\.25/);
  assert.equal(gh.state.latest, "1.0.24");
  assert.deepEqual(gh.state.patches, []);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(g) promote-all after beta's day flips GitHub latest to v, then names v for all", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ beta: "1.0.25", since: { beta: new Date(T0).toISOString() } }) });
  runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR));
  assert.equal(gh.state.latest, "1.0.25");
  assert.equal(gh.state.releases["1.0.25"].prerelease, false);
  assert.equal(offered(gh.read(), {}), "1.0.25");
});

test("B7(h) promote-all partial failure (flip done, manifest write failed) re-runs idempotently", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ beta: "1.0.25", since: { beta: new Date(T0).toISOString() } }), failRefUpdate: 1 });
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR)), /failed/);
  assert.equal(gh.state.latest, "1.0.25");
  assert.equal(gh.read().rings.all.version, "1.0.24", "the failed half left the manifest as it was");
  runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 31 * HOUR));
  assert.equal(gh.state.patches.length, 1, "the re-run does not flip GitHub a second time");
  assert.equal(gh.read().rings.all.version, "1.0.25");
  assert.equal(runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 32 * HOUR)), null, "a third run has nothing to do");
});

test("B7(i) halt beta pins beta and all to the previous version; no beta or all client is offered the bad one", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ beta: "1.0.25", since: { beta: new Date(T0).toISOString() } }) });
  runRingOp("halt", { ring: "beta", version: "1.0.25", previous: "1.0.24" }, gh.deps(T0 + 2 * HOUR));
  const m = gh.read();
  assert.equal(offered(m, { beta: true }), "1.0.24");
  assert.deepEqual([m.rings.beta.halted, m.rings.all.halted, m.rings.internal.halted], [true, true, false]);
  assert.equal(m.rings.internal.version, "1.0.25", "halting beta leaves the narrower internal ring alone");
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR)), /open halt/);
});

test("B7(j) halt all after D2 also pins GitHub latest back to the previous release", () => {
  const gh = github({ releases: { "1.0.25": { prerelease: false }, "1.0.24": {} }, latest: "1.0.25", manifest: manifest({ beta: "1.0.25", all: "1.0.25" }) });
  runRingOp("halt", { ring: "all", version: "1.0.25", previous: "1.0.24" }, gh.deps(T0 + 2 * HOUR));
  assert.equal(gh.state.latest, "1.0.24");
  assert.equal(gh.state.releases["1.0.25"].prerelease, true);
  assert.equal(offered(gh.read(), {}), "1.0.24");
});

test("B7(k) resign keeps the content: same rings and kills, seq+1, a new 72 h window", () => {
  const kill = [{ id: "memory.capture", versions: ">=1.0.25 <1.0.26", code: "kill-data" }];
  const gh = github({ manifest: manifest({ kill, halted: { all: true } }) });
  const before = gh.read();
  runRingOp("resign", {}, gh.deps(T0 + 24 * HOUR));
  const m = gh.read();
  assert.equal(m.seq, before.seq + 1);
  assert.deepEqual(m.rings, before.rings);
  assert.deepEqual(m.kill, before.kill);
  assert.equal(m.expiresAt, T0 + 24 * HOUR + 72 * HOUR);
});

test("B7(l) kill takes only a registered id and a fixed code; the kill reaches the covered version only", () => {
  const gh = github({ manifest: manifest() });
  assert.throws(() => runRingOp("kill", { id: "memory.everything", versions: ">=1.0.25 <1.0.26", code: "kill-safety" }, gh.deps(T0)), /unknown kill id/);
  assert.throws(() => runRingOp("kill", { id: "memory.capture", versions: ">=1.0.25 <1.0.26", code: "customer asked" }, gh.deps(T0)), /never free text/);
  assert.equal(gh.state.writes.length, 0);
  runRingOp("kill", { id: "memory.capture", versions: ">=1.0.25 <1.0.26", code: "kill-safety" }, gh.deps(T0));
  const m = gh.read();
  assert.deepEqual(activeKills(m, "1.0.25", KILL_SWITCH_IDS), ["memory.capture"]);
  assert.deepEqual(activeKills(m, "1.0.26", KILL_SWITCH_IDS), []);
});

test("B7(m) publish-internal: the first manifest names v for internal only, and only for a published prerelease", () => {
  const draft = github({ releases: { "1.0.25": { draft: true, prerelease: true }, "1.0.24": {} } });
  assert.throws(() => runRingOp("publish-internal", { version: "1.0.25" }, draft.deps(T0)), /not a published release/);
  const latest = github({ releases: { "1.0.25": { prerelease: false }, "1.0.24": {} } });
  assert.throws(() => runRingOp("publish-internal", { version: "1.0.25" }, latest.deps(T0)), /not a prerelease/);
  const gh = github({ releases: prerelease });
  runRingOp("publish-internal", { version: "1.0.25" }, gh.deps(T0));
  const m = gh.read();
  assert.equal(offered(m, { internal: true }), "1.0.25");
  assert.equal(offered(m, { beta: true }), "1.0.24");
  assert.equal(offered(m, {}), "1.0.24");
});

test("B7(n) a manifest signed by any key but the pinned one is never written", () => {
  const gh = github({ manifest: manifest() });
  assert.throws(() => runRingOp("resign", {}, gh.deps(T0, attacker)), /refused signature/);
  assert.equal(gh.state.writes.length, 0);
});

test("B7(o) promote-all of the bootstrap version needs Sean's board line, and runs on internal's day", () => {
  const gh = github({ releases: prerelease, manifest: manifest() });
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25", bootstrap: "MAIN-RULING rings bootstrap 1.0.25" }, gh.deps(T0 + 30 * HOUR)), /SEAN YES rings bootstrap/);
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25", bootstrap: "MAIN-RULING 2026-11-29 SEAN YES rings bootstrap 1.0.25" }, gh.deps(T0 + 2 * HOUR)), /later UTC date/);
  runRingOp("promote-all", { version: "1.0.25", bootstrap: "MAIN-RULING 2026-11-29 SEAN YES rings bootstrap 1.0.25" }, gh.deps(T0 + 30 * HOUR));
  assert.equal(offered(gh.read(), {}), "1.0.25");
});

test("B7(p) resume clears the halt and does not advance; a halted ring is never advanced", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ halted: { beta: true, all: true } }) });
  assert.throws(() => runRingOp("advance-beta", { version: "1.0.25", receipts: RECEIPTS }, gh.deps(T0 + 30 * HOUR)), /halted ring is never advanced/);
  runRingOp("resume", { ring: "beta" }, gh.deps(T0 + 30 * HOUR));
  const m = gh.read();
  assert.equal(m.rings.beta.halted, false);
  assert.equal(m.rings.beta.version, "1.0.24");
});

test("B6(pin-latest) the bad release goes back to prerelease and the previous one is latest", () => {
  const gh = github({ releases: { "1.0.25": {}, "1.0.24": {} }, latest: "1.0.25" });
  guard.pinLatest("1.0.25", "1.0.24", gh.run);
  assert.equal(gh.state.latest, "1.0.24");
  assert.equal(gh.state.releases["1.0.25"].prerelease, true);
});

test("B7(q) halt writes the signed halt before pin-latest: a pin-latest failure still leaves the ring halted", () => {
  // r5: previous must now be a promoted release (B7(w)), so pin-latest fails at GitHub's flip instead (HTTP 502).
  const gh = github({ releases: { "1.0.25": { prerelease: false }, "1.0.24": {} }, latest: "1.0.25", failFlip: true, manifest: manifest({ beta: "1.0.25", all: "1.0.25" }) });
  assert.throws(() => runRingOp("halt", { ring: "all", version: "1.0.25", previous: "1.0.24" }, gh.deps(T0 + 2 * HOUR)), /gh api failed/);
  assert.equal(gh.read()?.rings.all.halted, true, "the halt must not depend on the GitHub latest flip");
});

test("B7(r) promote-all signs before the GitHub flip: a manifest the pinned key refuses leaves latest unchanged", () => {
  const gh = github({ releases: prerelease, manifest: manifest({ beta: "1.0.25", since: { beta: new Date(T0).toISOString() } }) });
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR, attacker)), /refused signature/);
  assert.equal(gh.state.latest, "1.0.24", "a failed signature must not make the release latest for pre-ring clients");
});

test("B7(s) re-running promote-all after a pin-latest does not make the pinned-back release latest again", () => {
  const gh = github({ releases: { "1.0.25": { prerelease: true }, "1.0.24": {} }, latest: "1.0.24", manifest: manifest({ beta: "1.0.25", all: "1.0.25", since: { beta: new Date(T0).toISOString() } }) });
  assert.equal(runRingOp("promote-all", { version: "1.0.25" }, gh.deps(T0 + 30 * HOUR)), null);
  assert.equal(gh.state.latest, "1.0.24", "promote-all with nothing to do must not touch GitHub");
});

test("B7(t) a promote racing a halt never overwrites it, and latest goes back to the signed all target", () => {
  // The halt runs to completion after promote-all read the manifest and before its GitHub flip.
  const racing = github({ releases: prerelease, manifest: manifest({ beta: "1.0.25", since: { beta: new Date(T0).toISOString() } }),
    beforeFlip: () => runRingOp("halt", { ring: "beta", version: "1.0.25", previous: "1.0.24" }, racing.deps(T0 + 30 * HOUR)) });
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, racing.deps(T0 + 30 * HOUR)), /failed/);
  const m = racing.read();
  assert.equal(m.rings.beta.halted, true, "the stale promote must not overwrite the halt");
  assert.equal(offered(m, {}), "1.0.24");
  assert.equal(racing.state.latest, "1.0.24", "pre-ring clients must not be left on the halted release");
});

test("B7(u) a standalone pin-latest never makes a D0 prerelease (or a newer release) latest", () => {
  const gh = github({ releases: { "1.0.26": { prerelease: true }, "1.0.25": {}, "1.0.24": {} }, latest: "1.0.25" });
  assert.throws(() => guard.pinLatest("1.0.25", "1.0.26", gh.run), /must be older/);
  const pre = github({ releases: { "1.0.25": {}, "1.0.24": { prerelease: true } }, latest: "1.0.25" });
  assert.throws(() => guard.pinLatest("1.0.25", "1.0.24", pre.run), /is a prerelease/);
  assert.equal(pre.state.latest, "1.0.25");
  assert.deepEqual(pre.state.patches, []);
});

test("B7(v) the race recovery restores the release that was latest before the flip, even when all's target was rolled back", () => {
  // A standalone pin-latest moved latest 1.0.24 -> 1.0.23 earlier, so the signed all target 1.0.24 is now a prerelease.
  // r5: the racing halt names the promoted 1.0.23 as previous (a halt never pins to a prerelease, B7(w)).
  const releases = { "1.0.25": { prerelease: true }, "1.0.24": { prerelease: true }, "1.0.23": {} };
  const racing = github({ releases, latest: "1.0.23", manifest: manifest({ beta: "1.0.25", all: "1.0.24", since: { beta: new Date(T0).toISOString() } }),
    beforeFlip: () => runRingOp("halt", { ring: "beta", version: "1.0.25", previous: "1.0.23" }, racing.deps(T0 + 30 * HOUR)) });
  assert.throws(() => runRingOp("promote-all", { version: "1.0.25" }, racing.deps(T0 + 30 * HOUR))); // fails red, any reason
  assert.equal(racing.read().rings.beta.halted, true, "the racing halt must have landed (else this row proves nothing)");
  assert.equal(racing.state.latest, "1.0.23", "pre-ring clients must not be left on the halted release");
});

test("B7(w) halt refuses a previous that is not a promoted release before anything is signed or written", () => {
  // Astra + Opus 4222cd33ed High: halt signed `previous` into every halted ring (all included) with only an
  // older-than check, so a D0 prerelease, a draft or a missing tag became the ring target before D2.
  for (const [label, releases] of [
    ["a D0 prerelease", { "1.0.25": { prerelease: true }, "1.0.24": { prerelease: true } }],
    ["a draft", { "1.0.25": { prerelease: true }, "1.0.24": { draft: true } }],
    ["a missing tag", { "1.0.25": { prerelease: true } }],
    ["a promoted release without its feeds", { "1.0.25": { prerelease: true }, "1.0.24": { assets: [] } }],
  ]) {
    const gh = github({ releases, latest: "1.0.23", manifest: manifest({ beta: "1.0.25", all: "1.0.25", since: { beta: new Date(T0).toISOString() } }) });
    const deps = gh.deps(T0 + 2 * HOUR), sign = deps.sign;
    let signatures = 0;
    deps.sign = (bytes) => { signatures += 1; return sign(bytes); };
    assert.throws(() => runRingOp("halt", { ring: "beta", version: "1.0.25", previous: "1.0.24" }, deps), /v1\.0\.24 is (?:not a published release|a prerelease)|v1\.0\.24 has no uploaded|GitHub lookup failed/, label);
    assert.deepEqual(gh.state.writes, [], `${label}: nothing written`);
    assert.equal(signatures, 0, `${label}: nothing signed`);
    assert.equal(gh.read().rings.all.version, "1.0.25", `${label}: all keeps its signed target`);
  }
});
