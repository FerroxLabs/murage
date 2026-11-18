// The macOS-only suite `src/e2e/*.offline.node-test.ts` runs under plain Node
// (type stripping), which does not probe extensions the way Vite does. An
// extensionless relative import anywhere in its static graph (for example
// src/lib/group-routing.ts -> ../../shared/mention-boundary) builds and bundles
// fine but fails that suite with ERR_MODULE_NOT_FOUND. This walks the same graph
// on every OS so the break is caught before the macOS quality gate.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = readdirSync(join(root, "src/e2e"))
  .filter((name) => name.endsWith(".offline.node-test.ts"))
  .map((name) => join(root, "src/e2e", name));

// Runtime imports only: `import type` / `export type` are erased by type stripping.
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gm;

function runtimeSpecifiers(source) {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]);
}

function walk(files) {
  const seen = new Set();
  const problems = [];
  const queue = [...files];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith("@/")) {
        problems.push(`${relative(root, file)}: runtime alias import "${spec}" does not resolve under Node`);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (!existsSync(target) || !statSync(target).isFile()) {
        problems.push(`${relative(root, file)}: "${spec}" is not an exact file path (Node does not add extensions)`);
        continue;
      }
      if (/\.(ts|mts|tsx)$/.test(target)) queue.push(target);
    }
  }
  return { seen, problems };
}

test("the offline node-test suite's static import graph resolves under plain Node", () => {
  assert.ok(entries.length > 0, "no src/e2e/*.offline.node-test.ts entries found");
  const { seen, problems } = walk(entries);
  assert.ok(seen.has(join(root, "src/lib/group-routing.ts")), "group-routing.ts should be in the walked graph");
  assert.ok(seen.has(join(root, "shared/mention-boundary.ts")), "shared/mention-boundary.ts should be in the walked graph");
  assert.deepEqual(problems, []);
});

test("the walker flags an extensionless relative import and ignores type-only imports", () => {
  assert.deepEqual(runtimeSpecifiers('import { a } from "../../shared/x";\nimport type { B } from "@/state/store";\n'), ["../../shared/x"]);
  assert.deepEqual(runtimeSpecifiers('export { a } from "./y.ts";\nexport type { C } from "./z";\n'), ["./y.ts"]);
});

test("the app's mention router loads under plain Node", async () => {
  const routing = await import(pathToFileURL(join(root, "src/lib/group-routing.ts")).href);
  assert.equal(typeof routing.roomRespondersForComposer, "function");
  const speakers = await import(pathToFileURL(join(root, "src/lib/room-speakers.ts")).href);
  assert.ok(Object.keys(speakers).length > 0);
});
