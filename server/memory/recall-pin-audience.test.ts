// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2f (audience verdict); consumer owner: recall-s1s2f (PIN-6 dispatch refusal).
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { expect, it } from 'vitest';
import { database } from '../database.ts';
import { buildMemoryBundle } from './bundle.ts';
import { readerWithheldMessage, lineageReaderOf } from './disclosures.ts';
import { capturedMessageWithheld, recordRestsOnWithheldMessage } from './replay-lineage.ts';
import { denyLookup } from './deny-read.ts';
import { FOOTPRINT_STAR } from './lineage-types.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { MemoryPinProjectionPending } from './recall-recovery.ts';
import { access, hits, world } from './testing/xthread-world.ts';

useOutsideStoreFixture();

for (const ownThread of [false, true]) for (const fault of ['wide', 'missing', 'shown', 'denied'] as const) {
  it(`PIN-6 real ${ownThread ? 'own' : 'cross'}-thread audience ${fault}: unfinished pins refuse before dispatch`, async () => {
    const { person, x } = world({ flipFirst: fault === 'denied' });
    const db = database();
    db.prepare("UPDATE memory_records SET owner_pinned=1,kind='constraint' WHERE id=? AND version=?").run(x.id, x.version);
    if (fault === 'wide') db.prepare("UPDATE memory_line_lineage SET footprint=? WHERE message_id='g1' AND thread_no=(SELECT no FROM memory_thread_no WHERE thread_id='t1')").run(FOOTPRINT_STAR);
    if (fault === 'missing') db.prepare("UPDATE memory_line_lineage SET footprint=? WHERE message_id='g1' AND thread_no=(SELECT no FROM memory_thread_no WHERE thread_id='t1')").run(999999);
    const reader = access('finch', ownThread ? 't1' : 't2', { human: person, notOwnerAudience: true });
    const allowance = () => LineageAllowance.tool(1000000000);
    // Content remains shown; this failure must come from the real audience lookup.
    expect(capturedMessageWithheld(allowance(), 't1', 'g1')).toBe(false);
    const verdict = denyLookup(db, { threadId: 't1', lines: [{ messageId: 'g1', author: 'generated' }] }, lineageReaderOf(reader)).get('g1');
    const unfinished = fault === 'wide' || fault === 'missing';
    expect(verdict?.state).toBe(unfinished ? 'checking' : fault === 'shown' ? 'shown' : 'withheld');
    const rule = readerWithheldMessage(reader)!;
    const detail: { checking?: boolean } = {};
    expect(rule('t1', 'g1', allowance(), detail)).toBe(fault !== 'shown');
    expect(detail.checking === true).toBe(unfinished);
    const build = () => buildMemoryBundle('', reader, hits([x]), { allowance: allowance(), withheldMessage: rule });
    if (unfinished) {
      expect(() => recordRestsOnWithheldMessage(allowance(), x.id, x.version, rule, true)).toThrow(MemoryPinProjectionPending);
      await expect(build()).rejects.toBeInstanceOf(MemoryPinProjectionPending);
    } else {
      const bundle = await build();
      expect(bundle.withheldPins?.length ?? 0).toBe(fault === 'denied' ? 1 : 0);
      expect(bundle.pinned.length).toBe(fault === 'shown' ? 1 : 0);
    }
  });
}
