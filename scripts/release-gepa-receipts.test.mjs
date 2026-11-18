// Static assertions over release.yml's GEPA build receipts.
//
// release.yml used to have no GEPA step at all while scripts/after-pack.mjs
// refused to package without a per-target manifest hash, so a release run
// could only fail after the signed builds started. These assert, by parsing
// the workflow, that every platform job builds and pins the worker before
// packaging, that only the Intel Mac opts out (build-mac.py builds the
// runner's own arch and the release runner is arm64), and that the evidence
// artifacts never merge into the assembled asset set.
//
// Kept separate from release-workflows.test.mjs, which has not collected
// since ci.yml renamed its `test` job (40d9027d) and would hide these.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { assertSigningWorkflowIsolation, signingWorkflows } from "./fixtures/windows-signing-workflows.mjs";

const workflows = join(dirname(dirname(fileURLToPath(import.meta.url))), ".github", "workflows");
const source = readFileSync(join(workflows, "release.yml"), "utf8");
const release = parse(source);
const runs = (job) => release.jobs[job].steps.map((step) => String(step.run ?? "")).join("\n");

describe("release.yml GEPA receipts", () => {
  it("builds, pins and packages the memory worker on every platform job", () => {
    expect(runs("mac")).toContain("native/gepa/build-mac.py");
    expect(runs("mac")).toContain("--config.extraMetadata.murageGepaManifests.darwin-arm64=$gepa_hash");
    // Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped; controller-admitted signing + SAC qualification are the first post-release item.
    // The worker is built in the windows job itself, as in 1.0.18; the build step still receives no Azure credentials.
    const workerJobs = Object.entries(release.jobs).filter(([, job]) => job.steps?.some(step => step.run?.includes("native/gepa/build-windows.py")));
    expect(workerJobs.map(([name]) => name)).toEqual(["windows"]);
    const workerBuild = workerJobs[0][1].steps.find(step => step.run?.includes("native/gepa/build-windows.py"));
    expect(JSON.stringify(workerBuild)).not.toMatch(/AZURE_/);
    expect(runs("windows")).toContain("--config.extraMetadata.murageGepaManifests.win32-x64=$hash");
    expect(runs("linux")).toContain("native/gepa/build-linux.py");
    expect(runs("linux")).toContain("--config.extraMetadata.murageGepaManifests.linux-x64=$gepa_hash");
  });

  it("signs the Windows worker before freezing its manifest, as package-win.yml does", () => {
    // Option A (Sean 2026-11-18T06:42Z): all workflows keep Azure credentials to the 1.0.18 placement and prohibit every other one.
    assertSigningWorkflowIsolation(signingWorkflows());
    const steps = release.jobs.windows.steps.map((step) => step.name ?? step.uses ?? "");
    const build = steps.findIndex((name) => name.startsWith("Build unsigned pinned GEPA worker"));
    const sign = steps.findIndex((name) => name.startsWith("Sign GEPA native images"));
    const freeze = steps.findIndex((name) => name.startsWith("Verify signed GEPA runtime"));
    const pack = steps.findIndex((name) => name.startsWith("Package (Azure Trusted Signing)"));
    expect(build).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(build);
    expect(freeze).toBeGreaterThan(sign);
    expect(pack).toBeGreaterThan(freeze);
  });

  it("opts the Intel Mac out explicitly, and only the Intel Mac", () => {
    const optOuts = [...source.matchAll(/murageGepaManifests\.([\w-]+)=unavailable/g)].map((m) => m[1]);
    expect(optOuts).toEqual(["darwin-x64"]);
    expect(runs("mac")).toContain('test ! -e "$x64/gepa-worker"');
  });

  it("hands the pinned commit to every source-verifying GEPA build", () => {
    for (const job of ["mac", "linux"]) {
      const build = release.jobs[job].steps.find((step) => String(step.run ?? "").includes("native/gepa/build-"));
      expect(build.env.SOURCE_SHA, job).toBe("${{ needs.prepare.outputs.sha }}");
    }
  });

  it("uses the same pinned actions as the package-*.yml workflows", () => {
    const win = readFileSync(join(workflows, "package-win.yml"), "utf8");
    for (const action of ["actions/setup-python@", "Azure/artifact-signing-action@"]) {
      const pin = win.match(new RegExp(`${action}[0-9a-f]{40}`))[0];
      expect(source, action).toContain(pin);
    }
    // Option A (Sean 2026-11-18T06:42Z): the pinned Azure action signs the GEPA images directly, as 1.0.18 did; the controller's
    // windows-gepa-ci.mjs entry is not called. The two-parameter verifier then refuses any image without our timestamped signature.
    for (const content of [source, win]) {
      expect(content).not.toContain("node scripts/windows-gepa-ci.mjs");
      // The 1.0.18 action call signs the whole worker tree (nested .dll/.pyd too); the verifier below walks the same tree
      // recursively and refuses any image left unsigned. The controller-era ban on recursion applied to its own driver only.
      expect(content).toContain("files-folder-recurse: true"); expect(content).toContain("files-folder-filter: exe,dll,pyd");
      expect(content).toMatch(/verify-windows\.ps1 -Bundle \S+ -Receipt \S+\s*\n/);
      expect(content).not.toContain("-SigningManifest");
    }
    const verifier = readFileSync(join(workflows, "..", "..", "native", "gepa", "verify-windows.ps1"), "utf8");
    expect(verifier).not.toContain("SigningManifest");
    expect(verifier).toContain("if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw");
    expect(verifier).toContain("if ($publisher -ne 'Ferrox Labs, LLC') { throw");
  });

  it("keeps evidence artifacts out of the assembled asset set", () => {
    const download = release.jobs.stage.steps.find((step) => String(step.uses).startsWith("actions/download-artifact"));
    expect(download.with.pattern).toBe("*-release");
    for (const job of ["mac", "windows", "linux"]) {
      const names = release.jobs[job].steps
        .filter((step) => String(step.uses).startsWith("actions/upload-artifact"))
        .map((step) => step.with.name);
      expect(names.filter((name) => name.endsWith("-release")), job).toHaveLength(1);
      // Besides evidence, the mac job hands its x64 app to the native Intel
      // smoke job (mac-x64); that handoff never matches the "*-release" pattern.
      const handoffs = job === "mac" ? ["mac-x64-app-smoke"] : [];
      // Option A (Sean 2026-11-18T06:42Z): no SAC inventory artifact exists in 1.0.19; every non-release artifact is GEPA evidence.
      expect(names.filter((name) => !name.endsWith("-release") && !handoffs.includes(name)).every((name) => name.endsWith("-gepa-evidence")), job).toBe(true);
      expect(names).not.toContain("windows-sac-inventory");
    }
  });

  it("bounds notarization at the step, not only the job", () => {
    const notarize = release.jobs.mac.steps.find((step) => String(step.name).startsWith("Notarize"));
    expect(notarize["timeout-minutes"]).toBeGreaterThan(0);
    // every file is submitted first, then each is waited on with its own bound
    expect(notarize.run).toContain("notarytool wait");
    expect(notarize.run).toMatch(/notarytool wait[^\n]*--timeout \d+m/);
  });

  it("gives the GEPA-building jobs room for the 45-minute worker build", () => {
    expect(release.jobs.mac["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(release.jobs.windows["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(release.jobs.linux["timeout-minutes"]).toBeGreaterThanOrEqual(90);
  });

  it("keeps release credentials out of every build and preparation job", () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name !== 'assemble') expect(JSON.stringify(job)).not.toContain('RELEASES_PAT');
    }
    expect(release.jobs.assemble.steps.some(step => step.run === 'node scripts/release-guard.mjs wait-stage')).toBe(true);
    expect(release.jobs.stage.permissions.contents).toBe('read');
  });
});
