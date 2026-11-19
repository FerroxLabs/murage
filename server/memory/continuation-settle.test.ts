// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: warm-keep (continuation preparation and its dispatch consumer).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database, closeDatabase } from '../database.ts';
import { continuationMemoryRevoked, continuationPendingProbe, resetSessionHolds } from './disclosures.ts';
import { verdictStore } from './verdict-store.ts';
import { retainedSessionInvalid, CONTENT_SESSION_READER, sessionCheckRefusal, refusalCauseNote, memoryRefusalCause } from './dispatch.ts';
import { sessionLookup } from './deny-read.ts';
import { LineageAllowance, recordSessionRoots } from './replay-lineage.ts';
import { commitRevoke } from './revoke-commit.ts';
import { resetRevokeWriteBudget, revokePaceTestHooks } from './revoke-budget.ts';
import { setScopeFlowEdgesRecorded } from './revoke-marker.ts';
import { freshDataDir, accessFor } from './testing/recall-fixture.ts';
import { WritetimeFixture, stampFreshSession } from './testing/writetime-fixture.ts';
import { sessionKeyOf } from './session-incarnation.ts';
import { captureSource } from './capture.ts';
import { forgetMemory } from './forget.ts';
import { ownerMemoryTicket } from './authority.ts';
import { initializeFreshSessionProof } from './session-proof.ts';
import { noteSessionFrame } from './session-proof-schema.ts';
import { setIntegrityFlags } from './integrity-flags.ts';

beforeEach(() => { freshDataDir('active'); resetSessionHolds(); resetRevokeWriteBudget(); setScopeFlowEdgesRecorded(true); revokePaceTestHooks.osUnknown = true; });
afterEach(() => { vi.restoreAllMocks(); revokePaceTestHooks.osUnknown = false; setScopeFlowEdgesRecorded(false); closeDatabase(); });
const key = sessionKeyOf('thread', 'engine', 'fixture-session');
function world() {
  const db = database(), f = new WritetimeFixture(db);
  f.cert(true).ready('thread', true).owner('thread', 'shown-owner-line', 20).ready('other', true).owner('other', 'other-owner-line', 25);
  db.exec('UPDATE memory_lsn SET next=100 WHERE id=1');
  stampFreshSession(db, key.threadId, key.driverInstance, key.nativeSession);
  db.prepare('UPDATE memory_session_lineage SET first_lsn=10,last_lsn=90 WHERE thread_id=?').run('thread');
  recordSessionRoots(key.threadId, key.driverInstance, key.nativeSession, { roots: new Set(), over: false });
  // MAIN RULING 1115-RECALL-DESIGN-GROK: this fixture is a new, proven session, rather than an unknown upgrade session.
  noteSessionFrame(db,key,false);
  // MAIN RULING 1115-RECALL-GROK-Q1Q2: bind the first frame inside the live P6 initialization.
  initializeFreshSessionProof(key,accessFor().access,()=>{
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) SELECT 'fixture-receipt',?,?,?,'[]','[]',policy_revision,deletion_epoch,0,'delivered',1 FROM memory_meta WHERE id=1").run(key.threadId, key.driverInstance, key.nativeSession);
  noteSessionFrame(db,key,true);});
  // MAIN RULING 1115-RECALL-GROK-Q1Q2: the fixture completes this receipt's references before the first check.
  db.prepare('UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?').run(key.threadId,key.driverInstance,key.nativeSession);
  accessFor();
  const check = (kind: 'active' | 'retained', allowance = LineageAllowance.turn()) => {
    const why: { reason?: string } = {};
    const invalid = kind === 'active' ? continuationMemoryRevoked(allowance, key.threadId, key.driverInstance, key.nativeSession, accessFor().access, why)
      : retainedSessionInvalid(allowance, key.threadId, key.driverInstance, key.nativeSession, why, CONTENT_SESSION_READER);
    return { invalid, reason: why.reason };
  };
  return { db, f, check };
}
for (const kind of ['active', 'retained'] as const) {
  it(`${kind}: finishes an unrelated revoke's pending proof before dropping the warm session`, () => {
    const w = world();
    commitRevoke(w.db, { kind: 'line', threadId: 'other', messageIds: ['other-owner-line'], cause: 'edit' }, { inline: false });
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toMatchObject({ state: 'checking', reason: 'pending' });
    for (let n = 0; n < 10; n++) expect(w.check(kind)).toEqual({ invalid: false, reason: undefined });
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toEqual({ state: 'shown' });
    expect(w.db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id='fixture-receipt'").get()?.state).toBe('delivered');
  });
  it(`${kind}: targeted preparation leaves an unrelated blocked backlog untouched`, () => {
    const w = world();
    w.f.job(1, 1).pending('elsewhere', 1, 1);
    w.db.exec("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,1,'{unreadable')");
    const before = w.db.prepare('SELECT * FROM memory_revoke_jobs WHERE revoke_id=1').get();
    commitRevoke(w.db, { kind: 'line', threadId: 'other', messageIds: ['other-owner-line'], cause: 'edit' }, { inline: false });
    expect(w.check(kind)).toEqual({ invalid: false, reason: undefined });
    expect(w.db.prepare('SELECT * FROM memory_revoke_jobs WHERE revoke_id=1').get()).toEqual(before);
    expect(w.db.prepare('SELECT node FROM memory_revoke_frontier WHERE revoke_id=1').get()?.node).toBe('{unreadable');
  });
  it(`${kind}: too many pending candidates stop before any marking`, () => {
    const w = world();
    for (let id = 1; id <= 33; id++) w.f.pending('thread', 1, id);
    const before = w.db.prepare('SELECT total_changes() AS n').get()!.n;
    expect(w.check(kind)).toEqual({ invalid: true, reason: 'checking:pending' });
    expect(w.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
  });
  it(`${kind}: a revoke of a line this session held still resets`, () => {
    const w = world();
    commitRevoke(w.db, { kind: 'line', threadId: 'thread', messageIds: ['shown-owner-line'], cause: 'edit' }, { inline: false });
    expect(w.check(kind).invalid).toBe(true);
  });
  it(`${kind}: an unfinished or unreadable proof remains closed with its fixed checking sub-cause`, () => {
    const w = world();
    w.f.pending('thread', 1); // Orphaned hold: there is no safe work to finish.
    expect(w.check(kind)).toEqual({ invalid: true, reason: 'checking:pending' });
  });
  it(`${kind}: missing lineage and thread readiness keep their distinct reasons`, () => {
    const w = world();
    w.f.owner('thread', 'fixture-unordered', 30);
    w.db.exec("UPDATE messages SET at=-1 WHERE thread_id='thread' AND id='fixture-unordered'");
    w.f.ready('thread', false);
    expect(w.check(kind)).toEqual({ invalid: true, reason: 'checking:thread-not-ready' });
    w.db.exec('DELETE FROM memory_session_lineage');
    expect(w.check(kind).invalid).toBe(true);
  });
  it(`${kind}: completes the readiness proof for a small unchanged imported thread`, () => {
    const w = world(); w.f.ready('thread', false);
    expect(w.check(kind)).toEqual({ invalid: false, reason: undefined });
    expect(w.db.prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='thread'").get()?.ready).toBe(1);
  });
  it(`${kind}: does not certify a thread beyond the bounded readiness proof`, () => {
    const w = world();
    for (let n = 0; n < 257; n++) w.f.owner('thread', `fixture-import-${n}`, 110 + n);
    w.f.ready('thread', false);
    expect(w.check(kind)).toEqual({ invalid: true, reason: 'checking:thread-not-ready' });
    expect(w.db.prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='thread'").get()?.ready).toBe(0);
  });
  it(`${kind}: a missing global certificate cannot be replaced by this thread's local proof`, () => {
    const w = world(); w.f.cert(false);
    expect(w.check(kind)).toEqual({ invalid: true, reason: 'checking:thread-not-ready' });
    expect(w.db.prepare('SELECT ready FROM memory_lineage_cert WHERE id=1').get()?.ready).toBe(0);
  });
  it(`${kind}: preparation cannot do work after its allowance is spent`, () => {
    const w = world();
    commitRevoke(w.db, { kind: 'line', threadId: 'other', messageIds: ['other-owner-line'], cause: 'edit' }, { inline: false });
    expect(w.check(kind, LineageAllowance.turn(0)).invalid).toBe(true);
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toMatchObject({ state: 'checking', reason: 'pending' });
  });
  for (const [reason, change] of [
    ['thread-deny', (w: ReturnType<typeof world>) => w.f.deny('thread', key.threadId)],
    ['deny-session', (w: ReturnType<typeof world>) => w.f.denySession(key.threadId, key.driverInstance, key.nativeSession)],
    ['watermark', (w: ReturnType<typeof world>) => w.db.exec('UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1')],
    ['door-epoch', (w: ReturnType<typeof world>) => w.db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='reader_door_epoch'")],
  ] as const) {
    it(`${kind}: real ${reason} cannot be settled into a resumed session`, () => {
      const w = world(); change(w);
      // MAIN RULING 2026-11-14 SEAN 1114-ENGINE-STAYS-WARM: real denies remain fail closed.
      // The active reader itself is denied before continuation inspection; the retained/off route has no access to mint.
      if (kind === 'active' && reason === 'thread-deny') {
        expect(() => w.check(kind)).toThrow('MEMORY_CONTEXT_REVOKED');
        expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toEqual({ state: 'withheld', reason });
      } else expect(w.check(kind)).toEqual({ invalid: true, reason: `writetime-${reason}` });
    });
  }
  for (const change of ['forget', 'edit'] as const) {
    it(`${kind}: real source ${change} resets the session that was shown it`, () => {
      const w = world();
      captureSource(w.db, { id: 'fixture-source', threadId: key.threadId, messageId: 'shown-owner-line', kind: 'text', speaker: 'owner', outcome: 'recorded', text: 'The fixture gate is green.' });
      w.db.prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='fixture-receipt'").run(JSON.stringify([{ id: 'fixture-source', revision: 1 }]));
      expect(w.check(kind).invalid).toBe(false);
      if (change === 'forget') forgetMemory(ownerMemoryTicket(), { kind: 'source', id: 'fixture-source' });
      else {
        w.db.exec("UPDATE memory_sources SET revision=revision+1,content_hash='fixture-changed' WHERE id='fixture-source'");
        w.f.ready('thread', false); // readiness completion must still check this session's changed receipt
      }
      expect(w.check(kind).invalid).toBe(true);
    });
  }
  it(`${kind}: a background integrity check alone does not discard this session's proven receipts`, () => {
    const w = world();
    setIntegrityFlags(w.db, { pending: true });
    try { expect(w.check(kind)).toEqual({ invalid: false, reason: undefined }); }
    finally { setIntegrityFlags(w.db, { pending: false }); }
  });
  it(`${kind}: final submission stays read-only when a new revoke is pending`, () => {
    const w = world();
    commitRevoke(w.db, { kind: 'line', threadId: 'other', messageIds: ['other-owner-line'], cause: 'edit' }, { inline: false });
    const before = w.db.prepare('SELECT total_changes() AS n').get()!.n;
    expect(w.check(kind, LineageAllowance.tool()).invalid).toBe(true);
    expect(w.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
  });
}

// T3 (DESIGN-T3.md): the owner turn's check on exactly checking:pending keeps the session and never consumes (or grants) its hold; the
// probe is read-only; a settled revoke still resets with keepPending.
it('T3 keepPending: a pending window keeps the session without consuming or granting the hold; without it the hold is consumed', () => {
  const w = world();
  w.f.pending('thread', 1);
  const access = accessFor().access;
  const lose = vi.spyOn(verdictStore, 'loseHold'), set = vi.spyOn(verdictStore, 'setHold'), touch = vi.spyOn(verdictStore, 'touchHold');
  expect(continuationPendingProbe(key.threadId, key.driverInstance, key.nativeSession, access)).toBe(true);
  expect(lose).not.toHaveBeenCalled();
  const kept: { reason?: string; kept?: boolean } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, access, kept, true)).toBe(false);
  expect(kept).toEqual({ reason: 'checking:pending', kept: true });
  expect(lose).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(touch).not.toHaveBeenCalled();
  // the same verdict without the owner's keepPending: today's reset, the hold consumed
  const reset: { reason?: string; kept?: boolean } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, access, reset)).toBe(true);
  expect(reset).toEqual({ reason: 'checking:pending' });
  expect(lose).toHaveBeenCalledTimes(1); expect(lose.mock.calls[0]![1]).toBe('consumed');
});
it('T3 keepPending never keeps a settled revoke of a line the session held', () => {
  const w = world();
  commitRevoke(w.db, { kind: 'line', threadId: 'thread', messageIds: ['shown-owner-line'], cause: 'edit' }, { inline: false });
  const access = accessFor().access, why: { reason?: string; kept?: boolean } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, access, why, true)).toBe(true);
  expect(why.kept).toBeUndefined();
  expect(why.reason).not.toBe('checking:pending');
});
it('late submission diagnostics keep a fixed checking sub-cause without recalled content', () => {
  const error = sessionCheckRefusal({ reason: 'checking:pending' });
  expect(error.message).toBe('MEMORY_CONTEXT_REVOKED');
  expect(memoryRefusalCause(error)).toBe('checking');
  expect(refusalCauseNote(error)).toBe('; continuation=checking:pending');
  expect(refusalCauseNote(sessionCheckRefusal({ reason: 'checking:unrecognized-fixture-code' }))).toBe('');
});
