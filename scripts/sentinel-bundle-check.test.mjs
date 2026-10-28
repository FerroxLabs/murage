// The Sentinel packaging guard (1.0.9): the scanner entry and the host boundary are real esbuild bundles, checked by
// their metafile import graph, and the bundled outputs run: the scanner entry answers on its own (ESM direct-run
// guard), the host boundary exposes the producer and descriptor API, and the sealed statistics eval worker still builds
// a generation once bundled (A1 note).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { HOST_BOUNDARY_OUTPUT, SENTINEL_CLI_OUTPUT, assertSentinelBundles, sentinelBundleProblems } from "./sentinel-bundle-check.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
afterAll(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const temp = prefix => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); roots.push(dir); return dir; };

const meta = (outputs) => ({ inputs: {}, outputs });
const clean = () => ({
  [SENTINEL_CLI_OUTPUT]: { inputs: { "server/sentinel/cli.ts": {}, "server/sentinel/paths.ts": {}, "shared/health-protocol.mjs": {} }, imports: [{ path: "node:fs", kind: "import-statement", external: true }, { path: "node:sqlite", kind: "import-statement", external: true }] },
  [HOST_BOUNDARY_OUTPUT]: { inputs: { "server/health/publisher.ts": {}, "server/sentinel/paths.ts": {}, "node_modules/zod/index.js": {} }, imports: [{ path: "node:worker_threads", external: true }] },
});

describe("sentinel bundle rules", () => {
  it("accepts a scanner that inlines only the scanner and the shared contract, and a host boundary with producers", () => {
    expect(sentinelBundleProblems(meta(clean()))).toEqual([]);
  });

  it("refuses server startup, the database opener, drivers, config, memory and producers in the scanner", () => {
    for (const input of ["server/index.ts", "server/database.ts", "server/drivers/claude.ts", "server/config.ts", "server/memory/extract.ts", "server/health/publisher.ts"]) {
      const outputs = clean();
      outputs[SENTINEL_CLI_OUTPUT].inputs[input] = {};
      expect(sentinelBundleProblems(meta(outputs)).join("\n")).toContain(`inlines forbidden ${input}`);
    }
  });

  it("refuses any package and any unexpected server file in the scanner, but allows packages in the host boundary", () => {
    const outputs = clean();
    outputs[SENTINEL_CLI_OUTPUT].inputs["node_modules/zod/index.js"] = {};
    outputs[SENTINEL_CLI_OUTPUT].inputs["server/atomic.ts"] = {};
    const problems = sentinelBundleProblems(meta(outputs)).join("\n");
    expect(problems).toContain("inlines forbidden node_modules/zod/index.js");
    expect(problems).toContain("inlines unexpected server/atomic.ts");
    expect(problems).not.toContain(HOST_BOUNDARY_OUTPUT);
  });

  it("refuses network modules in either bundle and non-built-in imports in the scanner", () => {
    const outputs = clean();
    outputs[SENTINEL_CLI_OUTPUT].imports.push({ path: "node:https", external: true }, { path: "undici", external: true }, { path: "left-pad", external: true });
    outputs[HOST_BOUNDARY_OUTPUT].imports.push({ path: "net", external: true });
    const problems = sentinelBundleProblems(meta(outputs)).join("\n");
    expect(problems).toContain(`${SENTINEL_CLI_OUTPUT}: imports network module node:https`);
    expect(problems).toContain(`${SENTINEL_CLI_OUTPUT}: imports network module undici`);
    expect(problems).toContain(`${SENTINEL_CLI_OUTPUT}: imports non-built-in left-pad`);
    expect(problems).toContain(`${HOST_BOUNDARY_OUTPUT}: imports network module net`);
  });

  it("refuses the build when either output is missing, and finds outputs keyed relative to another working directory", () => {
    expect(sentinelBundleProblems(meta({ [SENTINEL_CLI_OUTPUT]: clean()[SENTINEL_CLI_OUTPUT] }))).toEqual([`${HOST_BOUNDARY_OUTPUT}: missing from the build`]);
    const shifted = Object.fromEntries(Object.entries(clean()).map(([key, value]) => [`../repo/${key}`, value]));
    expect(sentinelBundleProblems(meta(shifted))).toEqual([]);
    expect(() => assertSentinelBundles(meta({}))).toThrow(/not self-contained/);
  });
});

describe("the real bundles", () => {
  let bundle;
  const outdir = () => bundle.outdir;
  async function bundleOnce() {
    if (bundle) return bundle;
    const dir = temp("murage-sentinel-bundle-");
    const out = join(dir, "dist-server");
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: ["sentinel/cli.ts", "health/host-boundary.ts", "health/stats-publisher.ts"].map(entry => join(ROOT, "server", entry)),
      bundle: true, platform: "node", target: "node20", format: "esm", outbase: join(ROOT, "server"), outdir: out, write: false, metafile: true,
      banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
      external: ["@huggingface/transformers"], logLevel: "silent",
    });
    for (const file of result.outputFiles) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, file.contents); }
    // Re-key outputs as the bundle script sees them (relative to the repository root).
    const outputs = Object.fromEntries(Object.entries(result.metafile.outputs).map(([key, value]) => [`dist-server/${relative(out, join(ROOT, key)).split("\\").join("/")}`, value]));
    bundle = { outdir: out, metafile: { ...result.metafile, outputs } };
    return bundle;
  }

  it("keep the scanner's import graph clean", { timeout: 60_000 }, async () => {
    const { metafile } = await bundleOnce();
    expect(sentinelBundleProblems(metafile)).toEqual([]);
  });

  it("the bundled scanner entry runs by itself and answers usage for anything but its three service modes", { timeout: 60_000 }, async () => {
    await bundleOnce();
    const cli = join(outdir(), "sentinel", "cli.js");
    expect(existsSync(cli)).toBe(true);
    const run = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: {}, timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe(JSON.stringify({ status: "usage" }));
  });

  it("the bundled host boundary exposes the producer and descriptor API", { timeout: 60_000 }, async () => {
    await bundleOnce();
    const mod = await import(pathToFileURL(join(outdir(), "health", "host-boundary.js")).href);
    for (const name of ["HealthPublisher", "HealthCounters", "startHealthProducer", "stopHealthProducer", "createBackupStatusProducer", "sentinelInstallationId", "defaultOutputRoot", "ensureOutputRoot", "writeDescriptor", "loadDescriptor", "sourcePaths", "checkInstall", "registrationMatches"]) {
      expect(typeof mod[name], name).toBe("function");
    }
    expect(mod.DESCRIPTOR_VERSION).toBe(1);
  });

  it("the sealed statistics eval worker still builds a generation once bundled", { timeout: 60_000 }, async () => {
    await bundleOnce();
    const mod = await import(pathToFileURL(join(outdir(), "health", "stats-publisher.js")).href);
    const dir = temp("murage-sentinel-stats-");
    const file = join(dir, ".tmp-0123456789abcdef.sqlite");
    const result = await mod.buildInWorker({
      file, tables: (await import(pathToFileURL(join(ROOT, "shared", "health-protocol.mjs")).href)).DB_STATS_TABLES,
      snapshot: { version: 1, installation_id: "0123456789abcdef0123456789abcdef", generation: 1, at: 1_700_000_000_000, coverage: "complete" },
      rows: [],
    });
    expect(result.ok).toBe(true);
    expect(result.sidecar).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});
