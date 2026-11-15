import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const scenario = readFileSync(new URL('./windows/scenario-common.ps1', import.meta.url), 'utf8');
const observer = readFileSync(new URL('./windows/owned-process.ps1', import.meta.url), 'utf8');
const control = readFileSync(new URL('./windows/console-observer.ps1', import.meta.url), 'utf8');
const gate = scenario + observer + control;
test('desktop and positive observer control must precede the scenario and guard PASS', () => {
 for (const token of ['WTSGetActiveConsoleSessionId', 'OpenInputDesktop', 'GetProcessWindowStation', 'WinSta0', 'Default', 'Assert-WindowsHideDesktop', 'Assert-WindowsHideControl']) assert.ok(gate.includes(token), token);
 assert.ok(scenario.indexOf('Assert-WindowsHideDesktop') < scenario.indexOf('::RunInBackground'));
 assert.ok(control.indexOf('::AcceptControl(') < control.indexOf('::EndControl()'));
 assert.match(observer, /try \{ RequireDesktop\(\); \} catch \{ Errors\.Add\(-1\); return; \}/);
 assert.match(observer, /Positive control window did not close/);
 assert.match(gate, /desktopVerified/);
 assert.match(gate, /controlVerified/);
});
test('PASS verifies and retains the complete build manifest against Commit before scenario', () => {
 assert.match(gate, /Assert-WindowsHideManifest/);
 assert.ok(scenario.indexOf('Assert-WindowsHideManifest') < scenario.indexOf('::RunInBackground'));
 assert.match(scenario, /package-manifest-after\.json/);
 assert.match(scenario, /Package changed during scenario/);
 assert.match(gate, /package-manifest\.json/);
 assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url),'utf8'), /afterSign: .*windows-hide-package-manifest/);
});
