// Driver/config tests owner: win-sac-sign; enrolled Windows tooling and deployment owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { readWindowsSigningBuilderConfig, WINDOWS_BUILDER_HOOKS } from "./windows-signing-config.mjs";
const roots = [], callback = fileURLToPath(new URL("./windows-builder-custom-sign.mjs", import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
export function builderConfigFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-config-")); roots.push(root);
  const config = { extends: null, publish: null, npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    ...WINDOWS_BUILDER_HOOKS, forceCodeSigning: true,
    win: { signtoolOptions: { sign: callback, publisherName: "Ferrox Labs, LLC", signingHashAlgorithms: ["sha256"] } } };
  const f = { root, config, file: path.join(root, "builder.json"), files: [callback, ...Object.values(WINDOWS_BUILDER_HOOKS)].map(file => ({ path: file })) };
  f.write = () => { fs.writeFileSync(f.file, JSON.stringify(f.config)); f.expected = peSha256(fs.readFileSync(f.file)); };
  f.read = () => readWindowsSigningBuilderConfig(f.file, f.expected, { projectDir: f.root, env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" }, files: f.files });
  f.write(); return f;
}
it("accepts only authenticated flat JSON with static hooks and all dependency rebuilding disabled", async () => {
  const f = builderConfigFixture(); await expect(f.read()).resolves.toEqual(f.config);
});
export const builderConfigViolations = [
  ["relative config", f => { f.file = path.relative(process.cwd(), f.file); }],
  ["executable config extension", f => { f.file = path.join(f.root, "builder.cjs"); f.write(); }],
  ["config digest", f => { fs.appendFileSync(f.file, " "); }],
  ["missing extends null", f => { delete f.config.extends; f.write(); }],
  ["JavaScript extends", f => { f.config.extends = "./inherited.cjs"; f.write(); }],
  ["array extends", f => { f.config.extends = ["./inherited.cjs"]; f.write(); }],
  ["publishing discovery", f => { delete f.config.publish; f.write(); }],
  ...["npmRebuild", "nodeGypRebuild", "buildDependenciesFromSource"].flatMap(key => [
    [key + " enabled", f => { f.config[key] = true; f.write(); }],
    [key + " unspecified", f => { delete f.config[key]; f.write(); }],
  ]),
  ...["beforeBuild", "appxManifestCreated", "msiProjectCreated", "artifactBuildStarted", "artifactBuildCompleted", "onNodeModuleFile"].map(key =>
    ["extra executable " + key, f => { f.config[key] = "./unapproved.cjs"; f.write(); }]),
  ...Object.keys(WINDOWS_BUILDER_HOOKS).flatMap(key => [
    ["missing " + key, f => { delete f.config[key]; f.write(); }],
    ["substituted " + key, f => { f.config[key] = path.join(f.root, "unapproved.cjs"); f.write(); }],
    ["unenrolled " + key, f => { f.files = f.files.filter(row => row.path !== WINDOWS_BUILDER_HOOKS[key]); }],
  ]),
  ["unenrolled signing callback", f => { f.files = f.files.filter(row => row.path !== callback); }],
];
it.each(builderConfigViolations)("rejects %s before builder configuration loading", async (_name, mutate) => {
  const f = builderConfigFixture(); mutate(f); await expect(f.read()).rejects.toThrow("WINDOWS_SIGNING_BUILDER_CONFIG_REJECTED");
});
it.each(["valid", "extends", "hook"])("production driver uses the real locked builder config loader without executing a candidate config: %s", mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driver-config-")); roots.push(root);
  const result = spawnSync(process.execPath, ["scripts/fixtures/windows-builder-config.mjs", root, mode], {
    encoding: "utf8", timeout: 30_000, shell: false, env: { NODE_OPTIONS: "", PATH: "" } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const counts = JSON.parse(result.stdout.trim().split("\n").at(-1));
  expect(counts.credentialLeaks).toBe(0); expect(counts.providerRuns).toBe(0);
  expect(counts.validations).toBe(mode === "valid" ? 1 : 0);
});
it("keeps authenticated config loading while applying the signed GEPA projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driver-config-")); roots.push(root);
  const result = spawnSync(process.execPath, ["scripts/fixtures/windows-builder-config.mjs", root, "projection"], {
    encoding: "utf8", timeout: 30_000, shell: false, env: { NODE_OPTIONS: "", PATH: "" } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const counts = JSON.parse(result.stdout.trim().split("\n").at(-1));
  expect(counts.validations).toBe(1); expect(counts.finalized).toBe(1);
  expect(counts.credentialLeaks).toBe(0); expect(counts.providerRuns).toBe(0);
});
