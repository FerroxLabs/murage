// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-e. Consumer owner: MAIN (R7 exception and identity cleanup).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { expect, it } from 'vitest';
import { InternalCapabilities } from './internal-capabilities.ts';
import { turnOutcome } from './turn-outcome.ts';
import { createLedgerLease } from './ledger-refusal.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const subscription = ast.statements.find(s => ts.isExpressionStatement(s) && s.getText(ast).startsWith('bus.subscribeExecution(')
  && s.getText(ast).includes('observeOwnerLimitProvider(event)')) as ts.ExpressionStatement;
const callback = (subscription.expression as ts.CallExpression).arguments[0]!.getText(ast);
const dispatch = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'terminalDispatchFor')?.getText(ast) ?? '';

function fixture(failure?: 'project' | 'terminal', change?: string) {
  const registry = new InternalCapabilities();
  const generation = registry.begin('fixture-bot', 'fixture-thread');
  registry.bindProviderTurn('fixture-thread', generation, 'fixture-turn');
  const current = change?.startsWith('replacement') ? registry.begin('fixture-bot', 'fixture-thread') : generation;
  if (change?.includes('reused-id')) registry.bindProviderTurn('fixture-thread', current, 'fixture-turn');
  const token = registry.mint({ botId: 'fixture-bot', threadId: 'fixture-thread', generation: current, kind: 'memory', depth: 0, skillAuthoring: false });
  if (change === 'stopped') registry.revokeGeneration('fixture-thread', current);
  const owners = new Map([['fixture-thread', { generation: current }]]);
  const source = { admission: {}, attachment: {} };
  const noop = () => {};
  const lease = createLedgerLease({ botId: 'fixture-bot', threadId: 'fixture-thread', dispatchGeneration: generation, lineageTurnIds: ['fixture-lineage'], adapterLeaseId: generation },
    { seal: noop, interrupt: async () => true, settle: noop, present: noop, quarantine: noop });
  if (change !== 'early') lease.attach('fixture-turn');
  const receipts = new Map();
  let prepared = false;
  const observer = runInNewContext(`${stripTypeScriptTypes(dispatch)}\n(${stripTypeScriptTypes(callback)})`, {
    observeOwnerLimitProvider: noop,
    botOutsideWrites: { ledger: { by_ptid: new Map(), gen_of: () => undefined } },
    isLedgerEventRefused: () => false, shouldIgnoreProviderEvent: () => false,
    bus: { sourceForExecution: () => change === 'source' ? { admission: {}, attachment: source.attachment } : source },
    ledgerLeasesByAdmission: new WeakMap([[source.admission, lease]]),
    ledgerCompletionSources: new WeakMap([[lease, source]]), ledgerProviderInstances: new WeakMap([[lease, 'fixture-instance']]),
    admittedLedgerLeases: new Map([[generation, lease]]), memoryDispatches: receipts, pendingRoomStops: new Map(),
    lateProjectWrites: { complete: noop }, endHeldWriteWaits: noop,
    projectTurnLeases: { complete: () => { if (failure === 'project') throw Error('fixture write failed'); } },
    prepareTerminalEvent: (event: Parameters<typeof turnOutcome>[0]) => {
      prepared = true;
      if (turnOutcome(event) === 'completed') expect(registry.activeGeneration('fixture-thread')).toBe(generation);
      if (failure === 'terminal') throw Error('fixture write failed');
      return { outcome: turnOutcome(event) };
    },
    terminalPreparations: new WeakMap(), internalCapabilities: registry, internalTurnOwners: owners,
    queueMicrotask, console: { debug: noop }, traceEngineEvent: noop, notePromptSent: noop,
    watchdog: { settleCompleted: noop }, releaseBrowserCapabilityForThread: noop,
  }) as (event: unknown) => void;
  const event = { type: 'turn.completed', threadId: change === 'thread' ? 'other-thread' : 'fixture-thread',
    turnId: change === 'turn' ? 'other-turn' : 'fixture-turn', providerInstanceId: change === 'instance' ? 'other-instance' : 'fixture-instance', ok: !change?.endsWith('failed'), ...(change?.endsWith('stopped') ? { stopReason: 'cancelled' } : {}) };
  return { registry, generation: current, token, owners, observer, event, receipts, lease, prepared: () => prepared };
}

it('R-A synchronous completion names the admitted turn without handing it back', () => {
  const f = fixture(undefined, 'early');
  f.observer(f.event);
  expect(f.lease.providerTurnId).toBe('fixture-turn');
  expect(f.lease.handedBack).toBe(false);
  f.lease.attach('fixture-turn');
  expect(f.lease.handedBack).toBe(true);
});

it('a stopped turn cannot bind or complete an unbound successor receipt', () => {
  const f = fixture(undefined, 'replacement');
  let completed = 0;
  const receipt = { instanceId: 'fixture-instance', completed: () => completed++ };
  f.receipts.set('fixture-thread', receipt);
  f.observer(f.event);
  expect(completed).toBe(0);
  expect(receipt).not.toHaveProperty('turnId');
});

it.each(['project', 'terminal'] as const)('%s persistence failure still revokes the exact generation and clears its owner', failure => {
  const f = fixture(failure);
  expect(() => f.observer(f.event)).toThrow('fixture write failed');
  expect(f.prepared()).toBe(failure === 'terminal');
  expect(f.registry.resolve(`Bearer ${f.token}`)).toBeNull();
  expect(f.registry.activeGeneration('fixture-thread')).toBeUndefined();
  expect(f.owners.has('fixture-thread')).toBe(false);
});

it.each(['instance', 'thread', 'turn', 'source', 'replacement', 'replacement-reused-id', 'replacement-reused-id-stopped', 'replacement-reused-id-failed'])('%s mismatch cannot prepare a reply or revoke a replacement owner', change => {
  const f = fixture(undefined, change);
  expect(() => f.observer(f.event)).not.toThrow();
  expect(f.prepared()).toBe(false);
  expect(f.registry.resolve(`Bearer ${f.token}`)).not.toBeNull();
  expect(f.registry.activeGeneration('fixture-thread')).toBe(f.generation);
  expect(f.owners.get('fixture-thread')?.generation).toBe(f.generation);
});

it('an already stopped generation still reconciles its cancelled transcript without restoring authority', () => {
  const f = fixture(undefined, 'stopped');
  expect(() => f.observer(f.event)).not.toThrow();
  expect(f.prepared()).toBe(true);
  expect(f.registry.resolve(`Bearer ${f.token}`)).toBeNull();
  expect(f.registry.activeGeneration('fixture-thread')).toBeUndefined();
  expect(f.owners.has('fixture-thread')).toBe(false);
});
