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

const workflows = join(dirname(dirname(fileURLToPath(import.meta.url))), ".github", "workflows");
const source = readFileSync(join(workflows, "release.yml"), "utf8");
const release = parse(source);
const runs = (job) => release.jobs[job].steps.map((step) => String(step.run ?? "")).join("\n");

describe("release.yml GEPA receipts", () => {
  it("builds, pins and packages the memory worker on every platform job", () => {
    expect(runs("mac")).toContain("native/gepa/build-mac.py");
    expect(runs("mac")).toContain("--config.extraMetadata.murageGepaManifests.darwin-arm64=$gepa_hash");
    expect(runs("windows")).toContain("native/gepa/build-windows.py");
    expect(runs("windows")).toContain("--config.extraMetadata.murageGepaManifests.win32-x64=$hash");
    expect(runs("linux")).toContain("native/gepa/build-linux.py");
    expect(runs("linux")).toContain("--config.extraMetadata.murageGepaManifests.linux-x64=$gepa_hash");
  });

  it("signs the Windows worker before freezing its manifest, as package-win.yml does", () => {
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
  });

  it("keeps evidence artifacts out of the assembled asset set", () => {
    const download = release.jobs.assemble.steps.find((step) => String(step.uses).startsWith("actions/download-artifact"));
    expect(download.with.pattern).toBe("*-release");
    for (const job of ["mac", "windows", "linux"]) {
      const names = release.jobs[job].steps
        .filter((step) => String(step.uses).startsWith("actions/upload-artifact"))
        .map((step) => step.with.name);
      expect(names.filter((name) => name.endsWith("-release")), job).toHaveLength(1);
      expect(names.filter((name) => !name.endsWith("-release")).every((name) => name.endsWith("-gepa-evidence")), job).toBe(true);
    }
  });

  it("bounds notarization at the step, not only the job", () => {
    const notarize = release.jobs.mac.steps.find((step) => String(step.name).startsWith("Notarize"));
    expect(notarize["timeout-minutes"]).toBeGreaterThan(0);
    expect(notarize.run).toContain("--wait --timeout");
  });

  it("gives the GEPA-building jobs room for the 45-minute worker build", () => {
    expect(release.jobs.mac["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(release.jobs.windows["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(release.jobs.linux["timeout-minutes"]).toBeGreaterThanOrEqual(90);
  });

  it("proves the release token can write before any signed build starts", () => {
    const probe = release.jobs.prepare.steps.find((step) => String(step.name).startsWith("Prove the release token"));
    expect(probe.if).toBe("steps.pin.outputs.should_release == 'true'");
    expect(probe.env.GH_TOKEN).toBe("${{ secrets.RELEASES_PAT }}");
    expect(probe.run).toContain("-F draft=true");
    expect(probe.run).toContain("--method DELETE");
  });
});
