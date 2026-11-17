// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { WritetimeFixture } from '../server/memory/testing/writetime-fixture.ts';
// Starting source has no integrated reader/G9 checks: report an assertion RED.
const readerPath = './gh18-package-acceptance.ts';
const readers = await import(readerPath).catch(() => ({}));
const { seedPackageReaders, packageReaderProjection } = readers;
import { applyFreshStartRows, planFreshStart } from '../server/memory/gh18-fresh-start.ts';
const g9Path = './gh18-package-g9.mjs';
const { G9_TASKS } = await import(g9Path).catch(() => ({}));
it('bundled reporting keeps clean text and still masks credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'package-display-policy-'));
  try {
    const outfile = join(root, 'collector.mjs');
    await build({ entryPoints: ['server/harness/audience-collector.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { RuntimeAudienceCollector } = await import(pathToFileURL(outfile).href);
    const collector = new RuntimeAudienceCollector(), attachment = collector.attach('fixture');
    const source = collector.source(collector.admitNewTurn({ attachment, instanceId: 'fixture', threadId: 'package-thread' }));
    const feed = text => collector.intake({ type: 'item.completed', eventId: 'fixture-event', provider: 'fixture', threadId: 'package-thread', createdAt: new Date().toISOString(), itemType: 'assistant_text', text }, source).audience;
    expect(JSON.stringify(feed('Report written: synthetic report')), 'Packaged display policy must keep clean report text').toContain('Report written: synthetic report');
    expect(JSON.stringify(feed('**password**: fixture private value'))).not.toContain('fixture private value');
    expect(collector.masked(source)).toBe(true);
  } finally { safeWipeSync(root); }
});
it('packaged acceptance compares nonowner reader verdicts across the real P1 clear', () => {
  expect(typeof packageReaderProjection, 'Packaged acceptance must observe reader visibility').toBe('function');
  const fx = new WritetimeFixture().cert(true);
  try {
    seedPackageReaders(fx.db, 'package-thread');
    fx.db.exec('INSERT INTO memory_revoke_audience VALUES(918001)');
    fx.denySession('package-thread', 'fixture', 'owner-session', 918001);
    const before = packageReaderProjection(fx.db, 'package-thread');
    const plan = planFreshStart(fx.db, { id: 'package-bot', tasks: [{ threadId: 'package-thread', resumeCursors: { fixture: 'owner-session' } }] }, { ownerDirectThread: () => true, liveThreads: new Set(), pendingDeletion: () => false });
    expect(plan.blocked).toBeNull();
    fx.db.exec('BEGIN IMMEDIATE');
    expect(applyFreshStartRows(fx.db, plan)).toBe(1);
    fx.db.exec('COMMIT');
    expect(packageReaderProjection(fx.db, 'package-thread')).toEqual(before);
    // This observation must fail if a clear also removes a protected mark.
    fx.db.exec("DELETE FROM memory_deny_line WHERE thread_id='package-thread'");
    expect(() => packageReaderProjection(fx.db, 'package-thread')).toThrow(assert.AssertionError);
  } finally { fx.close(); }
});
it('packaged G9 covers every required task with a concrete destination', () => {
  expect(Array.isArray(G9_TASKS), 'Packaged acceptance must enumerate the fifteen tasks').toBe(true);
  expect(G9_TASKS.map(row => row[0])).toEqual(['add OpenAI key', 'change bot engine', 'stop permission asking', 'connect Gmail', 'quiet notifications at night', 'pair phone', 'house rules', 'morning brief', 'add MCP server', 'bot Chrome access', 'voice', 'backup', 'spending', 'Grok Bot migration', 'folder access']);
  expect(new Set(G9_TASKS.map(row => row[2])).size).toBe(15);
});
