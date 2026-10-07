// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Murage for Chrome release identity: the committed placeholder fails the
// release, a real dashboard identity passes and reaches the packaged build.
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { BROWSER_EXTENSION_RELEASE_CONFIG, checkBrowserExtensionBuild, extensionIdFromPublicKey, readBrowserExtensionReleaseConfig } from "./browser-extension-release-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "bx-release-"))); roots.push(dir); return dir; };
function realIdentity() {
  const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { productionIds: [extensionIdFromPublicKey(publicKey)], publicKey };
}
const guard = (...args) => spawnSync(process.execPath, [join(root, "scripts/release-guard.mjs"), ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });

it("the committed config is the placeholder or a real identity, never anything in between", () => {
  // Before the owner creates the store item it holds the handoff placeholder;
  // afterwards the real ID and key. Both are valid commits; a half edit is not.
  expect(["placeholder", "ready"]).toContain(readBrowserExtensionReleaseConfig(join(root, BROWSER_EXTENSION_RELEASE_CONFIG)).status);
});

it("the placeholder fails a release and leaves a qualification build without an identity", () => {
  const dir = scratch(), file = join(dir, "release.json");
  writeFileSync(file, JSON.stringify({ productionIds: ["REPLACE_WITH_REAL_32_CHARACTER_STORE_ID"], publicKey: "REPLACE_WITH_DASHBOARD_PUBLIC_KEY_BASE64" }));
  expect(readBrowserExtensionReleaseConfig(file)).toEqual({ status: "placeholder" });
  const release = guard("browser-extension", file);
  expect(release.status).toBe(1);
  expect(release.stderr).toContain("Murage for Chrome release identity is not set");
  expect(release.stdout).toBe("");
  const qualification = guard("browser-extension-optional", file);
  expect(qualification.status).toBe(0);
  expect(qualification.stdout).toBe("");
  expect(qualification.stderr).toContain("::warning::");
});

it("a real dashboard identity passes and prints the env line for the packaging step", () => {
  const dir = scratch(), file = join(dir, "release.json"), identity = realIdentity();
  writeFileSync(file, JSON.stringify(identity));
  expect(readBrowserExtensionReleaseConfig(file)).toEqual({ status: "ready", path: file, productionIds: identity.productionIds, publicKey: identity.publicKey, chromeWebStoreId: identity.productionIds[0] });
  for (const command of ["browser-extension", "browser-extension-optional"]) {
    const result = guard(command, file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG=${file}\n`);
  }
});

it("a half-edited or mismatched identity fails both release and qualification builds", () => {
  const dir = scratch(), identity = realIdentity();
  const cases = {
    "missing-key": { productionIds: identity.productionIds },
    "placeholder-key": { productionIds: identity.productionIds, publicKey: "REPLACE_WITH_DASHBOARD_PUBLIC_KEY_BASE64" },
    "wrong-id": { productionIds: ["a".repeat(32)], publicKey: identity.publicKey },
    "extra-field": { ...identity, storeUrl: "https://example.com" },
  };
  for (const [name, value] of Object.entries(cases)) {
    const file = join(dir, `${name}.json`); writeFileSync(file, JSON.stringify(value));
    expect(readBrowserExtensionReleaseConfig(file).status, name).toBe("invalid");
    expect(guard("browser-extension", file).status, name).toBe(1);
    expect(guard("browser-extension-optional", file).status, name).toBe(1);
  }
});

it("the packaged build.json must be release mode with exactly the configured identity", () => {
  const dir = scratch(), identity = realIdentity(), config = join(dir, "release.json");
  writeFileSync(config, JSON.stringify(identity));
  const resources = join(dir, "Resources"); mkdirSync(join(resources, "browser-extension"), { recursive: true });
  const build = join(resources, "browser-extension", "build.json");
  const write = value => writeFileSync(build, JSON.stringify(value));
  const manifest = key => { mkdirSync(join(resources, "browser-extension", "extension"), { recursive: true }); writeFileSync(join(resources, "browser-extension", "extension", "manifest.json"), JSON.stringify({ name: "Murage for Chrome", ...(key ? { key } : {}) })); };
  manifest(identity.publicKey);
  const good = { version: 1, mode: "release", extensionVersion: "0.1.0", productionIds: identity.productionIds, chromeWebStoreId: identity.productionIds[0], registered: false, packagedNativeQualified: false };
  write(good);
  expect(checkBrowserExtensionBuild(build, config)).toEqual([]);
  expect(guard("browser-extension-build", build, config).status).toBe(0);
  write({ ...good, mode: "resources" }); expect(checkBrowserExtensionBuild(build, config)).toContain("build.json mode is resources, not release");
  write({ ...good, developmentId: "b".repeat(32) }); expect(checkBrowserExtensionBuild(build, config)).toContain("build.json carries a development ID");
  write({ ...good, productionIds: ["c".repeat(32)] }); expect(checkBrowserExtensionBuild(build, config)).toContain("build.json IDs differ from the release config");
  write({ ...good, chromeWebStoreId: undefined }); expect(checkBrowserExtensionBuild(build, config)).toContain("build.json has no Chrome Web Store ID");
  write(good);
  manifest(undefined); expect(checkBrowserExtensionBuild(build, config)).toContain("the packaged extension manifest does not carry the store public key");
  manifest(realIdentity().publicKey); expect(checkBrowserExtensionBuild(build, config)).toContain("the packaged extension manifest does not carry the store public key");
  expect(guard("browser-extension-build", build, config).status).toBe(1);
});
