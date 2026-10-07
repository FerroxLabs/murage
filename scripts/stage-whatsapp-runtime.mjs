// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stage the WhatsApp bridge's runtime (baileys + jimp and their full installed
// dependency graphs) into dist-server/node_modules, beside the Transformers
// runtime staged by stage-memory-runtime.mjs. The packaged app ships no
// node_modules, and Baileys is CommonJS-era code with a wasm dependency, so it
// is declared `external` for the bridge bundle and shipped as installed.
//
// Every staged package's licence is recorded in
// dist-server/whatsapp-runtime-manifest.json (the third-party inventory that
// runtime-pin.test.ts checks against an allowlist). `sharp` is deliberately NOT
// staged: Baileys lists it only as an (optional) peer, and falls back to jimp.
// No network, install scripts, global environment or user profile mutations.
import { excludedPackage, generateInventory } from "./whatsapp-inventory.mjs";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "murage-whatsapp-runtime";
const TOP_LEVEL = ["baileys", "jimp"];
// Packages whose package.json declares no licence but whose shipped LICENSE file
// was read and is permissive. Keyed by exact name@version so a bump re-reviews.
const LICENSE_OVERRIDES = { "exif-parser@0.1.12": "MIT" /* LICENSE.md: "The MIT License" */ };
const records = [];

function packageRoot(name, from) {
  const require = createRequire(join(from, "package.json"));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name, "package.json");
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === name) return dirname(realpathSync(candidate));
  }
  let file;
  try { file = require.resolve(`${name}/package.json`); } catch { file = require.resolve(name); }
  let dir = dirname(realpathSync(file));
  for (;;) {
    const path = join(dir, "package.json");
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw Error(`package root unavailable: ${name}`);
    dir = parent;
  }
}

function stage(name, from, destination, ancestors = new Set()) {
  if (excludedPackage(name)) throw Error(`${name} must not be staged for the WhatsApp runtime`);
  const source = packageRoot(name, from);
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const identity = `${name}@${pkg.version}`;
  if (ancestors.has(identity)) return;
  cpSync(source, destination, { recursive: true, dereference: true, filter: (path) => !relative(source, path).split(sep).includes("node_modules") });
  records.push({ name, version: pkg.version, license: pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((entry) => entry.type).join(" OR ") : null) ?? LICENSE_OVERRIDES[identity] ?? null, path: relative(join(root, "dist-server"), destination) });
  const seen = new Set(ancestors);
  seen.add(identity);
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (excludedPackage(dependency)) throw Error(`Excluded dependency requested: ${dependency}`);
    try { packageRoot(dependency, source); } catch (error) { if (pkg.optionalDependencies?.[dependency]) continue; throw error; }
    stage(dependency, source, join(destination, "node_modules", dependency), seen);
  }
}

for (const name of TOP_LEVEL) {
  const destination = join(root, "dist-server", "node_modules", name);
  const marker = join(destination, ".murage-runtime-stage");
  if (existsSync(destination)) {
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== MARKER) throw Error("refusing unowned runtime staging directory");
    safeWipeSync(destination, { within: root });
  }
  mkdirSync(destination, { recursive: true });
  writeFileSync(marker, MARKER);
  stage(name, root, destination);
}

// Baileys imports `long` (lib/Socket/messages-recv.js) without declaring it; it
// resolves in a flat npm tree only because protobufjs depends on it. Nested
// staging would hide it, so provide the SAME installed copy beside Baileys,
// resolved from protobufjs itself (as stage-memory-runtime does for
// onnxruntime-common).
const baileysDestination = join(root, "dist-server", "node_modules", "baileys");
const baileysSource = packageRoot("baileys", root);
stage("long", packageRoot("protobufjs", baileysSource), join(baileysDestination, "node_modules", "long"));

// The bridge bundle's build record: path, size and sha256 of the bytes just built. runtime-pin.test.ts recomputes
// the hash from the staged file, so a bundle changed after the build (or a stale one) fails there; the packaged
// smoke can do the same from Resources/server.
const bridgeFile = join(root, "dist-server", "channels", "whatsapp", "bridge.js");
let bridge = null;
if (existsSync(bridgeFile)) {
  const bytes = readFileSync(bridgeFile);
  bridge = { path: relative(join(root, "dist-server"), bridgeFile), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), external: ["baileys", "jimp"] };
}

writeFileSync(
  join(root, "dist-server", "whatsapp-runtime-manifest.json"),
  JSON.stringify({ platform: process.platform, arch: process.arch, packages: generateInventory({ server: join(root, "dist-server"), lockfile: join(root, "pnpm-lock.yaml") }), bridge }, null, 2) + "\n",
);
console.log(`Staged WhatsApp runtime: ${records.length} packages (${process.platform}/${process.arch})`);
