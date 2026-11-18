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

it.each([
  ['encoded command and operands', String.raw`execFileSync("\u0067\u0068", ["\u0072\u0065\u006c\u0065\u0061\u0073\u0065", "\u0063\u0072\u0065\u0061\u0074\u0065", "v1"]);`],
  ['continued release URL', 'fetch("https://api.github.com/repos/o/r/rele' + '\\\n' + 'ases", {method: "POST"});'],
  ['continued CRLF release URL', 'fetch("https://api.github.com/repos/o/r/rele' + '\\\r\n' + 'ases", {method: "POST"});'],
  ['encoded release URL', String.raw`fetch("https://api.github.com/repos/o/r/\u0072\u0065leases", {method: "POST"});`],
])('release parsing retains encoded literals: %s', (_name, source) => {
  const doc = clean(); doc.jobs.stage.steps.push({run: 'node scripts/encoded-release.mjs'});
  expect(audit(doc, [['scripts/encoded-release.mjs', source]]).errors.some(error => error.reason.includes('release operation'))).toBe(true);
});

// New G-A witnesses only. Existing reviewed expectations above stay intact.
it.each(['sac-extract-stage', 'sac-extract-publish', 'windows-sac-qualification'])('G-A accepts exact OIDC class %s', id => {
  const d = clean();
  d.jobs[id] = { permissions: {contents:'read', 'id-token':'write'}, steps: [{run:'node scripts/windows-sac-stage-gate.mjs extract'}] };
  expect(audit(d).errors).toEqual([]);
});
it.each([
  ['secret', j => { j.steps[0].env = {AZURE_CLIENT_ID:'${{ secrets.AZURE_CLIENT_ID }}'}; }],
  ['token', j => { j.steps[0].env = {GH_TOKEN:'${{ github.token }}'}; }],
  ['inherited secrets', j => { j.secrets = 'inherit'; }],
  ['write contents', j => { j.permissions.contents = 'write'; }],
  ['extra permission', j => { j.permissions.actions = 'read'; }],
  ['missing permission', j => { delete j.permissions.contents; }],
  ['read id token', j => { j.permissions['id-token'] = 'read'; }],
  ['guard command', j => { j.steps[0].run = 'node scripts/release-guard.mjs stage'; }],
  ['job env', j => { j.env = {PUBLIC:'value'}; }],
  ['extract environment', j => { j.environment = 'windows-sac-qualification'; }],
  ['reusable', j => { j.uses = './.github/workflows/reusable.yml'; delete j.steps; }],
])('G-A rejects OIDC %s without expanding writer permissions', (_name, mutate) => {
  const d = clean(); const id = 'sac-extract-stage';
  d.jobs[id] = {permissions:{contents:'read','id-token':'write'},steps:[{run:'echo neutral'}]};
  mutate(d.jobs[id]); expect(audit(d).errors.some(e => e.path.startsWith(`jobs.${id}`))).toBe(true);
});
it('G-A rejects unlisted OIDC, workflow OIDC and assemble OIDC', () => {
  for (const mode of ['unlisted','workflow','assemble']) {
    const d = clean();
    if (mode === 'unlisted') d.jobs.unlisted = {permissions:{contents:'read','id-token':'write'},steps:[{run:'echo neutral'}]};
    if (mode === 'workflow') d.permissions['id-token'] = 'write';
    if (mode === 'assemble') d.jobs.assemble.permissions['id-token'] = 'write';
    expect(audit(d).errors.some(e => e.path.endsWith('permissions'))).toBe(true);
  }
});
it('G-A admits the package qualification pair only on its exact key', () => {
  const packageFile = '.github/workflows/package-win.yml';
  const job = {environment:'windows-sac-qualification',permissions:{contents:'read','id-token':'write'},steps:[{run:'echo neutral'}]};
  const report = jobs => audit(clean(), [[packageFile,stringify({permissions:{contents:'read'},jobs})]]);
  expect(report({'windows-sac-qualification':job}).errors).toEqual([]);
  expect(report({other:job}).errors.length).toBeGreaterThan(0);
  expect(report({'windows-sac-qualification':{...job,environment:'other'}}).errors.length).toBeGreaterThan(0);
});
it('M-A18 removal, duplication and conditional bypass of the SAC gate fail workflow admission', () => {
  const accepted = clean();
  expect(accepted.jobs.stage.steps.filter(s => s.run === 'node scripts/windows-sac-stage-gate.mjs')).toHaveLength(1);
  expect(audit(accepted).errors).toEqual([]);
  for (const mode of ['remove','duplicate','conditional','ignore failure']) {
    const d = clean(); const gate = d.jobs.stage.steps.find(s => s.run === 'node scripts/windows-sac-stage-gate.mjs');
    if (mode === 'remove') d.jobs.stage.steps = d.jobs.stage.steps.filter(s => s !== gate);
    if (mode === 'duplicate') d.jobs.stage.steps.push({...gate});
    if (mode === 'conditional') gate.if = 'false';
    if (mode === 'ignore failure') gate['continue-on-error'] = true;
    expect(audit(d).errors.some(e => e.reason === 'required unconditional SAC stage gate missing')).toBe(true);
  }
});
it('G-A Windows download fetches SAC data from the same run, fails closed, and never loads the verifier or requests OIDC', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { spawnSync } = await import('node:child_process');
  for (const failSac of [false,true]) {
    const scratch = mkdtempSync(join(tmpdir(),'sac-download-'));
    try {
      mkdirSync(join(scratch,'scripts')); mkdirSync(join(scratch,'bin'));
      writeFileSync(join(scratch,'scripts/release-guard.mjs'),readFileSync(new URL('./release-guard.mjs',import.meta.url)));
      writeFileSync(join(scratch,'scripts/signal-release-prerequisites.mjs'),'export function assertSignalReleaseReady() {}');
      writeFileSync(join(scratch,'scripts/windows-sac-promotion.mjs'),'throw Error("verifier loaded by download")');
      writeFileSync(join(scratch,'package.json'),'{}');
      const gh = join(scratch,'bin/gh');
      writeFileSync(gh,`#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync('calls',JSON.stringify(args)+'\\n');
const name=args[args.indexOf('--name')+1];
if(name==='release-staged-assets-2')fs.writeFileSync('assets/Murage-setup.exe','neutral installer');
if(name==='release-sac-prepared-2'&&${failSac})process.exit(2);
`); chmodSync(gh,0o755);
      const result = spawnSync(process.execPath,['scripts/release-guard.mjs','download'], {cwd:scratch,encoding:'utf8',env:{PATH:join(scratch,'bin'),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',GITHUB_REPOSITORY:'neutral/repo'}});
      expect(result.status === 0).toBe(!failSac);
      const calls = readFileSync(join(scratch,'calls'),'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual(['run','download','123','--repo','neutral/repo','--name','release-sac-prepared-2','--dir','release-sac']);
      const invalid = spawnSync(process.execPath,['scripts/release-guard.mjs','download'], {cwd:scratch,encoding:'utf8',env:{PATH:join(scratch,'bin'),GITHUB_RUN_ID:'../foreign',GITHUB_RUN_ATTEMPT:'2',GITHUB_REPOSITORY:'neutral/repo'}});
      expect(invalid.status).not.toBe(0);
      expect(readFileSync(join(scratch,'calls'),'utf8').trim().split('\n')).toHaveLength(3);
    } finally { rmSync(scratch,{recursive:true}); }
  }
});
it('stage and extraction gates refuse unenrolled input, unknown commands and existing output before a prepared result', async () => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const { extractWindowsSacInvocation } = await import('./windows-sac-stage-gate.mjs');
  const scratch = mkdtempSync(join(tmpdir(),'sac-invocation-'));
  try {
    const output = join(scratch,'output');
    await expect(extractWindowsSacInvocation('unknown',{},output)).rejects.toThrow('INVOCATION');
    expect(readdirSync(scratch)).toEqual([]);
    await expect(extractWindowsSacInvocation('stage',{},output)).rejects.toThrow();
    expect(readdirSync(output)).toEqual([]);
    await expect(extractWindowsSacInvocation('publish-prepared',{},output)).rejects.toThrow();
    expect(readdirSync(output)).toEqual([]);
  } finally { rmSync(scratch,{recursive:true}); }
});

it.each(['unlisted pair','other environment','object environment','case-folded environment','actions write','third job','missing verify'])('R2-16 qualification boundary: %s',mode=>{
 const name='.github/workflows/windows-qualsign.yml';
 const cleanQualification=()=>parse(readFileSync(new URL(`../${name}`,import.meta.url),'utf8'));
 expect(audit(clean(),[[name,stringify(cleanQualification())]]).errors).toEqual([]);
 const d=cleanQualification();
 if(mode==='unlisted pair')d.jobs.unlisted={permissions:{contents:'read','id-token':'write'},steps:[]};
 if(mode==='other environment')d.jobs['verify-collector'].environment='windows-qualsign';
 if(mode==='object environment')d.jobs['verify-collector'].environment={name:'windows-qualsign'};
 if(mode==='case-folded environment')d.jobs['verify-collector'].environment='WINDOWS-QUALSIGN';
 if(mode==='actions write')d.jobs['sign-collector'].permissions.actions='write';
 if(mode==='third job')d.jobs.other={permissions:{contents:'read'},steps:[]};
 if(mode==='missing verify')delete d.jobs['verify-collector'];
 expect(audit(clean(),[[name,stringify(d)]]).errors.some(e=>e.file===name),mode).toBe(true);
 expect(audit(clean(),[[name,stringify(cleanQualification())]]).errors).toEqual([]);
});
it('R2-16 another workflow cannot claim the qualification environment',()=>{
 const d=clean(); d.jobs.other={environment:'windows-qualsign',permissions:{contents:'read'},steps:[]};
 expect(audit(d).errors.some(e=>e.path==='jobs.other.environment')).toBe(true);
});
