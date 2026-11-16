// Isolated fake-engine server, using the project's required control surface.
import { readFileSync, writeFileSync } from 'node:fs';
import { launchVerificationServer, runControlMurage } from '../../scripts/control-murage.ts';
let fixture;
try { fixture = await launchVerificationServer(process.env); }
catch (error) {
  const log = String(error).match(/see ([^\n]+\.log)/)?.[1];
  if (log) writeFileSync('lane-evidence/inbox-rollup/round2-fixture-server.log', readFileSync(log));
  throw error;
}
try {
  const doctor = await runControlMurage(['doctor', '--url', fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
  console.log(JSON.stringify({ fixture: fixture.info, doctor }));
} finally { writeFileSync('lane-evidence/inbox-rollup/round2-fixture-server.log', readFileSync(fixture.info.logPath)); await fixture.close(); }
