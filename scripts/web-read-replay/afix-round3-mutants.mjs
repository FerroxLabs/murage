// Fake service regression proofs. Run only in the isolated network-none container.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
const out = process.argv[2];
if (!out || out.startsWith('/dev')) throw Error('Specify an evidence directory outside /dev');
evidenceDir(out);
const file = 'server/browser-extension-service.ts';
const original = readFileSync(file, 'utf8');
const baseline = readFileSync('.webread-evidence/afix-r3/baseline/browser-extension-service.ts', 'utf8');
const results = [];
const hash = text => createHash('sha256').update(text).digest('hex');
writeEvidence(join(out, 'source-sha256.json'), JSON.stringify({ baseline: hash(baseline), candidate: hash(original) }, null, 2));
function run(id, source, pattern, expected) {
  if (source === original) throw Error(`${id}: mutation did not apply`);
  try {
    writeFileSync(file, source);
    const result = spawnSync('node_modules/.bin/vitest', ['run', 'server/browser-read-route-inventory.test.ts', '-t', pattern], { encoding: 'utf8', timeout: 240000 });
    const log = (result.stdout ?? '') + (result.stderr ?? '');
    writeEvidence(join(out, `${id}.log`), log);
    const killed = result.status === 1 && expected.every(text => log.includes(text)) && !/Transform failed|Failed Suites|SyntaxError/.test(log);
    results.push({ id, exit: result.status, killed, expected });
    if (!killed) process.exitCode = 1;
  } finally {
    writeFileSync(file, original);
    writeEvidence(join(out, 'results.json'), JSON.stringify(results, null, 2));
  }
}
run('RED-authority-baseline', baseline, 'G-WEB same-binding|G-WEB No limits read grant', ['7 failed', 'promise resolved', 'expected']);
run('RED-never-baseline', baseline, 'G-WEB Never Allow', ['8 failed', 'site_denied', 'WAITING FOR THE OWNER']);
run('M7-task-consent', original.replace('if (ordinaryRead) (entry.readL1 ??= new Set()).add(origin); else entry.taskL1.add(origin);', 'entry.taskL1.add(origin);'),
  'G-WEB same-binding|G-WEB No limits read grant', ['7 failed', 'promise resolved']);
run('M8-ignore-immediate', original.replace('neverRead = true;', "fail('site_denied');"),
  'G-WEB Never Allow.*immediate', ['4 failed', 'site_denied']);
run('M8-ignore-delayed', original.replace("const earlier = options.consumeApproval?.({ ...entry.context }, { kind: 'site', binding }) === true;", 'const earlier = false;'),
  'G-WEB Never Allow.*delayed', ['4 failed', 'WAITING FOR THE OWNER']);
console.log(JSON.stringify(results, null, 2));
