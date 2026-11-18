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
it("RED both Windows workflows expose credentials only to the isolated driver, never a full package chain", () => {
  const workflows = signingWorkflows();
  // MAIN RULING 1115-WINSAC-WF: exactly one fresh protected job per Windows workflow; all other workflows are credential-free.
  assertSigningWorkflowIsolation(workflows);
  for (const [file, original] of [["release.yml", "windows"], ["package-win.yml", "package"]]) {
    const config = workflows[file];
    const signing = Object.entries(config.jobs).find(([, job]) => job.steps?.some(step => step.env?.AZURE_CLIENT_SECRET));
    const [name, job] = signing;
    // MAIN RULING 1115-WINSAC-WF: the signing job is separate from the original package/windows job.
    expect(name).not.toBe(original);
    const dependencies = typeof job.needs === "string" ? [job.needs] : job.needs;
    const preparation = dependencies.map(name => config.jobs[name]).find(job => job.steps?.some(step => step.run?.includes("windows-signing-provider.mjs")));
    // MAIN RULING 1115-WINSAC-WF: credential-free preparation and tool staging are in an earlier dependency job.
    expect(preparation).toBeDefined();
    // MAIN RULING 1115-WINSAC-WF: no Azure credentials reach the preparation job.
    expect(JSON.stringify(preparation)).not.toContain("secrets.AZURE_");
    // MAIN RULING 1115-WINSAC-WF: preparation stages tools before the protected job.
    expect(preparation.steps.some(step => step.run?.includes("windows-signing-prepare.mjs"))).toBe(true);
    expect(JSON.stringify(config.jobs[original].env ?? {})).not.toContain("secrets.AZURE_");
    expect(JSON.stringify(config.env ?? {})).not.toContain("secrets.AZURE_");
  }
});

it("accepts the neutral single-driver workflow placement fixture without claiming runner approval", () => {
  // MAIN RULING 1115-WINSAC-WF: the workflow checks are independently exercised before their refusal mutants.
  expect(() => assertSigningWorkflowIsolation(signingWorkflowFixture())).not.toThrow();
});
it.each(signingWorkflowViolations)("refuses workflow mutation %s", (_name, mutate) => {
  const workflows = signingWorkflowFixture(); mutate(workflows);
  // MAIN RULING 1115-WINSAC-WF: every new workflow negative rejects independently, including a second secret-bearing step.
  expect(() => assertSigningWorkflowIsolation(workflows)).toThrow();
});
