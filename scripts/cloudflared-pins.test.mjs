// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The cloudflared pins have one source, scripts/prepare-cloudflared.mjs
// (upstream 379fce4d7). A version bump that left a workflow comparing the
// packaged cloudflared.exe with the old build's digest failed a Windows
// release build; here no workflow carries a pinned digest at all, and every
// other copy (version checks, the provenance README, the Cloud home image)
// must agree with the pin file.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CLOUDFLARED_ASSETS, CLOUDFLARED_VERSION } from "./prepare-cloudflared.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = Object.values(CLOUDFLARED_ASSETS);
const digests = [...new Set(assets.flatMap((asset) => [asset.sha256, asset.binarySha256]))];
const workflowDir = join(ROOT, ".github", "workflows");
const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(workflowDir, name), "utf8") }));

describe("cloudflared pins have one source", () => {
  it("no workflow hard-codes a cloudflared digest; the Windows checks read the pin file", () => {
    const pinned = workflows.flatMap(({ name, text }) => digests.filter((digest) => text.includes(digest)).map((digest) => `${name}: ${digest}`));
    expect(pinned).toEqual([]);
    for (const name of ["package-win.yml", "release.yml"]) {
      const text = workflows.find((workflow) => workflow.name === name)?.text ?? "";
      expect(text, name).toContain("CLOUDFLARED_ASSETS['win32-x64'].binarySha256");
    }
  });

  it("every workflow version check names the pinned version", () => {
    const versions = workflows.flatMap(({ name, text }) => [...text.matchAll(/cloudflared version (\S+) /g)].map((match) => `${name}: ${match[1]}`));
    for (const name of ["package-win.yml", "release.yml"]) expect(versions, name).toContain(`${name}: ${CLOUDFLARED_VERSION}`);
    for (const line of versions) expect(line.endsWith(`: ${CLOUDFLARED_VERSION}`), line).toBe(true);
  });

  it("the third-party README lists the version and every asset's digests", () => {
    const readme = readFileSync(join(ROOT, "third_party", "cloudflared", "README.md"), "utf8");
    expect(readme).toContain(`\`cloudflared\` ${CLOUDFLARED_VERSION} `);
    expect(readme).toContain(`releases/tag/${CLOUDFLARED_VERSION}>`);
    for (const asset of assets) {
      const row = readme.split("\n").find((line) => line.includes(`\`${asset.name}\``));
      expect(row, asset.name).toBeDefined();
      expect(row).toContain(asset.sha256);
      if (asset.binarySha256 !== asset.sha256) expect(row).toContain(asset.binarySha256);
    }
  });

  it("the Cloud home image installs, and its license record names, the same version and Linux digests", () => {
    const script = readFileSync(join(ROOT, "deploy", "cloud-home", "build-image.sh"), "utf8");
    expect(script).toContain(`cloudflared_version=${CLOUDFLARED_VERSION}\n`);
    expect(script).toContain(`[x86_64]=${CLOUDFLARED_ASSETS["linux-x64"].sha256} [aarch64]=${CLOUDFLARED_ASSETS["linux-arm64"].sha256})`);
    const licenses = readFileSync(join(ROOT, "deploy", "cloud-home", "LICENSES.md"), "utf8");
    expect(licenses).toContain(`| cloudflared | ${CLOUDFLARED_VERSION}, https://github.com/cloudflare/cloudflared/releases/tag/${CLOUDFLARED_VERSION};`);
    expect(licenses).toContain(`asset SHA-256 ${CLOUDFLARED_ASSETS["linux-x64"].sha256}`);
    expect(licenses).toContain(`| cloudflared ${CLOUDFLARED_VERSION} | cloudflared-linux-arm64 ${CLOUDFLARED_ASSETS["linux-arm64"].sha256} |`);
  });
});
