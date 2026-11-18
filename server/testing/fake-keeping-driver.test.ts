// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput, SourceContext } from "../contracts.ts";
import { makeKeepingDriver } from "./fake-keeping-driver.ts";

let instance: ProviderInstance;
afterEach(async () => { await instance?.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["stop", "supersede", "interrupt", "complete", "dispose"] as const)("releases a %s turn's source without losing event provenance", async action => {
  vi.useFakeTimers();
  instance = await makeKeepingDriver().create({ instanceId: "keeper", displayName: undefined, enabled: true, config: {}, environment: {} });
  const source = { attachment: {} } as SourceContext;
  const listener = vi.fn();
  instance.adapter.onEvent(listener);
  // Observe the retained reference without adding a fixture inspection API.
  const set = vi.spyOn(Map.prototype, "set");
  const { turnId } = await instance.adapter.sendTurn({ threadId: "thread", text: "hello", sourceContext: source });
  const index = set.mock.calls.findIndex(([, value]) => value === source);
  const retained = set.mock.contexts[index] as Map<string, SourceContext>;
  set.mockRestore();
  expect(retained.get(turnId)).toBe(source);
  const replacementSource = { attachment: {} } as SourceContext;
  if (action === "stop") await instance.adapter.stopAll();
  if (action === "supersede") await instance.adapter.sendTurn({ threadId: "thread", text: "replacement", sourceContext: replacementSource });
  if (action === "interrupt") await instance.adapter.interruptTurn("thread");
  if (action === "complete") await vi.advanceTimersByTimeAsync(60);
  if (action === "dispose") await instance.dispose();
  expect(retained.has(turnId)).toBe(false);
  await vi.advanceTimersByTimeAsync(60);
  const events = listener.mock.calls.filter(([event]) => event.turnId === turnId);
  expect(events.length).toBeGreaterThan(0);
  for (const [, context] of events) expect(context).toBe(source);
  expect(events.filter(([event]) => event.type === "item.completed")).toHaveLength(action === "complete" ? 1 : 0);
  if (action === "supersede") {
    const replacement = listener.mock.calls.filter(([event]) => event.turnId !== turnId);
    expect(replacement.some(([event]) => event.type === "turn.completed")).toBe(true);
    for (const [, context] of replacement) expect(context).toBe(replacementSource);
  }
});


it('releases the kept prompt before confirming its write', async () => {
  vi.useFakeTimers();
  instance = await makeKeepingDriver().create({ instanceId: 'keeper', displayName: undefined, enabled: true, config: {}, environment: {} });
  const order: string[] = [];
  const written = vi.fn(() => { order.push('confirmed'); });
  const release = vi.fn((write: () => unknown, _validate?: unknown, bytes?: number) => {
    expect(bytes).toBe(Buffer.byteLength('hello'));
    order.push('release');
    expect(written).not.toHaveBeenCalled();
    return write();
  });
  await instance.adapter.sendTurn({ threadId: 'thread', text: 'hello', fencedWrite: release, onEngineWrite: written } as SendTurnInput);
  await vi.advanceTimersByTimeAsync(60);
  expect(release).toHaveBeenCalledOnce();
  expect(written).toHaveBeenCalledOnce();
  expect(order).toEqual(['release', 'confirmed']);
});


it('a refused kept writer retains no session and confirms no write', async () => {
  vi.useFakeTimers();
  instance = await makeKeepingDriver().create({ instanceId: 'keeper', displayName: undefined, enabled: true, config: {}, environment: {} });
  const listener = vi.fn(), written = vi.fn();
  instance.adapter.onEvent(listener);
  await instance.adapter.sendTurn({ threadId: 'thread', text: 'hello', onEngineWrite: written,
    fencedWrite: () => { throw new Error('fixture release refused'); } });
  await vi.advanceTimersByTimeAsync(60);
  expect(written).not.toHaveBeenCalled();
  expect(instance.adapter.hasSession?.('thread')).toBe(false);
  expect(listener.mock.calls.filter(([event]) => event.type === 'item.completed')).toEqual([]);
  expect(listener.mock.calls.filter(([event]) => event.type === 'turn.completed')).toEqual([[expect.objectContaining({ ok: false, stopReason: 'submission_refused' }), undefined]]);
});
