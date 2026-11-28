// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Generation/epoch fence components (O23 section 2). Every component comes from something that exists for EVERY
// published release, including ones that predate the suite: the release's PUBLIC asset sha256 digests. An asset
// digest pins every byte of that build, so no version or patch list is needed. Nothing is unpacked here.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_FILES = {
  S1: ["feed.mjs", "native-spike.mjs", "native-evidence.mjs", "validate-s1.mjs", "receipt-schema.mjs"],
  "S1-build": ["feed.mjs", "native-spike.mjs", "native-evidence.mjs", "validate-s1.mjs", "receipt-schema.mjs"],
  S2: ["linux-credential.mjs", "validate-s2.mjs", "receipt-schema.mjs"],
  S3: ["quit.mjs", "validate-s3.mjs", "receipt-schema.mjs"],
  S4: ["permission-boundary.mjs", "validate-s4.mjs", "receipt-schema.mjs"],
};
const OS_KIND = { "mac-a": "mac", "mac-b": "mac", "win-a": "win", "linux-vm": "linux", "linux-box": "linux" };

export function probeHashes(spike, dir = HERE) {
  const hash = (names) => createHash("sha256").update(names.map((n) => readFileSync(join(dir, n))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest("hex");
  const [probe, ...validators] = [PROBE_FILES[spike].slice(0, -2), ...PROBE_FILES[spike].slice(-2)];
  return { probe_sha256: hash(probe), validator_sha256: hash(validators) };
}

// The file the updater consumes, named in the release's public latest*.yml (mac: the zip for that Mac's arch).
export function targetAssetName(target, ymlText, arch = "arm64") {
  const kind = OS_KIND[target];
  const urls = [...ymlText.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const pick = (test) => urls.find(test) ?? null;
  if (kind === "mac") return pick((u) => u.endsWith(".zip") && (arch === "arm64" ? /arm64/.test(u) : !/arm64/.test(u)));
  if (kind === "win") return pick((u) => u.endsWith(".exe"));
  return pick((u) => /\.AppImage$/.test(u) && !/arm64|aarch64/.test(u));
}

export function publicDigest(release, name) {
  const asset = release?.assets?.find((a) => a.name === name);
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? "");
  return m ? m[1] : null;
}

// Default build-GO pair: the newest non-draft, non-prerelease release published before latest -> latest.
export function defaultPair(releases) {
  const live = releases.filter((r) => !r.draft && !r.prerelease).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
  if (live.length < 2) return null;
  return { from: live.at(-2).tag, to: live.at(-1).tag };
}

// deps: fetchRelease(tag) -> {assets:[{name,digest}], ymls:{mac,win,linux}} | null; listReleases(); loadManifest(ref) ->
// {from, targetAssets:{<target>: sha256}}; epoch(); ids() -> {appId, repoId}; arch(target); probeDir.
export function createFenceProvider(deps) {
  const noDigest = (name) => `asset ${name} has no public digest; re-upload or pick another pair`;
  async function targetDigest(tag, target) {
    const release = await deps.fetchRelease(tag);
    const name = release && targetAssetName(target, release.ymls?.[OS_KIND[target]] ?? "", deps.arch?.(target));
    if (!name) return { digest: null, hint: `no target asset for ${target} in ${tag}` };
    const digest = publicDigest(release, name);
    return { digest, hint: digest ? undefined : noDigest(name) };
  }
  return {
    async components({ spike, target, release, from, to }) {
      const probe = probeHashes(spike, deps.probeDir);
      if (spike === "S2") return { components: { epoch: deps.epoch(), ...probe }, nSha256: null };
      if (spike === "S4") { const { appId, repoId } = deps.ids(); return { components: { app_id: appId, repo_id: repoId, ...probe }, nSha256: null }; }
      let hint;
      if (spike === "S1-build") {
        const pair = from && to ? { from, to } : defaultPair(await deps.listReleases());
        if (!pair) return { components: { n1_asset_sha256: null, n_asset_sha256: null, ...probe }, hint: "no published pair" };
        const a = await targetDigest(pair.from, target);
        const b = await targetDigest(pair.to, target);
        return { components: { n1_asset_sha256: a.digest, n_asset_sha256: b.digest, ...probe }, nSha256: b.digest, hint: a.hint ?? b.hint };
      }
      const manifest = await deps.loadManifest(release);
      const nSha = manifest?.targetAssets?.[target] ?? null;
      if (spike === "S3") return { components: { n_asset_sha256: nSha, ...probe }, nSha256: nSha };
      const n1 = await targetDigest(manifest?.from, target);
      hint = n1.hint;
      return { components: { n1_asset_sha256: n1.digest, ...probe }, nSha256: nSha, hint };
    },
  };
}

// `qual preflight`: typed OS identity from read-only commands MAIN runs on the target over its existing transport.
export function parseOsIdentity(target, out) {
  const kind = OS_KIND[target];
  const build = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
  let name;
  let value;
  if (kind === "mac") {
    name = "macos";
    value = `${/ProductVersion:\s*(\S+)/.exec(out.sw_vers)?.[1]}-${/BuildVersion:\s*(\S+)/.exec(out.sw_vers)?.[1]}`;
  } else if (kind === "win") {
    name = "windows";
    value = `${/CurrentBuild\s+REG_SZ\s+(\d+)/.exec(out.registry)?.[1]}.${/UBR\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.registry)?.[1] ? parseInt(/UBR\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.registry)[1], 16) : undefined}`;
  } else {
    name = "linux";
    value = `${/^ID=(\S+)/m.exec(out.os_release)?.[1]?.replace(/"/g, "")}-${/^VERSION_ID="?([^"\n]+)"?/m.exec(out.os_release)?.[1]}-${out.uname?.trim()}`;
  }
  if (!build.test(value) || /undefined/.test(value)) return null;
  return { name, build: value };
}
