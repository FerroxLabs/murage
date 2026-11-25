// cause22 GROUP E (b) witnesses (lane cause22-redact; owner of this file: lane cause22-redact). MAIN-RULING 2026-11-22T17:47:36Z
// cause22-E-remainder (b) + MAIN-RULING 17:58:19Z (build designs/REDACT-AUDIENCE-1021.md): a turn of any size is shown to its
// audience as its real text with secrets redacted; size never decides what is shown. SAFETY FLOOR: no unscanned byte is released.
// Entry point (design section 7, P2): a fake adapter registered with a real EventBus through bus.attach (bus.ts:313); every event
// goes in through the bus's own adapter.onEvent listener (bus.ts:320), so the charge, the stamp, publish, the real
// RuntimeAudienceCollector and the real createTurnTextPolicy all run. Output is read from bus.subscribeAudience.
//   A1 streamed 20 MiB reply (design rows C3, C4, T10, T12)      A2 snapshot-only 20 MiB reply (T5, T8, S5, C6, C11)
//   A4 one 20 MiB line, snapshot only (T2, X1)                    B1 a raw secret in a 20 MiB reply never shows (KEEP-GREEN guard)
//   A16 the stored row read exit (transcript-page.ts sanitizeBotDisplayMessage, the function every transcript page read returns a
//   bot row through; design X5-X7): a stored 20 MiB reply and a row with 30,000 preview fields read back whole; a key stays masked
//   A12 one 20 MiB delta; A2/A12 also bound the longest event-loop block (MAIN-RULING 17:58:19Z), A4 measures the one-line case
//   Q4 browser tool output (browser-output-redaction.ts redactPageOutput, sanitizeRawHtml; MAIN-RULING 17:58:19Z Q4, 18:02:24Z): 20 MiB
//   of page text comes back whole with its card number hidden, and a hidden field past 4 MiB is removed, not passed through unchecked
//   A0 control: a small clean reply is shown and not masked (green before the fix too, so a RED A row is not a harness fault)
//   B4/B5/B6 SAFETY FLOOR (MAIN-RULING 17:58:19Z Q2, design 5.4/5.5): a chunk the scanner cannot finish (B4 exhausted, B5 throws)
//   withholds the rest of its own chain under one marker, each later item of that chain shows one marker, and every other
//   chain, tool row and the turn end keep showing; B6 an unscannable whole field is withheld alone. The scanner fault is injected
//   into the real policy through the bus's own constructor parameter (bus.ts EventBus(appendLog, policy)); policy, collector and
//   bus are the real ones. The turn is not masked and not marked secret, and the bus reports it as withheld (FABLE design H1).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AudienceEmission, RuntimeEvent } from '../contracts.ts';
import { EventBus } from './bus.ts';
import { createTurnTextPolicy } from '../redact-turn.ts';
import { scanTurnText } from '../redact.ts';
import { sanitizeBotDisplayMessage } from '../transcript-page.ts';
import { redactPageOutput, sanitizeRawHtml } from '../browser-output-redaction.ts';
import { ownerReplyText, REPLY_WITHHELD } from '../owner-display.ts';
import type { Scanner } from '../redact-stream-release.ts';

const M20 = 20 * 1024 * 1024;
const base = { provider: 'fake', threadId: 'thread', createdAt: 'provider-time' };
let seq = 0;
const ev = (fields: object): RuntimeEvent => ({ ...base, eventId: `provider-event-${++seq}`, ...fields }) as RuntimeEvent;

/** n characters of distinct numbered lines, so a dropped, repeated or reordered chunk changes the text. */
function PROSE(n: number): string {
  const parts: string[] = []; let size = 0;
  for (let i = 0; size < n; i++) { const line = `line ${String(i).padStart(7, '0')} the quick brown fox jumps over the lazy dog\n`; parts.push(line); size += line.length; }
  return parts.join('').slice(0, n - 1) + '\n';
}
/** n characters of space-separated numbered words, no LF. */
function ONE_LINE(n: number): string {
  const parts: string[] = []; let size = 0;
  for (let i = 0; size < n; i++) { const word = `w${i} `; parts.push(word); size += word.length; }
  return parts.join('').slice(0, n);
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** EQ without printing the text: length, sha256 and the first differing index. */
function same(actual: string | undefined, expected: string) {
  let at = -1;
  if (actual !== undefined && actual !== expected) { at = 0; while (at < actual.length && actual[at] === expected[at]) at++; }
  return { length: actual?.length ?? -1, sha: actual === undefined ? 'none' : sha(actual), firstDiff: at };
}
const want = (expected: string) => ({ length: expected.length, sha: sha(expected), firstDiff: -1 });

const MARK = '«redacted»';
function turn(scan?: Scanner) {
  const bus = scan ? new EventBus(() => {}, createTurnTextPolicy({ scan, separateItemRegions: true }) as unknown as ConstructorParameters<typeof EventBus>[1]) : new EventBus(() => {}); bus.omitLog(() => true);
  let listener: ((event: RuntimeEvent, source?: unknown) => void) | undefined;
  bus.attach([{ instanceId: 'engine', driverKind: 'fake', adapter: { onEvent: (fn: (event: RuntimeEvent, source?: unknown) => void) => { listener = fn; return () => { listener = undefined; }; } } }] as never);
  const source = bus.admitNewTurn('engine', 'thread');
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false });
  // The bus hands its own (stamped) copy of each event to execution listeners; the mask facts are keyed by that copy.
  const delivered: RuntimeEvent[] = [];
  bus.subscribeExecution(e => { delivered.push(e); }, { durable: false });
  const masked = () => delivered.filter(e => bus.audienceMaskedFor(e));
  const send = (event: RuntimeEvent) => { listener!(event, source); };
  /** A long text is taken in chunk by chunk with the event loop running in between: wait until the bus has taken it all in. */
  const idle = async () => { await (bus as unknown as { intakeIdle?: () => Promise<void> }).intakeIdle?.(); };
  return { bus, seen, masked, send, delivered, idle };
}
const completedText = (seen: AudienceEmission[], itemType = 'assistant_text') => seen.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === itemType ? [(row.event as { text: string }).text] : []);
const omitted = (seen: AudienceEmission[]) => seen.filter(row => row.event.type === 'audience.omitted').length;
/** What a live viewer saw streamed: every content.delta of the turn joined in order (a repeated or dropped chunk changes it). */
const streamedText = (seen: AudienceEmission[]) => seen.flatMap(row => row.event.type === 'content.delta' ? [(row.event as { delta: string }).delta] : []).join('');
/** The longest time the event loop could not run while `run` was in flight (a 5 ms timer that is late by that much). */
async function longestBlock(run: () => Promise<void>): Promise<number> {
  let last = performance.now(), longest = 0;
  const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; };
  const timer = setInterval(tick, 5);
  try { await run(); tick(); } finally { clearInterval(timer); }
  return longest;
}
/** MAIN-RULING 2026-11-22T17:58:19Z: "if it blocks over 250 ms, yield between line-safe chunks (setImmediate) in this build". */
const BLOCK_LIMIT_MS = 250;
/** The bound used by the rows below: 250 ms on a machine that scans 4 MiB of these lines in about 200 ms (the remote test boxes
 * when idle). A loaded shared box is slower by some factor, so the bound grows by that same measured factor and is never under
 * 250 ms. Without the yield one 20 MiB reply blocks for 30 times that scan, so the row still fails by a wide margin. */
function blockLimit(): number {
  const sample = PROSE(4 * 1024 * 1024), from = performance.now();
  scanTurnText(sample, { perChar: 64 });
  return Math.max(BLOCK_LIMIT_MS, BLOCK_LIMIT_MS * (performance.now() - from) / 200);
}

describe('cause22 GROUP E (b): a 20 MiB turn is shown as its real text (real EventBus listener, collector and turn policy)', () => {
  it('A0 control: a small clean reply is shown, every event of the turn is delivered and none is masked', () => {
    const { seen, masked, send, delivered } = turn();
    const text = PROSE(2048);
    send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text }));
    send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
    send(ev({ type: 'turn.completed', ok: true }));
    expect(same(completedText(seen).at(-1), text)).toEqual(want(text));
    expect(omitted(seen)).toBe(0);
    expect(delivered.map(e => e.type)).toEqual(['content.delta', 'item.completed', 'turn.completed']);
    expect(masked()).toHaveLength(0);
  });

  it('A1 a streamed 20 MiB reply shows whole', () => {
    const { seen, masked, send } = turn();
    const text = PROSE(M20), limit = blockLimit();
    let slowest = 0;
    const timed = (event: RuntimeEvent) => { const from = performance.now(); send(event); slowest = Math.max(slowest, performance.now() - from); };
    for (let at = 0; at < text.length; at += 8192) timed(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text.slice(at, at + 8192) }));
    timed(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
    timed(ev({ type: 'turn.completed', ok: true }));
    console.info(`EVENT-LOOP A1 streamed 20 MiB in 8 KiB deltas: slowest single event ${Math.round(slowest)} ms`);
    expect(same(completedText(seen).at(-1), text)).toEqual(want(text));
    expect(same(streamedText(seen), text)).toEqual(want(text));
    expect(slowest).toBeLessThan(limit);
    expect(omitted(seen)).toBe(0);
    expect(masked()).toHaveLength(0);
  }, 300_000);

  it('A2 a snapshot-only 20 MiB reply shows whole, and the event loop keeps running while it is scanned', async () => {
    const { seen, masked, send, idle, delivered } = turn();
    const text = PROSE(M20), limit = blockLimit();
    const blocked = await longestBlock(async () => {
      send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
      send(ev({ type: 'turn.completed', ok: true })); // arrives while the reply is still being taken in: it must wait its turn
      await idle();
    });
    expect(same(completedText(seen).at(-1), text)).toEqual(want(text));
    expect(same(streamedText(seen), text)).toEqual(want(text));
    expect(omitted(seen)).toBe(0);
    expect(masked()).toHaveLength(0);
    expect(seen.at(-1)!.event.type).toBe('turn.completed');
    expect(delivered.at(-1)!.type).toBe('turn.completed');
    console.info(`EVENT-LOOP A2 snapshot-only 20 MiB of lines: longest block ${Math.round(blocked)} ms over ${delivered.length - 2} chunks (bound ${Math.round(limit)} ms)`);
    expect(blocked).toBeLessThan(limit);
  }, 300_000);

  it('A12 one 20 MiB delta of lines shows whole, and the event loop keeps running while it is scanned', async () => {
    const { seen, masked, send, idle } = turn();
    const text = PROSE(M20), limit = blockLimit();
    const blocked = await longestBlock(async () => {
      send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text }));
      send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
      send(ev({ type: 'turn.completed', ok: true }));
      await idle();
    });
    expect(same(completedText(seen).at(-1), text)).toEqual(want(text));
    expect(same(streamedText(seen), text)).toEqual(want(text));
    expect(omitted(seen)).toBe(0);
    expect(masked()).toHaveLength(0);
    console.info(`EVENT-LOOP A12 one 20 MiB delta of lines: longest block ${Math.round(blocked)} ms`);
    expect(blocked).toBeLessThan(limit);
  }, 300_000);

  // One line has no line-safe place to stop (a split line could hide a secret, design 5.1), so it is one scan: the block is
  // MEASURED and logged here, not bounded. Reported to MAIN as open (a resumable scanner is needed to yield inside a line).
  it('A4 one 20 MiB line with no LF, snapshot only, shows whole', async () => {
    const { seen, masked, send, idle } = turn();
    const text = ONE_LINE(M20);
    const blocked = await longestBlock(async () => {
      send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
      send(ev({ type: 'turn.completed', ok: true }));
      await idle();
    });
    console.info(`EVENT-LOOP A4 one 20 MiB line (no line end): longest block ${Math.round(blocked)} ms`);
    expect(same(completedText(seen).at(-1), text)).toEqual(want(text));
    expect(omitted(seen)).toBe(0);
    expect(masked()).toHaveLength(0);
  }, 300_000);

  it('B1 a raw secret in a 20 MiB reply never shows, first chunk or last line (KEEP-GREEN)', () => {
    for (const where of ['first', 'last'] as const) {
      const { seen, send } = turn();
      const canary = `fixture-canary-${where}-Zq81Lw4Hd`;
      const body = PROSE(M20);
      const text = where === 'first' ? `**api_key:** ${canary}\n${body}` : `${body}**api_key:** ${canary}`;
      let checked = 0;
      for (let at = 0; at < text.length; at += 8192) {
        send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text.slice(at, at + 8192) }));
        // CAN after every event: every new emission is checked once.
        for (; checked < seen.length; checked++) expect(JSON.stringify(seen[checked].event).includes(canary), `${where} at ${at}`).toBe(false);
      }
      send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
      send(ev({ type: 'turn.completed', ok: true }));
      expect(completedText(seen).some(t => t.includes(canary)), where).toBe(false);
    }
  }, 600_000);

  it('A16 a stored 20 MiB reply row and a row with 30,000 preview fields read back whole; a stored key is still masked', () => {
    const text = PROSE(M20);
    const read = sanitizeBotDisplayMessage({ id: 'row-1', role: 'bot', kind: 'text', text }, { authorship: 'bot' });
    expect(same(read.text as string, text)).toEqual(want(text));
    const preview = Array.from({ length: 30_000 }, (_, i) => ({ key: `field ${i}`, value: `value ${i}` }));
    const wide = sanitizeBotDisplayMessage({ id: 'row-2', role: 'bot', kind: 'activity', tool: { name: 'search', preview } }, { authorship: 'bot' });
    const shown = (wide.tool as { preview?: { key: string; value: string }[] } | undefined)?.preview;
    expect({ rows: shown?.length, last: shown?.at(-1) }).toEqual({ rows: 30_000, last: { key: 'field 29999', value: 'value 29999' } });
    const canary = 'FIXTUREVALUE' + '778899';
    const leak = sanitizeBotDisplayMessage({ id: 'row-3', role: 'bot', kind: 'text', text: `${text}api_key=${canary}\n` }, { authorship: 'bot' });
    expect(JSON.stringify(leak).includes(canary)).toBe(false);
    expect(String(leak.text).startsWith(text.slice(0, 4096))).toBe(true);
  }, 300_000);

  it('Q4 20 MiB of page text is cleaned and returned whole; a hidden field past 4 MiB of markup is removed, not passed through', () => {
    const line = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet\n';
    const body = line.repeat(Math.ceil(M20 / line.length));
    const out = redactPageOutput(`${body}card 4111 1111 1111 1111\n`);
    expect(same(out.slice(0, body.length), body)).toEqual(want(body));
    expect(out.includes('4111')).toBe(false);
    const canary = 'fixture-hidden-field-Vt52Kp8Wn';
    const page = `<p>${line.repeat(Math.ceil((5 * 1024 * 1024) / line.length))}</p><input type="hidden" name="session" value="${canary}"><p>the end of the page</p>`;
    const html = sanitizeRawHtml(page);
    expect(html.includes(canary)).toBe(false);
    expect(html.includes('the end of the page')).toBe(true);
    const text = redactPageOutput(page);
    expect({ leak: text.includes(canary), end: text.includes('the end of the page') }).toEqual({ leak: false, end: true });
  }, 300_000);

  // ---- SAFETY FLOOR ----
  const SENTINEL = 'unscannable-fixture-sentinel';
  const faults: Record<string, Scanner> = {
    'B4 the scan of one chunk exhausts its work': (text, o) => text.includes(SENTINEL) ? { text, detected: false, exhausted: true, workUnits: 0, candidates: [] } : scanTurnText(text, o),
    'B5 the scanner throws on one chunk': (text, o) => { if (text.includes(SENTINEL)) throw new Error('scanner fault'); return scanTurnText(text, o); },
  };
  for (const [name, scan] of Object.entries(faults)) it(`${name}: the rest of that chain is withheld under one marker, a later item of the chain shows one marker, everything else shows`, () => {
    const { bus, seen, masked, send, delivered } = turn(scan);
    const canary = 'fixture-canary-floor-Rk27Mx9Qa';
    const before = PROSE(1024 * 1024);
    const text = `${before}this line holds the ${SENTINEL} word\n**password:** ${canary}\n${PROSE(65_536)}`;
    const cut = before.length + `this line holds the ${SENTINEL} word\n**password:** `.length; // a delta ends right after the label
    let checked = 0;
    const can = (at: string) => { for (; checked < seen.length; checked++) expect(JSON.stringify(seen[checked].event).includes(canary), at).toBe(false); };
    const say = (event: RuntimeEvent, at: string) => { send(event); can(at); };
    const think = 'first the plan is weighed, in plain words\n', think2 = 'then the answer is checked once more\n';
    say(ev({ type: 'content.delta', streamKind: 'reasoning_text', itemId: 'think', delta: think }), 'think');
    const bounds = [0]; for (let at = 8192; at < cut; at += 8192) bounds.push(at); bounds.push(cut); for (let at = cut + 8192; at < text.length; at += 8192) bounds.push(at); bounds.push(text.length);
    for (let i = 0; i + 1 < bounds.length; i++) say(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text.slice(bounds[i], bounds[i + 1]) }), `reply delta ${i}`);
    say(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }), 'reply done');
    const later = 'A later clean item of the same chain.\n';
    say(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply-2', delta: later }), 'later delta');
    say(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply-2', text: later }), 'later done');
    say(ev({ type: 'item.completed', itemType: 'tool', itemId: 'tool-7', ok: true, detail: 'Found listing 7', result: { title: 'Listing 7' } }), 'tool');
    say(ev({ type: 'content.delta', streamKind: 'reasoning_text', itemId: 'think-2', delta: think2 }), 'think 2');
    say(ev({ type: 'turn.completed', ok: true }), 'end');
    const replies = completedText(seen);
    expect(replies).toHaveLength(2);
    // (1)+(2) the reply shows its real words up to a line end before the unscannable chunk, then exactly one marker
    const shown = replies[0]!, kept = shown.slice(0, -MARK.length);
    expect(shown.endsWith(MARK) && shown.split(MARK).length === 2, 'one marker at the end of the reply').toBe(true);
    const where = `kept ${kept.length} of ${before.length}, replies ${replies.map(r => r.length).join('/')}, masked ${masked().length}, omitted ${omitted(seen)}, emissions ${seen.length}`;
    expect({ realPrefix: text.startsWith(kept), endsAtLine: kept.endsWith('\n'), stopsBefore: kept.length <= before.length, reaches: kept.length > before.length - 16_384 }, where)
      .toEqual({ realPrefix: true, endsAtLine: true, stopsBefore: true, reaches: true });
    // the streamed view agrees with the completed row: the same words, one marker, nothing after it
    const streamed = seen.flatMap(row => row.event.type === 'content.delta' && (row.event as { itemId?: string }).itemId === (seen.find(r => r.event.type === 'item.completed' && (r.event as { text?: string }).text === shown)!.event as { itemId: string }).itemId ? [(row.event as { delta: string }).delta] : []).join('');
    expect(same(streamed, shown)).toEqual(want(shown));
    // (4) the later item of the BLIND chain is one marker
    expect(replies[1]).toBe(MARK);
    // (5) the other chain and the tool row show their real text, before and after the withheld chunk
    const reasoning = seen.flatMap(row => row.event.type === 'content.delta' && (row.event as { streamKind?: string }).streamKind === 'reasoning_text' ? [(row.event as { delta: string }).delta] : []);
    expect(reasoning.join('')).toBe(think + think2);
    expect(seen.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'tool' ? [(row.event as { detail?: string }).detail] : [])).toEqual(['Found listing 7']);
    // (6) the turn is not masked and not marked as holding a secret; (7) its end is shown
    expect(omitted(seen)).toBe(0);
    expect(masked().map(e => e.type)).toEqual([]);
    expect(delivered.some(e => bus.audienceSecretMaskedFor(e))).toBe(false);
    expect(seen.at(-1)!.event.type).toBe('turn.completed');
    // MAIN-RULING 18:02:24Z (1): the owner fallback (owner-display.ts ownerReplyText, wired at index.ts with the same two bus facts)
    // does not show the owner the RAW words of a later item of the BLIND chain, although those words scan clean on their own.
    const laterEvent = delivered.find(e => e.type === 'item.completed' && (e as { itemId?: string }).itemId === 'reply-2')!;
    expect(ownerReplyText(replies[1], later, true, () => bus.audienceSecretMaskedFor(laterEvent) || bus.audienceWithheldFor(laterEvent))).toBe(REPLY_WITHHELD);
    // FABLE design H1: raw readers are told this turn withheld unscanned text, from the withheld chunk on and not before
    const flags = delivered.map(e => bus.audienceWithheldFor(e));
    expect({ first: flags[0], atEnd: flags.at(-1), tool: flags[delivered.findIndex(e => (e as { itemId?: string }).itemId === 'tool-7')] }).toEqual({ first: false, atEnd: true, tool: true });
  }, 300_000);

  it('B6 an unscannable whole field is withheld alone: the same row keeps its other fields and the turn goes on', () => {
    const { bus, seen, masked, send, delivered } = turn(faults['B4 the scan of one chunk exhausts its work']);
    send(ev({ type: 'item.completed', itemType: 'tool', itemId: 'tool-1', ok: true, detail: `detail with the ${SENTINEL} word`, result: { title: 'Listing 1' } }));
    send(ev({ type: 'item.completed', itemType: 'tool', itemId: 'tool-2', ok: true, detail: 'Found listing 2', result: { title: 'Listing 2' } }));
    const reply = 'The reply after the tool rows.\n';
    send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: reply }));
    send(ev({ type: 'turn.completed', ok: true }));
    const tools = seen.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'tool' ? [row.event as { detail?: string }] : []);
    expect(tools.map(t => t.detail)).toEqual([MARK, 'Found listing 2']);
    expect(JSON.stringify(tools[0])).toContain('Listing 1');
    expect(JSON.stringify(seen.map(row => row.event)).includes(SENTINEL)).toBe(false);
    expect(completedText(seen)).toEqual([reply]);
    expect(omitted(seen)).toBe(0);
    expect(masked()).toHaveLength(0);
    expect(delivered.map(e => bus.audienceWithheldFor(e))).toEqual([true, true, true, true]);
  });
});
