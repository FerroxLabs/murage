// Signing contract/tests owner: win-sac-sign; workflow credential injection and Windows proof owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { windowsBuilderSigning, preflightWindowsPackage, signWindowsPackageSource } from "./windows-builder-signing.mjs";
import { fixturePeSource, fixturePeTrust, fixtureRevision } from "./fixtures/windows-pe-provenance.mjs";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
import { assertSigningWorkflowIsolation, signingWorkflows, signingWorkflowFixture, signingWorkflowViolations } from "./fixtures/windows-signing-workflows.mjs";
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
it("RED captured stock signIf is unreachable; app policy uses only the injected pinned provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-provider-")); dirs.push(root);
  const file = path.join(root, "resources/engine-exclusion.node"); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, unsignedPeFixture());
  const pin = fixturePeSource("resources/engine-exclusion.node", fs.readFileSync(file), { kind: "build", component: "engine-exclusion", sourceRevision: fixtureRevision,
    inputs: [{ component: "source", sha256: "b".repeat(64) }], transformations: ["fixture compile"] });
  const stock = vi.fn(async () => { throw Error("STOCK_SIGNER_SENTINEL"); });
  const provider = vi.fn(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  const packager = { config: { extraMetadata: {} }, signIf: stock };
  const state = await windowsBuilderSigning({ appOutDir: root, arch: "x64", packager, windowsPeSigner: provider,
    windowsPeSources: [pin], windowsPeSourceRevision: fixtureRevision, signingTrust: fixturePeTrust });
  expect(packager.signIf).toBe(stock);
  await preflightWindowsPackage(state); await signWindowsPackageSource(state, pin);
  expect(stock).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledOnce();
});
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped; controller-admitted signing + SAC qualification are the first post-release item.
// MAIN RULING 1115-WINSAC-WF (fresh protected driver job, credential-free preparation job) is not in force for 1.0.19, so its
// job-shape assertions are retired here; the credential placement that 1.0.18 shipped is asserted instead.
it("RED both Windows workflows expose credentials only to the pinned signing action and the one package step of the Windows build job", () => {
  const workflows = signingWorkflows();
  assertSigningWorkflowIsolation(workflows);
  for (const [file, original] of [["release.yml", "windows"], ["package-win.yml", "package"]]) {
    const config = workflows[file];
    const holders = Object.entries(config.jobs).filter(([, job]) => JSON.stringify(job).includes("secrets.AZURE_")).map(([name]) => name);
    expect(holders).toEqual([original]);
    const steps = config.jobs[original].steps;
    const pack = steps.findIndex(step => step.env?.AZURE_CLIENT_SECRET);
    expect(steps[pack].run).toContain("pnpm package:win");
    // Fail closed: the installer signature gate runs unconditionally after the only credentialed package step.
    const gate = steps.findIndex(step => step.name === { "release.yml": "Gate: the installer must actually be signed", "package-win.yml": "Record installer identity and verify publisher" }[file]);
    expect(gate).toBeGreaterThan(pack);
    expect(steps[gate].if).toBeUndefined(); expect(steps[gate]["continue-on-error"]).toBeUndefined();
    expect(steps[gate].run).toContain("Get-AuthenticodeSignature"); expect(steps[gate].run).toContain("Ferrox Labs, LLC");
    expect(JSON.stringify(config.jobs[original].env ?? {})).not.toContain("secrets.AZURE_");
    expect(JSON.stringify(config.env ?? {})).not.toContain("secrets.AZURE_");
    // No controller job remains that could be mistaken for the signer.
    for (const name of ["windows-signing", "windows-preparation", "windows-sac-qualification"]) expect(config.jobs[name]).toBeUndefined();
  }
});

it("accepts the neutral in-job signing placement fixture without claiming runner approval", () => {
  // The workflow checks are independently exercised before their refusal mutants (Option A placement, Sean 2026-11-18T06:42Z).
  expect(() => assertSigningWorkflowIsolation(signingWorkflowFixture())).not.toThrow();
});
it.each(signingWorkflowViolations)("refuses workflow mutation %s", (_name, mutate) => {
  const workflows = signingWorkflowFixture(); mutate(workflows);
  // Every workflow negative rejects independently, including a second secret-bearing step and a skippable signing step.
  expect(() => assertSigningWorkflowIsolation(workflows)).toThrow();
});
