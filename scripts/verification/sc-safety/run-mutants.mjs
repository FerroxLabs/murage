// Owner: sc-safety-rd (manifest, activation and classification).
// Owner: lane verification runner (isolated execution and artifact retention).
// Run only inside the isolated lane container:
// node --experimental-strip-types scripts/verification/sc-safety/run-mutants.mjs --out /evidence/mutants
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, lstatSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {waitForReviewedSource} from './reviewed-prechecks.mjs';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const outArgument = process.argv.indexOf('--out');
if (outArgument < 0 || !process.argv[outArgument + 1]) throw Error('An evidence directory outside the repository is required');
const out = resolve(process.argv[outArgument + 1]);
if (!relative(root, out).startsWith('..') || out === '/dev' || out.startsWith('/dev/')) throw Error('Evidence must be outside the repository and device tree');
mkdirSync(out, { recursive: true });
await waitForReviewedSource(out);
const scratch = mkdtempSync(join(out, 'private-'));
const source = join(scratch, 'source'); mkdirSync(source);
const manifest = JSON.parse(readFileSync(new URL('./mutants.json', import.meta.url), 'utf8'));
if (manifest.length !== 49 || new Set(manifest.map(m => m.id)).size !== 49) throw Error('Exactly 49 distinct mutants are required');
const selected = process.env.SC_MUTANTS?.split(',');
const specs = selected ? manifest.filter(m => selected.includes(m.id)) : manifest;
const shell = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
const listed = shell('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
const excluded = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'coverage', 'test-results', 'playwright-report', '.vite', '.vitest', 'evidence', 'lane-evidence', '.audit3', '.superpowers']);
function walk(directory, prefix = '') {
  const names = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...walk(join(directory, entry.name), name));
    else names.push(name);
  }
  return names;
}
// Remote snapshots intentionally do not carry the shared hub's .git target.
// A caller may supply an exact file list; otherwise walk only source inputs.
const files = process.env.SC_MUTANT_FILELIST_JSON ? JSON.parse(process.env.SC_MUTANT_FILELIST_JSON)
  : listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : walk(root);
const hashes = {};
for (const name of new Set(files)) {
  if (name.split('/').some(part => excluded.has(part))) continue;
  const from = join(root, name), to = join(source, name);
  let stat; try { stat = lstatSync(from); } catch { continue; }
  mkdirSync(dirname(to), { recursive: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (stat.isFile()) { copyFileSync(from, to); hashes[name] = createHash('sha256').update(readFileSync(from)).digest('hex'); }
}
symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'));
const gitconfig = join(scratch, 'gitconfig'); writeFileSync(gitconfig, '');
const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_SYSTEM: gitconfig };
delete env.SC_MUTANTS;
const init = shell('git', ['init', '--quiet', source], { env });
if (init.status !== 0) throw Error('Cannot initialize private copy');
const { plantWithProof } = await import(pathToFileURL(join(root, 'server/testing/ast-plant.ts')).href);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const infra = /dispatch dependency missing|FIXTURE_|MUTANT_NOT_ACTIVATED|is not a function|Cannot find module|does not provide an export|ReferenceError|Test timed out/i;
function run(spec, phase) {
  const report = join(out, `${spec.id}-${phase}.json`);
  const identityReport = join(out, `${spec.id}-${phase}-assertions.json`);
  const started = Date.now();
  const result = shell(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...spec.tests, '--testNamePattern', spec.killers.map(escape).join('|'), '--reporter=json', '--reporter=./scripts/verification/sc-safety/assertion-reporter.mjs', `--outputFile=${report}`], { cwd: source, env: {...env,SC_ASSERTION_IDENTITY_REPORT:identityReport}, timeout: 240000 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(out, `${spec.id}-${phase}.log`), log);
  let parsed;
  try { parsed = JSON.parse(readFileSync(report, 'utf8')); }
  catch { return { state: result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'INFRA', status: result.status, elapsed: Date.now() - started }; }
  const tests = parsed.testResults.flatMap(file => file.assertionResults ?? []);
  const named = tests.filter(test => spec.killers.some(id => test.fullName.includes(id)) && test.status !== 'pending' && test.status !== 'skipped');
  const failed = named.filter(test => test.status === 'failed');
  const leadingError = message => String(message).replace(/\u001b\[[0-9;]*m/g, '').trimStart().split('\n')[0];
  const actualInfra = test => {
    // Vitest may render a rejects assertion as "Error:" while its structured
    // identity is AssertionError. Expected FIXTURE text is not infrastructure.
    const receipt=identities.find(row=>row.name===test.title);
    if(receipt?.errors.length && receipt.errors.every(error=>error.name==='AssertionError'))return false;
    return (test.failureMessages ?? []).some(message => {
    const first = leadingError(message);
    return !/^AssertionError\b/.test(first) && infra.test(first);
  });
  };
  let identities=[];try{identities=JSON.parse(readFileSync(identityReport,'utf8'));}catch{}
  const namedAssertion = test => identities.some(row => row.name===test.title && row.errors.some(error=>error.name==='AssertionError'));
  const assertionKills = failed.filter(test => ((test.failureMessages ?? []).some(message => /^AssertionError\b/.test(leadingError(message))) || namedAssertion(test)) && !actualInfra(test));
  const state = result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT'
    : named.length === 0 || failed.some(actualInfra) || parsed.numRuntimeErrorTestSuites > 0 ? 'INFRA'
    : failed.length > 0 ? assertionKills.length ? 'ASSERTION_RED' : 'INFRA'
    : result.status === 0 && named.every(test => test.status === 'passed') ? 'GREEN' : 'INFRA';
  return { state, status: result.status, elapsed: Date.now() - started, tests: named.map(test => ({ id: test.fullName, status: test.status })), assertionKills: assertionKills.map(test => test.fullName), assertionIdentities: identities };
}
const rows = [];
writeFileSync(join(out, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
try {
  for (const spec of specs) {
    const path = join(source, spec.file); let original;
    const row = { id: spec.id, file: spec.file, verdict: 'NOT_ACTIVATED' };
    try {
      try { original = readFileSync(path, 'utf8'); } catch { throw Error('MUTANT_NOT_ACTIVATED source file absent'); }
      const planted = plantWithProof(path, spec.locator, spec.edit, original);
      if (planted.proof.matches !== 1 || planted.proof.before === planted.proof.after) throw Error('MUTANT_NOT_ACTIVATED');
      row.activation = planted.proof;
      row.control = process.env.SC_MUTANT_ACTIVATION_ONLY === '1' ? { state: 'ACTIVATED' } : run(spec, 'control');
      if (process.env.SC_MUTANT_ACTIVATION_ONLY === '1') row.verdict = 'ACTIVATED';
      else {
        try { writeFileSync(path, planted.text); row.applied = true; row.mutant = run(spec, 'mutant'); }
        finally { writeFileSync(path, original); }
        row.restored = run(spec, 'restored');
        row.verdict = row.control.state !== 'GREEN' ? row.control.state
          : row.mutant.state === 'ASSERTION_RED' && row.restored.state === 'GREEN' ? 'KILLED'
          : row.restored.state !== 'GREEN' ? row.restored.state
          : row.mutant.state === 'GREEN' ? 'SURVIVED' : row.mutant.state;
      }
    } catch (error) { row.error = String(error); row.verdict = /MUTANT_NOT_ACTIVATED/.test(row.error) ? 'NOT_ACTIVATED' : 'INFRA'; }
    finally { if (original !== undefined) writeFileSync(path, original); }
    rows.push(row);
    writeFileSync(join(out, 'results.json'), JSON.stringify({ complete: rows.length === 49, killed: rows.filter(row => row.verdict === 'KILLED').length, total: 49, rows }, null, 2));
    process.stdout.write(`${row.id} ${row.verdict}\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
const finalReport = { mode: process.env.SC_MUTANT_ACTIVATION_ONLY === '1' ? 'activation-only' : 'qualification', complete: rows.length === 49,
  killed: rows.filter(row => row.verdict === 'KILLED').length, activated: rows.filter(row => row.activation).length, total: 49, rows };
writeFileSync(join(out,'results.json'),JSON.stringify(finalReport,null,2));
process.stdout.write(`SC_SAFETY_MUTANT_REPORT\n${JSON.stringify(finalReport)}\n`);
process.exitCode = rows.length === specs.length && rows.every(row => row.verdict === (process.env.SC_MUTANT_ACTIVATION_ONLY === '1' ? 'ACTIVATED' : 'KILLED')) ? 0 : 1;
