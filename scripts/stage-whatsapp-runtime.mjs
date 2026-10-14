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
import { createHoistedStager, packageRoot, wipeStagedTree } from "./stage-hoisted.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL = ["baileys", "jimp"];
// Packages whose package.json declares no licence but whose shipped LICENSE file
// was read and is permissive. Keyed by exact name@version so a bump re-reviews.
const LICENSE_OVERRIDES = { "exif-parser@0.1.12": "MIT" /* LICENSE.md: "The MIT License" */ };
const licenseFor = (pkg, identity) => pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((entry) => entry.type).join(" OR ") : null) ?? LICENSE_OVERRIDES[identity] ?? null;

// This stager runs first in scripts/bundle-server.mjs and owns the reset of the shared hoisted tree under
// dist-server/node_modules (stage-memory-runtime.mjs then adds its packages to the same tree).
wipeStagedTree(join(root, "dist-server"), root);
const stager = createHoistedStager({ distRoot: join(root, "dist-server"), excluded: excludedPackage, licenseFor });
for (const name of TOP_LEVEL) stager.stage(name, root);

// Baileys imports `long` (lib/Socket/messages-recv.js) without declaring it; it
// resolves in a flat npm tree only because protobufjs depends on it. Provide the SAME installed copy
// where Baileys resolves it, found from protobufjs itself (as stage-memory-runtime does for
// onnxruntime-common). In the hoisted tree this is normally the one shared copy; it is nested under
// Baileys only when protobufjs' own `long` was shadowed by a different version.
const baileysDestination = join(root, "dist-server", "node_modules", "baileys");
stager.stage("long", packageRoot("protobufjs", packageRoot("baileys", root)), baileysDestination);
const records = stager.records();

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
