import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const mandatoryFiles = [
  'scripts/no-limits-live/mandatory-ruling.test.mjs',
  'scripts/no-limits-live/mandatory-powershell.test.mjs',
  'scripts/no-limits-live/mandatory-unreadable.test.mjs',
  'scripts/no-limits-live/mandatory-wipe.test.mjs',
];
// These No limits assertions encode the superseded two-exception rule or
// reader fail-closed rule. Their replacement files above are owned by G-NL;
// we cannot rewrite product tests from this script-only lane. No baseline
// failing-test subtraction is accepted for the replacements.
export const supersededMandatoryFiles = [
  'server/nolimits-means-it.test.ts',
  'server/powershell-fail-closed-104.test.ts',
  'server/nolimits-means-it-1020.test.ts',
  'server/no-limits-r13-gate.test.ts',
];
export function childResult(args, { cwd, env = process.env, timeout = 600000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: 'Child could not start' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? 1 : code ?? 1, stdout, stderr, timedOut }); });
  });
}
export function absoluteSuiteVerdict(result, exitCode) {
  const assertions = (result?.testResults ?? []).flatMap(r => r.assertionResults ?? []);
  return exitCode === 0 && result?.success === true && result.numTotalTests > 0
    && assertions.length === result.numTotalTests && assertions.every(a => a.status === 'passed')
    && mandatoryFiles.every(path => result.testResults.some(r => r.name.replaceAll('\\', '/').endsWith(path))) ? 'PASS' : 'FAIL';
}
export async function mandatoryLeg(root, out) {
  const json = join(out, 'mandatory.json');
  const result = await childResult([join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...mandatoryFiles,
    '--maxWorkers=1', '--reporter=json', `--outputFile=${json}`], { cwd: root });
  writeFileSync(join(out, 'mandatory.log'), result.stdout + result.stderr);
  let report; try { report = JSON.parse(readFileSync(json)); } catch {}
  return { verdict: absoluteSuiteVerdict(report, result.code), code: result.code, files: mandatoryFiles,
    tests: report?.numTotalTests ?? 0, failed: report?.numFailedTests ?? 0, skipped: report?.numPendingTests ?? 0,
    supersededMandatoryFiles,
    rule: '11-12 replacement assertions absolute green; no baseline subtraction and no skipped tests' };
}
export async function replayLeg(root, out, { corpus, corpusSha, platform, candidateSha }) {
  if (!corpus || !existsSync(corpus)) {
    const report = { verdict: 'FAIL', status: 'UNPROVEN', rows: 257, pass: 0, skipped: 257,
      reason: '257-row redacted real-log corpus absent; no substitute generated' };
    writeFileSync(join(out, 'replay.json'), JSON.stringify(report, null, 2) + '\n'); return report;
  }
  const json = join(out, 'replay.json');
  const result = await childResult(['--experimental-strip-types', join(root, 'scripts/nolim-replay/run.mjs'),
    '--release', '--corpus', corpus, '--sha256', corpusSha ?? '', '--platform', platform, '--candidate', candidateSha, '--out', json], { cwd: root });
  writeFileSync(join(out, 'replay.log'), result.stdout + result.stderr);
  let report; try { report = JSON.parse(readFileSync(json)); } catch {}
  return report && result.code === 0 ? report : { ...report, verdict: 'FAIL', code: result.code, status: report?.status ?? 'UNPROVEN' };
}
