// Owner-only long turn: a tool-heavy research turn on one admission must keep
// showing clean assistant and tool text to the owner. Real EventBus, real
// RuntimeAudienceCollector and the real turn text policy (no recording fake).
// Cases copied unchanged from lane redacted-owner-n1 (fix/1020-redacted-owner
// e62cc24e54), kept only where they are requirements on the late tip's design
// (MAIN ruling Q2): the tip's caps stay; a full turn history drops its OLDEST
// settled fields (server/redact-turn.ts makeRoom) and a field whose history is
// gone is withheld alone. Left out: n1's own rotation/eviction/tombstone cases.
// The last describe block is this branch's own (fix/1020-redact-residual-fable).
import { describe, expect, it } from 'vitest';
import type { AudienceEmission, RuntimeEvent } from '../contracts.ts';
import { EventBus } from './bus.ts';
import { createTurnTextPolicy, type ManifestBatch, type TurnAdmission } from '../redact-turn.ts';
import { sanitizeBotDisplayMessage } from '../transcript-page.ts';
import { REPLY_WITHHELD } from '../owner-display.ts';
import { engineDividers } from '../../shared/chat-engine-notes.ts';

const MARK = '«redacted»';
const base = { provider: 'fake', threadId: 'thread', createdAt: 'provider-time' };
let seq = 0;
const ev = (fields: object): RuntimeEvent => ({ ...base, eventId: `provider-event-${++seq}`, ...fields }) as RuntimeEvent;

function ownerTurn() {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const attachment = bus.collector.attach('instance');
  const source = bus.collector.source(bus.collector.admitNewTurn({ attachment, instanceId: 'instance', threadId: 'thread' }));
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false });
  return { bus, source, seen };
}

/** One research step the way a hosted engine reports it: a tool item with a
 * small input and result preview, then a short assistant progress item. */
function step(i: number): RuntimeEvent[] {
  return [
    ev({ type: 'item.started', itemType: 'tool', origin: 'engine', itemId: `tool-${i}`, title: 'Web search', input: { query: `clinic listing page ${i}`, limit: 5 } }),
    ev({ type: 'item.completed', itemType: 'tool', itemId: `tool-${i}`, ok: true, detail: `Found listing ${i}`, result: { title: `Listing ${i}`, url: `https://listing-${i}.example/contact` } }),
    ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: `text-${i}`, delta: `Checked listing ${i}, moving on.\n` }),
    ev({ type: 'item.completed', itemType: 'assistant_text', itemId: `text-${i}`, text: `Checked listing ${i}, moving on.\n` }),
  ];
}

const assistantTexts = (seen: AudienceEmission[]) => seen.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'assistant_text' ? [(row.event as { text: string }).text] : []);
const toolTitles = (seen: AudienceEmission[]) => seen.flatMap(row => row.event.type === 'item.started' && (row.event as { itemType?: string }).itemType === 'tool' ? [(row.event as { title: string }).title] : []);

describe('owner-only long turn keeps clean text visible', () => {
  it('owner-long-turn.120-steps-no-mask', () => {
    const { bus, source, seen } = ownerTurn();
    let firstMasked = -1;
    for (let i = 0; i < 120; i++) {
      for (const event of step(i)) {
        bus.publish(event, source);
        if (firstMasked < 0 && bus.audienceMaskedFor(event)) firstMasked = i;
      }
    }
    bus.publish(ev({ type: 'turn.completed', ok: true }), source);
    expect(firstMasked, 'first step whose display was masked').toBe(-1);
    expect(seen.some(row => row.event.type === 'audience.omitted')).toBe(false);
    const texts = assistantTexts(seen);
    expect(texts).toHaveLength(120);
    expect(texts.at(-1)).toBe('Checked listing 119, moving on.\n');
    expect(toolTitles(seen).filter(t => t === 'Web search')).toHaveLength(120);
    expect(JSON.stringify(seen)).not.toContain(MARK);
  });

  it('owner-long-turn.secret-still-latches-after-many-steps', () => {
    // Fail-closed is kept: a real credential in a long turn still masks.
    const { bus, source, seen } = ownerTurn();
    for (let i = 0; i < 80; i++) for (const event of step(i)) bus.publish(event, source);
    const before = seen.length;
    bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'leak', text: '**password**:' }), source);
    bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'leak-2', text: 'fixture private value' }), source);
    expect(JSON.stringify(seen.slice(before))).not.toContain('fixture private value');
    expect(bus.collector.masked(source)).toBe(true);
  });

  it('owner-long-turn.streamed-partial-lines-and-parallel-tools', () => {
    // The shape a hosted engine streams: deltas cut mid-word with no trailing
    // newline, a snapshot completion, and tool calls fanned out in parallel.
    const { bus, source, seen } = ownerTurn();
    let masked = false;
    const send = (event: RuntimeEvent) => { bus.publish(event, source); masked ||= bus.audienceMaskedFor(event); };
    for (let round = 0; round < 30; round++) {
      for (let k = 0; k < 4; k++) send(ev({ type: 'item.started', itemType: 'tool', origin: 'engine', itemId: `p-${round}-${k}`, title: 'Fetch page', input: { url: `https://site-${round}-${k}.example/`, prompt: 'list the contact email' } }));
      for (let k = 0; k < 4; k++) send(ev({ type: 'item.completed', itemType: 'tool', itemId: `p-${round}-${k}`, ok: true, detail: 'Fetched', result: { status: 200, text: `Contact page ${round}-${k}` } }));
      const words = `Round ${round}: four pages read, ${'notes '.repeat(400)}done`;
      for (let at = 0; at < words.length; at += 37) send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: `say-${round}`, delta: words.slice(at, at + 37) }));
      send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: `say-${round}`, text: words }));
    }
    send(ev({ type: 'turn.completed', ok: true }));
    expect(masked).toBe(false);
    const texts = assistantTexts(seen);
    expect(texts).toHaveLength(30);
    expect(texts[29]).toMatch(/^Round 29: four pages read, notes .* done$/s);
    expect(JSON.stringify(seen)).not.toContain(MARK);
  });

  it('owner-long-turn.100-anonymous-replies', () => {
    // Engines that send assistant text without item ids: each completion is its own item.
    const { bus, source, seen } = ownerTurn();
    for (let i = 0; i < 100; i++) bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', text: `Progress note ${i}.` }), source);
    expect(bus.collector.masked(source)).toBe(false);
    expect(assistantTexts(seen)).toHaveLength(100);
    expect(assistantTexts(seen).at(-1)).toBe('Progress note 99.');
  });

  it('owner-long-turn.another-engine-reloads-mid-turn', () => {
    // Switching or reloading a different engine re-attaches only that engine;
    // this turn's admission stays valid and its text stays shown.
    const bus = new EventBus(() => {}); bus.omitLog(() => true);
    const listeners = new Map<string, (event: RuntimeEvent, source?: unknown) => void>();
    const instance = (instanceId: string) => ({ instanceId, driverKind: 'fake', adapter: { onEvent: (fn: (event: RuntimeEvent, source?: unknown) => void) => { listeners.set(instanceId, fn); return () => listeners.delete(instanceId); } } });
    bus.attach([instance('engine-a'), instance('engine-b')] as never);
    const source = bus.admitNewTurn('engine-a', 'thread');
    const seen: AudienceEmission[] = [];
    bus.subscribeAudience(e => seen.push(e), { durable: false });
    listeners.get('engine-a')!(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'one', text: 'Before the switch.' }), source);
    bus.detach(new Set(['engine-b'])); bus.attach([instance('engine-b')] as never);
    const after = ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'two', text: 'After the switch.' });
    listeners.get('engine-a')!(after, source);
    expect(assistantTexts(seen)).toEqual(['Before the switch.', 'After the switch.']);
    expect(seen.some(row => row.event.type === 'audience.omitted')).toBe(false);
  });
});

describe('turn text policy keeps a long clean turn shown', () => {
  let n = 0;
  const batch = (text: string, stream: string, mode: 'delta' | 'whole' | 'snapshot' = 'whole', path = 'title'): ManifestBatch =>
    ({ envelope: { eventId: `e${++n}`, instanceId: 'i', threadId: 't', generation: 1, intakeOrdinal: n, createdAt: 0 }, variant: 'M08', carriers: [{ path, stream, mode, text }], controls: {} });
  const shown = (d: { operations: readonly { text: string }[] }) => d.operations.map(o => o.text).join('');
  const fresh = () => { const p = createTurnTextPolicy({ separateItemRegions: true }), a = Object.freeze({}) as TurnAdmission; p.admit(a); return { p, a }; };

  it('policy.long-assistant-items-guard', () => {
    // Guard (green before and after): 40 completed items of 4 KB each pass the 64 KB turn history; each item
    // ends mid-line (pending tail) when its snapshot completes it.
    const { p, a } = fresh();
    for (let i = 0; i < 40; i++) {
      const words = `Item ${i} ` + 'research notes '.repeat(270) + 'end';
      const d1 = p.consume(a, batch(words.slice(0, 2000), `say-${i}:assistant`, 'delta', 'delta'));
      expect(d1.masked, `delta ${i}`).toBe(false);
      const d2 = p.consume(a, batch(words, `say-${i}:assistant`, 'snapshot', 'text'));
      expect(d2.masked, `snapshot ${i}`).toBe(false);
      expect(shown(d1) + shown(d2)).toBe(words);
    }
  });

  it('policy.history-full-reuse-of-a-recent-field', () => {
    // 20 tool inputs of 4 KB pass the 64 KB turn history; the newest tool's
    // result preview then reuses its input preview key. Older settled history
    // makes room, so the recent field keeps its scan context and is shown.
    const { p, a } = fresh();
    for (let i = 0; i < 20; i++) expect(p.consume(a, batch('v'.repeat(4096), `item-${i}:other:preview.0.value`, 'whole', 'preview.0.value')).masked, `input ${i}`).toBe(false);
    const result = p.consume(a, batch('result text', 'item-19:other:preview.0.value', 'whole', 'preview.0.value'));
    expect(result.masked).toBe(false);
    expect(shown(result)).toBe('result text');
  });

  it('policy.secret-after-eviction-still-latches', () => {
    const { p, a } = fresh();
    for (let i = 0; i < 500; i++) p.consume(a, batch(`Field ${i}`, `item-${i}:other:title`));
    expect(p.consume(a, batch('**password**: hunter2', 'item-500:other:title')).masked).toBe(true);
    expect(shown(p.consume(a, batch('anything', 'item-501:other:title')))).not.toContain('anything');
  });
});

describe('a masked reply still names its engine', () => {
  const row = { id: 'row-1', at: 1, role: 'bot', kind: 'text', text: MARK, turnId: 'turn-1',
    engine: { instanceId: 'engine-b', driverKind: 'claude', model: 'fixture-model', capabilityHash: 'cap-fixture' } };
  it('engine-line.instance-survives-the-display-unit', () => {
    const out = sanitizeBotDisplayMessage(row, { authorship: 'bot' }) as { text: string; engine: Record<string, string> };
    // MAIN-RULING 2026-11-23T00:58:16Z redact-marker: a marker-only reply renders as the fixed held-back sentence for EVERY reader.
    expect(out.text).toBe(REPLY_WITHHELD);
    expect(out.engine).toMatchObject({ instanceId: 'engine-b', driverKind: 'claude', capabilityHash: 'cap-fixture' });
    // The model can be the provider's own report: still scanned with its siblings.
    expect(out.engine.model).toBe(MARK);
    const label = (engine: { instanceId: string }) => ({ 'engine-a': 'Engine A', 'engine-b': 'Engine B' } as Record<string, string>)[engine.instanceId] ?? engine.instanceId;
    const dividers = engineDividers([{ id: 'row-0', role: 'bot', engine: { instanceId: 'engine-a' } }, out as never], label);
    expect(dividers.get('row-1')).toMatch(/^Engine changed: Engine B\./);
  });
});


describe('a full turn history drops old fields, never the turn', () => {
  let n = 0;
  const batch = (text: string, stream: string, path = 'preview.0.value'): ManifestBatch =>
    ({ envelope: { eventId: `h${++n}`, instanceId: 'i', threadId: 't', generation: 1, intakeOrdinal: n, createdAt: 0 }, variant: 'M08', carriers: [{ path, stream, mode: 'whole', text }], controls: {} });
  const shown = (d: { operations: readonly { text: string }[] }) => d.operations.map(o => o.text).join('');
  const fresh = () => { const p = createTurnTextPolicy({ separateItemRegions: true }), a = Object.freeze({}) as TurnAdmission; p.admit(a); return { p, a }; };
  const OLD = 'item-old:other:preview.0.value';
  /** 20 tool inputs of 4 KB: more than the 64 KB turn history holds. */
  const fill = (p: ReturnType<typeof fresh>['p'], a: TurnAdmission) => { for (let i = 0; i < 20; i++) expect(p.consume(a, batch('v'.repeat(4096), `item-${i}:other:preview.0.value`)).masked, `input ${i}`).toBe(false); };

  // cause22-E (b) DECISIONS D-b2: a field rewritten many times keeps only the last 64 KB of what it showed as scan context,
  // and only when that history is closed at its end. Clean rewrites are all shown; a history left open (a label with no value
  // yet) cannot be shortened safely, so it is let go and the next rewrite of that field is withheld alone, never shown unjoined.
  it('history.one-field-rewritten-100-times-is-shown-each-time', () => {
    const { p, a } = fresh();
    for (let i = 0; i < 100; i++) {
      const value = `rewrite ${i} ` + 'words '.repeat(680);
      const d = p.consume(a, batch(value, OLD));
      expect(d.masked, `rewrite ${i}`).toBe(false);
      expect(shown(d), `rewrite ${i}`).toBe(value);
    }
  });
  it('history.open-label-then-padding-then-value-in-the-next-rewrite-is-not-shown', () => {
    const { p, a } = fresh();
    expect(shown(p.consume(a, batch('token:' + ' '.repeat(70_000), OLD)))).toBe('token:' + ' '.repeat(70_000));
    const next = p.consume(a, batch('hunter2X', OLD));
    expect(JSON.stringify(next.operations)).not.toContain('hunter2X');
    expect(shown(p.consume(a, batch('next field', 'item-next:other:title', 'title')))).toBe('next field');
  });
  it('history.old-field-reused-after-20-more-fields-is-shown', () => {
    const { p, a } = fresh();
    expect(shown(p.consume(a, batch('first value', OLD)))).toBe('first value');
    fill(p, a);
    // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design T10): the 64 KB turn history no longer makes room by dropping an old field's history (that withheld
    // the field when it was written again, for size). The history is kept, the new value is scanned joined to it, and shown.
    const reuse = p.consume(a, batch('second value', OLD));
    expect(reuse.masked).toBe(false);
    expect(reuse.exhausted).toBe(false);
    expect(reuse.operations).toHaveLength(1);
    expect(reuse.operations[0]).toMatchObject({ op: 'append', text: 'second value', path: 'preview.0.value', stream: OLD });
    expect(shown(p.consume(a, batch('next field', 'item-next:other:title', 'title')))).toBe('next field');
    expect(shown(p.consume(a, batch('newest result', 'item-19:other:preview.0.value')))).toBe('newest result');
  });

  it('history.secret-split-across-one-field-is-never-shown', () => {
    // Control (the join latch on a kept history): a label and its value in two writes of the same field;
    // neither half is a hit alone (asserted), only the join is.
    const lone = fresh();
    expect(lone.p.consume(lone.a, batch(': hunter2-fixture-value', 'item-lone:other:preview.0.value')).masked).toBe(false);
    const kept = fresh();
    expect(kept.p.consume(kept.a, batch('**password**', OLD)).masked).toBe(false);
    const joined = kept.p.consume(kept.a, batch(': hunter2-fixture-value', OLD));
    expect(joined.masked).toBe(true);
    expect(JSON.stringify(joined.operations)).not.toContain('hunter2');
    // The same split once the label's history made room: the value is still not shown.
    const { p, a } = fresh();
    expect(p.consume(a, batch('**password**', OLD)).masked).toBe(false);
    fill(p, a);
    const late = p.consume(a, batch(': hunter2-fixture-value', OLD));
    expect(JSON.stringify(late.operations)).not.toContain('hunter2');
    expect(late.operations[0]).toMatchObject({ op: 'omit', text: MARK });
  });

  it('history.secret-in-one-value-after-the-history-is-full-still-latches', () => {
    const { p, a } = fresh();
    fill(p, a);
    const hit = p.consume(a, batch('**password**: hunter2', 'item-19:other:preview.0.value'));
    expect(hit.masked).toBe(true);
    expect(JSON.stringify(hit.operations)).not.toContain('hunter2');
    expect(shown(p.consume(a, batch('anything', 'item-after:other:title', 'title')))).not.toContain('anything');
  });

  it('owner-long-turn.secret-after-a-long-streamed-turn-still-masks', () => {
    // The mandatory long turn above (history full, old fields dropped), then a real credential: masked.
    const { bus, source, seen } = ownerTurn();
    for (let round = 0; round < 30; round++) {
      for (let k = 0; k < 4; k++) bus.publish(ev({ type: 'item.started', itemType: 'tool', origin: 'engine', itemId: `s-${round}-${k}`, title: 'Fetch page', input: { url: `https://site-${round}-${k}.example/`, prompt: 'list the contact email' } }), source);
      for (let k = 0; k < 4; k++) bus.publish(ev({ type: 'item.completed', itemType: 'tool', itemId: `s-${round}-${k}`, ok: true, detail: 'Fetched', result: { status: 200, text: `Contact page ${round}-${k}` } }), source);
      bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: `note-${round}`, text: `Round ${round}: four pages read, ${'notes '.repeat(400)}done` }), source);
    }
    expect(bus.collector.masked(source)).toBe(false);
    const before = seen.length;
    bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'leak', text: '**password**:' }), source);
    bus.publish(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'leak-2', text: 'fixture private value' }), source);
    expect(JSON.stringify(seen.slice(before))).not.toContain('fixture private value');
    expect(bus.collector.masked(source)).toBe(true);
    expect(bus.collector.maskedBySecret(source)).toBe(true);
  });
});
