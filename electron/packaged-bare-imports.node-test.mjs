// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The packaged app ships no node_modules for the main process (electron-builder.yml `!**/node_modules/**`), so a bare
// package import in electron/ packages an app that dies at launch with ERR_MODULE_NOT_FOUND: 1.0.3's `import "ws"`
// did, caught only by the Linux package smoke. A main-process dependency is vendored under electron/vendor
// (scripts/bundle-updater.mjs, scripts/bundle-ws.mjs) and required by path. This fails on any other bare specifier.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const electronDir = fileURLToPath(new URL(".", import.meta.url));
const ALLOWED = new Set(["electron"]);
// Static ESM imports and re-exports only: they resolve when the module loads, so a missing package is a launch crash.
// (An optional add-on loaded behind a try, as cua.mjs does, is a choice that module makes and tests itself.)
const SPECIFIER = /^\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"'./][^"']*)["']/gm;

function packagedSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "vendor", "fixtures", "resources"].includes(entry.name)) continue;
      packagedSources(path, out);
    } else if (/\.(mjs|cjs|js)$/.test(entry.name) && !/\.(test|node-test|electron-smoke)\./.test(entry.name)) out.push(path);
  }
  return out;
}

test("the packaged main process statically imports no package by bare name (vendor it under electron/vendor)", () => {
  const files = packagedSources(electronDir);
  assert.ok(files.some((file) => file.endsWith("main.mjs")), "the scan reads electron/main.mjs");
  const bare = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
    .map((match) => match[1]).filter((name) => !name.startsWith("node:") && !ALLOWED.has(name))
    .map((name) => `${file.slice(electronDir.length)}: ${name}`));
  assert.deepEqual(bare, []);
});

test("the vendored ws is the version the lockfile pins", () => {
  const bundle = readFileSync(join(electronDir, "vendor", "ws.cjs"), "utf8");
  const pinned = JSON.parse(readFileSync(join(electronDir, "..", "package.json"), "utf8")).dependencies.ws;
  assert.match(bundle, new RegExp(`^/\\* ws ${pinned.replace(/\./g, "\\.")} \\(MIT`));
});
