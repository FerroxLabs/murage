// SPDX-License-Identifier: AGPL-3.0-or-later
// Only the repository's inert fake engine runs, in an isolated launcher fixture.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchVerificationServer, runControlMurage } from './control-murage.ts';
import { ProductClient } from './no-limits-live/run.mjs';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const report = { verdict: 'FAIL', rows: [], commands: [] };
let fixture, client;
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
  for (const [id, level, tool, input, cards, behavior] of [
    ['H2-python-cut-no-limits', 'unlimited', 'python', { code: '('.repeat(201) + '0' + ')'.repeat(201) }, 0, 'allow'],
    ['H2-python-cut-ask', 'ask', 'python', { code: '('.repeat(201) + '0' + ')'.repeat(201) }, 1, 'deny'],
    ['wipe-positive-control', 'unlimited', 'Bash', { command: 'rm -rf /' }, 1, 'deny'],
  ]) {
    const bot = await client.bot(id, { id: 'verification', model: 'sonnet' }, fixture.info.dataDir, level);
    const row = { id, tool, input }, text = 'S3_FIELD:' + Buffer.from(JSON.stringify(row)).toString('base64url');
    const obs = await client.turn(bot, text);
    report.rows.push({ id, level, ...obs });
    assert.equal(obs.complete, true, id); assert.equal(obs.ended, true, id); assert.deepEqual(obs.errors, [], id);
    assert.equal(obs.cards.filter(card => !card.question).length, cards, id);
    const resolutions = obs.events.filter(event => event.type === 'request.resolved');
    assert.ok(resolutions.length > 0, id + ' resolution'); assert.ok(resolutions.every(event => event.behavior === behavior), id + ' behavior');
    await client.stop(bot);
  }
  const wait = async read => {
    const until = Date.now() + 45000;
    while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(50); }
    throw Error('R4 live fixture deadline');
  };
  const durable = approvalId => {
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { const record = db.prepare('SELECT * FROM approval_records WHERE id=?').get(approvalId); return { ...record, evidence: JSON.parse(record.evidence) }; }
    finally { db.close(); }
  };
  for (const [name, command, operand, target] of [
    ['fat', 'mkfs.fat -F 32 out/disk', 'disk', '../b'],
    ['btrfs', 'mkfs.btrfs out/first out/second', 'second', '../b'],
    ['delete-system', 'rm -rf out/system/', 'system', '/usr'],
    ['probe-identity', 'mkfs.ext4 opaque=disk', 'opaque=disk', 'a'],
    ['dd-dotdot', 'dd if=/dev/zero of=out/branch/../disk', 'branch', '../two/inner'],
    ['dd-embedded', 'dd if=/dev/zero of=out/disk', 'disk', '../dev/sdb'],
    ['pwsh-backslash', 'mkfs.fat -F 32 out\\disk', 'out\\disk', 'b'],
    ['python-dotdot', "import subprocess; subprocess.run(['mkfs.ext4','out/branch/../disk'])", 'branch', '../two/inner'],
  ]) for (const changed of [true, false]) {
    const id = `R4-${name}-retarget-${changed}`;
    const cwd = join(fixture.info.dataDir, id); mkdirSync(join(cwd, 'out'), { recursive: true });
    writeFileSync(join(cwd, 'a'), 'inert a'); writeFileSync(join(cwd, 'b'), 'inert b');
    for (const path of ['disk', 'first', 'second']) symlinkSync('../a', join(cwd, 'out', path));
    if (['dd-embedded', 'dd-dotdot'].includes(name)) {
      mkdirSync(join(cwd, 'dev'));
      for (const disk of ['sda', 'sdb']) writeFileSync(join(cwd, 'dev', disk), 'inert image');
      unlinkSync(join(cwd, 'out/disk')); symlinkSync('../dev/sda', join(cwd, 'out/disk'));
    }
    if (name === 'probe-identity') symlinkSync('a', join(cwd, 'opaque=disk'));
    if (name === 'pwsh-backslash') symlinkSync('a', join(cwd, 'out\\disk'));
    if (name === 'python-dotdot' || name === 'dd-dotdot') {
      for (const directory of ['one', 'two']) { mkdirSync(join(cwd, directory, 'inner'), { recursive: true }); if (name === 'dd-dotdot') symlinkSync('../dev/' + (directory === 'one' ? 'sda' : 'sdb'), join(cwd, directory, 'disk')); else writeFileSync(join(cwd, directory, 'disk'), 'inert image'); }
      symlinkSync('../one/inner', join(cwd, 'out/branch'));
    }
    symlinkSync('/etc', join(cwd, 'out/system'));
    const bot = await client.bot(id, { id: 'verification', model: 'sonnet' }, cwd, 'unlimited');
    const tool = name === 'pwsh-backslash' ? 'powershell' : name === 'python-dotdot' ? 'python' : 'Bash';
    const row = { id, tool, input: name === 'python-dotdot' ? { code: command, cwd } : { command, cwd } }, mark = client.events.length;
    const currentCard = async () => {
      const open = await client.api('GET', `/api/threads/${bot.threadId}/open-cards`);
      return open.pending ? undefined : open.openCards?.find(row => row.card?.approvalId && !row.card.answered);
    };
    await client.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'S3_FIELD:' + Buffer.from(JSON.stringify(row)).toString('base64url'), sendId: randomUUID() });
    const original = await wait(currentCard), initial = durable(original.card.approvalId);
    const fingerprint = initial.evidence.releaseEvidence.inspection.wipes[0].fingerprint;
    assert.equal(typeof fingerprint, 'string');
    let refreshed, replacement, firstAnswer;
    if (changed) {
      const link = ['pwsh-backslash', 'probe-identity'].includes(name) ? join(cwd, operand) : join(cwd, 'out', operand); unlinkSync(link); symlinkSync(target, name === 'probe-identity' ? join(cwd, 'disk') : link);
      firstAnswer = await client.api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: original.card.requestId, behavior: 'allow' });
      replacement = await wait(async () => { const card = await currentCard(); return card && card.id !== original.id ? card : undefined; });
      refreshed = durable(replacement.card.approvalId);
      assert.equal(initial.why, 'wipe'); assert.equal(refreshed.why, 'wipe');
      assert.equal(refreshed.state, 'open'); assert.equal(refreshed.delivery, 'none');
      assert.notEqual(fingerprint, refreshed.evidence.releaseEvidence.inspection.wipes[0].fingerprint);
      assert.notEqual(original.card.requestId, replacement.card.requestId, 'new fingerprint needs a new answer key');
      assert.notEqual(initial.action_hash, refreshed.action_hash);
      assert.equal(client.events.slice(mark).filter(event => event.threadId === bot.threadId && event.type === 'request.resolved' && event.behavior === 'allow').length, 0, 'stale approval never reaches provider');
    }
    const current = replacement ?? original;
    await client.api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: current.card.requestId, behavior: 'allow' });
    await wait(async () => {
      const state = await client.api('GET', `/api/bots/${bot.id}`);
      return state.bot?.busy === false && client.events.slice(mark).some(event => event.threadId === bot.threadId && event.type === 'request.resolved');
    });
    const transcript = await client.api('GET', `/api/threads/${bot.threadId}/messages?limit=200`);
    assert.equal(transcript.hasMore, false, 'complete isolated transcript');
    const cards = transcript.messages.filter(message => message.card?.approvalId);
    assert.equal(cards.length, changed ? 2 : 1);
    if (changed) assert.equal(cards.find(card => card.id === original.id)?.card.answered, 'Permission changed before release');
    const events = client.events.slice(mark).filter(event => event.threadId === bot.threadId);
    const allowed = events.filter(event => event.type === 'request.resolved' && event.behavior === 'allow');
    assert.equal(allowed.length, 1, 'exactly one approved fake-provider delivery');
    report.rows.push({ id, cards, messages: transcript.messages, events, initial, refreshed, firstAnswer });
    await client.stop(bot);
  }
  report.verdict = 'PASS';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (fixture) writeFileSync(join(out, 'server.log'), readFileSync(fixture.info.logPath));
  await client?.disconnect(); await fixture?.close();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: report.verdict, rows: report.rows.map(row => ({ id: row.id, cards: row.cards.length })), error: report.error }));
}
