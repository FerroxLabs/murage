// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { createFenceProvider, defaultPair, parseOsIdentity, targetAssetName } from "./fence.mjs";
import { bytes, fixture, h, OS_A, s1Receipt } from "./qual-fixture.mjs";
import { QualError } from "./qual.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const made = [];
afterEach(() => { for (const dir of made.splice(0)) safeWipeSync(dir); });

const MAC_YML = "version: 1.0.22\nfiles:\n  - url: Murage-1.0.22-arm64-mac.zip\n    sha512: x\n  - url: Murage-1.0.22-mac.zip\n    sha512: y\npath: Murage-1.0.22-arm64-mac.zip\n";
const rel = (tag, digest) => ({
  tag, assets: [{ name: `Murage-${tag}-arm64-mac.zip`, digest }, { name: `Murage-${tag}-mac.zip`, digest: null }],
  ymls: { mac: MAC_YML.replaceAll("1.0.22", tag), win: `path: Murage-Setup-${tag}.exe\n`, linux: `path: Murage-${tag}.AppImage\n` },
});
const published = {
  "1.0.21": rel("1.0.21", `sha256:${h("a21")}`), "1.0.22": rel("1.0.22", `sha256:${h("a22")}`),
  "1.0.20": rel("1.0.20", null),
};
const releases = [
  { tag: "1.0.20", published_at: "2026-10-01T00:00:00Z" }, { tag: "1.0.21", published_at: "2026-11-01T00:00:00Z" },
  { tag: "1.0.22", published_at: "2026-11-20T00:00:00Z" }, { tag: "1.0.23-rc1", published_at: "2026-11-21T00:00:00Z", prerelease: true },
];
const manifests = {
  m23: { from: "1.0.22", targetAssets: { "mac-a": h("a23-unpublished") } },
  mnull: { from: "1.0.20", targetAssets: { "mac-a": h("a23-unpublished") } },
};
const provider = (overrides = {}) => createFenceProvider({
  fetchRelease: async (tag) => published[tag] ?? null, listReleases: async () => releases,
  loadManifest: async (ref) => manifests[ref], epoch: () => 1, ids: () => ({ appId: 42, repoId: 7 }), arch: () => "arm64", ...overrides,
});
const open = (fx, fences = provider()) => { made.push(fx.base); return fx.open({ fences }); };
const code = async (p) => { try { await p; } catch (e) { if (e instanceof QualError) return e.code; throw e; } return "OK"; };

it("W16 a 1.0.22-shaped release (no manifest, no product tag) has a known fence from public digests alone", async () => {
  const fences = provider();
  const s1 = await fences.components({ spike: "S1-build", target: "mac-a", from: "1.0.21", to: "1.0.22" });
  expect(s1.components).toMatchObject({ n1_asset_sha256: h("a21"), n_asset_sha256: h("a22") });
  expect(Object.values(s1.components).every((v) => typeof v === "string")).toBe(true);
  expect(defaultPair(releases)).toEqual({ from: "1.0.21", to: "1.0.22" });
  expect(targetAssetName("mac-a", MAC_YML, "arm64")).toBe("Murage-1.0.22-arm64-mac.zip");
  expect(targetAssetName("mac-b", MAC_YML, "x64")).toBe("Murage-1.0.22-mac.zip");
});

it("W16 S3 for an unpublished candidate stores N's digest from --release and goes STALE when it moves", async () => {
  const fx = fixture();
  const q = open(fx);
  const n = fx.preflight("mac-a", OS_A, q);
  await q.request({ spike: "S3", target: "mac-a", os: n, release: "m23" });
  expect(fx.req("S3", "mac-a", 1).n_sha256).toBe(h("a23-unpublished"));
  expect(fx.req("S3", "mac-a", 1).fence.n_asset_sha256).toBe(h("a23-unpublished"));
  manifests.m23.targetAssets["mac-a"] = h("a23-rebuilt");
  expect((await q.keyState("S3", "mac-a", { release: "m23" })).state).toBe("STALE");
  manifests.m23.targetAssets["mac-a"] = h("a23-unpublished");
});

it("W16 the first-ever request needs a preflight and burns no generation without one", async () => {
  const fx = fixture();
  const q = open(fx);
  expect(await code(q.request({ spike: "S1", target: "mac-a", os: 1, release: "m23" }))).toBe("PREFLIGHT");
  expect(existsSync(join(fx.roots[0], "S1-mac-a"))).toBe(false);
  const n = fx.preflight("mac-a", OS_A, q);
  expect((await q.request({ spike: "S1", target: "mac-a", os: n, release: "m23" })).g).toBe(1);
});

it("W16 build GO proves the published pair against a qual-only manifest and survives an RC-cut S1 request", async () => {
  const fx = fixture();
  const q = open(fx);
  const n = fx.preflight("mac-a", OS_A, q);
  await q.request({ spike: "S1-build", target: "mac-a", os: n });
  const req = fx.req("S1-build", "mac-a", 1);
  expect(req.fence.n1_asset_sha256).toBe(h("a21"));
  const receipt = s1Receipt(fx, "mac-a", 1, { spike: "S1-build", body: { consumed_sha256: h("a22") } });
  expect((await q.record({ spike: "S1-build", target: "mac-a", gen: 1, receipt: bytes(receipt) })).state).toBe("PROVEN");
  const rc = fx.preflight("mac-a", OS_A, q);
  await q.request({ spike: "S1", target: "mac-a", os: rc, release: "m23" });
  expect((await q.keyState("S1-build", "mac-a", {})).state).toBe("PROVEN");
});

it("W16 a null public digest is UNKNOWN with the hint and writes nothing", async () => {
  const fx = fixture();
  const q = open(fx, provider());
  let error;
  const m = fx.preflight("mac-a", OS_A, q);
  try { await q.request({ spike: "S1", target: "mac-a", os: m, release: "mnull" }); } catch (e) { error = e; }
  expect(error?.code).toBe("FENCE_UNKNOWN");
  expect(error?.hint).toContain("has no public digest");
  expect(existsSync(join(fx.roots[0], "S1-mac-a"))).toBe(false);
});

it("preflight parses typed OS identity from read-only command output", () => {
  expect(parseOsIdentity("mac-a", { sw_vers: "ProductName: macOS\nProductVersion: 14.5\nBuildVersion: 23F79\n" })).toEqual({ name: "macos", build: "14.5-23F79" });
  expect(parseOsIdentity("win-a", { registry: "CurrentBuild    REG_SZ    26100\nUBR    REG_DWORD    0x4d2\n" })).toEqual({ name: "windows", build: "26100.1234" });
  expect(parseOsIdentity("linux-vm", { os_release: 'ID=ubuntu\nVERSION_ID="24.04"\n', uname: "6.8.0-1\n" })).toEqual({ name: "linux", build: "ubuntu-24.04-6.8.0-1" });
  expect(parseOsIdentity("mac-a", { sw_vers: "garbage" })).toBeNull();
  expect(readdirSync).toBeTypeOf("function");
});
