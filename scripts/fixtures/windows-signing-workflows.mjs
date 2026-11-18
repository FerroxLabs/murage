// Workflow assertions owner: win-sac-sign; runner configuration owner: MAIN.
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped; controller-admitted
// signing + SAC qualification are the first post-release item. MAIN RULING 1115-WINSAC-WF (one fresh protected
// driver job) is therefore not in force for 1.0.19. What this file still enforces is the 1.0.18 placement: Azure
// credentials reach only the Windows build job of package-win.yml and release.yml, there only the pinned Azure
// signing action and the one unconditional `pnpm package:win` step, and no other workflow, job or step.
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";

export const azureSigningKeys = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
export const azureSigningJobs = { "package-win.yml": "package", "release.yml": "windows" };
const actionInputs = { "azure-tenant-id": "AZURE_TENANT_ID", "azure-client-id": "AZURE_CLIENT_ID", "azure-client-secret": "AZURE_CLIENT_SECRET" };
const references = value => azureSigningKeys.some(key => JSON.stringify(value ?? {}).includes(`secrets.${key}`));
const credentials = value => azureSigningKeys.some(key => Object.hasOwn(value ?? {}, key)) || references(value);
export function signingWorkflows() {
  const directory = new URL("../../.github/workflows/", import.meta.url);
  return Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith(".yml"))
    .map(file => [file, parse(fs.readFileSync(new URL(file, directory), "utf8"))]));
}

export function assertSigningWorkflowIsolation(workflows) {
  for (const required of ["package-win.yml", "release.yml", "gepa-intel-qualification.yml"]) assert.ok(workflows[required], required);
  for (const [file, workflow] of Object.entries(workflows)) {
    const unprotected = structuredClone(workflow);
    assert.ok(!credentials(workflow.env), `${file}: workflow Azure env`);
    const visit = value => {
      if (!value || typeof value !== "object") return;
      assert.notEqual(value.secrets, "inherit", `${file}: secrets inherit`);
      for (const child of Object.values(value)) visit(child);
    };
    visit(workflow);
    const actions = [], packages = [];
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      assert.ok(!credentials(job.env), `${file}: job Azure env`);
      assert.ok(!references(job.secrets), `${file}: reusable job Azure secrets`);
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!credentials(step.env) && !references(step)) continue;
        assert.equal(name, azureSigningJobs[file], `${file}: Azure reference outside the Windows build job`);
        // A signing step that may be skipped or may fail quietly is an unsigned-installer path.
        assert.ok(step.if === undefined && step["continue-on-error"] === undefined, `${file}: conditional or ignorable signing step`);
        if (step.uses !== undefined) {
          assert.match(step.uses, /^Azure\/artifact-signing-action@[0-9a-f]{40}$/, `${file}: pinned Azure signing action`);
          assert.ok(!credentials(step.env), `${file}: action env credentials`);
          for (const [input, key] of Object.entries(actionInputs)) assert.equal(step.with?.[input], `\${{ secrets.${key} }}`, `${file}: ${input} secret source`);
          const rest = structuredClone(step); for (const input of Object.keys(actionInputs)) delete rest.with[input];
          assert.ok(!references(rest), `${file}: Azure reference outside the action credentials`);
          for (const input of Object.keys(actionInputs)) delete unprotected.jobs[name].steps[index].with[input];
          actions.push(step);
        } else {
          for (const key of azureSigningKeys) assert.equal(step.env?.[key], `\${{ secrets.${key} }}`, `${file}: ${key} secret source`);
          const others = Object.keys(step.env).filter(key => !azureSigningKeys.includes(key));
          assert.ok(others.every(key => key === "NODE_OPTIONS" && /^--max-old-space-size=\d+$/.test(step.env[key])), `${file}: exact protected env`);
          const outsideEnv = { ...step }; delete outsideEnv.env;
          assert.ok(!references(outsideEnv), `${file}: Azure reference outside step env`);
          assert.ok(typeof step.run === "string" && step.run.includes("pnpm package:win"), `${file}: credentials outside the package step`);
          assert.ok(!/windows-gepa-ci\.mjs|GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|forceCodeSigning|--dir\b|CSC_/.test(step.run), `${file}: package step changes signing or exports credentials`);
          delete unprotected.jobs[name].steps[index].env;
          packages.push(step);
        }
      }
    }
    const expected = Object.hasOwn(azureSigningJobs, file) ? 1 : 0;
    assert.equal(actions.length, expected, `${file}: Azure signing action count`);
    assert.equal(packages.length, expected, `${file}: credentialed package step count`);
    assert.ok(!references(unprotected), `${file}: Azure reference outside protected placement`);
  }
}

export function signingWorkflowFixture() {
  const workflows = { "gepa-intel-qualification.yml": { jobs: { fixture: { steps: [] } } }, "other.yml": { jobs: {} } };
  for (const [file, name] of Object.entries(azureSigningJobs)) workflows[file] = { jobs: { [name]: { steps: [
    { uses: `Azure/artifact-signing-action@${"a".repeat(40)}`, with: { "azure-tenant-id": "${{ secrets.AZURE_TENANT_ID }}",
      "azure-client-id": "${{ secrets.AZURE_CLIENT_ID }}", "azure-client-secret": "${{ secrets.AZURE_CLIENT_SECRET }}", "files-folder": "fixture" } },
    { run: "pnpm package:win", env: { NODE_OPTIONS: "--max-old-space-size=6144", ...Object.fromEntries(azureSigningKeys.map(key => [key, `\${{ secrets.${key} }}`])) } },
  ] } } };
  return workflows;
}

const job = (workflows, file) => workflows[file].jobs[azureSigningJobs[file]];
export const signingWorkflowViolations = [
  ...Object.keys(azureSigningJobs).flatMap(file => [
    [`${file} duplicate credentialed package step`, workflows => job(workflows, file).steps.push(structuredClone(job(workflows, file).steps[1]))],
    [`${file} duplicate signing action`, workflows => job(workflows, file).steps.push(structuredClone(job(workflows, file).steps[0]))],
    [`${file} missing credentialed package step`, workflows => job(workflows, file).steps.pop()],
    [`${file} missing signing action`, workflows => job(workflows, file).steps.shift()],
    [`${file} conditional package step`, workflows => job(workflows, file).steps[1].if = "false"],
    [`${file} ignorable package step`, workflows => job(workflows, file).steps[1]["continue-on-error"] = true],
    [`${file} conditional signing action`, workflows => job(workflows, file).steps[0].if = "false"],
    [`${file} ignorable signing action`, workflows => job(workflows, file).steps[0]["continue-on-error"] = true],
    [`${file} unpinned signing action`, workflows => job(workflows, file).steps[0].uses = "Azure/artifact-signing-action@v2"],
    [`${file} foreign signing action`, workflows => job(workflows, file).steps[0].uses = `fixture/other-action@${"a".repeat(40)}`],
    [`${file} credentials moved to another job`, workflows => { const jobs = workflows[file].jobs; jobs.other = jobs[azureSigningJobs[file]]; delete jobs[azureSigningJobs[file]]; }],
    [`${file} credentials without packaging`, workflows => job(workflows, file).steps[1].run = "node fixture.mjs"],
    [`${file} unsigned package override`, workflows => job(workflows, file).steps[1].run += " --config.forceCodeSigning=false"],
    [`${file} unpacked-only package`, workflows => job(workflows, file).steps[1].run += " --dir"],
    [`${file} extra env`, workflows => job(workflows, file).steps[1].env.FIXTURE = "1"],
    [`${file} preload NODE_OPTIONS`, workflows => job(workflows, file).steps[1].env.NODE_OPTIONS = "--require=fixture.cjs"],
  ]),
  ...["gepa-intel-qualification.yml", "other.yml"].flatMap(file => [
    [`${file} credentialed package step`, workflows => workflows[file].jobs.fixture = { steps: [structuredClone(job(workflows, "package-win.yml").steps[1])] }],
    [`${file} signing action`, workflows => workflows[file].jobs.fixture = { steps: [structuredClone(job(workflows, "package-win.yml").steps[0])] }],
  ]),
  ...azureSigningKeys.flatMap(key => [
    [`${key} second step`, workflows => job(workflows, "package-win.yml").steps.push({ run: "fixture", env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} release second step`, workflows => job(workflows, "release.yml").steps.push({ run: "fixture", env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} Intel workflow`, workflows => workflows["gepa-intel-qualification.yml"].jobs.fixture.steps.push({ env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} other workflow`, workflows => workflows["other.yml"].jobs.fixture = { steps: [{ env: { [key]: `\${{ secrets.${key} }}` } }] }],
    [`${key} workflow env`, workflows => workflows["package-win.yml"].env = { [key]: `\${{ secrets.${key} }}` }],
    [`${key} job env`, workflows => job(workflows, "release.yml").env = { [key]: `\${{ secrets.${key} }}` }],
    [`${key} outside env`, workflows => job(workflows, "package-win.yml").steps[1].run += `\nWrite-Output '\${{ secrets.${key} }}'`],
    [`${key} missing from package step`, workflows => delete job(workflows, "release.yml").steps[1].env[key]],
    [`${key} literal in package step`, workflows => job(workflows, "release.yml").steps[1].env[key] = "fixture"],
    [`${key} GEPA entry`, workflows => job(workflows, "package-win.yml").steps[1].run = "pnpm package:win; node scripts/windows-gepa-ci.mjs"],
    [`${key} exported`, workflows => job(workflows, "package-win.yml").steps[1].run += `\n"${key}=$env:${key}" >> $env:GITHUB_ENV`],
  ]),
  ["missing action credential", workflows => delete job(workflows, "release.yml").steps[0].with["azure-client-secret"]],
  ["action credential in another input", workflows => job(workflows, "release.yml").steps[0].with["files-folder"] = "${{ secrets.AZURE_CLIENT_SECRET }}"],
  ["secrets inherit", workflows => workflows["other.yml"].jobs.fixture = { uses: "./fixture.yml", secrets: "inherit" }],
  ["Azure reference in workflow metadata", workflows => workflows["other.yml"].name = "${{ secrets.AZURE_CLIENT_SECRET }}"],
  ["reusable Azure secrets", workflows => workflows["other.yml"].jobs.fixture = { uses: "./fixture.yml", secrets: { secret: "${{ secrets.AZURE_CLIENT_SECRET }}" } }],
];
