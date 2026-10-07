// The packaged artifact, built and run the way the Flux team will run it:
// extracted OUTSIDE the repo, with nothing but node.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

import { scriptedProvider } from "../flux-stream-sim/providers/scripted.ts";
import { createSimServer } from "../flux-stream-sim/server.ts";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = mkdtempSync(join(tmpdir(), "flux-pack-"));
const dist = join(work, "dist");
const extracted = join(work, "extracted");
let sim: Awaited<ReturnType<typeof createSimServer>>;
let manifest: Record<string, unknown>;
let tgz = "";

beforeAll(async () => {
  sim = await createSimServer({ port: 0, provider: scriptedProvider(), log: () => undefined });
  await run("node", ["--experimental-strip-types", join(root, "tools/flux-stream-conformance/pack.ts"), "--out", dist], { cwd: root });
  tgz = readdirSync(dist).find((f) => f.endsWith(".tgz")) ?? "";
  await run("mkdir", ["-p", extracted]);
  await run("tar", ["xzf", join(dist, tgz), "-C", extracted]);
  manifest = JSON.parse(readFileSync(join(extracted, "flux-stream-conformance", "manifest.json"), "utf8"));
}, 120_000);
afterAll(async () => {
  await sim.close();
  safeWipeSync(work);
});

const node = (args: string[], env: Record<string, string> = {}) =>
  run("node", args, { cwd: extracted, env: { ...process.env, ...env } });

it("the archive is one directory with the bundle, fixtures, manifest and README", () => {
  expect(tgz).toMatch(/^flux-stream-conformance-\d+\.\d+\.\d+\.tgz$/);
  expect(extracted.startsWith(root)).toBe(false);
  const dir = join(extracted, "flux-stream-conformance");
  expect(readdirSync(extracted)).toEqual(["flux-stream-conformance"]);
  for (const f of ["run.mjs", "manifest.json", "README.md", "fixtures/manifest.json"]) expect(existsSync(join(dir, f)), f).toBe(true);
  expect(readdirSync(join(dir, "fixtures")).filter((f) => f.endsWith(".pcm"))).toHaveLength(12);
  expect(existsSync(join(dist, "manifest.json"))).toBe(true);
});

it("the manifest carries the version, the contract hash and the check inventory", () => {
  const contract = readFileSync(join(root, "shared/flux-stream-contract.ts"));
  expect(manifest).toMatchObject({ name: "flux-stream-conformance", node: ">=24", contract: { module: "shared/flux-stream-contract.ts", sha256: createHash("sha256").update(contract).digest("hex") } });
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  const ids = manifest.check_ids as string[];
  expect(manifest.checks).toBe(ids.length);
  expect(ids).toContain("L10");
  expect(manifest.run).toMatch(/--mode acceptance --target flux --url wss:\/\/<host>\/v1 .*--flux-faults --report report\.json/);
  expect(Object.keys(manifest.exit_codes as object)).toEqual(["0", "1", "2"]);
  expect(JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))).toEqual(manifest);
});

it("runs in plain node: --help, --version, and a usage error", async () => {
  const bundle = join("flux-stream-conformance", "run.mjs");
  const help = await node([bundle, "--help"]);
  for (const flag of ["--mode", "--target", "--base", "--url", "--key-env", "--key2-env", "--free-key-env", "--restricted-key-env", "--sim", "--flux-faults", "--no-latency", "--profile", "--commit", "--eagerness", "--min-silence", "--max-silence", "--only", "--owner-recording", "--report", "--starts-per-minute", "--version"]) {
    expect(help.stdout, flag).toContain(flag);
  }
  expect(help.stdout).not.toMatch(/—|experimental-transform-types/);
  expect((await node([bundle, "--version"])).stdout.trim()).toBe(manifest.version);
  await expect(node([bundle, "--not-a-flag"])).rejects.toMatchObject({ code: 2 });
});

it("a short dev run against the simulator passes from the extracted copy", async () => {
  const out = join(work, "report.json");
  const r = await node(
    [join("flux-stream-conformance", "run.mjs"), "--mode", "dev", "--target", "flux", "--url", sim.baseUrl, "--key-env", "PACK_KEY", "--only", "P01,P02", "--report", out],
    { PACK_KEY: "sim_key" },
  );
  expect(r.stdout).toContain("dev run (not an acceptance run)");
  const report = JSON.parse(readFileSync(out, "utf8")) as { results: Array<{ id: string; status: string }> };
  expect(report.results.map((x) => `${x.id}:${x.status}`)).toEqual(["P01:pass", "P02:pass"]);
}, 60_000);

it("L10 runs from the extracted bundle against a fresh cap-3 sim", async () => {
  const capped = await createSimServer({ port: 0, provider: scriptedProvider(), log: () => undefined, startsPerMinute: 3 });
  try {
    const r = await node(
      [join("flux-stream-conformance", "run.mjs"), "--mode", "dev", "--target", "flux", "--url", capped.baseUrl, "--key-env", "PACK_KEY", "--only", "L10", "--starts-per-minute", "3", "--max-inflight", "2"],
      { PACK_KEY: "sim_key" },
    );
    expect(r.stdout).toMatch(/\| L10 \| .*pass/);
  } finally {
    await capped.close();
  }
}, 60_000);
