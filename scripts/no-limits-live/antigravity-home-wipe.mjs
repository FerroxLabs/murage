// Isolated HTTP/SSE fixture. Nothing billable, and the fake cannot execute the
// requested wipe even if the candidate wrongly allows it.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchVerificationServer } from '../control-murage.ts';
import { ProductClient } from './run.mjs';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const cli = fileURLToPath(new URL('../../server/drivers/testing/inert-agy.mjs', import.meta.url)); chmodSync(cli, 0o755);
const source = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
process.env.NODE_ENV = 'test';
globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
const data = process.env.MURAGE_DATA_DIR;
const config = JSON.parse(readFileSync(join(data,'config.json'),'utf8'));
config.instances.verification = { driver: 'antigravityAgent', displayName: 'Antigravity fixture', config: { cli: ${JSON.stringify(cli)}, fullAuto: true }, environment: { FAKE_AGY_RUN_HOOKS: '1', FAKE_AGY_TOOL_CALLS: JSON.stringify([{ name: 'run_command', args: { CommandLine: 'rm -rf ~' } }]), INERT_AGY_WITNESS: join(data,'unexpected-execution') } };
writeFileSync(join(data,'config.json'),JSON.stringify(config));
`;
let fixture, client;
const report = { fixture: 'Antigravity home wipe', releaseGate: false, verdict: 'FAIL' };
try {
 fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: source, separateHome: true });
 const { secret } = await (await fetch(fixture.info.url + '/api/desktop-secret')).json();
 client = new ProductClient(fixture.info.url, { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret }, fixture.info.dataDir, 30000);
 await client.connect();
 const bot = await client.bot('Antigravity wipe fixture', { id: 'verification', model: 'gemini-4-argon-high' }, fixture.info.dataDir, 'unlimited');
 const o = await client.turn(bot, 'Request the fixture tool once.');
 report.cards = o.cards; report.cardCount = o.cards.length; report.ended = o.ended;
 report.requests = o.events.filter(e => e.type === 'request.opened').map(e => ({ requestId: e.requestId, tool: e.tool }));
 report.executed = existsSync(join(fixture.info.dataDir,'unexpected-execution'));
 assert.equal(report.cardCount, 1, 'Antigravity home wipe must produce exactly one product card');
 assert.equal(report.executed, false, 'wipe must not execute');
 assert.equal(report.requests.length, 1, 'one canonical request');
 report.verdict = 'PASS';
} catch (e) { report.error = e.stack; process.exitCode = 1; }
finally {
 if (fixture) writeFileSync(join(out,'server.log'), readFileSync(fixture.info.logPath));
 await client?.disconnect(); await fixture?.close();
 writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(report.verdict + ': Antigravity home-wipe fixture');
}
