// Workflow assertions owner: win-sac-sign; runner configuration and launch-boundary proof owner: MAIN.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const azureSigningKeys = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const references = value => azureSigningKeys.some(key => JSON.stringify(value ?? {}).includes(`secrets.${key}`));
const credentials = value => azureSigningKeys.some(key => Object.hasOwn(value ?? {}, key)) || references(value);
export function signingWorkflows() {
  const directory = new URL("../../.github/workflows/", import.meta.url);
  return Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith(".yml"))
    .map(file => [file, parse(fs.readFileSync(new URL(file, directory), "utf8"))]));
}

// MAIN RULING 1115-WINSAC-WF: YAML placement is required separately from MAIN's pre-secret launch-boundary proof.
export function assertSigningWorkflowIsolation(workflows) {
  for (const required of ["package-win.yml", "release.yml", "gepa-intel-qualification.yml"]) assert.ok(workflows[required], required);
  for (const [file, workflow] of Object.entries(workflows)) {
    const unprotected = structuredClone(workflow);
    assert.ok(!credentials(workflow.env), `${file}: workflow Azure env`);
    const protectedSteps = [];
    const visit = value => {
      if (!value || typeof value !== "object") return;
      assert.notEqual(value.secrets, "inherit", `${file}: secrets inherit`);
      for (const child of Object.values(value)) visit(child);
    };
    visit(workflow);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      assert.ok(!credentials(job.env), `${file}: job Azure env`);
      assert.ok(!references(job.secrets), `${file}: reusable job Azure secrets`);
      for (const step of job.steps ?? []) {
        if (!credentials(step.env)) {
          assert.ok(!references(step), `${file}: Azure reference outside step env`);
          continue;
        }
        assert.deepEqual(Object.keys(step.env).sort(), [...azureSigningKeys].sort(), `${file}: exact protected env`);
        for (const key of azureSigningKeys) assert.equal(step.env[key], `\${{ secrets.${key} }}`, `${file}: ${key} secret source`);
        const outsideEnv = { ...step }; delete outsideEnv.env;
        assert.ok(!references(outsideEnv), `${file}: Azure reference outside step env`);
        protectedSteps.push({ name, job, step });
        const index = job.steps.indexOf(step);
        delete unprotected.jobs[name].steps[index].env;
      }
    }
    const expected = ["package-win.yml", "release.yml"].includes(file) ? 1 : 0;
    assert.equal(protectedSteps.length, expected, `${file}: protected step count`);
    assert.ok(!references(unprotected), `${file}: Azure reference outside protected env`);
    for (const { name, job, step } of protectedSteps) {
      assert.ok(!["package", "windows"].includes(name), `${file}: fresh signing job`);
      assert.ok(!JSON.stringify(job).includes("pnpm package:win"), `${file}: protected package chain`);
      assert.ok(!Object.hasOwn(workflow.env ?? {}, "NODE_OPTIONS") && !Object.hasOwn(job.env ?? {}, "NODE_OPTIONS"), `${file}: inherited NODE_OPTIONS`);
      const shell = /^"?([A-Za-z]:\\[^"\r\n]*\\pwsh\.exe)"? -NoProfile -NonInteractive -File \{0\}$/.exec(step.shell ?? "");
      assert.ok(shell && path.win32.isAbsolute(shell[1]), `${file}: absolute pinned pwsh shell`);
      assert.ok(JSON.stringify(job).includes("vars.WINDOWS_SIGNING_LAUNCH_SHA256"), `${file}: trusted configuration pin`);
      assert.ok(typeof step.run === "string" && step.run.includes("windows-signing-driver.mjs"), `${file}: protected driver`);
      assert.ok(!/windows-gepa-ci\.mjs|NODE_OPTIONS|GITHUB_PATH|GITHUB_ENV|GITHUB_OUTPUT|(?:^|[\s;&|])(?:node(?:\.exe)?|pwsh(?:\.exe)?|pnpm(?:\.cmd)?)(?=[\s;]|$)|Get-Command|where(?:\.exe)?\s/i.test(step.run), `${file}: ambient executable or environment resolution`);
      assert.match(step.run, /^(?:\$ErrorActionPreference = 'Stop'\r?\n)?& '[A-Za-z]:\\[^'\r\n]*\\node\.exe' (?:--max-old-space-size=\d+ )?'[A-Za-z]:\\[^'\r\n]*\\windows-signing-driver\.mjs'(?:\r?\nexit \$LASTEXITCODE)?\s*$/, `${file}: only the absolute node driver invocation`);
    }
  }
}

export function signingWorkflowFixture() {
  const workflows = { "gepa-intel-qualification.yml": { jobs: { fixture: { steps: [] } } }, "other.yml": { jobs: {} } };
  for (const file of ["package-win.yml", "release.yml"]) workflows[file] = { jobs: { preparation: { steps: [] }, signing: {
    needs: ["preparation"], steps: [
      { env: { MURAGE_WINDOWS_SIGNING_LAUNCH_SHA256: "${{ vars.WINDOWS_SIGNING_LAUNCH_SHA256 }}" }, run: "fixture bootstrap" },
      { shell: 'C:\\FixtureTools\\pwsh.exe -NoProfile -NonInteractive -File {0}',
        run: "& 'C:\\FixtureTools\\node.exe' 'C:\\FixtureTools\\windows-signing-driver.mjs'",
        env: Object.fromEntries(azureSigningKeys.map(key => [key, `\${{ secrets.${key} }}`])) },
    ],
  } } };
  return workflows;
}

export const signingWorkflowViolations = [
  ...["package-win.yml", "release.yml"].map(file => [`${file} duplicate complete protected step`, workflows =>
    workflows[file].jobs.signing.steps.push(structuredClone(workflows[file].jobs.signing.steps[1]))]),
  ...["gepa-intel-qualification.yml", "other.yml"].map(file => [`${file} complete protected step`, workflows =>
    workflows[file].jobs.fixture = { steps: [structuredClone(workflows["package-win.yml"].jobs.signing.steps[1])] }]),
  ...azureSigningKeys.flatMap(key => [
    [`${key} second step`, workflows => workflows["package-win.yml"].jobs.signing.steps.push({ env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} release second step`, workflows => workflows["release.yml"].jobs.signing.steps.push({ env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} Intel workflow`, workflows => workflows["gepa-intel-qualification.yml"].jobs.fixture.steps.push({ env: { [key]: `\${{ secrets.${key} }}` } })],
    [`${key} other workflow`, workflows => workflows["other.yml"].jobs.fixture = { steps: [{ env: { [key]: `\${{ secrets.${key} }}` } }] }],
    [`${key} workflow env`, workflows => workflows["package-win.yml"].env = { [key]: `\${{ secrets.${key} }}` }],
    [`${key} job env`, workflows => workflows["release.yml"].jobs.signing.env = { [key]: `\${{ secrets.${key} }}` }],
    [`${key} outside env`, workflows => workflows["package-win.yml"].jobs.signing.steps[1].run += `\nWrite-Output '\${{ secrets.${key} }}'`],
    [`${key} GEPA entry`, workflows => workflows["package-win.yml"].jobs.signing.steps[1].run = "node scripts/windows-gepa-ci.mjs"],
  ]),
  ["secrets inherit", workflows => workflows["other.yml"].jobs.fixture = { uses: "./fixture.yml", secrets: "inherit" }],
  ["missing protected step", workflows => workflows["release.yml"].jobs.signing.steps.pop()],
  ["missing package protected step", workflows => workflows["package-win.yml"].jobs.signing.steps.pop()],
  ["Azure reference in workflow metadata", workflows => workflows["other.yml"].name = "${{ secrets.AZURE_CLIENT_SECRET }}"],
  ["reusable Azure secrets", workflows => workflows["other.yml"].jobs.fixture = { uses: "./fixture.yml", secrets: { secret: "${{ secrets.AZURE_CLIENT_SECRET }}" } }],
  ["original signing job", workflows => { const jobs = workflows["release.yml"].jobs; jobs.windows = jobs.signing; delete jobs.signing; }],
  ["protected package chain", workflows => workflows["release.yml"].jobs.signing.steps[1].run += "\npnpm package:win"],
  ...["pwsh", "pwsh.exe", "relative\\pwsh.exe -NoProfile -NonInteractive -File {0}",
    "C:\\FixtureTools\\pwsh.exe -NonInteractive -File {0}", "C:\\FixtureTools\\pwsh.exe -NoProfile -File {0}",
    "C:\\FixtureTools\\pwsh.exe -NoProfile -NonInteractive {0}"].map(shell =>
    [`shell ${shell}`, workflows => workflows["package-win.yml"].jobs.signing.steps[1].shell = shell]),
  ["missing trusted pin", workflows => delete workflows["release.yml"].jobs.signing.steps[0].env],
  ...["workflow", "job", "step"].map(scope => [`${scope} NODE_OPTIONS`, workflows => {
    const workflow = workflows["package-win.yml"], job = workflow.jobs.signing;
    const target = scope === "workflow" ? workflow : scope === "job" ? job : job.steps[1];
    target.env = { ...target.env, NODE_OPTIONS: "--require=fixture.cjs" };
  }]),
  ...["node", "pwsh", "pnpm"].map(command => [`PATH ${command}`, workflows => workflows["package-win.yml"].jobs.signing.steps[1].run += `\n${command} fixture`]),
  ...["node.exe", "pwsh.exe", "pnpm.cmd"].map(command => [`quoted PATH ${command}`, workflows => workflows["release.yml"].jobs.signing.steps[1].run += `\n& '${command}' fixture`]),
  ["indirect PATH invocation", workflows => workflows["release.yml"].jobs.signing.steps[1].run += "\n& $env:SIGNING_NODE fixture"],
  ["relative node", workflows => workflows["release.yml"].jobs.signing.steps[1].run = "& '.\\node.exe' 'windows-signing-driver.mjs'"],
  ["resolved absolute PATH result", workflows => workflows["release.yml"].jobs.signing.steps[1].run += "\n& (Get-Command node).Source fixture"],
  ...["GITHUB_PATH", "GITHUB_ENV", "GITHUB_OUTPUT", "NODE_OPTIONS"].map(key =>
    [key, workflows => workflows["package-win.yml"].jobs.signing.steps[1].run += `\n$env:${key} = 'fixture'`]),
];
