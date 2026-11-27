// 1.0.20 redact-acp: a long or record-heavy CLEAN turn on an ACP engine is never masked by a table that filled up.
// Owners: the redact-acp closer owns this witness; the collector and the turn text policy are owned by their modules.
// Real EventBus, real RuntimeAudienceCollector, real turn text policy (no recording fake). The events have the fields
// the ACP driver emits (server/drivers/acp/core.ts: `tool_call` -> item.started with title, input = rawInput, toolKind
// and the engine stamp as toolIdentity; `tool_call_update` -> item.completed with result = rawOutput; a text region is
// content.delta + item.completed under one item id; the host's approval note is its own item). The real-driver witness
// of the same turn is server/redact-acp-long-turn.test.ts; this file is the fast one and holds the policy cases.
// Shapes and counts are copied from recorded real Fuigo turns; no recorded text is.
import { describe, expect, it } from 'vitest';
import type { AudienceEmission, RuntimeEvent } from '../contracts.ts';
import { EventBus } from './bus.ts';
import { createTurnTextPolicy, TURN_TEXT_LIMITS, type ManifestBatch, type TurnAdmission } from '../redact-turn.ts';

const MARK = '«redacted»';
const FIXTURE_SECRET = 'api_key=' + 'FIXTURESECRET123456';
const base = { provider: 'fake', createdAt: 'provider-time' };
let seq = 0;
const ev = (threadId: string, fields: object): RuntimeEvent => ({ ...base, threadId, eventId: `provider-event-${++seq}`, ...fields }) as RuntimeEvent;

function house() {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false });
  const turn = (name: string) => {
    const attachment = bus.collector.attach(`instance-${name}`);
    return bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: `instance-${name}`, threadId: `thread-${name}` }));
  };
  return { bus, seen, turn };
}
/** The seven-key result record a real Fuigo shell call reports as rawOutput (null, number and boolean leaves). */
const shellRecord = (i: number) => ({ type: 'exec', description: null, exit_code: 0, signal: null, timed_out: false, total_bytes: 18 + i, truncated: false });
const command = (i: number) => `echo research-step-${i}-ok`;
const progress = (i: number) => `Step ${i}: reading the next source.\n`;
/** One step of a Fuigo research turn as the ACP driver emits it. `input` and `result` default to the shell shapes. */
function step(thread: string, i: number, over: { command?: string; result?: unknown } = {}): RuntimeEvent[] {
  return [
    ev(thread, { type: 'content.delta', streamKind: 'assistant_text', itemId: `text-${i}`, delta: progress(i) }),
    ev(thread, { type: 'item.completed', itemType: 'assistant_text', origin: 'engine', itemId: `text-${i}`, text: progress(i) }),
    ev(thread, { type: 'item.started', itemType: 'tool', origin: 'engine', itemId: `call-${i}`, title: 'run_terminal_cmd', summary: over.command ?? command(i), toolKind: 'other',
      input: { variant: 'UseTool', tool_name: 'run_terminal_cmd', tool_input: { command: over.command ?? command(i), description: `Research step ${i}`, timeout_ms: 120000, is_background: false } },
      toolIdentity: { namespace: 'fuigo_build', name: 'use_tool', kind: 'use_tool' } }),
    ev(thread, { type: 'item.started', itemType: 'tool', origin: 'murage', itemId: `approved-${i}`, title: 'Approved 1 step (No limits)', toolKind: 'notice' }),
    ev(thread, { type: 'item.completed', itemType: 'tool', itemId: `approved-${i}`, ok: true }),
    ev(thread, { type: 'item.completed', itemType: 'tool', itemId: `call-${i}`, ok: true, result: over.result ?? shellRecord(i) }),
  ];
}
const of = (seen: AudienceEmission[], thread: string) => seen.filter(row => (row.event as { threadId?: string }).threadId === thread);
const replies = (rows: AudienceEmission[]) => rows.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'assistant_text' ? [(row.event as { text: string }).text] : []);
const toolStarts = (rows: AudienceEmission[]) => rows.flatMap(row => row.event.type === 'item.started' && (row.event as { origin?: string }).origin === 'engine' ? [JSON.stringify(row.event)] : []);
const toolResults = (rows: AudienceEmission[]) => rows.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'tool' && (row.event as { preview?: unknown[] }).preview?.length ? [JSON.stringify(row.event)] : []);

describe('a long clean ACP owner turn is never masked by a full field table', () => {
  // 72 = the live turn; 130 = more fields than the turn's table holds with these shapes (full near step 90).
  it.each([72, 130])('acp-long-turn.%i-steps-of-record-results: every tool row and every reply stays shown', count => {
    const { bus, seen, turn } = house();
    const source = turn('a');
    let firstMasked = -1;
    for (let i = 1; i <= count; i++) for (const event of step('thread-a', i)) {
      bus.publish(event, source);
      if (firstMasked < 0 && bus.audienceMaskedFor(event)) firstMasked = i;
    }
    const done = ev('thread-a', { type: 'item.completed', itemType: 'assistant_text', origin: 'engine', itemId: 'text-final', text: 'RESEARCH_DONE all steps are summarised.' });
    bus.publish(done, source);
    expect(firstMasked, 'first step whose display was masked').toBe(-1);
    expect(bus.audienceMaskedFor(done)).toBe(false);
    expect(bus.collector.masked(source)).toBe(false);
    const rows = of(seen, 'thread-a');
    expect(rows.some(row => row.event.type === 'audience.omitted')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(MARK);
    expect(replies(rows)).toHaveLength(count + 1);
    expect(replies(rows).at(-1)).toBe('RESEARCH_DONE all steps are summarised.');
    const starts = toolStarts(rows), results = toolResults(rows);
    expect(starts).toHaveLength(count); expect(results).toHaveLength(count);
    for (const i of [1, 36, 58, 72, count - 1, count]) { expect(starts[i - 1], `tool row ${i}`).toContain(command(i)); expect(results[i - 1], `result ${i}`).toContain(String(18 + i)); }
  });

  it('acp-long-turn.a-wide-record-result: one result with many leaves is shown whole, never a mask', () => {
    // An MCP structuredContent or rawOutput record with more leaves than one policy batch holds (two fields per leaf).
    const { bus, seen, turn } = house();
    const source = turn('w');
    const wide = (i: number) => ({ content: [{ type: 'text', text: `created item ${i}` }], structuredContent: { item: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`field_${k}`, k % 3 ? `value ${k}` : k])) }, isError: false });
    for (let i = 1; i <= 12; i++) for (const event of step('thread-w', i, { result: wide(i) })) {
      bus.publish(event, source);
      expect(bus.audienceMaskedFor(event), `step ${i} ${event.type}`).toBe(false);
    }
    const rows = of(seen, 'thread-w');
    expect(JSON.stringify(rows)).not.toContain(MARK);
    expect(replies(rows)).toHaveLength(12);
    const results = toolResults(rows);
    expect(results).toHaveLength(12);
    for (let i = 1; i <= 12; i++) expect(results[i - 1]).toContain(`created item ${i}`);
    // MAIN-RULING 2026-11-22T17:58:19Z Q3 (C5 shortenForDisplay deleted): the record is no longer cut to 24 fields with a
    // "more fields not shown" note; every field of it is scanned and shown. This one line flipped; the lines above are unchanged.
    expect(results[0]).not.toContain('more fields not shown');
    expect(results[0]).toContain('value 59');
    // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design T3): the 64-field batch cut this line measured against is deleted; a batch of any width is scanned.
  });

  it('acp-long-turn.three-long-turns-at-once: a third turn is still shown when the process table is full', () => {
    const { bus, seen, turn } = house();
    const a = turn('a'), b = turn('b');
    for (let i = 1; i <= 90; i++) { for (const event of step('thread-a', i)) bus.publish(event, a); for (const event of step('thread-b', i)) bus.publish(event, b); }
    const c = turn('c');
    for (let i = 1; i <= 10; i++) for (const event of step('thread-c', i)) { bus.publish(event, c); expect(bus.audienceMaskedFor(event), `third turn step ${i}`).toBe(false); }
    for (const event of step('thread-a', 91)) { bus.publish(event, a); expect(bus.audienceMaskedFor(event)).toBe(false); }
    const rows = of(seen, 'thread-c');
    expect(JSON.stringify(rows)).not.toContain(MARK);
    expect(replies(rows)).toHaveLength(10);
    expect(toolStarts(rows)).toHaveLength(10);
    expect(JSON.stringify(of(seen, 'thread-a').slice(-6))).not.toContain(MARK);
  });

  it('control.acp-long-turn.a-credential-in-step-50-still-latches: nothing of it is shown and the turn follows the secret rule', () => {
    for (const where of ['command', 'result'] as const) {
      const { bus, seen, turn } = house();
      const source = turn('s');
      for (let i = 1; i <= 49; i++) for (const event of step('thread-s', i)) bus.publish(event, source);
      const before = seen.length;
      const leak = where === 'command' ? { command: `export ${FIXTURE_SECRET}` } : { result: { ...shellRecord(50), description: FIXTURE_SECRET } };
      for (const event of step('thread-s', 50, leak)) bus.publish(event, source);
      for (let i = 51; i <= 72; i++) for (const event of step('thread-s', i)) bus.publish(event, source);
      expect(bus.collector.masked(source), where).toBe(true);
      expect(bus.collector.maskedBySecret(source), where).toBe(true);
      expect(JSON.stringify(seen), where).not.toContain('FIXTURESECRET123456');
      // the existing secret rule: once latched, the rest of the turn is not shown
      const after = JSON.stringify(seen.slice(before));
      expect(after).not.toContain(command(60)); expect(after).not.toContain(progress(72).trim());
      // what was shown before the hit was real
      expect(JSON.stringify(seen.slice(0, before))).toContain(command(1));
    }
  });
});

describe('the field table lets go of old released fields; it never forgets that it did', () => {
  let n = 0;
  const batch = (text: string, stream: string, mode: 'delta' | 'whole' | 'snapshot' = 'whole', path = 'title'): ManifestBatch =>
    ({ envelope: { eventId: `a${++n}`, instanceId: 'i', threadId: 't', generation: 1, intakeOrdinal: n, createdAt: 0 }, variant: 'M08', carriers: [{ path, stream, mode, text }], controls: {} });
  const shown = (d: { operations: readonly { text: string }[] }) => d.operations.map(o => o.text).join('');
  const fresh = () => { const p = createTurnTextPolicy({ separateItemRegions: true }), a = Object.freeze({}) as TurnAdmission; p.admit(a); return { p, a }; };
  const FULL = TURN_TEXT_LIMITS.retainedStreams;
  const fill = (p: ReturnType<typeof fresh>['p'], a: TurnAdmission, count: number, tag = 'item') => {
    for (let i = 0; i < count; i++) { const d = p.consume(a, batch(`Field ${i}`, `${tag}-${i}:other:title`)); expect(d.masked, `field ${i}`).toBe(false); expect(shown(d)).toBe(`Field ${i}`); }
  };

  it('policy.table-full: the newest field is shown and the table stays at its limit', () => {
    const { p, a } = fresh();
    fill(p, a, FULL + 500);
    expect(p.stats().streams).toBe(FULL);
  });

  it('policy.let-go-key-written-again: that one field is withheld alone, the turn stays shown', () => {
    const { p, a } = fresh();
    fill(p, a, FULL + 1);
    const again = p.consume(a, batch('a later value', 'item-0:other:title'));
    expect(again.masked).toBe(false); expect(again.exhausted).toBe(false);
    expect(again.operations.map(o => [o.op, o.text])).toEqual([['omit', MARK]]);
    // a field still in the table is rewritten as before, and new fields are still shown
    expect(shown(p.consume(a, batch('rewritten', `item-${FULL}:other:title`)))).toBe('rewritten');
    expect(shown(p.consume(a, batch('brand new', 'item-new:other:title')))).toBe('brand new');
  });

  it('policy.let-go-key-written-again-with-a-credential: the turn latches', () => {
    const { p, a } = fresh();
    fill(p, a, FULL + 1);
    const hit = p.consume(a, batch(FIXTURE_SECRET, 'item-0:other:title'));
    expect(hit.masked).toBe(true); expect(hit.exhausted).toBe(false);
    expect(shown(p.consume(a, batch('anything', 'item-after:other:title')))).not.toContain('anything');
  });

  it('policy.credential-after-the-table-turned-over-still-latches (new field, and split across two writes of one field)', () => {
    const one = fresh();
    fill(one.p, one.a, FULL + 300);
    expect(one.p.consume(one.a, batch('**password**: hunter2', 'item-x:other:title')).masked).toBe(true);
    const two = fresh();
    fill(two.p, two.a, FULL + 300);
    expect(two.p.consume(two.a, batch('**password**', 'item-y:other:preview.0.value', 'whole', 'preview.0.value')).masked).toBe(false);
    const joined = two.p.consume(two.a, batch(': hunter2-fixture-value', 'item-y:other:preview.0.value', 'whole', 'preview.0.value'));
    expect(joined.masked).toBe(true);
    expect(JSON.stringify(joined.operations)).not.toContain('hunter2');
  });

  it('policy.open-text-is-never-let-go: an unfinished reply survives a full table and completes whole', () => {
    const { p, a } = fresh();
    expect(p.consume(a, batch('The answer starts here', 'reply-1:assistant', 'delta', 'delta')).masked).toBe(false);
    fill(p, a, FULL + 200);
    const end = p.consume(a, batch('The answer starts here and ends here.', 'reply-1:assistant', 'snapshot', 'text'));
    expect(end.masked).toBe(false);
    expect(shown(end)).toContain('and ends here.');
  });

  it('policy.a-second-turn-is-seated-when-the-process-table-is-full', () => {
    const p = createTurnTextPolicy({ separateItemRegions: true });
    const caps = [0, 1, 2].map(() => Object.freeze({}) as TurnAdmission);
    for (const cap of caps) p.admit(cap);
    fill(p, caps[0], FULL, 'one'); fill(p, caps[1], FULL, 'two');
    expect(p.stats().streams).toBe(TURN_TEXT_LIMITS.globalStreams);
    fill(p, caps[2], 40, 'three');
    expect(p.stats().streams).toBe(TURN_TEXT_LIMITS.globalStreams);
  });
});
