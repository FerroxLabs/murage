// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated documented control fixture; its fake engine never executes payloads.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchVerificationServer, runControlMurage } from './control-murage.ts';
import { ProductClient } from './no-limits-live/run.mjs';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const report = { verdict: 'FAIL', rows: [], commands: [] };
let fixture, client, blocked;
class Client extends ProductClient {
  async api(method, path, body) {
    if (method === 'PATCH' && /^\/api\/bots\/[^/]+$/.test(path) && body?.autoApprove === true) body = { ...body, acknowledgeLocalAuto: true };
    const result = await super.api(method, path, body);
    report.commands.push({ method, path, body, result }); return result;
  }
}
try {
  const preload = `import {installTrulyFixture} from ${JSON.stringify(new URL('./no-limits-live/truly-fixture.mjs', import.meta.url).href)};await installTrulyFixture();`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: preload });
  report.fixture = fixture.info;
  report.doctor = await runControlMurage(['doctor', '--url', fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  assert.equal(report.doctor.ok, true);
  const secret = await (await fetch(fixture.info.url + '/api/desktop-secret')).json();
  client = new Client(fixture.info.url, { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret.secret }, fixture.info.dataDir, 60000);
  await client.connect();
  const cwd = join(fixture.info.dataDir, 'delete-scratch'); mkdirSync(join(cwd, 'out'), { recursive: true });
  writeFileSync(join(cwd, 'out/disk'), 'inert ordinary file');
  symlinkSync('loop', join(cwd, 'loop'));
  blocked = join(cwd, 'blocked'); mkdirSync(blocked); chmodSync(blocked, 0);
  for (const [id, tool, command, cards] of [
    ['review-missing-before-parent', 'Bash', 'rm -rf missing/../out/disk', 1],
    ['loop-prefix', 'Bash', 'rm -rf loop/child', 1],
    ['permission-prefix', 'Bash', 'rm -rf blocked/child', 1],
    ['absent-build', 'Bash', 'rm -rf build', 0],
    ['absent-build-slash', 'Bash', 'rm -rf build/', 0],
    ['absent-node-cache', 'Bash', 'rm -rf node_modules/.cache', 0],
    ['find-delete', 'Bash', 'find missing/../out/disk -delete', 1],
    ['powershell-delete', 'powershell', 'Remove-Item -Recurse missing/../out/disk', 1],
    ['python-delete', 'python', "import shutil; shutil.rmtree('missing/../out/disk')", 1],
    ['node-delete', 'node', "const fs=require('fs'); fs.rmSync('missing/../out/disk', {recursive:true})", 1],
    ['final-link-unlink', 'Bash', 'rm -rf loop', 0],
    ['final-link-traversal', 'Bash', 'rm -rf loop/', 1],
  ]) {
    const bot = await client.bot(id, { id: 'verification', model: 'sonnet' }, cwd, 'unlimited');
    const input = tool === 'python' || tool === 'node' ? { code: command, cwd } : { command, cwd };
    const row = { id, tool, input }, text = 'S3_FIELD:' + Buffer.from(JSON.stringify(row)).toString('base64url');
    const obs = await client.turn(bot, text); report.rows.push({ id, ...obs });
    assert.equal(obs.complete, true, id); assert.equal(obs.ended, true, id); assert.deepEqual(obs.errors, [], id);
    assert.equal(obs.cards.filter(card => !card.question).length, cards, id);
    const resolutions = obs.events.filter(event => event.type === 'request.resolved');
    assert.ok(resolutions.length > 0, id + ' resolution');
    assert.ok(resolutions.every(event => event.behavior === (cards ? 'deny' : 'allow')), id + ' behavior');
    await client.stop(bot);
  }
  report.verdict = 'PASS';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (blocked) chmodSync(blocked, 0o700);
  if (fixture) writeFileSync(join(out, 'server.log'), readFileSync(fixture.info.logPath));
  await client?.disconnect(); await fixture?.close();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: report.verdict, rows: report.rows.map(row => ({ id: row.id, cards: row.cards.length })), error: report.error }));
}
