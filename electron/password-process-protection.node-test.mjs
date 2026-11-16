// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const path = '../shared/password-process-protection.mjs';
const mod = existsSync(new URL(path, import.meta.url)) ? await import(path) : {};
function fixture(extra = {}) {
  assert.equal(typeof mod.protectPasswordProcess, 'function');
  const runtime = { execArgv: [], env: {}, report: { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true, writeReport() {}, getReport() {} } };
  const v8 = { writeHeapSnapshot() {}, getHeapSnapshot() {} };
  let calls = 0;
  const deps = { runtime, v8, inspectorUrl: () => undefined, syncExports() {}, native: { disableCoreDumps: () => { calls++; return true; } }, ...extra };
  return { deps, runtime, v8, calls: () => calls };
}
test('R11 disables automatic reports and explicit memory bearing report and heap sinks before admission', () => {
  const h = fixture(); assert.equal(mod.protectPasswordProcess(h.deps), true);
  assert.equal(h.calls(), 1);
  for (const key of ['reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException']) assert.equal(h.runtime.report[key], false);
  for (const operation of [() => h.runtime.report.writeReport(), () => h.runtime.report.getReport(), () => h.v8.writeHeapSnapshot(), () => h.v8.getHeapSnapshot()]) assert.throws(operation, /Password protection is unavailable\./);
});
test('R11 missing or failed OS dump prevention cannot attest a protected process', () => {
  for (const native of [undefined, {}, { disableCoreDumps: () => false }, { disableCoreDumps() { throw Error('unsafe native prose'); } }]) {
    const h = fixture({ native }); assert.equal(mod.protectPasswordProcess(h.deps), false);
  }
});
test('R11 inspector and automatic dump flags refuse password exposure', () => {
  const inspected = fixture({ inspectorUrl: () => 'ws://fixture' }); assert.equal(mod.protectPasswordProcess(inspected.deps), false);
  for (const flag of ['--inspect', '--report-on-fatalerror', '--report-on-signal', '--report-uncaught-exception', '--heapsnapshot-near-heap-limit=1', '--heap-prof', '--heapsnapshot-signal=SIGUSR2']) {
    for (const source of ['argv', 'env']) {
      const h = fixture(); if (source === 'argv') h.runtime.execArgv.push(flag); else h.runtime.env.NODE_OPTIONS = flag;
      assert.equal(mod.protectPasswordProcess(h.deps), false, flag);
    }
  }
});
test('R11 production main and server install process protection before accepting passwords', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('protectPasswordProcess(')); assert.ok(server.includes('protectPasswordProcess('));
  assert.ok(!server.includes('highlevelNativeSessions.available()'));
});
