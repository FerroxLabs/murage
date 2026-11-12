import { launchVerificationServer, runControlMurage } from '../../../scripts/control-murage.ts';
import { copyFileSync, existsSync } from 'node:fs';
const fixture = await launchVerificationServer();
console.log(JSON.stringify({launch:fixture.info}));
try {
  const doctor = await runControlMurage(['doctor','--url',fixture.info.url], {env:{...process.env,MURAGE_DATA_DIR:fixture.info.dataDir}});
  console.log(JSON.stringify({doctor}));
  if (!doctor || doctor.ok !== true) throw Error('doctor not ready');
} finally {
  await fixture.close();
  copyFileSync(fixture.info.logPath, 'lane-evidence/toolid-s4a/r12/fixture-server.log');
  if (existsSync(fixture.info.dataDir)) throw Error('fixture data not removed');
  console.log(JSON.stringify({cleanup:true}));
}
