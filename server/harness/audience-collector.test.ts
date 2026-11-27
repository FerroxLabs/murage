import { bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { describe, expect, it } from 'vitest';
import { resolveDisplayAction, resolveDisplaySubmission, type DisplayActionCard } from './audience-collector.ts';
import type { DisplayAction } from '../../shared/audience-wire.ts';

const questions = [
  { id: 'provider-one', question: 'Choose', options: [{ label: '**password**: original-a' }], multiSelect: false, allowOther: false },
  { id: 'provider-two', question: 'Many', options: [{ label: 'original-b' }, { label: 'original-c' }], multiSelect: true, allowOther: false },
  { id: 'provider-three', question: 'Other', options: [], multiSelect: false, allowOther: true },
  { id: 'provider-secret', question: 'Secret', options: [], multiSelect: false, allowOther: true, secret: true },
];
const card: DisplayActionCard = { id: 'host-card-1', requestType: 'question', questions };
const action: DisplayAction = { requestHandle: 'q.host-card-1', action: 'answer', answers: [
  { questionHandle: 'q.0', optionHandles: ['o.0.0'] },
  { questionHandle: 'q.1', optionHandles: ['o.1.1', 'o.1.0'] },
  { questionHandle: 'q.2', optionHandles: [], other: 'Other only' },
  { questionHandle: 'q.3', optionHandles: [], other: '  secret\n bytes  ' },
] };

describe('atomic stored-card handle resolution', () => {
  it('execution.answers-multi-question.unchanged', () => {
    expect(resolveDisplayAction(card, action)).toEqual({ ok: true, legacyBody: { behavior: 'answer', answers: [
      { id: 'provider-one', selected: ['**password**: original-a'] },
      { id: 'provider-two', selected: ['original-b', 'original-c'] },
      { id: 'provider-three', selected: [], other: 'Other only' },
      { id: 'provider-secret', selected: [], other: '  secret\n bytes  ' },
    ] } });
  });
  it('execution.answers-multiselect-order', () => {
    const result = resolveDisplayAction(card, action);
    expect(result.ok && result.legacyBody.answers?.[1].selected).toEqual(['original-b', 'original-c']);
  });
  it('execution.answers-other-only', () => {
    const result = resolveDisplayAction(card, action);
    expect(result.ok && result.legacyBody.answers?.[2]).toEqual({ id: 'provider-three', selected: [], other: 'Other only' });
  });
  it('execution.answers-mixed-request-handles', () => {
    expect(resolveDisplayAction(card, { ...action, requestHandle: 'q.another-card' })).toMatchObject({ ok: false, status: 400 });
    expect(resolveDisplayAction(card, { ...action, answers: [{ questionHandle: 'q.another-card.0', optionHandles: [] }] })).toMatchObject({ ok: false, status: 400 });
  });
  it('execution.answers-duplicate-and-range', () => {
    for (const answers of [
      [action.answers[0], action.answers[0]],
      [{ questionHandle: 'q.0', optionHandles: ['o.0.99'] }],
      [{ questionHandle: 'q.0', optionHandles: ['o.0.0', 'o.0.0'] }],
      [{ questionHandle: 'q.0', optionHandles: ['o.1.0'] }],
    ]) expect(resolveDisplayAction(card, { ...action, answers })).toMatchObject({ ok: false, status: 400 });
  });
  it('execution.answers-strict-schema', () => {
    for (const bad of [null, [], { ...action, raw: true }, { ...action, action: 'allow' }, { ...action, sentAsMessage: false }, { ...action, answers: [{ ...action.answers[0], raw: true }] }]) {
      expect(resolveDisplayAction(card, bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
  it.each(['async-question-answer', 'expired-late-answer', 'post-terminal-question'])('execution.handle-%s', kind => {
    // The pure resolver does not require an adapter request for stored questions.
    const submitted = kind === 'expired-late-answer' ? { ...action, sentAsMessage: true } : action;
    expect(resolveDisplayAction({ ...card, live: false }, submitted)).toMatchObject({ ok: true, legacyBody: { behavior: 'answer' } });
  });
  it('execution.handle-permission-timeout', () => {
    expect(resolveDisplayAction({ id: 'host-p', requestType: 'permission', live: false }, { requestHandle: 'p.host-p', action: 'allow' })).toEqual({ ok: false, status: 409, error: 'request_unavailable' });
  });
  it('execution.answers-legacy-body-equivalence', () => {
    expect(resolveDisplayAction(card, { requestHandle: 'q.host-card-1', action: 'skip' })).toEqual({ ok: true, legacyBody: { behavior: 'deny' } });
    for (const action of ['allow', 'deny']) expect(resolveDisplayAction({ id: 'host-p', requestType: 'permission', live: true }, { requestHandle: 'p.host-p', action })).toEqual({ ok: true, legacyBody: { behavior: action } });
  });
});

import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import type { ProviderDriver, ProviderInstance, RuntimeEvent, SourceContext } from '../contracts.ts';
import { RuntimeAudienceCollector } from './audience-collector.ts';
import { decorateMemoryInstance } from './memory-adapter.ts';

const driverCases = [
  ['claude', '../drivers/claude.ts', 'ClaudeDriver', 'fake-claude-cli.ts', { permissionMode: 'bypassPermissions' }],
  ['codex', '../drivers/codex.ts', 'CodexDriver', 'fake-codex-app-server.ts', { fullAuto: true }],
  ['pi', '../drivers/pi.ts', 'PiDriver', 'fake-pi-cli.ts', { fullAuto: true }],
  ['acp', '../drivers/grokagent.ts', 'GrokAgentDriver', 'fake-acp-cli.ts', { fullAuto: true }],
  ['antigravity', '../drivers/antigravity.ts', 'AntigravityDriver', 'fake-agy-cli.ts', { fullAuto: true }],
] as const;
async function assertSource(instance: ProviderInstance, integrations?: import("../contracts.ts").SendTurnInput["integrations"]) {
  if (instance.driverKind === "claudeAgent") bindFixtureAdapter(instance.adapter);
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach(instance.instanceId);
  const events: { event: RuntimeEvent; source?: SourceContext }[] = [];
  instance.adapter.onEvent((event, source) => events.push({ event, source }));
  for (let run = 0; run < 2; run++) {
    const source = collector.source(collector.admitNewTurn({ attachment, instanceId: instance.instanceId, threadId: 'admission-thread' }));
    const before = events.length;
    const sent = await instance.adapter.sendTurn({ threadId: 'admission-thread', text: 'hello', warmIdentity: { botId: 'fixture', audience: 'owner', decidedOwner: true }, cwd: fixtureBotFolder(), sourceContext: source, integrations });
    await vi.waitFor(() => expect(events.slice(before).some(row => row.event.type === 'turn.completed' && row.event.turnId === sent.turnId)).toBe(true), { timeout: 15_000 });
    const turn = events.slice(before).filter(row => row.event.turnId === sent.turnId);
    expect(turn.length).toBeGreaterThan(0);
    for (const row of turn) expect(row.source, `${row.event.type} run ${run}`).toBe(source);
  }
}
describe.skipIf(process.platform === 'win32')('driver admission capture', () => {
  for (const [name, path, exported, file, config] of driverCases) it(`admission.all-seven-drivers.${name}`, async () => {
    ensureDirs();
    const cli = fileURLToPath(new URL(`../testing/${file}`, import.meta.url)); chmodSync(cli, 0o755);
    const mod = await import(path);
    const driver = mod[exported] as ProviderDriver<Record<string, unknown>>;
    const instance = await driver.create({ instanceId: `capture-${name}`, enabled: true, displayName: 'Fixture', environment: {}, config: { ...config, cli } });
    bindFixtureAdapter(instance.adapter);
    try { await assertSource(instance); } finally { await instance.dispose(); }
  }, 45_000);
});

it('admission.memory-wrapper', async () => {
  let listener: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const source = { attachment: Object.freeze({}) } as SourceContext;
  let sent: unknown, received: unknown;
  const original = { instanceId: 'memory-fixture', driverKind: 'fake', adapter: {
    capabilities: {}, hasSession: () => false,
    onEvent: (next: typeof listener) => { listener = next; return () => {}; },
    sendTurn: async (turn: { sourceContext?: SourceContext }) => { sent = turn.sourceContext; listener?.({ type: 'turn.started', threadId: 't' } as RuntimeEvent, turn.sourceContext); return { turnId: 'turn' }; },
  } } as unknown as ProviderInstance;
  const wrapped = decorateMemoryInstance(original);
  wrapped.adapter.onEvent((_e, context) => { received = context; });
  await wrapped.adapter.sendTurn({ threadId: 't', text: 'unchanged', sourceContext: source });
  expect(sent).toBe(source); expect(received).toBe(source);
});

import { EventBus } from './bus.ts';
import type { AudienceEmission, TurnTextPolicy } from '../contracts.ts';

/** Contract fixture for F2: verifies once-only delivery and ordering separately
 * from 1A's detector. It buffers a line, flushes at terminal and records calls. */
function recordingPolicy() {
  let pending = ''; let retired = false;
  const consume = vi.fn((_cap, batch) => {
    const operations: any[] = [];
    for (const carrier of batch.carriers) {
      pending += carrier.text;
      if (pending.endsWith('\n')) { operations.push({ path: carrier.path, stream: carrier.stream, regionId: 'host-region', revision: 1, op: 'append', text: pending, speech: 'append' }); pending = ''; }
    }
    if (batch.terminal) {
      if (pending) operations.push({ path: 'delta', stream: 'anonymous:assistant', regionId: 'host-region', revision: 2, op: 'append', text: pending, speech: 'append' });
      pending = ''; retired = true;
    }
    return { masked: retired && !batch.terminal, exhausted: false, operations };
  });
  const policy: TurnTextPolicy = { admit() { retired = false; }, consume, reset: () => ({ masked: false, exhausted: false, operations: [] }), finish: () => ({ masked: false, exhausted: false, operations: [] }), retire() { retired = true; } };
  return { policy, consume };
}
const rawEvent = (fields: object = {}): RuntimeEvent => ({ provider: 'fake', eventId: 'provider-event', threadId: 'thread', createdAt: 'provider-time', type: 'content.delta', streamKind: 'assistant_text', delta: 'clean\n', ...fields }) as RuntimeEvent;
function admittedBus(policy: TurnTextPolicy) {
  const bus = new EventBus(() => {}, policy); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const cap = bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' });
  return { bus, cap, source: bus.collector.source(cap), attachment };
}
it('collector.held-writer-retry-once', async () => {
  const { policy, consume } = recordingPolicy(); const { bus, source } = admittedBus(policy);
  let held = true, release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  bus.gateDeliveries({ held: () => held, wait: () => wait, isBusy: error => error === 'busy' });
  const immediate: AudienceEmission[] = [], durable: AudienceEmission[] = [];
  bus.subscribeAudience(e => immediate.push(e), { durable: false });
  let attempts = 0; bus.subscribeAudience(e => { if (attempts++ === 0) throw 'busy'; durable.push(e); });
  bus.publish(rawEvent(), source); const id = immediate[0].emissionId;
  held = false; release(); await vi.waitFor(() => expect(bus.pendingDurable()).toBe(0));
  expect(consume).toHaveBeenCalledTimes(1); expect(durable[0]).toBe(immediate[0]); expect(durable[0].emissionId).toBe(id);
});
it('collector.terminal-flush-order', () => {
  const { policy } = recordingPolicy(); const { bus, source } = admittedBus(policy); const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false });
  bus.publish(rawEvent({ delta: 'last unterminated line' }), source); expect(seen).toHaveLength(0);
  bus.publish(rawEvent({ type: 'turn.completed', ok: true }), source);
  expect(seen.map(e => e.event.type)).toEqual(['content.delta', 'turn.completed']);
  expect(JSON.stringify(seen[0])).toContain('last unterminated line');
  bus.publish(rawEvent({ delta: 'LATE_SECRET\n' }), source);
  expect(JSON.stringify(seen)).not.toContain('LATE_SECRET');
});
it('collector.synthetic-id-stability', () => {
  const { policy } = recordingPolicy(); const { bus, source } = admittedBus(policy); const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false }); const event = rawEvent();
  bus.publish(event, source); bus.publish(event, source);
  expect(seen[0].emissionId).not.toBe(seen[1].emissionId); expect(seen[0].event.eventId).not.toBe(event.eventId);
  expect(Object.isFrozen(seen[0].event)).toBe(true);
});
it('collector.reused-thread-and-provider-replaced', () => {
  const { policy } = recordingPolicy(); const { bus, source, attachment } = admittedBus(policy); const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false }); bus.collector.detach(attachment);
  bus.publish(rawEvent({ delta: 'OLD_SECRET\n' }), source);
  expect(JSON.stringify(seen)).not.toContain('OLD_SECRET');
  const freshAttachment = bus.collector.attach('instance');
  const cap = bus.collector.admitNewTurn({ attachment: freshAttachment, instanceId: 'instance', threadId: 'thread' });
  bus.publish(rawEvent({ delta: 'fresh clean\n' }), bus.collector.source(cap));
  expect(JSON.stringify(seen)).toContain('fresh clean');
});

it('admission.all-seven-drivers.openai-chat', async () => {
  ensureDirs();
  const { createOpenAIChatRuntime } = await import('../drivers/openai-chat.ts');
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })) as typeof fetch;
  const instance = createOpenAIChatRuntime({
    input: { instanceId: 'chat-fixture', enabled: true, displayName: 'Fixture', environment: {}, config: {} },
    driverKind: 'chat-fixture', apiKey: 'fixture-key', apiUrl: 'https://fixture.invalid/v1',
    models: () => ({ default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: 'Fixture', missingKeyError: 'fixture', unavailableReason: 'fixture',
    nativeLog: { source: 'fixture', outgoing: () => ({}), incoming: () => ({}) },
  });
  try { await assertSource(instance); } finally { globalThis.fetch = previous; await instance.dispose(); }
});
it('admission.all-seven-drivers.boxagent', async () => {
  ensureDirs(); const { BoxAgentDriver } = await import('../drivers/boxagent.ts');
  const previous = globalThis.fetch; let run = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/prompt')) return json({ promptRun: { id: `run-${++run}` } });
    if (url.includes('/events')) return json({ events: [{ id: `reply-${run}`, type: 'response', text: 'hello' }] });
    if (url.includes('/prompts/')) return json({ promptRun: { status: 'finished', result: 'hello' } });
    return json({ ok: true });
  }) as typeof fetch;
  const instance = await BoxAgentDriver.create({ instanceId: 'box-fixture', enabled: true, displayName: 'Fixture', environment: { BOX_TOKEN: 'fixture-key' }, config: { pollMs: 0 } });
  try { await assertSource(instance, { computer: { boxId: 'fixture-box', token: 'fixture-key' } }); } finally { globalThis.fetch = previous; await instance.dispose(); }
}, 30_000);

// Transport proofs are validated by their existing gates after opaque action resolution.
it('opaque submissions retain task scope and fresh-auth transport without accepting execution fields', () => {
  const permission: DisplayActionCard = { id: 'host-p', requestType: 'permission', live: true };
  const proof = { nonce: 'host-nonce', signature: 'device-signature' };
  expect(resolveDisplaySubmission(permission, { requestHandle: 'p.host-p', action: 'allow', allowForTask: true, freshAuth: proof }))
    .toEqual({ ok: true, legacyBody: { behavior: 'allow', allowForTask: true, freshAuth: proof } });
  for (const extra of [{ requestId: 'raw' }, { allowKey: 'Bash' }, { allowForTask: 'true' }, { allowForTask: false }, { raw: true }]) {
    expect(resolveDisplaySubmission(permission, { requestHandle: 'p.host-p', action: 'allow', ...extra })).toMatchObject({ ok: false, status: 400 });
  }
  expect(resolveDisplaySubmission(permission, { requestHandle: 'p.host-p', action: 'deny', allowForTask: true })).toMatchObject({ ok: false, status: 400 });
  expect(resolveDisplaySubmission(card, { ...action, allowForTask: true })).toMatchObject({ ok: false, status: 400 });
  expect(resolveDisplaySubmission({ ...permission, live: false }, { requestHandle: 'p.host-p', action: 'allow', freshAuth: proof })).toMatchObject({ ok: false, status: 409 });
});


it('collector.anonymous-completions-have-distinct-display-regions', () => {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const source = bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' }));
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(event => seen.push(event), { durable: false });
  for (const text of ['First item.', 'First item. Again.', 'Last item.']) bus.publish(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text }), source);
  const items = seen.flatMap(row => row.event.type === 'item.completed' && row.event.itemType === 'assistant_text' ? [row.event] : []);
  expect(items.map(event => event.text)).toEqual(['First item.', 'First item. Again.', 'Last item.']);
  expect(new Set(items.map(event => event.regionId)).size).toBe(3);
});

it('collector.anonymous-item-boundary-keeps-the-turn-redaction-latch', () => {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const source = bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' }));
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(event => seen.push(event), { durable: false });
  bus.publish(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: '**password**:' }), source);
  const before = seen.length;
  bus.publish(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: 'fixture private value' }), source);
  expect(JSON.stringify(seen.slice(before))).not.toContain('fixture private value');
  expect(bus.collector.masked(source)).toBe(true);
});


it.each(['masked', 'exhausted'] as const)('collector.post-latch-flood-bounds-retained-state.%s', latch => {
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach('instance');
  const cap = collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' });
  const source = collector.source(cap);
  const state = (collector as unknown as { admissions: WeakMap<object, {
    snapshots: Map<string, string>; regions: Set<string>; items: Map<string, string>; anonymousAssistant: number;
  }> }).admissions.get(cap)!;
  collector.intake(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: latch === 'masked' ? '**password**:' : 42 }), source); // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z: 256 KiB + 1 of text no longer masks a turn (size cut removed); the non-secret mask this row needs is now a shape refusal (text that is not a string)
  expect(collector.masked(source)).toBe(true);
  for (let i = 0; i < 2_000; i++) {
    const result = collector.intake(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: 'fixture private value' }), source);
    expect(result.execution.type).toBe('item.completed');
    expect(JSON.stringify(result.audience)).not.toContain('fixture private value');
  }
  expect(state.snapshots.size).toBeLessThanOrEqual(64);
  expect(state.regions.size).toBeLessThanOrEqual(64);
  expect(state.items.size).toBeLessThanOrEqual(64);
  expect(state.anonymousAssistant).toBeLessThanOrEqual(64);
  const pending = collector.intake(rawEvent({ type: 'request.opened', requestType: 'permission', summary: 'fixture private value' }), source);
  expect(pending.audience.some(row => row.event.type === 'request.opened')).toBe(true);
  expect(JSON.stringify(pending.audience)).not.toContain('fixture private value');
  const terminal = collector.intake(rawEvent({ type: 'turn.completed', ok: true }), source);
  expect(terminal.audience.some(row => row.event.type === 'turn.completed')).toBe(true);
  expect(state.snapshots.size).toBe(0);
  expect(state.regions.size).toBe(0);
});


it.each(['masked', 'exhausted'] as const)('collector.post-latch-question-keeps-opaque-choices.%s', latch => {
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach('instance');
  const cap = collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' });
  const source = collector.source(cap);
  collector.intake(rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: latch === 'masked' ? '**password**:' : 42 }), source); // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z: 256 KiB + 1 of text no longer masks a turn (size cut removed); the non-secret mask this row needs is now a shape refusal (text that is not a string)
  expect(collector.masked(source)).toBe(true);
  const result = collector.intake(rawEvent({ type: 'request.opened', requestType: 'question', questions: [{
    id: 'private-question-id', question: 'fixture private question', options: [{ label: 'fixture private option' }, { label: 'another private option' }],
  }] }), source);
  const question = result.audience.find(row => row.event.type === 'request.opened')!.event as unknown as {
    questions: { handle: string; options: { handle: string; label: string }[] }[];
  };
  expect(question.questions).toEqual([{ handle: 'q.0', question: '«redacted»', options: [
    { handle: 'o.0.0', label: 'Option 1' }, { handle: 'o.0.1', label: 'Option 2' },
  ] }]);
  expect(JSON.stringify(result.audience)).not.toMatch(/private-question-id|fixture private|another private/);
});

it('collector.a rich startup command catalog does not mask a short answer', () => {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const source = bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' }));
  const commands = Array.from({ length: 40 }, (_, i) => ({ name: `command-${i}`, description: 'An ordinary menu entry.', hint: 'Optional input.' }));
  const privateValue = 'fixture' + 'MenuValue123';
  commands[0]!.description = `password: ${privateValue}`;
  const report = rawEvent({ type: 'engine.commands', commands });
  bus.publish(report, source);
  expect(bus.audienceFor(report).map(row => row.event)).toContainEqual(expect.objectContaining({ type: 'engine.commands', commands: [] }));
  expect(JSON.stringify(bus.audienceFor(report))).not.toContain(privateValue);
  const reply = rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: 'A short answer.' });
  bus.publish(reply, source);
  expect(bus.audienceMaskedFor(reply)).toBe(false);
  expect(bus.audienceFor(reply).map(row => row.event)).toContainEqual(expect.objectContaining({ type: 'item.completed', text: 'A short answer.' }));
});

it('collector.a long ordinary tool turn keeps its final owner reply', () => {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const source = bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' }));
  for (let i = 0; i < 120; i++) {
    const itemId = `step-${i}`;
    bus.publish(rawEvent({ type: 'item.started', itemType: 'tool', itemId, title: 'Read', input: { path: 'fixture.txt' } }), source);
    bus.publish(rawEvent({ type: 'item.completed', itemType: 'tool', itemId, ok: true, detail: 'Read a file.' }), source);
  }
  const reply = rawEvent({ type: 'item.completed', itemType: 'assistant_text', text: 'All files were read.' });
  bus.publish(reply, source);
  expect(bus.audienceMaskedFor(reply)).toBe(false);
  expect(bus.audienceFor(reply).map(row => row.event)).toContainEqual(expect.objectContaining({ type: 'item.completed', text: 'All files were read.' }));
});
