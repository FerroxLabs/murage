import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSmoothReceipt } from './smooth-receipt.mjs';
test('smoothness reuse binds raw evidence and rejects empty exits, wrong modes, stale and mismatched receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate1019-receipt-'));
  const sha = 'a'.repeat(40), rig = 'b'.repeat(40), overlay = 'c'.repeat(40);
  const now = Date.now(), state = 'smooth-idle/run-idle.fixture', evidence = 'smooth-idle-evidence';
  const write = (path, text) => writeFileSync(join(root, path), text);
  const json = (path, value) => write(path, JSON.stringify(value));
  mkdirSync(join(root, state), { recursive: true }); mkdirSync(join(root, evidence, 'out'), { recursive: true });
  const result = { tree: overlay, engines: 'fake', load: false, startedAt: new Date(now - 1000).toISOString() };
  json('manifest.json', { sha, smoothRig: rig }); write(`${state}/overlay`, overlay);
  write(`${state}/worker.exit`, '0\n'); write(`${state}/tee.exit`, '0\n'); write(`${evidence}/done`, '0\n');
  json(`${evidence}/out/results-fixture.json`, result); json(`${evidence}/fixture.json`, { pinned: true });
  write(`${evidence}/gate.log`, 'PASS: 63 of 63 rows pass.\n');
  const git = (command, ref) => command === 'show' ? '{"pinned":true}' : command === 'diff-tree' ? 'scripts/smoothness/fixture.mjs'
    : command === 'ls-tree' ? `100644 blob ${'d'.repeat(40)}\tscripts/smoothness/fixture.mjs` : ref.endsWith('^') ? sha : 'script-tree';
  const options = { root, sha, rig, mode: 'idle', git, now };
  try {
    assert.equal(readSmoothReceipt(options).result, 'PASS');
    write(`${state}/worker.exit`, ''); write(`${evidence}/done`, ''); assert.throws(() => readSmoothReceipt(options));
    write(`${state}/worker.exit`, '0'); write(`${evidence}/done`, '0');
    for (const changed of [{ load: true }, { engines: 'real' }, { tree: 'wrong' }, { startedAt: 'invalid' },
      { startedAt: new Date(now - 8 * 86400_000).toISOString() }]) {
      json(`${evidence}/out/results-fixture.json`, { ...result, ...changed }); assert.throws(() => readSmoothReceipt(options));
    }
    json(`${evidence}/out/results-fixture.json`, result);
    assert.throws(() => readSmoothReceipt({ ...options, sha: 'd'.repeat(40) }));
    assert.throws(() => readSmoothReceipt({ ...options, git: (cmd, ref) => ref.endsWith('^') ? 'wrong' : git(cmd, ref) }));
    assert.throws(() => readSmoothReceipt({ ...options, git: (cmd, ref) => cmd === 'diff-tree' ? 'server/index.ts' : git(cmd, ref) }));
    write(`${evidence}/gate.log`, 'PASS: 63 of 63 rows pass.\nPASS: 63 of 63 rows pass.\n');
    assert.equal(readSmoothReceipt(options).result, 'UNVERIFIED');
  } finally { safeWipeSync(root); }
});
