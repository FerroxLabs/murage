import assert from 'node:assert/strict';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { launchVerificationServer, runControlMurage } from '../../scripts/control-murage.ts';
const evidence = new URL('./', import.meta.url);
let fixture;
try {
  fixture = await launchVerificationServer(process.env, undefined, { separateHome: true });
  writeFileSync(new URL('fixture-info.json', evidence), JSON.stringify(fixture.info, null, 2) + '\n');
  const result = await runControlMurage(['doctor', '--url', fixture.info.url]);
  writeFileSync(new URL('fixture-doctor.json', evidence), JSON.stringify(result, null, 2) + '\n');
  assert.equal(result.ok, true);
  console.log('Isolated fake-engine fixture doctor passed.');
} finally {
  if (fixture) {
    await fixture.close();
    copyFileSync(fixture.info.logPath, new URL('fixture-server.log', evidence));
    assert.equal(existsSync(fixture.info.dataDir), false);
    console.log('Owned fixture closed; temporary data directory removed.');
  }
}
