// SPDX-License-Identifier: AGPL-3.0-or-later
// Every third-party action a workflow runs is pinned to a full commit sha, never a tag a
// publisher can move. scale-budget.yml writes the Hetzner root key and was the one left on
// tags (upstream 3a5935956's class).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  ...readdirSync(join(root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(".github/workflows", f)),
  ...readdirSync(join(root, ".github/actions")).map((d) => join(".github/actions", d, "action.yml")),
];

const workflows = files.filter(file => file.startsWith('.github/workflows/'));
const readYaml = file => parse(readFileSync(join(root, file), 'utf8'));

// Follow local composites before inspecting a job: bootstrap writes happen in
// the same RUNNER_TEMP as later workflow steps, including on Windows shards.
function expandSteps(steps, source, ancestors = []) {
  return steps.flatMap(step => {
    if (!step.uses?.startsWith('./')) return [{ step, source }];
    const file = posix.join(step.uses, 'action.yml');
    if (ancestors.includes(file)) throw Error(`Recursive local action: ${file}`);
    const action = readYaml(file);
    return [{ step, source, file }, ...expandSteps(action.runs.steps ?? [], file, [...ancestors, file])];
  });
}

// Local action dependencies include invoked Node scripts and their relative
// imports/data URLs. In particular, fetch-build-input reads build-inputs.json
// at module load time, before it can verify any downloaded bytes.
function localActionFiles(action) {
  const required = new Set();
  function addModule(file) {
    if (required.has(file)) return;
    required.add(file);
    const text = readFileSync(join(root, file), 'utf8');
    if (!/\.[cm]?[jt]s$/.test(file)) return;
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*|new URL\(\s*)["'](\.[^"']+)["']/g)) {
      addModule(posix.normalize(posix.join(dirname(file), match[1])));
    }
  }
  for (const { step, file } of expandSteps([{ uses: action }], action)) {
    if (file) required.add(file);
    for (const match of (step.run ?? '').matchAll(/\bnode\s+(?:--[\w-]+\s+)*["']?((?:scripts|shared)\/[\w./-]+\.[cm]?[jt]s)/g)) {
      addModule(match[1]);
    }
  }
  return [...required];
}

function sparseCheckoutErrors(workflow) {
  const errors = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    let sparse;
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        sparse = step.with?.['sparse-checkout']?.trim().split(/\s+/);
      }
      if (!sparse || !step.uses?.startsWith('./')) continue;
      for (const file of localActionFiles(step.uses)) {
        if (!sparse.some(entry => file === entry || file.startsWith(`${entry}/`))) {
          errors.push(`${jobId}: ${file} outside sparse-checkout`);
        }
      }
    }
  }
  return errors;
}

// Resolve the literal shell assignments used by pinned-input downloads. This
// deliberately treats conditional steps conservatively: two potential writes
// in one job must have distinct destinations. Jobs have separate temp folders.
function runnerTempWriterErrors(workflow) {
  const errors = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const writers = new Map();
    for (const { step, source } of expandSteps(job.steps ?? [], jobId)) {
      const variables = new Map();
      const resolve = value => value.replace(/^["']|["']$/g, '')
        .replace(/\$env:RUNNER_TEMP|\$\{RUNNER_TEMP\}|\$RUNNER_TEMP|\$\{\{\s*runner.temp\s*\}\}/gi, '<runner_temp>')
        .replace(/\$([\w]+)/g, (token, name) => variables.get(name.toLowerCase()) ?? token);
      for (const line of (step.run ?? '').split('\n')) {
        const assignment = /^\s*\$(\w+)\s*=\s*(.*)/.exec(line);
        if (assignment) {
          const [, name, value] = assignment;
          const path = /^Join-Path\s+(\S+)\s+(["'][^"']+["'])\s*$/.exec(value);
          if (path) variables.set(name.toLowerCase(), `${resolve(path[1])}/${resolve(path[2])}`);
          else if (/^["'][^"']*["']\s*$/.test(value)) variables.set(name.toLowerCase(), resolve(value.trim()));
        }
        const download = /\bnode\s+scripts\/fetch-build-input\.mjs\s+\S+\s+(["'][^"']+["']|\S+)/.exec(line);
        if (!download) continue;
        const destination = resolve(download[1]).replaceAll('\\', '/').toLowerCase();
        if (/\$/.test(destination)) throw Error(`${jobId}: unresolved download destination: ${download[1]}`);
        if (!destination.startsWith('<runner_temp>/')) continue;
        const previous = writers.get(destination);
        if (previous) errors.push(`${jobId}: two writers to ${destination}: ${previous}, ${source}`);
        writers.set(destination, source);
      }
    }
  }
  return errors;
}

describe("workflow action pins", () => {
  it.each(files)("%s pins every external action to a commit sha", (file) => {
    const unpinned = readFileSync(join(root, file), "utf8").split("\n")
      .map((line) => /^\s*-?\s*uses:\s*["']?([^\s"'#]+)/.exec(line)?.[1])
      .filter((ref) => ref && !ref.startsWith("./") && !ref.startsWith("docker://") && !/@[0-9a-f]{40}$/.test(ref));
    expect(unpinned).toEqual([]);
  });
});

it('Windows jobs bootstrap Node, a writable pnpm store and pinned PowerShell before their first command', () => {
  for (const file of ['ci.yml', 'package-win.yml']) {
    const workflow = parse(readFileSync(join(root, '.github/workflows', file), 'utf8'));
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? [];
      if (!steps.some(step => step.uses?.startsWith('pnpm/action-setup@'))) continue;
      const bootstrap = steps.findIndex(step => step.uses === './.github/actions/windows-ci-tools');
      expect(bootstrap).toBeGreaterThanOrEqual(0);
      expect(bootstrap).toBeLessThan(steps.findIndex(step => step.run));
      expect(steps[bootstrap].if).toBe("runner.os == 'Windows'");
    }
  }
  const action = parse(readFileSync(join(root, '.github/actions/windows-ci-tools/action.yml'), 'utf8'));
  expect(action.runs.steps[0].uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
  const setup = action.runs.steps[1];
  expect(setup.shell).toContain('-ExecutionPolicy Bypass');
  expect(setup.run).toContain("Join-Path $env:RUNNER_TEMP 'pnpm-store'");
  expect(setup.run).toContain('npm_config_store_dir=$store');
  expect(setup.run).toContain('node scripts/fetch-build-input.mjs D079 $archive');
  expect(setup.run).toContain('$env:GITHUB_PATH');
});

describe('local action checkout and pinned download contracts', () => {
  it.each(workflows)('%s includes local action files and dependencies in sparse checkouts', file => {
    expect(sparseCheckoutErrors(readYaml(file))).toEqual([]);
  });

  it.each(workflows)('%s has no two pinned-input writers to the same RUNNER_TEMP path', file => {
    expect(runnerTempWriterErrors(readYaml(file))).toEqual([]);
  });

  it('kills the ci-only sparse checkout mutant, including the downloader and its pins', () => {
    const workflow = readYaml('.github/workflows/package-win.yml');
    const checkout = workflow.jobs.stduser.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    checkout.with['sparse-checkout'] = 'ci';
    expect(sparseCheckoutErrors(workflow)).toEqual(expect.arrayContaining([
      'stduser: .github/actions/windows-ci-tools/action.yml outside sparse-checkout',
      'stduser: scripts/fetch-build-input.mjs outside sparse-checkout',
      'stduser: scripts/build-inputs.json outside sparse-checkout',
    ]));
  });

  it('kills the duplicate PowerShell archive writer mutant across composite and workflow steps', () => {
    const workflow = readYaml('.github/workflows/ci.yml');
    const fixture = workflow.jobs.vitest.steps.find(step => step.name === 'Provision required Windows command fixtures');
    fixture.run += `
      $fixtureVersion = '7.4.13'
      $fixtureArchive = Join-Path $env:RUNNER_TEMP "pwsh-$fixtureVersion.zip"
      node scripts/fetch-build-input.mjs D079 $fixtureArchive
    `;
    expect(runnerTempWriterErrors(workflow)).toEqual([
      'vitest: two writers to <runner_temp>/pwsh-7.4.13.zip: .github/actions/windows-ci-tools/action.yml, vitest',
    ]);
    // A separate destination or job does not collide with the bootstrap.
    fixture.run = fixture.run.replace('pwsh-$fixtureVersion.zip', 'pwsh-fixture-$fixtureVersion.zip');
    expect(runnerTempWriterErrors(workflow)).toEqual([]);
  });

  it('Windows command fixtures reuse the verified bootstrap and still check its version', () => {
    const fixture = readYaml('.github/workflows/ci.yml').jobs.vitest.steps
      .find(step => step.name === 'Provision required Windows command fixtures');
    expect(fixture.run).toContain('"pwsh-$fixtureVersion"');
    expect(fixture.run).toContain('$actual -ne $fixtureVersion');
    expect(fixture.run).toContain('Git Bash is required');
    expect(fixture.run).not.toContain('fetch-build-input.mjs');
    expect(fixture.run).not.toContain('Expand-Archive');
  });
});
