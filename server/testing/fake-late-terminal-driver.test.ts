// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: c4-misc-c3 for fake handback semantics and regression consumers.
import { expect, it, vi } from 'vitest';
import { makeLateTerminalDriver } from './fake-late-terminal-driver.ts';
import type { RuntimeEvent, SendTurnInput, SourceContext } from '../contracts.ts';

const create = (environment: Record<string, string> = {}) => makeLateTerminalDriver().create({
  instanceId: 'late-fixture', displayName: 'Fixture', enabled: true, config: {}, environment,
});

it('a pre-handback write refusal throws without publishing a native turn', async () => {
  const instance = await create();
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  const refusal = new Error('fixture write refused');
  try {
    await expect(instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', beforeSubmit: () => { throw refusal; } } as SendTurnInput)).rejects.toBe(refusal);
    expect(events).toEqual([]);
  } finally { await instance.dispose(); }
});

it.each([false, true])('the two-fence fake always executes both fences; observer=%s', async observer => {
  const instance = await create({ FAKE_LATE_TWO_FENCES: '1' });
  const fence = vi.fn(() => 17), notWritten = vi.fn();
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  vi.useFakeTimers();
  try {
    const result = await instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', beforeSubmit: fence,
      ...(observer ? { attemptNotWritten: notWritten } : {}) } as SendTurnInput);
    expect(fence).toHaveBeenCalledTimes(2);
    if (observer) expect(notWritten).toHaveBeenCalledExactlyOnceWith(17);
    await vi.advanceTimersByTimeAsync(25);
    expect(events.filter(event => event.type === 'turn.completed').map(event => event.turnId)).toEqual([result.turnId]);
  } finally { vi.useRealTimers(); await instance.dispose(); }
});

it('an ungated late write waits until sendTurn has handed back its id', async () => {
  const instance = await create({ FAKE_LATE_HANDBACK: '1' });
  const fence = vi.fn();
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  vi.useFakeTimers();
  try {
    const result = await instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', beforeSubmit: fence } as SendTurnInput);
    expect(fence).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'item.completed')).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(fence).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'turn.completed').map(event => event.turnId)).toEqual([result.turnId]);
  } finally { vi.useRealTimers(); await instance.dispose(); }
});


it.each([false, true])('the checked-write preset retains the unknown-action negative; unknown=%s', async unknown => {
  const driver = makeLateTerminalDriver({ fencedDefaults: true });
  const instance = await driver.create({ instanceId: 'checked-fixture', displayName: 'Fixture', enabled: true, config: {},
    environment: unknown ? { FAKE_LATE_UNKNOWN_ACTION: '1' } : {} });
  try { expect(instance.adapter.capabilities.fencedWrites).toBe(unknown ? undefined : true); }
  finally { await instance.dispose(); }
});


it.each<Record<string, string>>([{}, { FAKE_LATE_HANDBACK: '1' }, { FAKE_LATE_TWO_FENCES: '1' }])('writes through the admitted writer and confirms only after release: %j', async environment => {
  const instance = await create(environment);
  const order: string[] = [];
  const written = vi.fn(() => { order.push('confirmed'); });
  const release = vi.fn((write: () => unknown, _validate?: unknown, bytes?: number) => {
    expect(bytes).toBe(Buffer.byteLength('Fixture'));
    order.push('release');
    expect(written).not.toHaveBeenCalled();
    return write();
  });
  vi.useFakeTimers();
  try {
    await instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', beforeSubmit: () => 17,
      fencedWrite: release, onEngineWrite: written } as SendTurnInput);
    await vi.advanceTimersByTimeAsync(25);
    expect(release).toHaveBeenCalledOnce();
    expect(written).toHaveBeenCalledOnce();
    expect(order).toEqual(['release', 'confirmed']);
  } finally { vi.useRealTimers(); await instance.dispose(); }
});

it('a refused final writer emits no reply or write confirmation', async () => {
  const instance = await create({ FAKE_LATE_HANDBACK: '1' });
  const events: RuntimeEvent[] = [], written = vi.fn();
  instance.adapter.onEvent(event => events.push(event));
  vi.useFakeTimers();
  try {
    await instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', beforeSubmit: () => 17,
      fencedWrite: () => { throw new Error('fixture release refused'); }, onEngineWrite: written } as SendTurnInput);
    await vi.advanceTimersByTimeAsync(25);
    expect(written).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === 'item.completed')).toEqual([]);
    expect(events.filter(event => event.type === 'turn.completed')).toEqual([expect.objectContaining({ ok: false, stopReason: 'submission_refused' })]);
  } finally { vi.useRealTimers(); await instance.dispose(); }
});


it.each<Record<string, string>>([{}, { FAKE_LATE_TWO_FENCES: '1' }])('a refused pre-handback writer releases its source: %j', async environment => {
  const instance = await create(environment);
  const source = { attachment: {} } as SourceContext;
  const refusal = new Error('fixture release refused');
  const set = vi.spyOn(Map.prototype, 'set');
  try {
    await expect(instance.adapter.sendTurn({ threadId: 'fixture-thread', text: 'Fixture', sourceContext: source,
      fencedWrite: () => { throw refusal; } } as SendTurnInput)).rejects.toBe(refusal);
    const index = set.mock.calls.findIndex(([, value]) => value === source);
    const retained = set.mock.contexts[index] as Map<string, SourceContext>;
    expect(retained.size).toBe(0);
  } finally { set.mockRestore(); await instance.dispose(); }
});
