// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LegFailure, runLeg } from "./leg.mjs";
import { QualError, writeExcl } from "./qual.mjs";
import { bytes, fixture, h, OS_A, OS_B, s1Receipt, s2Receipt, s3Receipt, s4Receipt } from "./qual-fixture.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const made = [];
const fx = (...args) => { const f = fixture(...args); made.push(f.base); return f; };
afterEach(() => { for (const dir of made.splice(0)) safeWipeSync(dir); });

const code = async (promise) => { try { await promise; } catch (error) { if (error instanceof QualError) return error.code; throw error; } return "OK"; };
const rec = (q, spike, target, g, receipt, gen = g) => q.record({ spike, target, gen, receipt: bytes(receipt) });
const gate = (f, args) => f.open({ legs: ["mac-a"] }).gate(args);
const files = (f, root, sub) => (existsSync(join(f.roots[root], sub)) ? readdirSync(join(f.roots[root], sub)).sort() : []);

async function s3Request(f, target = "mac-a", os = OS_A) {
  const n = f.preflight(target, os);
  return f.q.request({ spike: "S3", target, os: n, release: "m1" });
}

it("W1 a receipt for a superseded generation is STALE_RECEIPT and the key follows the newest request", async () => {
  const f = fx();
  await s3Request(f);
  await s3Request(f);
  expect(await code(rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1)))).toBe("STALE_RECEIPT");
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("PENDING");
  expect(files(f, 0, "S3-mac-a")).not.toContain("1.result.json");
});

it("W1b a receipt whose fence differs from the request's is FENCE_MISMATCH and stores nothing", async () => {
  const f = fx();
  await s3Request(f);
  const asset = s3Receipt(f, "mac-a", 1);
  asset.fence = { ...asset.fence, n_asset_sha256: h("other") };
  const probe = s3Receipt(f, "mac-a", 1);
  probe.fence = { ...probe.fence, probe_sha256: h("probe-edited") };
  expect(await code(rec(f.q, "S3", "mac-a", 1, asset))).toBe("FENCE_MISMATCH");
  expect(await code(rec(f.q, "S3", "mac-a", 1, probe))).toBe("FENCE_MISMATCH");
  expect(files(f, 0, "S3-mac-a")).toEqual(["1.req.json"]);
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("PENDING");
});

it("W1c a receipt for another key or generation is WRONG_KEY: nothing stored, no observation appended", async () => {
  const f = fx();
  await s3Request(f, "mac-a");
  await s3Request(f, "mac-b");
  const before = files(f, 0, "os/mac-a");
  expect(await code(rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-b", 1), 1))).toBe("WRONG_KEY");
  const gen2 = s3Receipt(f, "mac-a", 1, { os: OS_B });
  gen2.gen = 2;
  expect(await code(f.q.record({ spike: "S3", target: "mac-a", gen: 1, receipt: bytes(gen2) }))).toBe("WRONG_KEY");
  expect(files(f, 0, "S3-mac-a")).toEqual(["1.req.json"]);
  expect(files(f, 0, "os/mac-a")).toEqual(before);
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("PENDING");
});

it("W2 a proof goes STALE when the asset it proved changes", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  expect((await gate(f, { for: "post", manifest: "m1" })).keys.find((k) => k.key === "S3-mac-a").state).toBe("PROVEN");
  f.table.m1 = { n1: h("n1-asset"), n: h("moved") };
  const moved = await f.q.keyState("S3", "mac-a", { release: "m1" });
  expect(moved.state).toBe("STALE");
  expect((await gate(f, { for: "post", manifest: "m1" })).exit).toBe(2);
});

it("W3 an unreadable public digest makes the fence UNKNOWN: the key is STALE and the gate shut", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  const unreadable = f.open({ legs: ["mac-a"], fences: { async components() { return { components: { n_asset_sha256: null, probe_sha256: h("probe-S3"), validator_sha256: h("validator-S3") }, nSha256: null }; } } });
  const state = await unreadable.keyState("S3", "mac-a", { release: "m1" });
  expect(state).toMatchObject({ state: "STALE", reason: "UNKNOWN" });
  expect((await unreadable.gate({ for: "post", manifest: "m1" })).exit).toBe(2);
});

it("W4 a second different result is CONFLICT, an identical re-record is a no-op, a crash temp is ignored", async () => {
  const f = fx();
  await s3Request(f);
  const proven = s3Receipt(f, "mac-a", 1);
  expect((await rec(f.q, "S3", "mac-a", 1, proven)).state).toBe("PROVEN");
  expect((await rec(f.q, "S3", "mac-a", 1, proven)).noop).toBe(true);
  const dir = join(f.base, "excl");
  expect(writeExcl(dir, "1.result.json", "first", "result")).toBe("created");
  expect(writeExcl(dir, "1.result.json", "second", "result")).toBe("exists");
  expect(readFileSync(join(dir, "1.result.json"), "utf8")).toBe("first");
  const failed = s3Receipt(f, "mac-a", 1, { body: { exit_ms: 90000 } });
  expect(await code(rec(f.q, "S3", "mac-a", 1, failed))).toBe("CONFLICT");
  expect(JSON.parse(readFileSync(join(f.roots[0], "S3-mac-a", "1.result.json"), "utf8")).state).toBe("PROVEN");
  const g = await s3Request(f);
  writeFileSync(join(f.roots[0], "S3-mac-a", `.${g.g}.result.tmp-99`), JSON.stringify({ spike: "S3", target: "mac-a", g: g.g, state: "PROVEN", reason: null, receipt_sha256: h("x") }));
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("PENDING");
  f.q.sweep();
  expect(files(f, 0, "S3-mac-a").some((name) => name.includes(".tmp-"))).toBe(false);
});

it("W4b sweeps on both replicas expire identically and reconcile before expiring", async () => {
  const f = fx();
  await s3Request(f);
  f.clock.t += 2 * 3600e3;
  f.q.sweep();
  f.clock.t += 60e3;
  const later = f.open();
  later.sweep();
  // same canonical result, different metadata (written-at): never INVALID
  const body = JSON.parse(readFileSync(join(f.roots[1], "S3-mac-a", "1.result.json"), "utf8"));
  writeFileSync(join(f.roots[1], "S3-mac-a", "1.result.json"), `${JSON.stringify({ ...body, written_at: "2026-12-01T23:59:59.000Z", host: "hz" })}\n`);
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).not.toBe("INVALID");
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" }))).toMatchObject({ state: "INCOMPLETE", reason: "TIMEOUT" });
  const g = await s3Request(f);
  await rec(f.q, "S3", "mac-a", g.g, s3Receipt(f, "mac-a", g.g));
  rmSync(join(f.roots[1], "S3-mac-a", `${g.g}.result.json`));
  f.clock.t += 2 * 3600e3;
  f.open().sweep();
  expect(files(f, 1, "S3-mac-a")).toContain(`${g.g}.result.json`);
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).not.toBe("INVALID");
  expect(JSON.parse(readFileSync(join(f.roots[1], "S3-mac-a", `${g.g}.result.json`), "utf8")).state).toBe("PROVEN");
});

it("W5 record checks the deadline itself: a late receipt is STALE_RECEIPT with or without a sweep", async () => {
  const f = fx();
  await s3Request(f);
  f.clock.t += 2 * 3600e3;
  expect(await code(rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1)))).toBe("STALE_RECEIPT");
  f.q.sweep();
  expect(await code(rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1)))).toBe("STALE_RECEIPT");
  expect(JSON.parse(readFileSync(join(f.roots[0], "S3-mac-a", "1.result.json"), "utf8"))).toMatchObject({ state: "INCOMPLETE", reason: "TIMEOUT" });
});

it("W6 replicas that disagree, or two requests with different fences, are INVALID", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  const other = JSON.parse(readFileSync(join(f.roots[1], "S3-mac-a", "1.result.json"), "utf8"));
  writeFileSync(join(f.roots[1], "S3-mac-a", "1.result.json"), JSON.stringify({ ...other, state: "FAILED", reason: "NO_GRACEFUL_QUIT" }));
  expect(await f.q.keyState("S3", "mac-a", { release: "m1" })).toMatchObject({ state: "INVALID" });
  expect((await gate(f, { for: "post", manifest: "m1" })).exit).toBe(2);
  const g = fx();
  await s3Request(g);
  const req = JSON.parse(readFileSync(join(g.roots[1], "S3-mac-a", "1.req.json"), "utf8"));
  writeFileSync(join(g.roots[1], "S3-mac-a", "1.req.json"), JSON.stringify({ ...req, fence: { ...req.fence, probe_sha256: h("different") } }));
  expect((await g.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("INVALID");
});

it("W6b an unreachable replica shuts the gate, refuses writes, and the hz sweep skips quietly", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  rmSync(f.roots[0], { recursive: true });
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("INVALID");
  expect((await gate(f, { for: "post", manifest: "m1" })).exit).toBe(2);
  const before = files(f, 1, "S3-mac-a");
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", os: 1, release: "m1" }))).toBe("REPLICA_UNREACHABLE");
  expect(files(f, 1, "S3-mac-a")).toEqual(before);
  f.clock.t += 5 * 3600e3;
  expect(f.q.sweep()).toMatchObject({ skipped: true, written: [] });
  f.q.sweep();
  expect(f.logs.filter((line) => line === "SWEEP_SKIPPED_PEER")).toHaveLength(1);
  expect(files(f, 1, "S3-mac-a")).toEqual(before);
});

it("W15 the gate is one exit for the whole entry; a leg PREFLIGHT that finds its proof stale is held", async () => {
  const f = fx();
  const pre = async () => f.open({ legs: ["mac-a", "win-a"] }).gate({ for: "pre", manifest: "m1", legs: [] });
  for (const target of ["mac-a", "win-a"]) {
    await s3Request(f, target, target === "win-a" ? { name: "windows", build: "10.0.26100.1" } : OS_A);
    await rec(f.q, "S3", target, 1, s3Receipt(f, target, 1, target === "win-a" ? { os: { name: "windows", build: "10.0.26100.1" } } : {}));
  }
  const result = await pre();
  expect(result.exit).toBe(2);
  expect(result.bad.map((k) => `${k.key}:${k.state}`)).toEqual(["S2-linux-box:PENDING"]);
  // S2 PROVEN but the box kernel moved: the key is STALE.
  const box = { name: "linux", build: "6.8.0" };
  const n = f.preflight("linux-box", box);
  await f.q.request({ spike: "S2", target: "linux-box", os: n });
  await rec(f.q, "S2", "linux-box", 1, s2Receipt(f, 1));
  expect((await pre()).exit).toBe(0);
  f.preflight("linux-box", { name: "linux", build: "6.9.0" });
  expect((await pre()).bad.map((k) => k.state)).toEqual(["STALE"]);
});

const goodSnapshot = () => ({
  ruleset: { target: "tag", enforcement: "active", conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    bypass_actors: [{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }],
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }] },
  immutableReleases: true, ownerId: 7, principals: [{ kind: "user", id: 7, permission: "admin" }],
  orgBasePermission: "read", orgRulesets: [], deployKeys: [], installations: [],
});

it("W15 flip needs S1, S3, S2 and S4 PROVEN plus a clean live snapshot; a caller cannot narrow the leg list", async () => {
  const f = fx();
  const flip = (snapshot, instance = f.open({ legs: ["mac-a"] })) => instance.gate({ for: "flip", manifest: "m1", legs: [] }, { fetchSnapshot: async () => snapshot, appId: 42 });
  const n = f.preflight("mac-a");
  await f.q.request({ spike: "S3", target: "mac-a", os: n, release: "m1" });
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  await f.q.request({ spike: "S1", target: "mac-a", os: n, release: "m1" });
  await rec(f.q, "S1", "mac-a", 1, s1Receipt(f, "mac-a", 1));
  await f.q.request({ spike: "S4", target: "gh" });
  await rec(f.q, "S4", "gh", 1, s4Receipt(f, 1));
  const box = f.preflight("linux-box", { name: "linux", build: "6.8.0" });
  const missingS2 = await flip(goodSnapshot());
  expect(missingS2.exit).toBe(2);
  expect(missingS2.bad.map((k) => `${k.key}:${k.state}`)).toEqual(["S2-linux-box:PENDING"]);
  await f.q.request({ spike: "S2", target: "linux-box", os: box });
  await rec(f.q, "S2", "linux-box", 1, s2Receipt(f, 1));
  expect((await flip(goodSnapshot())).exit).toBe(0);
  const drift = goodSnapshot();
  drift.immutableReleases = false;
  expect(await flip(drift)).toMatchObject({ exit: 2, boundary: "immutable" });
  const unverified = goodSnapshot();
  delete unverified.orgBasePermission;
  expect((await flip(unverified)).exit).toBe(2);
  expect((await f.q.gate({ for: "post", manifest: "m1", legs: [] })).keys.length).toBeGreaterThan(0);
  expect(() => f.open({ legs: [] })).toThrow("ARGS");
});

it("W15 row 3/4: a leg PREFLIGHT whose OS build differs from the proof is INCOMPLETE(QUAL_STALE); a failed append is QUAL_UNVERIFIED", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  let ranStale = false;
  const stale = await runLeg({
    phase: "latest", attempt: 1, restore: async () => {},
    preflight: () => f.q.legPreflight({ target: "mac-a", os: OS_B, relies: [["S3", "mac-a"]], args: { release: "m1" } }),
    work: async () => { ranStale = true; },
  });
  expect(stale).toMatchObject({ verdict: "INCOMPLETE", reason: "QUAL_STALE", latest_state: "held" });
  expect(ranStale).toBe(false);
  const g = fx();
  await s3Request(g);
  await rec(g.q, "S3", "mac-a", 1, s3Receipt(g, "mac-a", 1));
  rmSync(g.roots[1], { recursive: true });
  let ran = false;
  const unverified = await runLeg({
    phase: "latest", attempt: 1, restore: async () => {},
    preflight: () => g.q.legPreflight({ target: "mac-a", os: OS_A, relies: [["S3", "mac-a"]], args: { release: "m1" } }),
    work: async () => { ran = true; },
  });
  expect(unverified).toMatchObject({ verdict: "INCOMPLETE", reason: "QUAL_UNVERIFIED", latest_state: "held" });
  expect(ran).toBe(false);
  expect(new LegFailure("QUAL_STALE", "PREFLIGHT").stage).toBe("PREFLIGHT");
});

it("W17 the fence binds the OS the probe OBSERVED, and observations are ordered by n, never by clock", async () => {
  const f = fx();
  await s3Request(f);
  expect(await code(rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1, { os: OS_B })))).toBe("FENCE_MISMATCH");
  expect(f.q.currentOs("mac-a")).toMatchObject({ os: OS_B });
  expect(files(f, 0, "S3-mac-a")).toEqual(["1.req.json"]);
  // PROVEN at B (current), then a leg PREFLIGHT sees B on one replica only: STALE.
  const g = fx();
  await s3Request(g);
  await rec(g.q, "S3", "mac-a", 1, s3Receipt(g, "mac-a", 1));
  writeFileSync(join(g.roots[1], "os", "mac-a", "2.obs.json"), JSON.stringify({ target: "mac-a", n: 2, recorded_utc: "2026-12-01T10:30:00.000Z", os_name: "macos", build: "14.6" }));
  expect((await g.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("STALE");
  // S2 stays PROVEN while a linux-vm preflight sees another kernel (different target).
  const h2 = fx();
  const box = h2.preflight("linux-box", { name: "linux", build: "6.8.0" });
  await h2.q.request({ spike: "S2", target: "linux-box", os: box });
  await rec(h2.q, "S2", "linux-box", 1, s2Receipt(h2, 1));
  h2.preflight("linux-vm", { name: "linux", build: "6.9.9" });
  expect((await h2.q.keyState("S2", "linux-box", {})).state).toBe("PROVEN");
});

it("W17 a target clock a day ahead cannot order observations; same n with different builds or a bad file is INVALID; temps are ignored", async () => {
  const f = fx();
  f.preflight("mac-a", OS_A);
  const skew = JSON.parse(readFileSync(join(f.roots[0], "os", "mac-a", "1.obs.json"), "utf8"));
  f.preflight("mac-a", OS_B);
  writeFileSync(join(f.roots[0], "os", "mac-a", "3.obs.json"), JSON.stringify({ ...skew, n: 3, build: "14.7", target_utc: "2027-01-01T00:00:00Z", recorded_utc: "2026-11-30T00:00:00.000Z" }));
  writeFileSync(join(f.roots[1], "os", "mac-a", "3.obs.json"), JSON.stringify({ ...skew, n: 3, build: "14.7", recorded_utc: "2026-11-30T00:00:00.000Z" }));
  expect(f.q.currentOs("mac-a")).toMatchObject({ os: { build: "14.7" } });
  writeFileSync(join(f.roots[1], "os", "mac-a", "4.obs.json"), "{not json");
  expect(f.q.currentOs("mac-a").state).toBe("INVALID");
  rmSync(join(f.roots[1], "os", "mac-a", "4.obs.json"));
  writeFileSync(join(f.roots[0], "os", "mac-a", ".4.obs.tmp-1"), "{cut");
  expect(f.q.currentOs("mac-a").state).toBe("OK");
  writeFileSync(join(f.roots[1], "os", "mac-a", "3.obs.json"), JSON.stringify({ ...skew, n: 3, build: "15.0", recorded_utc: "2026-11-30T00:00:00.000Z" }));
  expect(f.q.currentOs("mac-a").state).toBe("INVALID");
});

it("W17 (Fable M1) a late receipt never revives a proof: no observation is appended behind a newer one", async () => {
  const f = fx();
  await s3Request(f);
  f.preflight("mac-a", OS_B);
  const late = await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  expect(late.state).toBe("PROVEN");
  expect(files(f, 0, "os/mac-a")).toEqual(["1.obs.json", "2.obs.json"]);
  expect(f.q.currentOs("mac-a")).toMatchObject({ os: OS_B });
  expect((await f.q.keyState("S3", "mac-a", { release: "m1" })).state).toBe("STALE");
  const stale = fx();
  await s3Request(stale);
  await s3Request(stale);
  stale.preflight("mac-a", OS_B);
  expect(await code(rec(stale.q, "S3", "mac-a", 1, s3Receipt(stale, "mac-a", 1, { os: { name: "macos", build: "13.9" } })))).toBe("STALE_RECEIPT");
  expect(stale.q.currentOs("mac-a")).toMatchObject({ os: OS_B });
});

it("W19 plan computes every fence fresh and lists a key whose asset moved", async () => {
  const f = fx();
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  expect((await f.open({ legs: ["mac-a"] }).plan({ manifest: "m1" })).map((k) => k.key)).not.toContain("S3-mac-a");
  f.table.m1 = { n1: h("n1-asset"), n: h("moved") };
  expect((await f.open({ legs: ["mac-a"] }).plan({ manifest: "m1" })).map((k) => k.key)).toContain("S3-mac-a");
});

it("W20 a replica root inside a git work tree or a lane job dir is ROOT_IN_TREE and nothing is written", async () => {
  const outer = mkdtempSync(join(tmpdir(), "canary-root-"));
  made.push(outer);
  const tree = join(outer, "work");
  mkdirSync(join(tree, ".git"), { recursive: true });
  const lane = join(outer, "swarm-b", "lane-x", "ledger");
  mkdirSync(lane, { recursive: true });
  const ok = join(outer, "plain");
  mkdirSync(ok);
  const opened = (root) => { try { fx().open({ roots: [root, ok] }); } catch (error) { return error.code; } return "OPEN"; };
  mkdirSync(join(tree, "ledger"));
  expect(opened(join(tree, "ledger"))).toBe("ROOT_IN_TREE");
  expect(opened(lane)).toBe("ROOT_IN_TREE");
  expect(readdirSync(join(tree, "ledger"))).toEqual([]);
  expect(opened(ok)).toBe("OPEN");
});

it("request refuses ARGS, UNKNOWN fences, stale preflights and free-text metadata without burning a generation", async () => {
  const f = fx();
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", release: "m1", os: 1 }))).toBe("PREFLIGHT");
  const n = f.preflight("mac-a");
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", os: n }))).toBe("ARGS");
  expect(await code(f.q.request({ spike: "S3", target: "linux-box", os: n, release: "m1" }))).toBe("ARGS");
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", os: n, release: "m1", requester: "canary-user" }))).toBe("UNTYPED_FIELD");
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", os: n, release: "m1", host: "canary-box-1" }))).toBe("UNTYPED_FIELD");
  f.clock.t += 61 * 60e3;
  expect(await code(f.q.request({ spike: "S3", target: "mac-a", os: n, release: "m1" }))).toBe("PREFLIGHT");
  expect(files(f, 0, "S3-mac-a")).toEqual([]);
  const g = fx();
  const gn = g.preflight("mac-a");
  const nodigest = g.open({ fences: { async components() { return { components: { n_asset_sha256: null, probe_sha256: h("p"), validator_sha256: h("v") }, hint: "asset has no public digest" }; } } });
  expect(await code(nodigest.request({ spike: "S3", target: "mac-a", os: gn, release: "m1" }))).toBe("FENCE_UNKNOWN");
  expect(files(g, 0, "S3-mac-a")).toEqual([]);
});

it("gate shapes: pre/post/flip/build need their keys; S1 and S4 PROVEN keys read back", async () => {
  const f = fx();
  const n = f.preflight("mac-a");
  await f.q.request({ spike: "S1", target: "mac-a", os: n, release: "m1" });
  expect(await code(rec(f.q, "S1", "mac-a", 1, s1Receipt(f, "mac-a", 1)))).toBe("OK");
  expect((await f.q.keyState("S1", "mac-a", { release: "m1" })).state).toBe("PROVEN");
  await f.q.request({ spike: "S4", target: "gh" });
  await rec(f.q, "S4", "gh", 1, s4Receipt(f, 1));
  expect((await f.q.keyState("S4", "gh", {})).state).toBe("PROVEN");
  const build = f.preflight("mac-a");
  await f.q.request({ spike: "S1-build", target: "mac-a", os: build, from: "m1", to: "m1" });
  expect((await f.q.keyState("S1-build", "mac-a", { from: "m1", to: "m1" })).state).toBe("PENDING");
  expect((await f.q.gate({ for: "build", from: "m1", to: "m1" })).exit).toBe(2);
});

it("W17 an observation that loses the race for its n is refused, never dropped", async () => {
  const f = fx();
  f.preflight("mac-a", OS_A);
  let raced = false;
  const racing = f.open({
    now: () => {
      if (!raced) { raced = true; writeFileSync(join(f.roots[0], "os", "mac-a", "2.obs.json"), JSON.stringify({ target: "mac-a", n: 2, recorded_utc: "2026-12-01T10:00:00.000Z", os_name: "macos", build: "14.5.1" })); }
      return f.clock.t;
    },
  });
  expect(() => racing.appendObservation("mac-a", OS_B)).toThrow("OBSERVATION_RACE");
  expect(f.q.currentOs("mac-a")).toMatchObject({ os: OS_A });
});

// r3 ASTRA n4:2596: a newer request that lands while the gate is awaiting (a fence lookup, or the flip snapshot)
// supersedes the generation being graded; GO is only ever issued from a ledger read after the gate's last await.
const during = (f, spike, act, extra = {}) => {
  let fired = false;
  const fences = {
    async components(args) {
      const out = await f.fences.components(args);
      if (args.spike === spike && !fired) { fired = true; await act(); }
      return out;
    },
  };
  return f.open({ fences, ...extra });
};
async function provenPre(f) {
  await s3Request(f);
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  const box = f.preflight("linux-box", { name: "linux", build: "6.8.0" });
  await f.q.request({ spike: "S2", target: "linux-box", os: box });
  await rec(f.q, "S2", "linux-box", 1, s2Receipt(f, 1));
  expect((await gate(f, { for: "pre", manifest: "m1" })).exit).toBe(0);
}
const badOf = (result) => result.bad.map((k) => `${k.key}:${k.state}:${k.reason ?? ""}`);

it("W1d a request for g+1 published during the key's own fence lookup is seen: PENDING, gate shut", async () => {
  const f = fx();
  await provenPre(f);
  const q = during(f, "S3", () => s3Request(f), { legs: ["mac-a"] });
  const result = await q.gate({ for: "pre", manifest: "m1" });
  expect(badOf(result)).toEqual(["S3-mac-a:PENDING:"]);
  expect(result.exit).toBe(2);
});

it("W1e a request for g+1 on key A published during key B's fence lookup supersedes A: STALE/SUPERSEDED, gate shut", async () => {
  const f = fx();
  await provenPre(f);
  const q = during(f, "S2", () => s3Request(f), { legs: ["mac-a"] });
  const result = await q.gate({ for: "pre", manifest: "m1" });
  expect(badOf(result)).toEqual(["S3-mac-a:STALE:SUPERSEDED"]);
  expect(result.exit).toBe(2);
});

it("W1f flip: a request for g+1 published while the live snapshot is fetched supersedes the proof", async () => {
  const f = fx();
  const n = f.preflight("mac-a");
  await f.q.request({ spike: "S3", target: "mac-a", os: n, release: "m1" });
  await rec(f.q, "S3", "mac-a", 1, s3Receipt(f, "mac-a", 1));
  await f.q.request({ spike: "S1", target: "mac-a", os: n, release: "m1" });
  await rec(f.q, "S1", "mac-a", 1, s1Receipt(f, "mac-a", 1));
  await f.q.request({ spike: "S4", target: "gh" });
  await rec(f.q, "S4", "gh", 1, s4Receipt(f, 1));
  const box = f.preflight("linux-box", { name: "linux", build: "6.8.0" });
  await f.q.request({ spike: "S2", target: "linux-box", os: box });
  await rec(f.q, "S2", "linux-box", 1, s2Receipt(f, 1));
  const q = f.open({ legs: ["mac-a"] });
  const flip = (fetchSnapshot) => q.gate({ for: "flip", manifest: "m1" }, { fetchSnapshot, appId: 42 });
  expect((await flip(async () => goodSnapshot())).exit).toBe(0);
  const result = await flip(async () => { await f.q.request({ spike: "S4", target: "gh" }); return goodSnapshot(); });
  expect(badOf(result)).toEqual(["S4-gh:STALE:SUPERSEDED"]);
  expect(result.exit).toBe(2);
});

it("W1g a leg PREFLIGHT whose relied key gets g+1 during a later key's fence lookup is QUAL_STALE", async () => {
  const f = fx();
  await provenPre(f);
  const q = during(f, "S2", () => s3Request(f));
  const relies = [["S3", "mac-a"], ["S2", "linux-box"]];
  let caught;
  try { await q.legPreflight({ target: "mac-a", os: OS_A, relies, args: { release: "m1" } }); } catch (error) { caught = error; }
  expect(caught?.message).toBe("QUAL_STALE");
});

it("W1h an OS observation that moves the build during a later key's fence lookup voids the earlier proof", async () => {
  const f = fx();
  await provenPre(f);
  const q = during(f, "S2", async () => { f.preflight("mac-a", OS_B); }, { legs: ["mac-a"] });
  const result = await q.gate({ for: "pre", manifest: "m1" });
  expect(badOf(result)).toEqual(["S3-mac-a:STALE:SUPERSEDED"]);
  expect(result.exit).toBe(2);
});
