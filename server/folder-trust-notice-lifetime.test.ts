// W-T08 (activity side), W-T09, W-T21 (store side). Uses the real message database file and a real restart.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { folderTrustDisplayName, folderTrustNotice } from '../shared/folder-trust.ts';
import { DATA_DIR } from './config.ts';
import { database, transaction } from './database.ts';
import { FolderTrustStore } from './folder-trust.ts';
import { folderTrustKeyDigest, lastActivity, recordActivity } from './folder-trust-activity.ts';
import { closeMessageDb, deleteThread, insertMessage } from './message-db.ts';
import type { Message } from './store.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const msg = (id: string): Message => ({ id, role: 'user', kind: 'text', text: 'fixture', at: Date.now() });
const digest = folderTrustKeyDigest('/fixture/workspace');
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

describe('activity rows are the lifetime of the saved-no notice', () => {
  it('stored-no-notice-at-no-limits: the saved-decline notice is claimed once whatever the level, and a repeat is not a second claim', () => {
    insertMessage('thread-a', msg('m1'));
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline')).toBe(true);
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline')).toBe(false);
    // a different decision revision or key is a different notice
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-2', digest, 'configuration-withheld', 'saved-decline')).toBe(true);
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-1', folderTrustKeyDigest('/fixture/other'), 'configuration-withheld', 'saved-decline')).toBe(true);
    expect(lastActivity('thread-a')).toMatchObject({ observation: 'configuration-withheld', reason: 'saved-decline', keyDigest: folderTrustKeyDigest('/fixture/other') });
  });

  it('saved-no-notice-survives-4097-threads-and-restart', () => {
    insertMessage('thread-a', msg('m1'));
    // one transaction for the 4,097 other threads' rows: the claim itself is what is under test, not the write-ahead log's admission
    transaction(() => {
      for (let n = 0; n < 4097; n++) expect(recordActivity(`other-${n}`, 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline')).toBe(true);
    });
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline')).toBe(true);
    transaction(() => {
      for (let n = 0; n < 4097; n++) expect(recordActivity(`other-${n}`, 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline')).toBe(false);
    });
    closeMessageDb(); // the restart: the server process starts again on the same data directory
    expect(recordActivity('thread-a', 'configuration-withheld', 'rev-1', digest, 'configuration-withheld', 'saved-decline'), 'shown once across 4,097 other threads and a restart').toBe(false);
    expect(lastActivity('thread-a')).toMatchObject({ kind: 'configuration-withheld', revision: 'rev-1' });
  });

  it('a row is removed with its thread, so a recreated thread may be told again', () => {
    insertMessage('thread-a', msg('m1'));
    recordActivity('thread-a', 'process-choice-sent', 'rev-1', digest, 'process-choice-sent', 'none');
    deleteThread('thread-a');
    expect(lastActivity('thread-a')).toBeNull();
    expect(database().prepare("SELECT COUNT(*) AS n FROM thread_folder_trust_activity WHERE thread_id='thread-a'").get()).toEqual({ n: 0 });
    expect(recordActivity('thread-a', 'process-choice-sent', 'rev-1', digest, 'process-choice-sent', 'none')).toBe(true);
  });

  it('refuses a reason or digest that could carry a path', () => {
    expect(() => recordActivity('thread-a', 'unknown', 'rev', digest, 'unknown', '/fixture/workspace' as never)).toThrow();
    expect(() => recordActivity('thread-a', 'unknown', 'rev', '/fixture/workspace', 'unknown', 'none')).toThrow();
  });
});

it('restart-reasks-and-settings-keeps-history (store side): the store bytes are untouched and the activity row survives a restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'trust-lifetime-'));
  try {
    const file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    mkdirSync(folder);
    // written by hand in a compact form no store write produces, so any rewrite by the store shows as a byte change
    const record = { folder, decision: 'trust', source: 'picker', decidedAt: 1 };
    writeFileSync(file, JSON.stringify({ version: 1, folders: { [folder]: record } }));
    const before = readFileSync(file, 'utf8');
    const seeded = new FolderTrustStore(file);
    expect(readFileSync(file, 'utf8'), 'loading the store does not rewrite it').toBe(before);
    insertMessage('thread-a', msg('m1'));
    recordActivity('thread-a', 'process-choice-sent', seeded.index().revision, folderTrustKeyDigest(folder), 'process-choice-sent', 'none');
    closeMessageDb();
    const restarted = new FolderTrustStore(file);
    expect(readFileSync(file, 'utf8'), 'an automatic choice never writes the store, before or after a restart').toBe(before);
    expect(restarted.list().map(row => [row.key, row.decision, row.source])).toEqual([[folder, 'trust', 'picker']]);
    expect(lastActivity('thread-a')).toMatchObject({ observation: 'process-choice-sent', keyDigest: folderTrustKeyDigest(folder) });
    expect(restarted.index().revision).toBe(seeded.index().revision);
  } finally { removeTempDirSync(root); }
});

it('T-TRUST-F08-copy: a process choice is neither saved consent nor an instruction-load acknowledgement', () => {
  const name = 'folder process choice sent:';
  expect(folderTrustNotice(name)?.kind).toBe('process');
  expect(folderTrustDisplayName(name)).toBe('Folder settings allowed for this turn. This does not save a trust decision.');
});

it('T-TRUST-F11-lifetime: saved-no events retain a unique server-fold key across 4097 threads and driver restart', () => {
  const text = readFileSync(new URL('./drivers/acp/core.ts', import.meta.url), 'utf8');
  const start = text.indexOf('const noteDeclineOnce =');
  const end = text.indexOf('\n        };', start) + '\n        };'.length;
  const js = ts.transpileModule(text.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const persisted = new Set<string>(), displayed: string[] = [];
  const context = () => { const ctx = { threadId: 'original', state: { settled: false }, declineChipsShown: new Map(),
    turn: { folderTrust: { rejects: [{ key: '/fixture/workspace', folder: '/fixture/workspace' }] } },
    digest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    noteFolderTrust(name: string, identity?: string) {
      const key = `${ctx.threadId}:${identity}`;
      if (identity && persisted.has(key)) return;
      if (identity) persisted.add(key);
      if (ctx.threadId === 'original') displayed.push(name);
    },
  }; return ctx; };
  const first = context();
  const emit = runInNewContext(js + '; noteDeclineOnce', first) as (key: string, name: string) => void;
  emit('/fixture/workspace', 'saved decline');
  for (let n = 0; n < 4097; n++) { first.threadId = `thread-${n}`; emit('/fixture/workspace', 'saved decline'); }
  first.threadId = 'original'; emit('/fixture/workspace', 'saved decline');
  const restarted = context();
  (runInNewContext(js + '; noteDeclineOnce', restarted) as typeof emit)('/fixture/workspace', 'saved decline');
  expect(displayed).toEqual(['saved decline']);
});
