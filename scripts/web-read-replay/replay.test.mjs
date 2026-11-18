import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { judgeReplay, releaseGateVerdict, replayBrowserRead } from './run.mjs';
import { registeredInternalRoute } from '../../server/consuming-sink-inventory.ts';
import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
import { replayWebRead } from '../../server/testing/fake-web-read.ts';
import { removeTempDirSync } from '../../server/testing/cleanup.ts';
const text = readFileSync(new URL('./fixtures/sales-13342.txt', import.meta.url), 'utf8');
const ranges = () => [0, 4000, 8000, 12000].map(offset => ({ handle: 'fixture', offset, next_offset: offset === 12000 ? null : offset + 4000, eof: offset === 12000, total_length: 13342 }));
const good = () => ({ text, ranges: ranges(), cards: [], events: Array.from({ length: 8 }, () => ({ type: 'item.completed', itemType: 'tool', name: 'agent_browser_read', ok: true })), commands: { cd: true, ls: true, curl: true, python: true }, ended: true,
  defaultRoute: { browser: true, useMyChrome: false }, routeReceipts: ranges().map(r => ({ ...r, route: 'unified' })), navigationRequests: 1, captures: 1, continuationRequests: 3 });
it('T3-gate requires default browser execution, exact reconstruction, ranges and zero cards', () => {
  expect(() => judgeReplay(good())).not.toThrow();
  for (const changes of [{ text: text.slice(0, 12000) }, { ranges: [] }, { cards: [{ requestId: 'card' }] }, { ended: false }, { events: [] }, { defaultRoute: { useMyChrome: true } }, { defaultRoute: { browser: false } }, { defaultRoute: { browserTransport: 'extension' } }, { routeReceipts: [] }, { captures: 2 }, { navigationRequests: 2 }, { continuationRequests: 0 }]) {
    expect(() => judgeReplay({ ...good(), ...changes })).toThrow();
  }
});
it('T3-followOn remains separate from the G-WEB verdict', () => {
  expect(() => judgeReplay({ ...good(), commands: {} })).not.toThrow();
  expect(() => judgeReplay({ ...good(), lane: 'web_read', routeReceipts: undefined, defaultRoute: undefined })).not.toThrow();
});
const modes = dir => {
  expect(statSync(dir).mode & 0o777, dir).toBe(0o755);
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    if (statSync(path).isDirectory()) modes(path);
    else expect(statSync(path).mode & 0o777, path).toBe(0o644);
  }
};
it.skipIf(process.platform === 'win32')('T4-permissions survives umask 077 for every replay evidence file and folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'webread-evidence-mode-'));
  try {
    const out = join(root, 'replay');
    const run = spawnSync('/bin/sh', ['-c', 'umask 077; exec "$@"', 'fixture', process.execPath, '--experimental-strip-types', 'scripts/web-read-replay/run.mjs', '--fake', '--out', out], {
      env: { ...process.env, WEBREAD_REVISION: 'permissions-fixture', WEBREAD_ENGINES: 'verification' }, encoding: 'utf8', timeout: 180000,
    });
    writeEvidence(join(root, 'permissions-replay.log'), (run.stdout ?? '') + (run.stderr ?? ''));
    const report = JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8'));
    expect(report.verdict).toBe('UNVERIFIED');
    expect(run.status).toBe(1);
    expect(report.routeVerdict, JSON.stringify(report.errors)).toBe('PASS');
    expect(run.stdout).toContain('Fake routes: PASS');
    expect(run.stdout).toContain('G-WEB: UNVERIFIED');
    modes(out);
    console.info("G6 replay fixture receipt", JSON.stringify(report));
    writeEvidence(join(root, 'permissions-verdict.json'), JSON.stringify(report, null, 2));
  } finally { removeTempDirSync(root); }
}, 200000);
it.skipIf(process.platform === 'win32')('T4-helper repairs existing private evidence files', () => {
  const root = mkdtempSync(join(tmpdir(), 'webread-mode-helper-'));
  const oldMask = process.umask(0o077);
  try { evidenceDir(root); writeEvidence(join(root, 'nested', 'deeper', 'log.txt'), 'fixture'); modes(root); } finally { process.umask(oldMask); removeTempDirSync(root); }
});

it.each([
  undefined, { status: 'OPEN' }, { status: 'UNVERIFIED' },
  { status: 'PASS', disposition: 'P1-3 OPEN' }, { status: 'PASS', disposition: 'Sol UNVERIFIED' },
])('G-WEB release gate cannot PASS without closed installed exclusion proof: %j', proof => {
  expect(releaseGateVerdict('PASS', proof)).toBe('UNVERIFIED');
  expect(releaseGateVerdict('FAIL', proof)).toBe('UNVERIFIED');
});
it('G-WEB verified exclusions preserve the independently computed route result', () => {
  for (const verdict of ['PASS', 'FAIL', 'UNVERIFIED']) expect(releaseGateVerdict(verdict, { status: 'PASS', disposition: 'CLOSED' })).toBe(verdict);
});

it.each(['browser', 'web'])('replay borrows the initialized %s MCP session without reopening or retiring it', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'replay-borrowed-'));
  const cwd = process.cwd(), calls = [], observations = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'tools/list') return { tools: ['agent_browser_open', 'agent_browser_read', 'web_read'].map(name => ({ name })) };
    expect(method).toBe('tools/call');
    if (params.name === 'agent_browser_open') return { content: [] };
    const offset = params.arguments.offset ?? 0, end = Math.min(offset + 4000, text.length);
    const page = { handle: 'borrowed', offset, next_offset: end === text.length ? null : end, total_length: text.length, eof: end === text.length };
    if (kind === 'browser') return { structuredContent: { ...page, content: 'BEGIN\n' + text.slice(offset, end) + '\nEND' } };
    return { content: [{ type: 'text', text: JSON.stringify({ ...page, text: text.slice(offset, end) }) }] };
  };
  try {
    process.chdir(root);
    const helper = kind === 'browser' ? replayBrowserRead : replayWebRead;
    const result = await helper({ command: '/fixture-must-not-be-spawned', args: [] }, 'http://127.0.0.1:12345/sales', (...args) => observations.push(args), request);
    expect(result.length).toBe(text.length);
    expect(readFileSync(join(root, 'reconstructed.txt'), 'utf8')).toBe(text);
    expect(calls.map(call => call.method)).toEqual(['tools/list', ...Array(kind === 'browser' ? 5 : 4).fill('tools/call')]);
    expect(observations).toHaveLength(kind === 'browser' ? 5 : 4);
    // The producer can still use its admitted session after the helper returns.
    expect((await request('tools/list', {})).tools).toHaveLength(3);
  } finally { process.chdir(cwd); removeTempDirSync(root); }
});

it('web_read internal route admits exactly its registered POST destination', () => {
  const registry = Object.fromEntries(['project', 'email', 'mcp', 'delegation', 'box'].map(name => [name, () => false]));
  expect(registeredInternalRoute('POST', '/api/internal/web-read', registry)).toBe(true);
  for (const [method, path] of [['GET', '/api/internal/web-read'], ['DELETE', '/api/internal/web-read'], ['POST', '/api/internal/web-read/other'], ['POST', '/api/internal/web-reader']])
    expect(registeredInternalRoute(method, path, registry)).toBe(false);
});

it.each(['success', 'validation'])('web_read actual %s response declares external provenance before release', async kind => {
  const source = readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('      if (method === "POST" && path === "/api/internal/web-read")');
  const end = source.indexOf('      if (method === "POST" && path === "/api/internal/web-search")', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const handler = new AsyncFunction('method', 'path', 'req', 'res', 'readBody', 'assertInternalIdentity', 'requireActiveInternal', 'readWebPage', 'webDocuments', 'internalClaim', 'internalCapabilities', 'localJson', 'json', source.slice(start, end));
  const claims = { botId: 'fixture-bot', threadId: 'fixture-thread' }, active = () => true;
  const read = async (_input, options) => {
    expect(options.scope).toBe(JSON.stringify([claims.botId, claims.threadId]));
    expect(options.authorize()).toBe(true); await options.admitUrl();
    if (kind === 'validation') throw new Error('Fixture URL refused');
    return { text: 'external fixture page', eof: true };
  };
  const response = await handler('POST', '/api/internal/web-read', {}, {}, async () => ({ input: {} }), () => {}, active, read, {}, claims, { isActive: claim => claim === claims },
    (_res, status, body) => ({ status, body, provenance: 'external' }),
    (_res, status, body) => ({ status, body, provenance: 'undeclared' }));
  expect(response).toEqual({ status: kind === 'success' ? 200 : 400, body: kind === 'success' ? { text: 'external fixture page', eof: true, untrusted: true } : { error: 'Fixture URL refused' }, provenance: 'external' });
});
