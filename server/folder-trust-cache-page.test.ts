import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { upstreamTrustForTurn } from './folder-trust-upstream-cache.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

it('an external own-store change withholds cached authority until the replacement index is ready', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trust-cache-'));
  try {
    const cwd = join(home, 'workspace'); mkdirSync(cwd);
    const file = join(home, 'trusted_folders.toml');
    const text = (trusted: boolean) => `[folders.${JSON.stringify(cwd)}]\ntrusted = ${trusted}\nconsent = 2\n`;
    writeFileSync(file, text(true));
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ state: 'unreadable', readable: false, trusted: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ state: 'readable', readable: true, trusted: true, declined: false });
    writeFileSync(file, text(false));
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ readable: false, trusted: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ state: 'readable', readable: true, trusted: false, declined: true });
    writeFileSync(file, 'malformed [[[ authority');
    upstreamTrustForTurn(home, cwd, 2); await new Promise(resolve => setImmediate(resolve));
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ state: 'unreadable', readable: false, trusted: false });
    rmSync(file);
    expect(upstreamTrustForTurn(home, cwd, 2)).toMatchObject({ state: 'absent', readable: true, trusted: false, declined: false });
  } finally { removeTempDirSync(home); }
});

it('all saved keys remain reachable through revision-bound 50-row Settings pages and exact Forget', () => {
  const root = mkdtempSync(join(tmpdir(), 'trust-page-'));
  try {
    const file = join(root, 'folder-trust.json');
    const folders = Object.fromEntries(Array.from({ length: 121 }, (_, n) => [join(root, `saved-${n}`), { folder: join(root, `saved-${n}`), decision: 'reject', source: 'card', decidedAt: n }]));
    writeFileSync(file, JSON.stringify({ version: 1, folders }));
    const store = new FolderTrustStore(file), seen: string[] = [];
    let cursor: string | undefined;
    do { const page = store.page(root, '', cursor); expect(page.records.length).toBeLessThanOrEqual(50); seen.push(...page.records.map(row => row.key)); cursor = page.next ?? undefined; } while (cursor);
    expect(new Set(seen).size).toBe(121);
    const first = store.page(root);
    expect(store.page(root, 'saved-120').records.map(row => row.key)).toEqual([join(root, 'saved-120')]);
    expect(() => store.page(root, 'different-search', first.next!)).toThrow(/refresh/);
    expect(store.forgetKey(join(root, 'saved-120'))).toBe(true);
    expect(() => store.page(root, '', first.next!)).toThrow(/refresh/);
    expect(new FolderTrustStore(file).page(root, 'saved-120').records).toEqual([]);
  } finally { removeTempDirSync(root); }
});

it('a malformed authority row is retained for recovery and cannot be rewritten as a clean trust baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'trust-recovery-'));
  try {
    const file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    const bytes = JSON.stringify({ version: 1, folders: { [folder]: { decision: 'unknown', folder, decidedAt: 1 } } });
    writeFileSync(file, bytes);
    const store = new FolderTrustStore(file);
    expect(store.readable).toBe(false);
    expect(() => store.remember(folder, 'trust', 'picker')).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  } finally { removeTempDirSync(root); }
});
