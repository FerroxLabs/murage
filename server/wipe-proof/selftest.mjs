// Tests the proof machinery itself, in a disposable fixture. Run via it-remote.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { here } from './adapter.mjs';
import { assertTempRoot } from './safety.mjs';
import { execute } from './process.mjs';
import { safeWipe } from '../testing/safe-wipe.mjs';
const results = [];
function check(name, ok) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} selftest/${name}`); }
function summaryOf(output) {
  return JSON.parse(output.trim().split('\n').at(-1));
}
let sandbox;
try {
  const normal = await execute(process.execPath, [path.join(here, 'posix/driver.mjs'), '--stub'], process.env, process.cwd(), 180000);
  // Preserve the requested individual case lines and final count-only summary.
  process.stdout.write(normal.stdout);
  const summary = summaryOf(normal.stdout);
  check('contract-stub-green', normal.code === 0 && summary.failed === 0 && summary.mode === 'contract-stub' && !summary.productionQualified);
  const mutant = await execute(process.execPath, [path.join(here, 'posix/driver.mjs'), '--stub', '--mutant-bypass'], process.env, process.cwd(), 180000);
  const mutantSummary = summaryOf(mutant.stdout);
  check('bypass-mutant-killed', mutant.code === 1 && mutantSummary.cases.some(x => x.name.endsWith('/literal-root') && !x.ok && x.backendCalls === 1));
  let refused = false;
  try { await assertTempRoot(process.cwd()); } catch { refused = true; }
  check('non-temp-root-refused', refused);
  sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-'));
  await assertTempRoot(sandbox);
  const root = path.join(sandbox, 'tree'), outside = path.join(sandbox, 'outside');
  await fs.mkdir(root); await fs.writeFile(outside, 'untouched');
  const env = { ...process.env, WIPE_PROOF_TREE: root, WIPE_PROOF_BACKEND: path.join(sandbox, 'backend') };
  const attempted = await execute(process.execPath, [path.join(here, 'fixture-tool.mjs'), 'rm', '-rf', outside], env, sandbox);
  check('backend-outside-refused', attempted.code === 97 && await fs.readFile(outside, 'utf8') === 'untouched');
  const link = path.join(root, 'link'); await fs.symlink(outside, link);
  const symlinked = await execute(process.execPath, [path.join(here, 'fixture-tool.mjs'), 'rm', '-rf', link], env, sandbox);
  check('backend-symlink-refused', symlinked.code === 97 && await fs.readFile(outside, 'utf8') === 'untouched');
  const logs = path.join(sandbox, 'logs'); await fs.mkdir(logs);
  const marker = 'private-fixture-row-do-not-print';
  await fs.writeFile(path.join(logs, 'commands.txt'), `echo ${marker}\nrm -rf /\n\n`);
  const before = path.join(sandbox, 'before.mjs'), after = path.join(sandbox, 'after.mjs');
  await fs.writeFile(before, `export const wipeBreaker = () => null;\n`);
  await fs.writeFile(after, `console.log(${JSON.stringify(marker)}); export const wipeBreaker = row => { console.error(row); return row.startsWith('rm ') ? {rule:'delete-root'} : null; };\n`);
  const replayArgs = [path.join(here, 'replay/replay.mjs'), logs];
  const replay = await execute(process.execPath, [...replayArgs, '--checker', after, '--baseline-checker', before, '--require-zero-new'], process.env, sandbox);
  const counts = summaryOf(replay.stdout);
  check('replay-counts-only-and-new-card-fails', replay.code === 1 && counts.commands === 2 && counts.cards === 1 && counts.newCards === 1 &&
    !replay.stdout.includes(marker) && !replay.stderr.includes(marker) && !replay.stdout.includes(logs));
  const zero = await execute(process.execPath, [...replayArgs, '--checker', after, '--baseline-checker', after, '--require-zero-new'], process.env, sandbox);
  check('replay-zero-new', zero.code === 0 && summaryOf(zero.stdout).newCards === 0);
  const unknown = path.join(sandbox, 'unknown.mjs');
  await fs.writeFile(unknown, `export const wipeBreaker = () => ({rule:${JSON.stringify(marker)}});`);
  const unknownRule = await execute(process.execPath, [...replayArgs, '--checker', unknown], process.env, sandbox);
  check('replay-rule-keys-private', unknownRule.code === 0 && summaryOf(unknownRule.stdout).rules.other === 2 &&
    !unknownRule.stdout.includes(marker) && !unknownRule.stderr.includes(marker));
  const real = await execute(process.execPath, [...replayArgs], process.env, sandbox, 30000);
  check('real-text-adapter', real.code === 0 && summaryOf(real.stdout).commands === 2 && summaryOf(real.stdout).cards === 1);
  const broken = path.join(sandbox, 'broken.mjs');
  await fs.writeFile(broken, `throw Error(${JSON.stringify(marker)});`);
  const failed = await execute(process.execPath, [...replayArgs, '--checker', broken], process.env, sandbox);
  check('replay-errors-private', failed.code === 1 && !failed.stdout.includes(marker) && !failed.stderr.includes(marker));
} catch { check('completed', false); }
finally { if (sandbox) { await assertTempRoot(sandbox); await safeWipe(sandbox); } }
console.log(JSON.stringify({ kind: 'wipe-proof-selftest', passed: results.filter(Boolean).length, failed: results.filter(x => !x).length }));
process.exitCode = results.every(Boolean) ? 0 : 1;
