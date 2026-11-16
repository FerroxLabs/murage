import { readFileSync, writeFileSync } from 'node:fs';
import { launchVerificationServer, runControlMurage, controlResultSucceeded } from './control-murage.ts';
const evidence = 'evidence/cfix-hlc2-f02';
const fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60000 });
try {
  writeFileSync(`${evidence}/fixture.json`, `${JSON.stringify(fixture.info, null, 2)}\n`);
  const result = await runControlMurage(['doctor', '--url', fixture.info.url]);
  writeFileSync(`${evidence}/doctor.json`, `${JSON.stringify(result, null, 2)}\n`);
  if (!controlResultSucceeded('doctor', result)) throw new Error('Isolated fixture doctor failed');
  console.log('PASS isolated fixture launch + doctor; production dispatcher/journals exercised separately by cfix-f02.test.ts with fake provider');
} finally {
  await fixture.close();
  writeFileSync(`${evidence}/fixture-server.log`, readFileSync(fixture.info.logPath));
}
