import { gitFixture } from '../server/testing/git-fixture.mjs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { stringify, parse } from 'yaml';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditReleaseCapabilities, RELEASE_WORKFLOW as file, RELEASE_ACTIONS, RELEASE_COMMANDS } from './release-capability-audit.mjs';
import { BROWSER_ASSEMBLY_WORKFLOW, DRAFT_ASSEMBLY_REASON } from './release-assembly-inventory.mjs';
import { interpreterInvocations } from './release-interpreter-invocations.mjs';
let root, repository;
beforeAll(() => { repository = gitFixture(); root = repository.root; }, 120_000);
afterAll(() => repository?.dispose());
const clean = () => parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'));
function audit(doc, extras=[]) {
  const others=['.github/workflows/prepare-release.yml','.github/workflows/cla.yml'].map(name=>[name,readFileSync(new URL(`../${name}`,import.meta.url),'utf8')]);
  return auditReleaseCapabilities(root, new Map([[file,stringify(doc)],...others,...extras]), [file,...others.map(([name])=>name),...extras.map(([name])=>name)]);
}
it('all workflow and local action credentials obey the capability boundary', () => {
  const report = auditReleaseCapabilities(root);
  console.log('RELEASE_CAPABILITIES', JSON.stringify(report));
  expect(report.errors).toEqual([]);
  expect(report.workflows.length).toBeGreaterThan(20);
});
// MAIN 2026-11-11 11:15Z: draft-only vendor work is permitted assembly.
// Publication stays with release.yml; the reviewed job must retain these properties.
it('vendor assembly creates drafts and uploads only after refusing a non-draft tag', () => {
  const job = parse(readFileSync(new URL(`../${BROWSER_ASSEMBLY_WORKFLOW}`, import.meta.url), 'utf8')).jobs['draft-release'];
  const runs = job.steps.filter(step => step.run).map(step => step.run.replace(/\\\n/g, ' '));
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    const creates = run.match(/^\s*gh release create[^\n]+/gm) ?? [];
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/\s--draft(?:\s|$)/);
  }
  const upload = runs[0].indexOf('gh release upload');
  const refusal = runs[0].indexOf('[ "$(gh release view "$tag" --json isDraft -q .isDraft)" = "true" ] || { echo "release $tag exists and is not a DRAFT: refusing"; exit 1; }');
  expect(refusal).toBeGreaterThan(-1);
  expect(upload).toBeGreaterThan(refusal);
  expect(runs[0].slice(refusal, upload)).not.toMatch(/\b(?:fi|else)\b/);
  expect(runs[1]).toContain('then echo "release $tag already exists: refusing to overwrite"; exit 1; fi');
  expect(JSON.stringify(job)).not.toMatch(/gh\s+release\s+(?:edit|publish)\b|--draft(?:=|\s+)false\b/);
  const report = auditReleaseCapabilities(root);
  expect(report.errors).toEqual([]);
  expect(report.assemblies).toEqual([{file: BROWSER_ASSEMBLY_WORKFLOW, job: 'draft-release', kind: 'assembly', owner: 'browserVendorDraftAssembly', reason: DRAFT_ASSEMBLY_REASON}]);
});
it.each([
  ['remove isDraft refusal', source => source.replace(/^.*--json isDraft.*\n/m, '')],
  ['create without draft', source => source.replace('--draft --target', '--target')],
  ['un-draft', source => source.replace('--draft --target', '--draft=false --target')],
  ['publish', source => source + '\n          gh release edit "$tag" --draft=false\n'],
])('vendor assembly classification rejects %s', (_name, mutate) => {
  const source = readFileSync(new URL(`../${BROWSER_ASSEMBLY_WORKFLOW}`, import.meta.url), 'utf8');
  const mutant = mutate(source);
  expect(mutant).not.toBe(source);
  const report = auditReleaseCapabilities(root, new Map([[BROWSER_ASSEMBLY_WORKFLOW, mutant]]));
  expect(report.assemblies).toEqual([]);
  expect(report.errors.some(error => error.file === BROWSER_ASSEMBLY_WORKFLOW)).toBe(true);
});
it('ignores prose mentioning Secrets and quoted expression literals', () => {
  const d=clean(); d.jobs.other={steps:[{run:"echo Secrets; echo ${{ 'secrets.RELEASES_PAT' }}"}]};
  expect(audit(d).errors).toEqual([]);
});
it('accepts the three reviewed write capabilities', () => expect(audit(clean()).errors).toEqual([]));
it('MAIN stage GET changed to POST goes RED', () => {
  const d = clean();
  const step = d.jobs.stage.steps.find(s => s.run?.includes('/releases/latest'));
  expect(step).toBeDefined();
  step.run = step.run.replace('curl -fsSL', 'curl -X POST -fsSL');
  const errors = audit(d).errors;
  expect(errors.some(e => e.path.startsWith('jobs.stage.steps.') && e.reason.includes('release operation'))).toBe(true);
  console.log('CAPABILITY_MUTANT_REJECTED stage GET -> POST', JSON.stringify(errors));
});
it.each([
  'curl -X PATCH https://api.github.com/repos/o/r/releases/1',
  'curl --request=PUT https://uploads.github.com/repos/o/r/releases/1/assets',
  'curl -X DELETE https://api.github.com/repos/o/r/releases/assets/1',
  'url=https://api.github.com/repos/o/r/releases\ncurl -X POST "$url"',
  'curl -I https://api.github.com/repos/o/r/releases/latest',
  'gh api --method HEAD repos/o/r/releases/latest',
  'gh api repos/o/r/releases -f tag_name=v1',
  ...['create', 'edit', 'upload', 'delete', 'delete-asset'].map(op => `gh release ${op} v1`),
  'electron-builder --publish always',
  'node scripts/release-guard.mjs probe-prepared',
])('release operation outside assemble goes RED: %s', run => {
  const d = clean(); d.jobs.stage.steps.push({run});
  expect(audit(d).errors.some(e => e.reason.includes('release operation'))).toBe(true);
});
it.each([
  'curl https://api.github.com/repos/o/r/releases/latest',
  'curl --request GET https://api.github.com/repos/o/r/releases/latest',
  'curl -f https://api.github.com/repos/o/r/releases/latest',
  'curl -X GET --data page=1 https://api.github.com/repos/o/r/releases',
  'gh api --method GET repos/o/r/releases',
  'gh api --method GET repos/o/r/releases -f page=1',
  'gh release view v1',
  'Invoke-WebRequest "https://github.com/o/r/releases/download/v1/tool-win-x64.zip" -OutFile "$archive"',
])('read-only release lookup remains allowed: %s', run => {
  const d = clean(); d.jobs.stage.steps.push({run});
  expect(audit(d).errors).toEqual([]);
});
it.each([
  ['scripts/capability-mutant.sh', 'curl -X POST https://api.github.com/repos/o/r/releases'],
  ['scripts/capability-mutant.mjs', 'fetch("https://api.github.com/repos/o/r/releases", {method: "POST"});'],
  ['scripts/capability-mutant.mjs', 'fetch("https://api.github.com/repos/o/r/releases", {method: "OPTIONS"});'],
  ['scripts/capability-mutant.mjs', 'await api("POST", "repos/o/r/releases");'],
  ['scripts/capability-mutant.mjs', 'octokit.request("TRACE /repos/o/r/releases");'],
  ['scripts/capability-mutant.mjs', 'execFileSync("gh", ["release", "create", "v1"]);'],
])('called script release operation goes RED: %s (%s)', (name, source) => {
  const d = clean(); d.jobs.stage.steps.push({run: `node ${name}`});
  expect(audit(d, [[name, source]]).errors.some(e => e.reason.includes('release operation'))).toBe(true);
});
it('checks inline JavaScript in a parsed action step', () => {
  const d = clean();
  d.jobs.stage.steps.push({uses:'actions/github-script@fixture', with:{script:'await github.request("POST /repos/o/r/releases");'}});
  expect(audit(d).errors.some(e => e.reason.includes('release operation'))).toBe(true);
});
it('checks release operations behind a package command', () => {
  const d = clean(); d.jobs.stage.steps.push({run: 'pnpm capability-mutant'});
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  pkg.scripts['capability-mutant'] = 'node scripts/capability-mutant.mjs';
  expect(audit(d, [
    ['package.json', JSON.stringify(pkg)],
    ['scripts/capability-mutant.mjs', 'execFileSync("gh", ["release", "delete", "v1"]);'],
  ]).errors.some(e => e.reason.includes('release operation'))).toBe(true);
});
it.each(['scripts/release.log', 'scripts/release.diff', 'scripts/release.patch', 'scripts/release', 'evidence/release.log'])('interpreter-invoked files stay in the capability traversal: %s', target => {
  const others = ['.github/workflows/prepare-release.yml', '.github/workflows/cla.yml'];
  const fixture = gitFixture(['package.json', file, ...others]);
  try {
    mkdirSync(dirname(join(fixture.root, target)), {recursive: true});
    writeFileSync(join(fixture.root, target), 'gh release create v1\n');
    chmodSync(join(fixture.root, target), 0o644);
    const pkg = {scripts: {'interpreter-fixture': `bash ${target}`}};
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify(pkg));
    for (const run of [`bash ${target}`, 'pnpm interpreter-fixture']) {
      const doc = clean();
      doc.jobs.stage.steps.push({run});
      writeFileSync(join(fixture.root, file), stringify(doc));
      fixture.git('add', '--force', '--all');
      expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
      const report = auditReleaseCapabilities(fixture.root);
      expect(report.errors.some(error => error.reason.includes(`release operation outside assemble: gh release mutation in ${target}:1`)), run).toBe(true);
    }
  } finally { fixture.dispose(); }
});
it('interpreter-invoked files reached through a JavaScript command wrapper stay in the capability traversal', () => {
  const doc = clean();
  doc.jobs.stage.steps.push({run: 'node scripts/interpreter-entry.mjs'});
  const report = audit(doc, [
    ['scripts/interpreter-entry.mjs', 'execFileSync("bash", ["scripts/release.log"]);'],
    ['scripts/release.log', 'gh release create v1\n'],
  ]);
  expect(report.errors.some(error => error.reason.includes('gh release mutation in scripts/release.log:1'))).toBe(true);
});
// MAIN 2026-11-11 12:11Z: invocation, including interpreter options, defines code.
it.each(['bash -e', 'bash -o pipefail', 'sh --', 'bash -x -u --norc --', 'zsh -e', 'pwsh -NoProfile -File'])('interpreter options reach mode-0644 evidence in the capability audit: %s', interpreter => {
  const target = 'evidence/release.log';
  const others = ['.github/workflows/prepare-release.yml', '.github/workflows/cla.yml'];
  const fixture = gitFixture(['package.json', file, ...others]);
  try {
    mkdirSync(join(fixture.root, 'evidence'));
    writeFileSync(join(fixture.root, target), 'gh release create v1\n');
    chmodSync(join(fixture.root, target), 0o644);
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({scripts: {fixture: `${interpreter} ${target}`}}));
    writeFileSync(join(fixture.root, 'evidence/entry.log'), `${interpreter} ${target}\n`);
    for (const run of [`${interpreter} ${target}`, 'pnpm fixture', 'bash -e evidence/entry.log']) {
      const doc = clean(); doc.jobs.stage.steps.push({run});
      writeFileSync(join(fixture.root, file), stringify(doc));
      fixture.git('add', '--force', '--all');
      expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
      const report = auditReleaseCapabilities(fixture.root);
      expect(report.errors.some(error => error.reason.includes(`gh release mutation in ${target}:1`)), run).toBe(true);
    }
  } finally { fixture.dispose(); }
});
it('interpreter options inspect inline code and its target in the capability audit', () => {
  const doc = clean(); doc.jobs.stage.steps.push({run: `bash -c 'bash -e evidence/release.log'`});
  expect(audit(doc, [['evidence/release.log', 'gh release create v1\n']]).errors.some(error => error.reason.includes('gh release mutation in evidence/release.log:1'))).toBe(true);
});
it('interpreter options follow JavaScript wrapper arguments into evidence', () => {
  const doc = clean(); doc.jobs.stage.steps.push({run: 'node scripts/interpreter-entry.mjs'});
  const report = audit(doc, [
    ['scripts/interpreter-entry.mjs', 'execFileSync("bash", ["-o", "pipefail", "evidence/release.log"]);'],
    ['evidence/release.log', 'gh release create v1\n'],
  ]);
  expect(report.errors.some(error => error.reason.includes('gh release mutation in evidence/release.log:1'))).toBe(true);
});
it.each([
  ['node --no-warnings', 'require("node:child_process").execFileSync("gh", ["release", "create", "v1"]);'],
  ['python3 -u -W ignore', 'import os\nos.system("gh release create v1")'],
  ['if bash -e', 'gh release create v1'],
  ['FIXTURE=1 bash -e', 'gh release create v1'],
  ['.', 'gh release create v1'],
])('interpreter options select code syntax and shell command prefixes: %s', (command, source) => {
  const doc = clean(); doc.jobs.stage.steps.push({run: `${command} evidence/release.log${command.startsWith('if ') ? '; then :; fi' : ''}`});
  expect(audit(doc, [['evidence/release.log', source]]).errors.some(error => error.reason.includes('gh release mutation in evidence/release.log:1'))).toBe(true);
});
it.each(['package', 'script'])('interpreter options reach evidence from every tracked caller: %s', entry => {
  const extras = [
    ['package.json', JSON.stringify({scripts: entry === 'package' ? {fixture: 'bash -e evidence/release.log'} : {}})],
    ['evidence/release.log', 'gh release create v1\n'],
  ];
  if (entry === 'script') extras.push(['scripts/entry.sh', 'bash -e evidence/release.log']);
  expect(audit(clean(), extras).errors.some(error => error.reason.includes('gh release mutation in evidence/release.log:1'))).toBe(true);
});
it('interpreter options leave uninvoked evidence passive in the capability audit', () => {
  expect(audit(clean(), [['evidence/release.log', 'gh release create v1\n']]).errors).toEqual([]);
});
// MAIN 2026-11-11 12:58Z: only the interpreter target must be static.
it.each([
  ['file', 'execFileSync("bash", ["-e", "evidence/release.log", process.env.VERSION]);'],
  ['option value', 'execFileSync("bash", ["-o", "pipefail", "evidence/release.log", process.env.VERSION]);'],
  ['inline', 'execFileSync("bash", ["-c", "bash -e evidence/release.log", process.env.VERSION]);'],
])('literal interpreter target with dynamic later arguments reaches the capability audit: %s', (_name, source) => {
  const others = ['.github/workflows/prepare-release.yml', '.github/workflows/cla.yml'];
  const fixture = gitFixture(['package.json', file, ...others]);
  try {
    const target = 'evidence/release.log';
    mkdirSync(join(fixture.root, 'evidence'));
    writeFileSync(join(fixture.root, target), 'gh release create v1\n');
    chmodSync(join(fixture.root, target), 0o644);
    writeFileSync(join(fixture.root, 'entry.mjs'), source);
    const doc = clean(); doc.jobs.stage.steps.push({run: 'node entry.mjs'});
    writeFileSync(join(fixture.root, file), stringify(doc));
    fixture.git('add', '--force', '--all');
    expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
    expect(auditReleaseCapabilities(fixture.root).errors.some(error => error.reason.includes(`gh release mutation in ${target}:1`))).toBe(true);
  } finally { fixture.dispose(); }
});
it.each([
  ['bash', ['-e', '-x', '-u', '--norc', '--']],
  ['bash', ['-o', 'pipefail', '-O', 'extglob']],
  ['bash', ['--rcfile', 'startup', '-r']],
  ['zsh', ['-o', 'errexit']],
  ['node', ['--no-warnings', '--require', 'startup', '--loader', 'loader']],
  ['node', ['--input-type', 'module', '--import', 'startup']],
  ['python3', ['-u', '-W', 'ignore', '-X', 'dev']],
  ['ruby', ['-I', 'lib', '-r', 'startup', '-E', 'UTF-8']],
  ['ruby', ['--encoding', 'UTF-8', '-c']],
  ['perl', ['-I', 'lib', '-M', 'strict']],
  ['perl', ['-c', '-w']],
])('literal interpreter target ignores later dynamics after its own options: %s %j', (command, options) => {
  const source = `execFileSync(${JSON.stringify(command)}, [${options.map(option => JSON.stringify(option)).join(',')}, "evidence/release.log", process.env.VERSION, ...extra]);`;
  expect(interpreterInvocations(source, true)).toEqual([{target: 'evidence/release.log', javascript: command === 'node'}]);
});
it.each([
  ['bash', '-c'], ['node', '--eval'], ['python3', '-c'], ['ruby', '-e'], ['perl', '-e'],
])('literal interpreter target audits inline text before dynamic arguments: %s %s', (command, option) => {
  expect(interpreterInvocations(`execFileSync(${JSON.stringify(command)}, [${JSON.stringify(option)}, "gh release create v1", process.env.VERSION]);`, true))
    .toEqual([{inline: 'gh release create v1', javascript: command === 'node'}]);
});
it('literal interpreter target preserves unknown targets and module modes', () => {
  for (const source of [
    'execFileSync("bash", ["-e", process.env.SCRIPT, "evidence/release.log"]);',
    'execFileSync("bash", ["-c", process.env.CODE, "evidence/release.log"]);',
    'execFileSync("bash", [...options, "evidence/release.log"]);',
    'execFileSync("bash", ["-o", ...options, "evidence/release.log"]);',
    'execFileSync("python3", ["-m", "module", "evidence/release.log", process.env.VERSION]);',
  ]) expect(interpreterInvocations(source, true), source).toEqual([]);
});
it('follows a called script import to its release operation', () => {
  const d = clean(); d.jobs.stage.steps.push({run: 'node scripts/capability-entry.mjs'});
  expect(audit(d, [
    ['scripts/capability-entry.mjs', 'import "./capability-mutation.mjs";'],
    ['scripts/capability-mutation.mjs', 'fetch("https://api.github.com/repos/o/r/releases", {method: "POST"});'],
  ]).errors.some(e => e.reason.includes('release operation'))).toBe(true);
});
it.each([
  ['another job contents: write', d=>{d.jobs.other={permissions:{contents:'write'},steps:[]};}],
  ['curl in release job', d=>{d.jobs.assemble.steps.push({run:'curl "$url"'});}],
  ['reusable workflow write', d=>{d.jobs.call={uses:'./.github/workflows/called.yml',permissions:{contents:'write'}};}],
  ['release secret on another step', d=>{d.jobs.other={steps:[{run:'echo no',env:{GH_TOKEN:'${{ secrets.RELEASES_PAT }}'}}]};}],
  ['release secret on checkout', d=>{d.jobs.assemble.steps[0].with.token='${{ secrets.RELEASES_PAT }}';}],
  ['release secret on bootstrap', d=>{d.jobs.assemble.steps[2].env={GH_TOKEN:'${{ secrets.RELEASES_PAT }}'};}],
  ['GitHub token in setup inputs', d=>{d.jobs.assemble.steps[1].with.token='${{ github.token }}';}],
  ['non-allowlisted action', d=>{d.jobs.assemble.steps.push({uses:'evil/action@'+'a'.repeat(40)});}],
  ['composite action in release job', d=>{d.jobs.assemble.steps.push({uses:'./.github/actions/local'});}],
  ['inherited reusable secrets', d=>{d.jobs.call={uses:'./.github/workflows/called.yml',secrets:'inherit'};}],
  ['unknown PAT', d=>{d.jobs.other={env:{TOKEN:'${{ secrets.NEW_PAT }}'},steps:[]};}],
  ['case-insensitive secret context', d=>{d.jobs.other={env:{TOKEN:'${{ SECRETS.releases_pat }}'},steps:[]};}],
  ['whole secret context', d=>{d.jobs.other={env:{TOKEN:'${{ toJSON(SECRETS) }}'},steps:[]};}],
  ['quoted expression delimiter cannot hide secret', d=>{d.jobs.other={env:{TOKEN:"${{ format('}}', SECRETS['RELEASES_PAT']) }}"},steps:[]};}],
  ['implicit if secret', d=>{d.jobs.other={if:'secrets.RELEASES_PAT',steps:[]};}],
  ['dynamic secret', d=>{d.jobs.other={env:{TOKEN:'${{ secrets[inputs.key] }}'},steps:[]};}],
  ['shell injection', d=>{d.jobs.assemble.steps[2].run+='; curl "$url"';}],
  ['environment injection', d=>{d.jobs.assemble.steps[2].env={NODE_OPTIONS:'--import=evil.mjs'};}],
])('capability mutant goes RED: %s', (_name, mutate)=>{
  const doc=clean(); mutate(doc);
  const report = audit(doc, [['.github/workflows/called.yml','on: workflow_call\npermissions: {contents: read}\njobs: {}\n'],['.github/actions/local/action.yml','runs: {using: composite, steps: []}\n']]);
  expect(report.errors.length).toBeGreaterThan(0);
  console.log('CAPABILITY_MUTANT_REJECTED', _name, JSON.stringify(report.errors));
});
it.each([
  ['.github/workflows/declarations.yml','on:\n  workflow_call:\n    secrets:\n      RELEASES_PAT: {required: true}\npermissions: {contents: read}\njobs: {}\n'],
  ['.github/workflows/called.yml','on: workflow_call\npermissions: {contents: read}\njobs:\n  bad:\n    permissions: {contents: write}\n    steps: []\n'],
  ['.github/actions/local/action.yml','runs:\n  using: composite\n  steps:\n    - run: echo no\n      env:\n        TOKEN: ${{ secrets.RELEASES_PAT }}\n'],
])('parses nested workflow/composite mutant: %s',(name,source)=>expect(audit(clean(),[[name,source]]).errors.length).toBeGreaterThan(0));
it('resolves local action references and rejects missing definitions',()=>{
  const d=clean();d.jobs.other={steps:[{uses:'./missing'}]};expect(audit(d).errors.length).toBeGreaterThan(0);
});
it('YAML anchors cannot hide an elevated permission',()=>{
  const source = 'elevation: &write {contents: write}\n' + stringify(clean()) + '    # alias below is in jobs\n  other:\n    permissions: *write\n    steps: []\n';
  const result=auditReleaseCapabilities(root,new Map([[file,source]]),[file]);
  expect(result.errors.some(error=>error.path==='jobs.other.permissions')).toBe(true);
});
it('duplicate YAML keys fail closed',()=>{
  const source=stringify(clean())+'permissions: {contents: read}\n';
  expect(auditReleaseCapabilities(root,new Map([[file,source]]),[file]).errors.some(error=>error.reason.startsWith('invalid YAML'))).toBe(true);
});
it.each([
 ['fourth write job (actions)',d=>{d.jobs.fourth={permissions:{actions:'write'},steps:[]};}],
 ['top-level non-contents write',d=>{d.permissions.actions='write';}],
 ['extra write permission on assemble',d=>{d.jobs.assemble.permissions.checks='write';}],
 ['extra read permission on assemble',d=>{d.jobs.assemble.permissions.checks='read';}],
 ['probe removed',d=>{d.jobs.assemble.steps=d.jobs.assemble.steps.filter(s=>s.run!=='node scripts/release-guard.mjs probe-prepared');}],
])('MAIN capability mutant goes RED: %s',(_name,mutate)=>{
 const d=clean();mutate(d);expect(audit(d).errors.length).toBeGreaterThan(0);
});
it.each([
 ['open-pr calls gh release','.github/workflows/prepare-release.yml','open-pr',job=>job.steps.push({run:'gh release create v1'}),'administrative steps must match'],
 ['CLA record references RELEASES_PAT','.github/workflows/cla.yml','record',job=>job.steps.at(-1).env.GH_TOKEN='${{ secrets.RELEASES_PAT }}','administrative credential must be GITHUB_TOKEN'],
])('MAIN forbidden operation goes RED: %s',(_name,name,id,mutate,reason)=>{
 const doc=parse(readFileSync(new URL(`../${name}`,import.meta.url),'utf8'));
 mutate(doc.jobs[id]);
 const report=auditReleaseCapabilities(root,new Map([[name,stringify(doc)]]));
 expect(report.errors.some(e=>e.file===name && e.reason.includes(reason))).toBe(true);
});
it.each([
 ['conditional probe gate', d=>{d.jobs.preflight.steps.at(-1).if='false';}],
 ['ignored probe failure', d=>{d.jobs.preflight['continue-on-error']=true;}],
 ['conditional probe step', d=>{d.jobs.assemble.steps.find(s=>s.run?.endsWith(' probe-prepared')).if='false';}],
 ['stage loses CI dependency',d=>{d.jobs.stage.needs=d.jobs.stage.needs.filter(n=>n!=='ci-gate');}],
])('sequencing bypass goes RED: %s',(_name,mutate)=>{
 const d=clean();mutate(d);expect(audit(d).errors.length).toBeGreaterThan(0);
});
it.each([['scalar','workflow_call'],['list',['workflow_call']]])('a privileged workflow cannot become reusable through shorthand %s',(_name,trigger)=>{
 const d=clean();d.on=trigger;
 expect(audit(d).errors.some(e=>e.reason.includes('reusable'))).toBe(true);
});

// MAIN 2026-11-11 13:25Z: every literal file operand is executable audit input,
// including option values and arguments after the primary target or a spread.
it.each([
  ['node warnings', 'node', ['--redirect-warnings', 'warnings.log', 'evidence/release.log'], 'execFileSync("gh", ["release", "create", "v1"]);'],
  ['python warnings', 'python3', ['-W', 'ignore', 'file.py', 'evidence/release.log'], 'gh release create v1\n'],
  ['ruby include', 'ruby', ['-I', 'dir', 'file.rb', 'evidence/release.log'], 'gh release create v1\n'],
  ['shell option value', 'bash', ['-o', 'evidence/release.log', 'entry.sh'], 'gh release create v1\n'],
  ['node option value', 'node', ['--require', 'evidence/release.log', 'entry.mjs'], 'execFileSync("gh", ["release", "create", "v1"]);'],
  ['python option value', 'python3', ['-W', 'evidence/release.log', 'file.py'], 'gh release create v1\n'],
  ['ruby option value', 'ruby', ['-I', 'evidence/release.log', 'file.rb'], 'gh release create v1\n'],
])('fail-closed interpreter file candidates reach the capability audit: %s', (_name, command, args, code) => {
  for (const entry of ['package', 'workflow', 'script', 'wrapper', 'dynamic wrapper', 'spread wrapper']) {
    const fixture = gitFixture(['package.json', file, '.github/workflows/prepare-release.yml', '.github/workflows/cla.yml']);
    try {
      const target = 'evidence/release.log';
      mkdirSync(join(fixture.root, 'evidence'));
      writeFileSync(join(fixture.root, target), code);
      chmodSync(join(fixture.root, target), 0o644);
      for (const name of ['warnings.log', 'ignore', 'file.py', 'dir', 'file.rb', 'entry.sh', 'entry.mjs']) writeFileSync(join(fixture.root, name), '');
      const invocation = `${command} ${args.join(' ')}`;
      writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({scripts: entry === 'package' ? {fixture: invocation} : {}}));
      if (entry === 'script') writeFileSync(join(fixture.root, 'caller.sh'), invocation);
      if (entry.endsWith('wrapper')) {
        const prefix = entry === 'dynamic wrapper' ? 'process.env.UNKNOWN, ' : entry === 'spread wrapper' ? '...options, ' : '';
        writeFileSync(join(fixture.root, 'caller.mjs'), `execFileSync(${JSON.stringify(command)}, [${prefix}${args.map(arg => JSON.stringify(arg)).join(', ')}, process.env.VERSION]);`);
      }
      const doc = clean();
      if (entry === 'workflow') doc.jobs.stage.steps.push({run: invocation});
      writeFileSync(join(fixture.root, file), stringify(doc));
      fixture.git('add', '--force', '--all');
      expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
      expect(auditReleaseCapabilities(fixture.root).errors.some(error => error.reason.includes(`gh release mutation in ${target}:1`)), entry).toBe(true);
    } finally { fixture.dispose(); }
  }
});

it('fail-closed interpreter file candidates include absolute and untracked repository paths', () => {
  for (const tracked of [true, false]) {
    const fixture = gitFixture(['package.json', file, '.github/workflows/prepare-release.yml', '.github/workflows/cla.yml']);
    try {
      const target = 'evidence/release.log';
      mkdirSync(join(fixture.root, 'evidence'));
      writeFileSync(join(fixture.root, target), 'gh release create v1\n');
      chmodSync(join(fixture.root, target), 0o644);
      writeFileSync(join(fixture.root, 'caller.mjs'), `execFileSync("bash", [process.env.UNKNOWN, "", ${JSON.stringify(join(fixture.root, target))}]);`);
      fixture.git('add', '--force', '--all');
      if (!tracked) fixture.git('rm', '--cached', '--', target);
      expect(fixture.git('ls-files', '--', target).trim()).toBe(tracked ? target : '');
      expect(auditReleaseCapabilities(fixture.root).errors.some(error => error.reason.includes(`gh release mutation in ${target}:1`))).toBe(true);
    } finally { fixture.dispose(); }
  }
});
