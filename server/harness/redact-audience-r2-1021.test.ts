// cause22 GROUP E (b), round 2 witnesses (owner of this file: lane cause22-redact-fable). They close the Highs of the three BLOCKs
// on 0489638c7a (ASTRA, FABLE, OPUS) under MAIN-RULING 2026-11-22T17:47:36Z (b), 17:58:19Z (Q1, Q3, Q4) and 18:02:24Z.
//   R1-R5 NEVER-UNREDACTED floor in browser output (browser-output-redaction.ts): no walk stops early and returns the rest as it
//     came. R1 node count, R2 depth, R5 a tree too deep to serialize: the exit functions redactPageOutput / sanitizeRawHtml (the
//     browser read tool refuses such a page earlier, browser-extension-engine-read.ts inspectReadHtml; the activity log, the action
//     checker and the service pass page markup straight in). R3 long attribute and R4 long URL: through the browser read tool
//     itself (readWithBrowserAuthority, the production entry of a page read).
//   C5 (Q3) tool input and tool result are shown whole, C8 display lists of any length, C9 a key of any length, C7 a deep preview
//     withholds its own subtree: none of them masks the turn. Entry: the bus's own adapter listener (EventBus.attach).
//   Q1 a label whose value is exactly one counted marker is complete in turn mode: streamed and unstreamed; a fake stays a finding.
//   B9 a detach or a replacement while a long reply is still being taken in drops nothing; B10 another thread does not wait.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AudienceEmission, RuntimeEvent } from '../contracts.ts';
import { EventBus } from './bus.ts';
import { PREVIEW_TOO_DEEP } from './audience-collector.ts';
import { redactPageOutput, sanitizeRawHtml, HIDDEN } from '../browser-output-redaction.ts';
import { readWithBrowserAuthority, type EngineReadContext, type EngineReadOptions } from '../browser-extension-engine-read.ts';

const base = { provider: 'fake', threadId: 'thread', createdAt: 'provider-time' };
let seq = 0;
const ev = (fields: object): RuntimeEvent => ({ ...base, eventId: `provider-event-${++seq}`, ...fields }) as RuntimeEvent;
function PROSE(n: number): string {
  const parts: string[] = []; let size = 0;
  for (let i = 0; size < n; i++) { const line = `line ${String(i).padStart(7, '0')} the quick brown fox jumps over the lazy dog\n`; parts.push(line); size += line.length; }
  return parts.join('').slice(0, n - 1) + '\n';
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function same(actual: string | undefined, expected: string) {
  let at = -1;
  if (actual !== undefined && actual !== expected) { at = 0; while (at < actual.length && actual[at] === expected[at]) at++; }
  return { length: actual?.length ?? -1, sha: actual === undefined ? 'none' : sha(actual), firstDiff: at };
}
const want = (expected: string) => ({ length: expected.length, sha: sha(expected), firstDiff: -1 });
type Listener = (event: RuntimeEvent, source?: unknown) => void;
function fakeAdapter() {
  let listener: Listener | undefined;
  return { adapter: { onEvent: (fn: Listener) => { listener = fn; return () => { listener = undefined; }; } }, emit: (event: RuntimeEvent, source?: unknown) => listener?.(event, source), live: () => listener !== undefined };
}
function turn() {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const engine = fakeAdapter();
  bus.attach([{ instanceId: 'engine', driverKind: 'fake', adapter: engine.adapter }] as never);
  const source = bus.admitNewTurn('engine', 'thread');
  const seen: AudienceEmission[] = [];
  bus.subscribeAudience(e => seen.push(e), { durable: false });
  const delivered: RuntimeEvent[] = [];
  bus.subscribeExecution(e => { delivered.push(e); }, { durable: false });
  const masked = () => delivered.filter(e => bus.audienceMaskedFor(e));
  const send = (event: RuntimeEvent) => { engine.emit(event, source); };
  const idle = async () => { await (bus as unknown as { intakeIdle?: () => Promise<void> }).intakeIdle?.(); };
  return { bus, seen, masked, send, delivered, idle, engine, source };
}
const completedText = (seen: AudienceEmission[]) => seen.flatMap(row => row.event.type === 'item.completed' && (row.event as { itemType?: string }).itemType === 'assistant_text' ? [(row.event as { text: string }).text] : []);
const omitted = (seen: AudienceEmission[]) => seen.filter(row => row.event.type === 'audience.omitted').length;
type Preview = { key: string; value: string }[];
const previewOf = (seen: AudienceEmission[], type: string, itemType = 'tool') => (seen.find(row => row.event.type === type && (row.event as { itemType?: string }).itemType === itemType)?.event as { preview?: Preview } | undefined)?.preview ?? [];

const ORIGIN = 'https://docs.test';
function reader(html: string) {
  const context: EngineReadContext = { currentUrl: ORIGIN + '/docs', activeHtml: async () => html, admitUrl: async () => {}, authorize: () => true, fetch: (async () => new Response('missing', { status: 404 })) as typeof fetch };
  return async (options: EngineReadOptions) => String((await readWithBrowserAuthority(options, context)).structuredContent.content);
}

describe('cause22 GROUP E (b) round 2: browser output never returns unchecked markup (NEVER-UNREDACTED floor)', () => {
  const END = 'the end of the page';
  it('R1 a page of more than 400,000 nodes: a hidden field anywhere in it is removed and the page is still returned', () => {
    const first = 'fixture-hidden-first-Bq61Zt', last = 'fixture-hidden-last-Wd83Lm';
    const page = `<input type="hidden" name="row" value="${first}">${'<i>x</i>'.repeat(210_000)}<input type="hidden" name="row" value="${last}"><p>${END}</p>`;
    const html = sanitizeRawHtml(page), text = redactPageOutput(page);
    expect({ first: html.includes(first), last: html.includes(last) }).toEqual({ first: false, last: false });
    expect({ first: text.includes(first), last: text.includes(last) }).toEqual({ first: false, last: false });
    expect({ html: html.includes(END), text: text.includes(END) }).toEqual({ html: true, text: true });
  }, 300_000);

  it('R2 a field nested 1,100 elements deep is removed and the page is still returned', () => {
    const canary = 'fixture-hidden-deep-Jx47Rn';
    const page = `${'<div>'.repeat(1_100)}<input type="hidden" name="row" value="${canary}"><p>${END}</p>${'</div>'.repeat(1_100)}`;
    const html = sanitizeRawHtml(page), text = redactPageOutput(page);
    expect({ html: html.includes(canary), text: text.includes(canary) }).toEqual({ html: false, text: false });
    expect({ html: html.includes(END), text: text.includes(END) }).toEqual({ html: true, text: true });
  }, 300_000);

  it('R3 an attribute longer than 4,000 characters is cleaned like a short one (browser read tool, raw page)', async () => {
    const canary = 'fixtureplainvalueKc29Vy';
    const title = `${'plain words in a long tooltip '.repeat(140)}password: &quot;${canary}&quot;`; // a quoted value: only the decoded attribute shows it as one
    expect(title.length).toBeGreaterThan(4_000);
    const content = await reader(`<h1>Active page</h1><p title="${title}">Current document</p><p>${END}</p>`)({ raw: true });
    expect(content.includes(canary)).toBe(false);
    expect({ end: content.includes(END), start: content.includes('plain words in a long tooltip') }).toEqual({ end: true, start: true });
  }, 300_000);

  it('R4 a URL longer than 4,096 characters is cleaned whole (browser read tool, page text)', async () => {
    const canary = 'fixtureplainsegmentTm58Gh';
    const url = `${ORIGIN}/${'ab/'.repeat(1_400)}password/${canary}`;
    expect(url.length).toBeGreaterThan(4_096);
    const content = await reader(`<h1>Active page</h1><p>see ${url} for more</p><p>${END}</p>`)({});
    expect(content.includes(canary)).toBe(false);
    expect({ end: content.includes(END), start: content.includes(`${ORIGIN}/ab/ab/`) }).toEqual({ end: true, start: true });
  }, 300_000);

  it('R5 a tree too deep to walk or serialize is withheld whole, never passed through', () => {
    const canary = 'fixture-hidden-abyss-Pn36Fs';
    const page = `${'<div>'.repeat(20_000)}<input type="hidden" name="row" value="${canary}"><p>${END}</p>`;
    const html = sanitizeRawHtml(page), text = redactPageOutput(page);
    expect({ html: html.includes(canary), text: text.includes(canary) }).toEqual({ html: false, text: false });
    // either the cleaned page (the walk finished) or the fixed marker (it could not): nothing in between
    expect({ html: html === HIDDEN || html.includes(END), text: text === HIDDEN || text.includes(END) }).toEqual({ html: true, text: true });
  }, 300_000);
});

describe('cause22 GROUP E (b) round 2: tool rows and display lists are shown whole and never mask the turn (real EventBus listener)', () => {
  const REPLY = 'The reply after the tool rows.\n';
  const finish = (t: ReturnType<typeof turn>) => {
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: REPLY }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    return { replies: completedText(t.seen), omitted: omitted(t.seen), masked: t.masked().length, end: t.seen.at(-1)!.event.type };
  };
  const SHOWN = { replies: [REPLY], omitted: 0, masked: 0, end: 'turn.completed' };

  it('C5 a 300,000-character tool input and a 120-field tool result are shown whole (Q3: shortenForDisplay deleted)', () => {
    const t = turn();
    const content = PROSE(300_000);
    const result: Record<string, string> = {}; for (let i = 0; i < 120; i++) result[`field ${i}`] = `value ${i}`;
    t.send(ev({ type: 'item.started', itemType: 'tool', itemId: 'write-1', title: 'Write', input: { file_path: 'notes/big.txt', content } }));
    t.send(ev({ type: 'item.completed', itemType: 'tool', itemId: 'write-1', ok: true, detail: 'Wrote the file', result }));
    expect(same(previewOf(t.seen, 'item.started').find(p => p.key === 'content')?.value, content)).toEqual(want(content));
    const rows = previewOf(t.seen, 'item.completed');
    expect({ rows: rows.length, last: rows.at(-1) }).toEqual({ rows: 120, last: { key: 'field 119', value: 'value 119' } });
    expect(finish(t)).toEqual(SHOWN);
  }, 300_000);

  it('C8 a plan of 300 entries, 65 subtasks, 301 commands and 257 denials: every row is shown and the turn is not masked', () => {
    const t = turn();
    t.send(ev({ type: 'plan.updated', entries: Array.from({ length: 300 }, (_, i) => ({ content: `step ${i}`, status: 'pending' })) }));
    t.send(ev({ type: 'turn.subtask', subtasks: Array.from({ length: 65 }, (_, i) => ({ label: `subtask ${i}`, status: 'running' })) }));
    t.send(ev({ type: 'engine.commands', commands: Array.from({ length: 301 }, (_, i) => ({ name: `command-${i}`, description: `does thing ${i}` })) }));
    const plan = t.seen.find(row => row.event.type === 'plan.updated')?.event as { entries?: { content: string }[] } | undefined;
    const subtasks = t.seen.find(row => row.event.type === 'turn.subtask')?.event as { subtasks?: { label: string }[] } | undefined;
    expect({ entries: plan?.entries?.length, last: plan?.entries?.at(-1)?.content }).toEqual({ entries: 300, last: 'step 299' });
    expect({ subtasks: subtasks?.subtasks?.length, last: subtasks?.subtasks?.at(-1)?.label }).toEqual({ subtasks: 65, last: 'subtask 64' });
    expect({ omitted: omitted(t.seen), masked: t.masked().length }).toEqual({ omitted: 0, masked: 0 });
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: REPLY }));
    t.send(ev({ type: 'turn.completed', ok: false, denials: Array.from({ length: 257 }, (_, i) => `denied tool ${i}`) }));
    const end = t.seen.at(-1)!.event as { type: string; denials?: string[] };
    expect({ replies: completedText(t.seen), omitted: omitted(t.seen), masked: t.masked().length, end: end.type, denials: end.denials?.length, last: end.denials?.at(-1) })
      .toEqual({ replies: [REPLY], omitted: 0, masked: 0, end: 'turn.completed', denials: 257, last: 'denied tool 256' });
  });

  it('C9 a tool input key of 2,000 characters is shown and the turn is not masked', () => {
    const t = turn();
    const key = 'k'.repeat(2_000);
    t.send(ev({ type: 'item.started', itemType: 'tool', itemId: 'tool-1', title: 'Lookup', input: { [key]: 'value of the long key', plain: 'kept' } }));
    expect(previewOf(t.seen, 'item.started')).toEqual([{ key, value: 'value of the long key' }, { key: 'plain', value: 'kept' }]);
    expect(finish(t)).toEqual(SHOWN);
  });

  it('C7 a tool input nested 45 levels deep withholds that subtree under one plain line; its sibling and the turn are shown', () => {
    const t = turn();
    let deep: unknown = 'the innermost value'; for (let i = 0; i < 45; i++) deep = { d: deep };
    t.send(ev({ type: 'item.started', itemType: 'tool', itemId: 'tool-1', title: 'Lookup', input: { nested: deep, plain: 'kept' } }));
    const rows = previewOf(t.seen, 'item.started');
    expect({ rows: rows.length, deep: rows[0]?.value, sibling: rows[1] }).toEqual({ rows: 2, deep: PREVIEW_TOO_DEEP, sibling: { key: 'plain', value: 'kept' } });
    expect(JSON.stringify(t.seen.map(row => row.event)).includes('the innermost value')).toBe(false);
    expect(finish(t)).toEqual(SHOWN);
  });
});

describe('cause22 GROUP E (b) round 2 Q1: a label whose value is exactly one counted marker is complete in turn mode', () => {
  const TEXT = 'Here is the config that was read:\npassword: «redacted 12 chars»\n**api_key:** «redacted 8 chars»\n- token = «redacted 40 chars»\n`secret:` **«redacted 5 chars»**\nNothing else was changed.\n';
  const check = (t: ReturnType<typeof turn>) => ({ replies: completedText(t.seen), omitted: omitted(t.seen), masked: t.masked().length, secret: t.delivered.some(e => t.bus.audienceSecretMaskedFor(e)), end: t.seen.at(-1)!.event.type });
  const SHOWN = { replies: [TEXT], omitted: 0, masked: 0, secret: false, end: 'turn.completed' };

  it('Q1a streamed in 7-character deltas (the marker is split across deltas), a plain label: the reply is shown as it is', () => { const PLAIN = 'Here is the config that was read:\npassword: «redacted 12 chars»\ntoken = «redacted 40 chars»\nNothing else was changed.\n';
    const t = turn();
    for (let at = 0; at < PLAIN.length; at += 7) t.send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: PLAIN.slice(at, at + 7) }));
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: PLAIN }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    expect(check(t)).toEqual({ ...SHOWN, replies: [PLAIN] });
  });

  // ASTRA gatefix-1021-E ac41f003bb: streamed, a mark before the marker (`**«redacted 5 chars»**`) latched and masked the turn.
  // (A wrapped LABEL such as `**api_key:**` is still a finding at once when streamed: its value may arrive on another stream.)
  const WRAPPED = 'Here is the config that was read:\npassword: **«redacted 12 chars»**\ntoken = `«redacted 40 chars»`\napi_key:  ~~*«redacted 8 chars»*~~ \nNothing else was changed.\n';
  for (const size of [1, 5, 7]) it(`Q1d streamed in ${size}-character deltas, a plain label, emphasis around the marker: the reply is shown as it is`, () => {
    const t = turn();
    for (let at = 0; at < WRAPPED.length; at += size) t.send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: WRAPPED.slice(at, at + size) }));
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: WRAPPED }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    expect(check(t)).toEqual({ ...SHOWN, replies: [WRAPPED] });
  });

  it('Q1b unstreamed (one completed item): the reply is shown as it is', () => {
    const t = turn();
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text: TEXT }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    expect(check(t)).toEqual(SHOWN);
  });

  const canary = 'fixtureplainvalueQd74Xb';
  const fakes: Record<string, string> = {
    'words after the marker': `password: «redacted 12 chars» ${canary}\n`,
    'a marker glued to the value': `password: «redacted 12 chars»${canary}\n`,
    'a marker that never closes': `**password:** «redacted 12 chars ${canary}\n`,
    'a count that is not a number': `password: «redacted ${canary} chars»\n`,
    'a second label after the marker': `password: «redacted 12 chars» token: ${canary}\n`,
    'a mark, then the value': `password: **${canary}**\n`,
  };
  for (const [name, line] of Object.entries(fakes)) for (const mode of ['unstreamed', 'streamed', 'streamed1'] as const) it(`Q1c ${name} (${mode}): the value is never shown`, () => {
    const t = turn();
    const text = `Read the file.\n${line}Done.\n`;
    if (mode !== 'unstreamed') for (let at = 0, size = mode === 'streamed' ? 5 : 1; at < text.length; at += size) t.send(ev({ type: 'content.delta', streamKind: 'assistant_text', itemId: 'reply', delta: text.slice(at, at + size) }));
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    expect(JSON.stringify(t.seen.map(row => row.event)).includes(canary)).toBe(false);
    expect(t.seen.at(-1)!.event.type).toBe('turn.completed');
    // A mark before a value that is not a counted marker is still the stream's finding (the turn latches), not only the release's.
    if (name === 'a mark, then the value' && mode !== 'unstreamed') expect(t.masked().length, 'streamed mark before a real value latches').toBeGreaterThan(0);
  });
});

describe('cause22 GROUP E (b) round 2: the chunked intake drops nothing and delays no other thread', () => {
  const M2 = 2 * 1024 * 1024;
  for (const how of ['detached', 'replaced by a new adapter'] as const) it(`B9 the engine is ${how} while its long reply is still being taken in: the reply and the turn end are still shown`, async () => {
    const t = turn();
    const text = PROSE(M2);
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
    t.send(ev({ type: 'turn.completed', ok: true }));
    if (how === 'detached') t.bus.detach(new Set(['engine']));
    else t.bus.attach([{ instanceId: 'engine', driverKind: 'fake', adapter: fakeAdapter().adapter }] as never);
    await t.idle();
    expect(same(completedText(t.seen)[0], text)).toEqual(want(text));
    expect({ omitted: omitted(t.seen), masked: t.masked().length, end: t.seen.at(-1)?.event.type }).toEqual({ omitted: 0, masked: 0, end: 'turn.completed' });
    // the old adapter is unsubscribed at once, and an event it emits after the detach is not taken
    expect(t.engine.live()).toBe(false);
  }, 300_000);

  it('B10 while one thread takes in a long reply, another thread is shown at once and in order', async () => {
    const t = turn();
    const other = fakeAdapter();
    t.bus.attach([{ instanceId: 'engine-2', driverKind: 'fake', adapter: other.adapter }] as never);
    const source2 = t.bus.admitNewTurn('engine-2', 'thread-2');
    const text = PROSE(M2), quick = 'A short reply on the other thread.\n';
    t.send(ev({ type: 'item.completed', itemType: 'assistant_text', itemId: 'reply', text }));
    other.emit(ev({ threadId: 'thread-2', type: 'item.completed', itemType: 'assistant_text', itemId: 'quick', text: quick }), source2);
    // no await yet: the long reply is still in flight, the other thread's reply is already shown
    expect({ quick: completedText(t.seen), long: completedText(t.seen).includes(text) }).toEqual({ quick: [quick], long: false });
    t.send(ev({ type: 'turn.completed', ok: true }));
    await t.idle();
    expect(same(completedText(t.seen)[1], text)).toEqual(want(text));
    expect({ omitted: omitted(t.seen), masked: t.masked().length, end: t.seen.at(-1)?.event.type }).toEqual({ omitted: 0, masked: 0, end: 'turn.completed' });
  }, 300_000);
});

describe('cause22 GROUP E (b) round 2: markup the parser dropped is never returned (MAIN-RULING 2026-11-22T20:41:56Z redact-cutoff)', () => {
  it('R6 a duplicate attribute the parser drops is not handed back with the source (browser read tool, raw page, and the raw sanitizer)', async () => {
    const canary = 'fixtureCanaryHandlerYs61';
    const page = `<h1>Active page</h1><p onclick="" onclick="${canary}()">Current document</p><p>the end of the page</p>`;
    const content = await reader(page)({ raw: true });
    expect({ read: content.includes(canary), exit: sanitizeRawHtml(page).includes(canary), marker: [content.includes(HIDDEN), sanitizeRawHtml(page).endsWith(`\n${HIDDEN}`)] }).toEqual({ read: false, exit: false, marker: [true, true] }); // the dropped source is left out and the reader says so (the plain withheld marker)
    expect({ read: content.includes('the end of the page'), exit: sanitizeRawHtml(page).includes('Current document') }).toEqual({ read: true, exit: true });
  });
  it('R6 control: well-formed markup with nothing to remove comes back as it was', () => {
    const page = '<h1>Active page</h1><p>Current document</p>';
    expect({ raw: sanitizeRawHtml(`<!DOCTYPE html><html><head></head><body>${page}</body></html>`), text: redactPageOutput(page) }).toEqual({ raw: `<!DOCTYPE html><html><head></head><body>${page}</body></html>`, text: page });
  });
});

// MAIN-RULING 2026-11-22T21:44:35Z redact-parse-error (b): question, option and choice counts and the folderTrust / envInfo lists
// never throw and never mask the turn. A card list shows its first entries and folds the rest into ONE counted marker (a last line of
// a shown text field: never a list entry, so it has no handle and cannot be picked); a folded entry is still scanned (it can latch). Entry: the bus's own adapter listener.
describe('cause22 GROUP E (b) round 3: a count never masks the turn; the rest of a card list folds into one counted marker', () => {
  const opened = (seen: AudienceEmission[]) => seen.find(row => row.event.type === 'request.opened')?.event as { choices?: string[]; summary?: string; questions?: { handle: string; question: string; options: { handle: string; label: string }[] }[] } | undefined;
  const state = (t: ReturnType<typeof turn>) => ({ omitted: omitted(t.seen), masked: t.masked().length });
  it('N1 12 choices: the first 10 are shown and one counted marker ends the summary; the turn is not masked', () => {
    const t = turn();
    t.send(ev({ type: 'request.opened', requestType: 'permission', summary: 'Pick one', choices: Array.from({ length: 12 }, (_, i) => `choice ${i}`) }));
    expect({ choices: opened(t.seen)?.choices, summary: opened(t.seen)?.summary, ...state(t) })
      .toEqual({ choices: Array.from({ length: 10 }, (_, i) => `choice ${i}`), summary: 'Pick one\n«2 more not shown»', omitted: 0, masked: 0 });
  });
  it('N2 6 questions, one with 13 options: the card contract is shown with its own handles, the rest is one counted marker line each; the turn is not masked', () => {
    const t = turn();
    const questions = Array.from({ length: 6 }, (_, i) => ({ question: `question ${i}`, options: Array.from({ length: i === 0 ? 13 : 2 }, (_, j) => ({ label: `option ${i}.${j}` })) }));
    t.send(ev({ type: 'question.async', questions }));
    const card = (t.seen.find(row => row.event.type === 'question.async')?.event as ReturnType<typeof opened>)?.questions;
    expect({ questions: card?.map(q => q.question), handles: card?.map(q => q.handle), first: card?.[0]?.options.map(o => o.label), last: card?.[0]?.options.at(-1)?.handle, ...state(t) }).toEqual({
      questions: ['question 0\n«3 more not shown»', 'question 1', 'question 2', 'question 3\n«2 more not shown»'], handles: ['q.0', 'q.1', 'q.2', 'q.3'],
      first: Array.from({ length: 10 }, (_, j) => `option 0.${j}`), last: 'o.0.9', omitted: 0, masked: 0,
    });
  });
  it.each([
    ['folderTrust.sources', { folderTrust: { folder: 'work/project', sources: Array.from({ length: 300 }, (_, i) => `source ${i}`) } }],
    ['envInfo.names', { envInfo: { names: Array.from({ length: 300 }, (_, i) => `NAME_${i}`) } }],
    ['envInfo.absent', { envInfo: { absent: Array.from({ length: 300 }, (_, i) => `ABSENT_${i}`) } }],
    ['envInfo.shell', { envInfo: { shell: Array.from({ length: 300 }, (_, i) => `shell ${i}`) } }],
    ['envInfo.managedEnv', { envInfo: { managedEnv: Array.from({ length: 300 }, (_, i) => `MANAGED_${i}`) } }],
  ])('N3 %s of 300 entries: the request is shown and the turn is not masked', (_site, extra) => {
    const t = turn();
    t.send(ev({ type: 'request.opened', requestType: 'permission', summary: 'Allow this folder', ...extra }));
    expect({ summary: opened(t.seen)?.summary, ...state(t) }).toEqual({ summary: 'Allow this folder', omitted: 0, masked: 0 });
  });
  it('N4 a folded entry is still scanned: a secret in choice 12 is a finding, and its text is never shown', () => {
    const t = turn();
    const canary = 'fixtureFoldedValueHq27Lw';
    t.send(ev({ type: 'request.opened', requestType: 'permission', summary: 'Pick one', choices: [...Array.from({ length: 11 }, (_, i) => `choice ${i}`), `password: ${canary}`] }));
    expect({ leaked: JSON.stringify(t.seen.map(row => row.event)).includes(canary), secret: t.delivered.some(e => t.bus.audienceSecretMaskedFor(e)) }).toEqual({ leaked: false, secret: true });
  });
  it('N5 a list that is not shown is still scanned whole: a secret in folderTrust source 300 is a finding', () => {
    const t = turn();
    const canary = 'fixtureSourceValueJt52Nc';
    t.send(ev({ type: 'request.opened', requestType: 'permission', summary: 'Allow this folder', folderTrust: { folder: 'work/project', sources: [...Array.from({ length: 299 }, (_, i) => `source ${i}`), `password: ${canary}`] } }));
    expect({ leaked: JSON.stringify(t.seen.map(row => row.event)).includes(canary), secret: t.delivered.some(e => t.bus.audienceSecretMaskedFor(e)) }).toEqual({ leaked: false, secret: true });
  });
});
