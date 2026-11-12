// Inert host action behind the candidate's real capability-mount predicate.
// The target is a new fixture file. No screen, browser or provider is touched.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { judgeScenario, machineSummary } from './counts.mjs';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'gnl-feature-off-'));
const home = join(root, 'home'), data = join(root, 'data'), target = join(root, 'action.done');
mkdirSync(home); mkdirSync(data); writeFileSync(join(data, 'config.json'), '{}');
Object.assign(process.env, { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, NODE_ENV: 'test' });
const report = { mode: 'fake host executor; real candidate capability predicate', releaseGate: false, rows: [], errors: [], verdict: 'FAIL' };
try {
  const { autoHostDeclined } = await import('../../server/host-computer-consent.ts');
  const browser=process.argv.includes('--browser');
  const source = browser?'browser-off-unlimited':'deny-host-declined';
  const feature=browser?'browser':'host-computer';
  const {builtInBrowserEnabled}=await import('../../server/config.ts');
  const declined = browser?!builtInBrowserEnabled({features:{browser:false}}):autoHostDeclined({ computer: undefined, hostComputerConsent: 'declined' });
  const ownerLines = [];
  // This is the only action sink, observed independently from the verdict.
  if (!declined) writeFileSync(target, 'fixture host action ran');
  else ownerLines.push(browser?'Browser control is off. Turn it on in Settings > Browser.':'Computer access is off. Turn it on in the bot Computer panel in Settings.');
  const actionExecuted = existsSync(target);
  report.rows.push(judgeScenario({ id: source, actor: 'owner', level: 'unlimited', expected: 'OFF_WITH_LINE', feature }, {
    complete: true, ended: true, actionProven: true, cards: [], refusals: [],
    featureOff: { feature, actionExecuted, actionNotRunProven: !actionExecuted, continued: true, ownerLines },
    actionSink: { executed: actionExecuted },
  }));
  report.verdict = report.rows.every(r => r.verdict === 'PASS') ? 'PASS' : 'FAIL';
} catch (e) { report.errors.push(e.message); }
finally {
  rmSync(root, { recursive: true, force: true });
  writeFileSync(join(out, 'verdict.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(machineSummary(report)); process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}
