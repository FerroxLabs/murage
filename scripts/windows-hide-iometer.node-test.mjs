import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { checkWindowsHide } from './check-windows-hide.mjs';
import { inspectChildEntries } from './check-windows-hide-entries.mjs';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';

// MAIN RULING 1115-IOMETER (GrokBuild).
const file = 'server/io-child-meter.ts';
const source = readFileSync(new URL('../server/io-child-meter.ts', import.meta.url), 'utf8');
// Exercise the lint gate's real failure filter in an isolated tracked tree.
function lintFailures(code, name = file) {
  const root = mkdtempSync(path.join(tmpdir(), 'windows-hide-meter-'));
  try {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), code);
    execFileSync('git', ['init', '-q', root], { windowsHide: true });
    execFileSync('git', ['add', '--', name], { cwd: root, windowsHide: true });
    return checkWindowsHide(root).failures;
  } finally {
    safeWipeSync(root);
  }
}
const mutant = (from, to) => {
  assert.ok(source.includes(from), `mutation anchor missing: ${from}`);
  return source.replaceAll(from, to);
};

for (const [gate, failures] of [
  ['launch lint', lintFailures],
  ['entry ordering', (code, name = file) => inspectChildEntries(name, code).failures],
]) describe(gate, () => {
  test('the reviewed meter type, prototype and sync forwarding references are non-spawning', () => {
    assert.deepEqual(failures(source), []);
  });

  for (const [name, from, to] of [
    ['rebuilt caller arguments', 'Reflect.apply(target,receiver,args)', 'Reflect.apply(target,receiver,[args[0],args[1],{}])'],
    ['direct original call', 'new Proxy(original,', 'new Proxy(original(...args),'],
    ['original called from the trap', 'Reflect.apply(target,receiver,args)', 'original(...args)'],
    ['constructed original', 'new Proxy(original,', 'new Proxy(new original(),'],
    ['a different Proxy target', 'new Proxy(original,', 'new Proxy(childProcess.spawn,'],
    ['called prototype', 'childProcess.ChildProcess.prototype as', 'childProcess.ChildProcess.prototype() as'],
    ['constructed ChildProcess', 'childProcess.ChildProcess.prototype as', 'new childProcess.ChildProcess() as'],
    ['another member', 'childProcess.ChildProcess.prototype as', 'childProcess.ChildProcess.other as'],
    ['direct target call', 'Reflect.apply(target,receiver,args)', 'target(...args)'],
    ['changed receiver', 'Reflect.apply(target,receiver,args)', 'Reflect.apply(target,null,args)'],
    ['changed arguments binding', 'apply(target,receiver,args){', 'apply(target,receiver,args){ args = [];'],
    ['escaped original', 'const original=childProcess[api];', 'const original=childProcess[api]; consume(original);'],
    ['escaped module', 'syncBuiltinESMExports();', 'consume(childProcess); syncBuiltinESMExports();'],
    ['outside the installer', 'function installChildProcessMeter()', 'function anotherInstaller()'],
  ]) {
    test(`rejects ${name}`, () => assert.ok(failures(mutant(from, to)).length > 0));
  }

  for (const api of ['spawn', 'exec', 'fork']) {
    test(`rejects ${api} added to the sync export list`, () => {
      assert.ok(failures(mutant('["spawnSync","execFileSync","execSync"]', `["spawnSync","execFileSync","execSync","${api}"]`)).length > 0);
    });
  }

  test('the same Proxy in any other file remains a finding', () => {
    for (const name of ['server/other.ts', 'server/nested/io-child-meter.ts', 'electron/io-child-meter.ts']) {
      assert.ok(failures(source, name).length > 0, name);
    }
  });

  for (const binding of ['Proxy', 'Reflect', 'Object', 'childProcess']) {
    test(`a shadowed ${binding} cannot reuse the reviewed reference exception`, () => {
      assert.ok(failures(mutant('function installChildProcessMeter()', `function installChildProcessMeter(${binding})`)).length > 0);
    });
  }

  test('comments and formatting do not change the reviewed structure', () => {
    assert.deepEqual(failures(source.replaceAll('childProcess[api]', 'childProcess /* read */ [ api ]')), []);
  });
});
