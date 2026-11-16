// SPDX-License-Identifier: AGPL-3.0-or-later
// Container-only behavioral mutations. Restore exact source bytes on every exit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const fingerprint = 'server/decision/wipe-fingerprint.ts', implementation = 'server/decision/implementation.ts';
const wipe = 'server/no-limits-wipe.ts', code = 'server/no-limits-code.ts', segments = 'server/shell/segments.ts';
const effects = 'server/no-limits-shell.ts';
const originals = new Map([fingerprint, implementation, wipe, code, segments, effects].map(path => [path, readFileSync(path, 'utf8')]));
const push = "objects.push({ index, probe, state: 'present', target, device: String(identity.dev), inode: String(identity.ino) });";
const tests = ['server/decision/release-guard-r4.test.ts', 'server/decision/release-guard-r5.test.ts'];
const run = (id, pattern) => {
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=2', ...(pattern ? ['-t', pattern] : [])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const log = result.stdout + result.stderr; writeFileSync(join(out, id + '.log'), log);
  assert.equal(result.signal, null, id + ' must finish'); if (result.error) throw result.error;
  return { result, log, args };
};
const mutants = [
  ['content-write-misclassified', effects, "&&!['shred','srm','truncate'].includes(roles.program)", '', 'R5 dangling device destination.*shred'],
  ['pwsh-backslash-loss', segments, "            if (c === '\\\\' && q !== \"'\") { translated += '\\\\\\\\'; continue; }", '', 'R5 (powershell|pwsh) literal backslashes'],
  ['device-effect-resolution-omitted', wipe, "target.op==='write'&&target.path", 'false', 'R5 dangling device destination'],
  ['embedded-values-omitted', fingerprint, "rawToken.indexOf('=')", '-1', 'R5 embedded path identity.*opaque=disk'],
  ['semantic-argv-omitted', code, "   onShell?.(text,location,lang==='pwsh'?'pwsh':'posix');", '', 'R5 (python|node) semantic argv'],
  ['explicit-class-change-bypass', implementation, 'if(!wipes.length&&!e)return true;', 'if(!wipes.length)return true;', 'R5 explicit'],
  ['fat-target-omitted', fingerprint, push, "if (argv[0] !== 'mkfs.fat' || index !== 3) " + push, 'R4 (guard|product) fat-option-value'],
  ['btrfs-second-omitted', fingerprint, push, "if (argv[0] !== 'mkfs.btrfs' || index !== 2) " + push, 'R4 (guard|product) btrfs-second-device'],
  ['delete-retarget-omitted', fingerprint, push, "if (argv[0] !== 'rm' || index !== 2) " + push, 'R4 (guard|product) delete-system-retarget'],
  ['inode-identity-omitted', fingerprint, 'inode: String(identity.ino)', "inode: 'omitted'", 'R4 every existing token.*inode$'],
  ['argv-values-omitted', fingerprint, 'commands.push({ argv, objects });', 'commands.push({ argv: [], objects });', 'R4 exact ordered argv rejects changed tokens: mkfs.fat -F 16'],
  ['new-token-resolution-omitted', fingerprint, 'const target = physicalWipePath(token, cwd, true);', "if (token === '32') continue; const target = physicalWipePath(token, cwd, true);", 'R4 every existing token.*create$'],
  ['product-fingerprint-bypass', implementation,
    'const targetsCovered=releaseWipes!==undefined&&heldWipes!==undefined&&approvedEvidenceCovers({decisions:[],wipes:releaseWipes},{decisions:[],wipes:heldWipes});',
    'const targetsCovered=true;', 'R4 product (fat-option-value|btrfs-second-device|delete-system-retarget) refreshes'],
];
const report = { control: 'pending', originals: Object.fromEntries([...originals].map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), results: [] };
try {
  assert.equal(run('control').result.status, 0, 'unmodified control must pass'); report.control = 'pass';
  for (const [id, path, anchor, replacement, pattern] of mutants) {
    const original = originals.get(path); assert.equal(original.split(anchor).length, 2, id + ' unique anchor');
    writeFileSync(path, original.replace(anchor, replacement));
    try {
      const { result, log, args } = run(id, pattern); assert.equal(result.status, 1, id + ' must be killed');
      assert.match(log, /AssertionError:/); assert.match(log, new RegExp(pattern, 'm'));
      assert.doesNotMatch(log, /Failed to parse|SyntaxError:|Cannot find module/);
      report.results.push({ id, status: 'killed', exitCode: result.status, args });
    } finally { writeFileSync(path, original); }
  }
} finally {
  for (const [path, text] of originals) writeFileSync(path, text);
  report.restored = [...originals].every(([path, text]) => readFileSync(path, 'utf8') === text);
  writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
