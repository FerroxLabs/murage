import { createHash } from "node:crypto";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateInventory, verifyInventory } from "./whatsapp-inventory.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extra) {
  const server = mkdtempSync(join(tmpdir(), "wa-inventory-")); roots.push(server);
  const packages = [["baileys", "7.0.0-rc14"], ["jimp", "1.6.1"], ...(extra ? [[extra, "1.0.0"]] : [])];
  for (const [name, version] of packages) {
    const dir = join(server, "node_modules", ...(name === "baileys" || name === "jimp" ? [] : ["baileys", "node_modules"]), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT" })); writeFileSync(join(dir, "LICENSE"), `${name} licence`);
  }
  const lockfile = join(server, "lock.yaml");
  writeFileSync(lockfile, JSON.stringify({ packages: Object.fromEntries(packages.map(([name, version]) => [`${name}@${version}`, { resolution: { integrity: "sha512-YWJj" } }])) }));
  mkdirSync(join(server, "channels/whatsapp"), { recursive: true });
  const bytes = Buffer.from("fixture bridge"); writeFileSync(join(server, "channels/whatsapp/bridge.js"), bytes);
  const bridge = { path: "channels/whatsapp/bridge.js", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bridge, server, lockfile, advisory: join(server, "advisory.json") };
}
it("inventories transitives, lockfile integrities and copied notices and detects tampering", () => {
  const f = fixture("dependency"), packages = generateInventory(f);
  writeFileSync(join(f.server, "whatsapp-runtime-manifest.json"), JSON.stringify({ packages, bridge: f.bridge }));
  expect(packages).toHaveLength(3); expect(packages.every(p => p.integrity === "sha512-YWJj" && p.licenseFiles.length)).toBe(true);
  expect(verifyInventory({ ...f, requireAdvisory: false })).toBe(3);
  writeFileSync(join(f.server, packages[0].licenseFiles[0].path), "tampered");
  expect(() => verifyInventory({ ...f, requireAdvisory: false })).toThrow("Licence copy differs");
});
it.each(["sharp", "@img/sharp-libvips-linux-x64"])("refuses excluded transitive %s", name => {
  expect(() => generateInventory(fixture(name))).toThrow("Excluded WhatsApp dependency");
});
it("fails closed on missing integrity, missing notices, and unreviewed advisory evidence", () => {
  const f = fixture(); const packages = generateInventory(f);
  writeFileSync(join(f.server, "whatsapp-runtime-manifest.json"), JSON.stringify({ packages, bridge: f.bridge }));
  writeFileSync(f.advisory, JSON.stringify({ status: "pending-network-review" }));
  expect(() => verifyInventory(f)).toThrow("advisory review evidence");
  writeFileSync(f.lockfile, '{"packages":{}}'); expect(() => generateInventory(f)).toThrow("Missing registry integrity");
  const other = fixture(); rmSync(join(other.server, "node_modules/baileys/LICENSE"));
  const pkgFile = join(other.server, "node_modules/baileys/package.json");
  writeFileSync(pkgFile, JSON.stringify({ name: "baileys", version: "7.0.0-rc14", license: "GPL-3.0" }));
  expect(() => generateInventory(other)).toThrow();
});
it("records a generated notice for a permissive package that publishes no licence file", () => {
  const f = fixture(); rmSync(join(f.server, "node_modules/jimp/LICENSE"));
  const jimp = generateInventory(f).find(p => p.name === "jimp");
  expect(jimp.licenseFiles).toHaveLength(1); expect(jimp.licenseFiles[0].source).toBe("package.json");
  expect(readFileSync(join(f.server, jimp.licenseFiles[0].path), "utf8")).toContain("Licence declared in package.json: MIT");
});
it("requires staged artifacts rather than skipping the release gate", () => {
  const f = fixture(); rmSync(join(f.server, "node_modules/jimp"), { recursive: true });
  expect(() => generateInventory(f)).toThrow("Missing staged package");
  expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).toContain('"check:whatsapp-inventory"');
});
it("requires every declared mandatory dependency in the staged closure", () => {
  const f = fixture();
  const file = join(f.server, "node_modules/baileys/package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")); pkg.dependencies = { missing: "1.0.0" }; writeFileSync(file, JSON.stringify(pkg));
  expect(() => generateInventory(f)).toThrow("Missing staged dependency");
});

it.each(["missing", "content", "size", "hash", "record"])("rejects bridge artifact mismatch: %s", change => {
  const f = fixture(), manifest = { packages: generateInventory(f), bridge: f.bridge };
  const bridge = join(f.server, "channels/whatsapp/bridge.js");
  if (change === "missing") rmSync(bridge);
  if (change === "content") writeFileSync(bridge, "changed bridge");
  if (change === "size") manifest.bridge.bytes++;
  if (change === "hash") manifest.bridge.sha256 = "0".repeat(64);
  if (change === "record") delete manifest.bridge;
  writeFileSync(join(f.server, "whatsapp-runtime-manifest.json"), JSON.stringify(manifest));
  expect(() => verifyInventory({ ...f, requireAdvisory: false })).toThrow();
});
