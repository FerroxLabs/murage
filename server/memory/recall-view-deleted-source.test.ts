// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deleted data never returns in recall (MAIN 1.0.20 ruling, intelsmoke). memory-revocation.ts endSource ends a source and a later,
// budgeted expand step of the job ends the records resting on it, so a recall view built before the source was deleted still holds
// an active record of a deleted source. Every view page must leave it out at once, read against the live rows.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { searchMemory } from './search.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it('a record whose source is deleted after the view was built leaves every view page and the recall answer', async () => {
  const views = await import('./recall-view.ts'), index = await import('./recall-view-index.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('conversation', 'direct');
  for (const id of ['kept', 'ended']) {
    const text = `quillfeather fixture ${id}`, hash = createHash('sha256').update(text).digest('hex');
    db.prepare("INSERT INTO memory_sources(id,scope_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,1,?,'text','owner','completed','active')").run(id, scope, hash);
    db.prepare('INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)').run(id, hash, JSON.stringify({ text }));
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'statement',?,'owner-statement','active',1,1)").run(id, scope, text);
    db.prepare('INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)').run(id, id, Buffer.byteLength(text));
  }
  await views.prepareRecallContext('reader', 'direct', roster); views.stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster)!;
  const ids = (refs: Array<{ id: string }>) => refs.map(ref => ref.id).sort();
  const pages = () => ({
    records: ids(index.eligibleViewPage(db, access.view!, '', 10, new index.RecallWorkBudget())),
    recent: ids(index.recentViewPage(db, access.view!, Number.MAX_SAFE_INTEGER, 10, new index.RecallWorkBudget())),
    words: ids(index.lexicalViewPage(db, 'quillfeather', access.view!, 10, 0, new index.RecallWorkBudget()).hits),
  });
  expect(pages()).toEqual({ records: ['ended', 'kept'], recent: ['ended', 'kept'], words: ['ended', 'kept'] });
  // The source ends exactly as endSource ends it; the record is still active and still projected into the view.
  db.prepare("UPDATE memory_sources SET state='deleted' WHERE id='ended'").run();
  expect(db.prepare("SELECT state FROM memory_records WHERE id='ended'").get()!.state).toBe('active');
  expect(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE record_id='ended'").get()!.n).toBe(1);
  expect(pages()).toEqual({ records: ['kept'], recent: ['kept'], words: ['kept'] });
  // A deleted record leaves them too, whatever the view's copy of its state says.
  db.prepare("UPDATE memory_records SET state='deleted',text='' WHERE id='kept'").run();
  expect(pages()).toEqual({ records: [], recent: [], words: [] });
  db.prepare("UPDATE memory_records SET state='active',text='quillfeather fixture kept' WHERE id='kept'").run();
  // The helper's lists name the deleted source's record anyway (a stale index): the answer still holds only the live record.
  const answer = await searchMemory('quillfeather', access, { async search() { return { hits: [], lexicalRanked: [['ended', 1], ['kept', 1]], vectorRanked: [['ended', 1, 0.9], ['kept', 1, 0.5]], vectorRows: 2 }; } },
    { allowance: LineageAllowance.tool(1_000_000_000), caller: 'tool' });
  expect(answer.hits.map(hit => hit.id)).toEqual(['kept']);
}, 120_000);
