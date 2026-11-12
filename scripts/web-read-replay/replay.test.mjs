import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { judgeReplay, releaseGateVerdict } from './run.mjs';
import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
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
    writeEvidence('.webread-evidence/r2/permissions-replay.log', (run.stdout ?? '') + (run.stderr ?? ''));
    const report = JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8'));
    expect(report.verdict).toBe('UNVERIFIED');
    expect(run.status).toBe(1);
    expect(report.routeVerdict, JSON.stringify(report.errors)).toBe('PASS');
    expect(run.stdout).toContain('Fake routes: PASS');
    expect(run.stdout).toContain('G-WEB: UNVERIFIED');
    modes(out);
    writeEvidence('.webread-evidence/r2/permissions-verdict.json', JSON.stringify(report, null, 2));
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
