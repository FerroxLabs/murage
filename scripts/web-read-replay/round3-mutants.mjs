// Fixture-only round 3 proofs. Run in the isolated network-none test container.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
const out = process.argv[2];
if (!out || out.startsWith('/dev')) throw Error('Specify an evidence directory outside /dev');
evidenceDir(out);
const service = 'server/browser-extension-service.ts', replay = 'scripts/web-read-replay/run.mjs';
const originals = new Map([service, replay].map(file => [file, readFileSync(file, 'utf8')]));
const results = [];
function run(id, file, changed, command, expected) {
  if (changed === originals.get(file)) throw Error(`${id}: mutation did not apply`);
  try {
    writeFileSync(file, changed);
    const result = spawnSync(command[0], command.slice(1), {
      encoding: 'utf8', timeout: 240000,
      env: { ...process.env, WEBREAD_REVISION: id, WEBREAD_ENGINES: 'verification' },
    });
    const log = (result.stdout ?? '') + (result.stderr ?? '');
    writeEvidence(join(out, `${id}.log`), log);
    const killed = result.status === 1 && expected.every(text => log.includes(text)) && !/Transform failed|Failed Suites|SyntaxError/.test(log);
    results.push({ id, exit: result.status, killed, expected });
    if (!killed) process.exitCode = 1;
  } finally {
    writeFileSync(file, originals.get(file));
    writeEvidence(join(out, 'results.json'), JSON.stringify(results, null, 2));
  }
}
const tests = (file, pattern) => ['node_modules/.bin/vitest', 'run', file, '-t', pattern];
const serviceTests = 'server/browser-read-route-inventory.test.ts';
const replayTests = 'scripts/web-read-replay/replay.test.mjs';
const baselineDir = '.webread-evidence/r3/baseline';
const baselineService = readFileSync(join(baselineDir, 'browser-extension-service.ts'), 'utf8');
const baselineReplay = readFileSync(join(baselineDir, 'run.mjs'), 'utf8');
writeEvidence(join(out, 'baseline-sha256.json'), JSON.stringify(Object.fromEntries([
  ['browser-extension-service.ts', baselineService], ['run.mjs', baselineReplay],
].map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')])), null, 2));
run('RED-first-read-baseline', service, baselineService, tests(serviceTests, 'G-WEB first read'), ['WAITING FOR THE OWNER', '4 failed']);
run('RED-release-gate-baseline', replay, baselineReplay,
  [process.execPath, '--experimental-strip-types', '--input-type=module', '-e', `
    import { main } from './scripts/web-read-replay/run.mjs';
    import { readFileSync } from 'node:fs';
    const out = ${JSON.stringify(join(out, 'baseline-replay'))};
    await main(['--fake', '--out', out]);
    const report = JSON.parse(readFileSync(out + '/verdict.json', 'utf8'));
    console.log('installed exclusions:', report.installedExclusions.status);
    console.log('observed overall:', report.verdict);
    if (report.verdict === 'PASS' && report.installedExclusions.status === 'UNVERIFIED') {
      console.log('RED: false release PASS with UNVERIFIED exclusion proof'); process.exitCode = 1;
    }
  `], ['RED: false release PASS with UNVERIFIED exclusion proof']);
run('M5-askSite', service, originals.get(service).replace('ordinaryRead || full || earlier', 'full || earlier'),
  tests(serviceTests, 'G-WEB first read'), ['WAITING FOR THE OWNER', '4 failed']);
run('M5-read-destination', service, originals.get(service).replace('const decision: Awaited<ReturnType<typeof decideFor>> = unlimitedRead', 'const decision: Awaited<ReturnType<typeof decideFor>> = false'),
  tests(serviceTests, 'G-WEB first read'), ['WAITING FOR THE OWNER', '2 failed']);
run('M5-never', service, originals.get(service).replace('if (ownerRead) {\n        const answer', 'if (false) {\n        const answer'),
  tests(serviceTests, 'G-WEB explicit Never'), ['expected []', '1 failed']);
run('M6-release-gate', replay, originals.get(replay).replace('report.verdict = releaseGateVerdict(report.routeVerdict, report.installedExclusions);', 'report.verdict = report.routeVerdict;'),
  tests(replayTests, 'T4-permissions'), ["expected 'PASS' to be 'UNVERIFIED'", '1 failed']);
console.log(JSON.stringify(results, null, 2));
