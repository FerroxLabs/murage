// SPDX-License-Identifier: AGPL-3.0-or-later
// The Murage for Chrome node test gate. One command, one fixed file list, so a count can never change because the command changed.
// A skipped, cancelled or todo test is a FAILURE here (a Chrome-gated security test that skips proves nothing). Needs Chrome for Testing:
//   MURAGE_GATE=1 MURAGE_CFT_CHROME=/path/to/chrome node scripts/run-extension-node-tests.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// The electron files run under the safe-wipe preload (as test:electron does; it scrubs MURAGE_* keys). The rest run without it,
// because the Chrome-gated file reads MURAGE_CFT_CHROME.
export const ELECTRON_TESTS = readdirSync('electron').filter(f => /^browser-extension-.*\.node-test\.mjs$/.test(f)).sort().map(f => `electron/${f}`);
export const SCRIPT_TESTS = [
  'scripts/prepare-browser-extension.node-test.mjs',
  'scripts/browser-extension-build.node-test.mjs',
  'scripts/browser-extension-host-registration.node-test.mjs',
  'scripts/browser-extension-fixture-site/browser-extension-fixture-site.node-test.mjs',
  'extensions/murage-browser/sidepanel/sidepanel.node-test.mjs',
  'scripts/browser-floor-facts.node-test.mjs',
  'scripts/browser-corefix8.node-test.mjs',
  'scripts/browser-extension-idle.node-test.mjs',
  'scripts/browser-extension-presence-animations.node-test.mjs',
  'scripts/browser-corefix10.node-test.mjs',
  'scripts/browser-extension-x1.node-test.mjs',
  'scripts/browser-c3.node-test.mjs',
];

const total = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
let bad = false;
for (const [args, files] of [[['--import', './server/testing/safe-wipe-preload.mjs'], ELECTRON_TESTS], [[], SCRIPT_TESTS]]) {
  const run = spawnSync(process.execPath, [...args, '--test', ...files], { encoding: 'utf8', env: { ...process.env, MURAGE_GATE: '1' }, maxBuffer: 256 * 1024 * 1024, timeout: 8 * 60 * 1000 });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) bad = true;
  for (const key of Object.keys(total)) {
    const n = Number(new RegExp(`^ℹ ${key} (\\d+)`, 'm').exec(run.stdout ?? '')?.[1]);
    if (Number.isFinite(n)) total[key] += n; else bad = true;
  }
}
console.log(`\nextension node gate: ${ELECTRON_TESTS.length + SCRIPT_TESTS.length} files, ${total.tests} tests, ${total.pass} pass, ${total.fail} fail, ${total.skipped} skipped, ${total.cancelled} cancelled, ${total.todo} todo`);
if (bad || total.fail || total.skipped || total.cancelled || total.todo || total.pass !== total.tests) {
  console.error('extension node gate FAILED: every test must pass and none may be skipped (a skip counts as a failure).');
  process.exit(1);
}
