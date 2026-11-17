import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { launchVerificationServer, runControlMurage } from '../../scripts/control-murage.ts';
import { parkSignalForDowngrade, recoverSignalPark } from '../../server/channels/signal/park.ts';
import { pathsFor, parkSchema } from '../../server/channels/signal/park-control.ts';

// Launch owns a disposable HOME/data directory and only the fake engine.
const fixture = await launchVerificationServer(process.env);
const evidence = { fixture: fixture.info, commands: [] };
try {
  const doctor = () => runControlMurage(['doctor', '--url', fixture.info.url], {
    env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir },
  });
  evidence.commands.push({ command: 'doctor --url <fixture>', result: await doctor() });
  assert.equal(evidence.commands[0].result.ok, true);
  await fixture.stop();
  const root = fixture.info.dataDir, paths = pathsFor(root);
  assert.equal(existsSync(paths.signal), false);
  assert.equal(existsSync(paths.channel), false);
  const put = (file, value) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, value, { mode: 0o600 });
  };
  if (!existsSync(join(root, 'install-id.json'))) put(join(root, 'install-id.json'), JSON.stringify({ installId: randomUUID() }));
  const record = JSON.stringify({ version: 1, connectionId: 'inode-fixture', generation: 1,
    enabled: false, paused: true, revoking: false, binding: null, account: null });
  put(join(paths.channel, 'connection.json'), record);
  put(join(paths.signal, 'auth/key'), 'SYNTHETIC-INODE-FIXTURE');
  const fence = { lease: () => 'fixture-lease', discover: () => true, host: () => 'fixture', boot: () => 'boot', uptime: () => 1 };
  parkSignalForDowngrade(root, { fence });
  assert.equal(existsSync(paths.signal), false);
  assert.equal(existsSync(paths.channel), false);
  const name = readdirSync(paths.bundles)[0];
  const journal = parkSchema.parse(JSON.parse(readFileSync(join(paths.bundles, name, 'park.json'), 'utf8')));
  assert.match(journal.root.ino, /^\d+$/);
  assert.match(journal.root.dev, /^\d+$/);
  evidence.commands.push({ command: 'parkSignalForDowngrade(disposable fixture)', root: journal.root, state: journal.state });
  const restored = recoverSignalPark(root, { fence });
  assert.equal(restored.state, 'ready');
  assert.equal(readFileSync(join(paths.channel, 'connection.json'), 'utf8'), record);
  assert.equal(readFileSync(join(paths.signal, 'auth/key'), 'utf8'), 'SYNTHETIC-INODE-FIXTURE');
  evidence.commands.push({ command: 'recoverSignalPark(disposable fixture)', result: restored, syntheticBytesPreserved: true });
  writeFileSync(new URL('./fixture-server-before.log', import.meta.url), readFileSync(fixture.info.logPath));
  await fixture.restart();
  const after = await doctor();
  assert.equal(after.ok, true);
  evidence.commands.push({ command: 'restart fixture; doctor --url <fixture>', result: after, logPath: fixture.info.logPath });
} finally {
  writeFileSync(new URL('./fixture-server-after.log', import.meta.url), readFileSync(fixture.info.logPath));
  await fixture.close();
  evidence.cleaned = !existsSync(evidence.fixture.dataDir);
  console.log(JSON.stringify(evidence, null, 2));
}
