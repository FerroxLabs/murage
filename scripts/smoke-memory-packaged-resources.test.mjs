// The packaged memory smoke runs the worker from a temporary copy of server/, where engine-exclusion.ts's dist-native fallback
// beside the module never exists. The worker must find engine-exclusion.node in the packaged Resources through MURAGE_RESOURCES_PATH,
// as the app's server hands it on (electron/harness-resources.mjs -> server/memory/worker-controller.ts); without it the worker
// fails closed with BG_ENFORCEMENT_UNAVAILABLE (release rehearsal 4, macOS Intel smoke).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { probeEnvironment } from "./smoke-memory-packaged.mjs";
import { ADDON_VERSION } from "../server/engine-exclusion.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

it("hands the packaged Resources to the probe and its worker; a build-stage run has none to hand", () => {
  const root = path.join(os.tmpdir(), "probe-root"), home = path.join(root, "home"), resources = path.join(os.tmpdir(), "App", "Resources");
  expect(probeEnvironment({ root, home, resources, backend: "wasm" })).toMatchObject({ MURAGE_RESOURCES_PATH: resources, MURAGE_MEMORY_BACKEND: "wasm", HOME: home });
  expect(probeEnvironment({ root, home, resources: null, backend: "auto" })).not.toHaveProperty("MURAGE_RESOURCES_PATH");
});

it("the loader in a copied server folder finds the Resources addon only with the smoke's environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-resources-"));
  roots.push(root);
  // The worker's copy of the loader, bundled the way the packaged server is (CommonJS leaves get require/__filename).
  const bundle = path.join(root, "copy", "server", "memory", "loader.mjs");
  await build({ entryPoints: [path.join(checkout, "server/engine-exclusion.ts")], bundle: true, platform: "node", target: "node20", format: "esm", outfile: bundle, logLevel: "error",
    banner: { js: 'import { createRequire as __r } from "node:module"; import { fileURLToPath as __p } from "node:url"; import { dirname as __d } from "node:path"; const require = __r(import.meta.url); const __filename = __p(import.meta.url); const __dirname = __d(__filename);' } });
  const resources = path.join(root, "App", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "engine-exclusion.node"), "stand-in");
  // A real native file cannot be built here: the stand-in replaces only the dlopen of a .node file, so candidates() and
  // loadExclusionAddon() run unchanged and the path they chose is what this reports.
  const preload = path.join(root, "stand-in.cjs");
  fs.writeFileSync(preload, `const Module = require("node:module"); const v = Number(process.env.STAND_IN_VERSION);
Module._extensions[".node"] = (module) => { module.exports = { lock() {}, processes() { return []; }, renameNoReplace() {}, version: () => v, writers() { return []; }, fullSync() {} }; };\n`);
  const runner = path.join(root, "run.mjs");
  fs.writeFileSync(runner, `const m = await import(${JSON.stringify(new URL(`file://${bundle}`).href)}); console.log(JSON.stringify({ path: m.exclusionAddonPath() ?? null }));\n`);
  const run = (env) => {
    const result = spawnSync(process.execPath, ["--require", preload, runner], { cwd: root, env: { ...env, PATH: process.env.PATH, STAND_IN_VERSION: String(ADDON_VERSION) }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)).path;
  };
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  expect(run(probeEnvironment({ root, home, resources, backend: "wasm" }))).toBe(path.join(resources, "engine-exclusion.node"));
  // The rehearsal failure: the same copy with no resources folder named finds nothing and the worker fails closed.
  expect(run(probeEnvironment({ root, home, resources: null, backend: "wasm" }))).toBeNull();
});
