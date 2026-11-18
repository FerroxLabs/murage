// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import ts from 'typescript';
import vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { fixture, baseCard, d } from '../decision/fixture.ts';
import * as records from '../decision/records.ts';
import { hash } from '../decision/bounds.ts';
import { actionProjection } from '../../shared/permission-card.ts';
import { fakeDecisionModule } from './runtime-fixture.ts';

function runtime(f: ReturnType<typeof fixture>) {
  const exports: Record<string, any> = {};
  const modules: Record<string, unknown> = {
    'node:fs': fs, 'node:path': path, '../database.ts': { database: () => f.db },
    './api.ts': d, './records.ts': records, './bounds.ts': { hash }, '../../shared/permission-card.ts': { actionProjection },
  };
  vm.runInNewContext(ts.transpileModule(fakeDecisionModule, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, {
    exports, require: (id: string) => { if (!(id in modules)) throw Error(`Unexpected fixture import: ${id}`); return modules[id]; },
    process: { env: { MURAGE_DATA_DIR: DATA_DIR } }, setTimeout,
  });
  exports.installDecisionHost({ store: f.store });
  exports.installProvenanceReader({ turnGenerationFor: () => 'g',
    provenance: () => ({ generation: 'g', principal: 'owner', roomOwnerOnly: true, initiator: { k: 'owner-typed' } }),
    live: () => ({ botId: 'b', owner: true, level: 'ask' }),
  });
  return exports;
}

it('runtime continuation keys are canonical, namespace exact, paged after deletion, and synchronously deleted', async () => {
  const f = fixture(), api = runtime(f);
  try {
    const keys = ['A', 'B', 'C'].map(id => ({ kind: 'background-job', id: `shared-peer:${id}`, botId: 'b', threadId: 't' }));
    for (const key of [...keys, { ...keys[0], id: 'queue:other' }]) await api.saveContinuation(key, { generation: 'g' });
    expect(api.readContinuation({ threadId: 't', botId: 'b', id: 'shared-peer:A', kind: 'background-job' })).toBeDefined();
    const first = api.listContinuations({ kind: 'background-job', namespace: 'shared-peer', limit: 2 });
    expect(first.keys).toEqual(keys.slice(0, 2)); expect(first.next).toBeTypeOf('string');
    const deleting = api.deleteContinuation(keys[1]);
    expect(api.readContinuation(keys[1])).toBeUndefined(); await deleting;
    expect(api.listContinuations({ kind: 'background-job', namespace: 'shared-peer', after: first.next, limit: 2 })).toEqual({ keys: [keys[2]] });
    expect(api.readContinuation({ ...keys[0], id: 'queue:other' })).toBeDefined();
  } finally { f.dispose(); }
});

it('runtime presentations obey the real record-before-card and action hash fences', async () => {
  const f = fixture(), api = runtime(f);
  try {
    let ingress!: (event: unknown) => void;
    api.installRequestIngress({ subscribe: (listener: typeof ingress) => { ingress = listener; return () => {}; } });
    ingress(f.event('runtime-card'));
    const result = api.decide(api.openRequest({ kind: 'engine', threadId: 't', requestId: 'runtime-card' }), baseCard);
    await api.presentApproval(result.ref, { title: 'Fixture', subtitle: '' });
    const record = api.readApproval(result.ref.approvalId);
    const message = f.store.messageById('t', record.chatMessageId)!;
    const durable = records.readRecord(f.db, result.ref.approvalId)!;
    expect(durable.action_hash).toBe(hash(actionProjection(message.card!)));
    expect(record.actionHash).toBe(durable.action_hash);
    expect(record.action.requestId).toBe('runtime-card');
    expect(durable.presented_action).toBeTruthy();
    await api.settle(result.ref, 'expired');
    expect(records.readRecord(f.db, result.ref.approvalId)?.state).toBe('expired');
    expect(f.store.messageById('t', record.chatMessageId)?.card?.answered).toBe('expired');
  } finally { f.dispose(); }
});
