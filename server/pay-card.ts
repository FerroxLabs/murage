// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Full-access pay and terms card (designs/PAYFULL-DESIGN-1024.md A4, A6, A7). Owners: this module, the executor's
// card gate and the service wiring = q1024-paybuild; the No limits lift = q1024-paynl; rulings = MAIN.
//
// One floor-classified step presented here ends in exactly one of: handoff (null: the caller's YOUR TURN text, byte for
// byte), denied, closed, expired, changed, pressed, uncertain, not-pressed. Every state change is saved (write, fsync,
// rename) BEFORE the next action; a save that fails ends the step with nothing pressed. A pass is issued only by the
// final check, after `spent` is on disk, for ONE call and ONE activation: one press is one payment.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CARDED_RULES, type PayStepAnswer } from './pay-owner-step.ts';
import type { FloorResult } from './browser-floor.ts';

export type PayState = 'waiting' | 'allowed' | 'spent' | 'pressed' | 'uncertain' | 'not-pressed' | 'denied' | 'expired' | 'closed' | 'changed';
const NEXT: Readonly<Record<PayState, readonly PayState[]>> = {
  waiting: ['allowed', 'denied', 'expired', 'closed', 'changed'],
  allowed: ['spent', 'denied', 'expired', 'closed', 'changed'],
  spent: ['pressed', 'uncertain', 'not-pressed', 'changed'],
  pressed: [], uncertain: [], 'not-pressed': [], denied: [], expired: [], closed: [], changed: [],
};
export const TERMINAL = (state: PayState) => NEXT[state].length === 0;

/** B: everything the owner's tap is tied to. The approval acts only when every field is the same at the press. */
export interface PayBinding {
  thread: string; bot: string;
  /** tabId:navigationEpoch:origin of the document. */
  tab: string;
  /** The main frame's loader id: changes whenever the frame commits a new document (a reload, a redirect). */
  loader: string;
  /** The document's address without its fragment. */
  address: string;
  /** The engine's node identity of the control. */
  node: number;
  /** Digest of the control's role, tag and name, read live. */
  control: string;
  /** kind:rule of the floor. */
  floor: string;
  /** The agreed digest: all visible text of the main document, hashed inside the page, plus the card rows. */
  agreed: string;
}
const BINDING_KEYS: readonly (keyof PayBinding)[] = ['thread', 'bot', 'tab', 'loader', 'address', 'node', 'control', 'floor', 'agreed'];
export function sameBinding(a: PayBinding | undefined, b: PayBinding | undefined): boolean {
  if (!a || !b) return false;
  for (const key of BINDING_KEYS) { const x = a[key], y = b[key]; if (x === undefined || x === '' || x !== y) return false; }
  return true;
}

/** What the page shows, read in Murage's isolated world (PAY_PAGE_EXPRESSION). Every value is page-written. */
export interface PayPage { title: string; order: string; amounts: { label: string; value: string }[]; digest: string }

/** A4: the card's rows. Merchant, item, quantity and total, built from parsed values only; page text is one line, capped. */
export interface PayCardRows {
  kind: 'pay' | 'terms';
  title: string;
  site: string;
  merchant: string;
  item: string;
  quantity: string;
  /** One amount, or every amount the page shows when it shows more than one (the card never picks one). */
  total: string;
  amounts: string[];
  asked: string;
  button: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const oneLine = (value: unknown, max: number) => String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Grouped digits: "1,000" = 1000, "12 500" (thin or no-break space too) = 12500. Groups after the first are exactly three
 *  digits. A dot is never a group mark here ("1.000" is ambiguous between locales): not a quantity. */
const GROUPED = /^(\d{1,3})((?:[,    ]\d{3})+)$/;
export function parseQuantityNumber(token: string): number | undefined {
  const raw = String(token ?? '').trim();
  if (/^\d+$/.test(raw)) { const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : undefined; }
  const grouped = GROUPED.exec(raw);
  if (!grouped) return undefined;
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
// "Qty: 1,000", "Quantity 3", "1,000 x USB-C cable", "USB-C cable × 2". The number token keeps its group marks.
const NUM = String.raw`(\d{1,3}(?:[,    ]\d{3})+|\d+)(?![\d.,]\d)`;
const QTY_LABEL = new RegExp(String.raw`\b(?:qty|quantity|menge|cantidad|quantit[eé])\s*[:：=]?\s*` + NUM, 'iu');
const QTY_TIMES_BEFORE = new RegExp(String.raw`(?:^|[^\d.,])` + NUM + String.raw`\s*[x×]\s+\S`, 'iu');
const QTY_TIMES_AFTER = new RegExp(String.raw`\S\s+[x×]\s*` + NUM, 'iu');
/** The quantity the page's order summary holds, or undefined when the page shows none (the card says so). */
export function orderQuantity(order: string): number | undefined {
  const text = String(order ?? '').normalize('NFKC');
  for (const pattern of [QTY_LABEL, QTY_TIMES_BEFORE, QTY_TIMES_AFTER]) {
    const found = pattern.exec(text);
    if (found) return parseQuantityNumber(found[1]!);
  }
  return undefined;
}
const AMOUNT = /^(?:([$€£¥₹]|[A-Z]{3})\s?)?(\d{1,3}(?:[,   ]\d{3})*|\d+)(?:[.,](\d{2}))?(?:\s?([$€£¥₹]|[A-Z]{3}))?$/u;
/** Amounts are normalised (currency, digits, one decimal mark) before they are shown; anything else is not an amount. */
export function normaliseAmount(value: string): string | undefined {
  // The in-page token runs over every mark next to the digits (any grouping a page uses); only closing punctuation is trimmed here, so an
  // unknown grouping (1’234.56, 1.234,56) never matches and is never cut down to a smaller amount.
  const found = AMOUNT.exec(oneLine(value, 40).normalize('NFKC').replace(/[.,;:!?)\]]+$/u, ''));
  if (!found) return undefined;
  const currency = found[1] ?? found[4];
  if (!currency) return undefined;
  const whole = found[2]!.replace(/[^\d]/g, '');
  return `${currency}${Number(whole).toLocaleString('en-US')}${found[3] !== undefined ? `.${found[3]}` : ''}`;
}

/** A4 amount rule and the required Order row. null = hand-off (E7): no amount, more than eight, or no order summary. */
export function payCardRows(input: { kind: 'pay' | 'terms'; site: string; page: PayPage; ownerText: string; button: string }): PayCardRows | null {
  const site = oneLine(input.site, 253);
  if (!site) return null;
  const merchant = oneLine(input.page.title, 80) || 'Not shown by the page';
  const asked = oneLine(input.ownerText, 200);
  const button = oneLine(input.button, 80) || 'unnamed button';
  if (input.kind === 'terms') return { kind: 'terms', title: `Agree to the terms on ${site}?`, site, merchant, item: '', quantity: '', total: '', amounts: [], asked, button };
  const item = oneLine(input.page.order, 200);
  if (!item) return null;
  const seen = new Map<string, string>();
  for (const amount of input.page.amounts ?? []) {
    const value = normaliseAmount(amount.value);
    // ASTRA 15482d2311: an amount the page shows that cannot be read exactly is never dropped (the card would show less than the page): hand-off.
    if (!value) return null;
    if (!seen.has(value)) seen.set(value, `${oneLine(amount.label, 60) || 'Amount'}: ${value}`);
  }
  if (seen.size === 0 || seen.size > 8) return null;
  const qty = orderQuantity(input.page.order);
  const quantity = qty === undefined ? 'Not shown by the page' : String(qty);
  const values = [...seen.keys()];
  const one = values.length === 1;
  return { kind: 'pay', title: one ? `Pay ${values[0]} at ${site}?` : `Pay at ${site}?`, site, merchant, item, quantity, total: one ? values[0]! : 'More than one amount: see below', amounts: [...seen.values()], asked, button };
}
export function cardSummary(rows: PayCardRows): string {
  const lines = [rows.title, `Site: ${rows.site}`, `Merchant (from the page): ${rows.merchant}`];
  if (rows.kind === 'pay') {
    lines.push(`Item (from the page): ${rows.item}`, `Quantity: ${rows.quantity}`, `Total: ${rows.total}`);
    if (rows.amounts.length > 1) lines.push('This page shows more than one amount. Murage cannot tell which one you will be charged.', ...rows.amounts);
  }
  lines.push(`You asked: ${rows.asked}`, `Button (from the page): ${rows.button}`, 'Approve presses this one button once. Amounts and names marked From the page were written by the website.');
  return lines.join('\n');
}
export const rowsDigest = (rows: PayCardRows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

/** Read in Murage's isolated world: the title, the visible order summary, every visible amount with its label, and a
 *  digest of ALL visible text of the document plus the link addresses (computed inside the page, never sent out whole).
 *  FABLE/ASTRA/OPUS adf932ab28 (class, DECISIONS #43): after the read amounts are taken off a line, a number left on it is an amount Murage
 *  cannot read (hand-off) when it has a mark or space between digits or 3+ digits, sits on a line with a money word, or touches a 1-3 letter
 *  word or code (kr, zł, Rs., usd, 円); only a 1-2 digit count by a longer word ("2 items") or ×N on a money line stays unread. */
export const PAY_PAGE_EXPRESSION = `(()=>{/*murage-pay-page*/
const vis=e=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0;};
const text=(document.body&&document.body.innerText)||'';
let h=2166136261;const mix=s=>{for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}};
mix(text);for(const a of document.querySelectorAll('a[href]'))if(vis(a))mix(a.href);
const order=[...document.querySelectorAll('[data-order-summary],[class*="order-summary"],[id*="order-summary"],[aria-label*="order summary" i]')].filter(vis).map(e=>e.innerText).join(' ').slice(0,2000);
const amounts=[];const re=/(?:[$€£¥₹]|[A-Z]{3})\\s*\\d(?:[^\\s\\p{L}]|\\s(?=\\d))*|\\d(?:[^\\s\\p{L}]|\\s(?=\\d))*\\s*(?:[$€£¥₹]|[A-Z]{3})(?!\\s*\\d)/gu;
const money=/(?:^|[^\\p{L}])(?:total|due|charge|amount|pay|price|cost|fee|tax|vat|gst|ship|subtotal|balance|sum|bill|owe|dollar|euro|pound|yen|yuan|rupee|franc|kron|zł|zlot|złot|peso|real|reais|rand|won|lira|lei|forint|korun|ringgit|baht|dong|dinar|dirham|riyal|rial|shekel|rubl|roubl|hryvn|naira|cedi|shilling)/iu;
const unread=(rest,line)=>/\\p{Sc}/u.test(rest)||/\\p{Nd}/u.test(rest)&&(/\\p{Nd}(?:[^\\s\\p{L}\\p{Nd}]+|\\s+)\\p{Nd}|\\p{Nd}{3}/u.test(rest)||money.test(line)&&/\\p{Nd}/u.test(rest.replace(/×\\s?\\p{Nd}{1,2}(?!\\p{Nd})/gu,''))||/(?:^|[^\\p{L}])\\p{L}{1,3}\\.?[\\s:()\\-]*\\p{Nd}|\\p{Nd}[\\s:()\\-]*\\p{L}{1,3}(?!\\p{L})/u.test(rest));
for(const line of text.normalize('NFKC').split('\\n')){const m=line.match(re);if(m)for(const v of m)amounts.push({label:line.replace(v,'').trim().slice(0,60),value:v.trim()});
if(unread((m||[]).reduce((rest,v)=>rest.replace(v,' '),line),line))amounts.push({label:'',value:'an amount Murage cannot read'});if(amounts.length>=64){amounts.push({label:'',value:'more amounts than Murage reads'});break;}}
return JSON.stringify({title:document.title.slice(0,200),order,amounts,digest:h.toString(16)});})()`;
export function readPayPage(value: unknown): PayPage | undefined {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : undefined;
    if (!parsed || typeof parsed.digest !== 'string' || !parsed.digest || typeof parsed.title !== 'string' || typeof parsed.order !== 'string' || !Array.isArray(parsed.amounts)) return undefined;
    const amounts = parsed.amounts.filter((a): a is { label: string; value: string } => !!a && typeof (a as { label?: unknown }).label === 'string' && typeof (a as { value?: unknown }).value === 'string');
    return { title: parsed.title, order: parsed.order, amounts, digest: parsed.digest };
  } catch { return undefined; }
}

export interface PayRecord {
  id: string; thread: string; bot: string; generation: string; kind: 'pay' | 'terms';
  binding: PayBinding; summary: string; createdAt: number; expiresAt: number; state: PayState;
  /** F2c: the owner's outcome row was written for this terminal state. */
  rowWritten?: boolean;
}
const PAY_CARD_LIFETIME_MS = 15 * 60_000;

/** The pay and terms records, in their own file (F14: 1.0.23 never reads it, so a rollback can approve nothing from it). */
export class PayCardStore {
  private records = new Map<string, PayRecord>();
  // Plain fields, no parameter properties: the server runs these files through node's type stripping, which refuses them (the server would not start).
  private readonly file: string;
  private readonly hooks: { beforeSave?: (record: PayRecord) => void };
  constructor(file: string, hooks: { beforeSave?: (record: PayRecord) => void } = {}) {
    this.file = file; this.hooks = hooks;
    if (existsSync(file)) {
      // A file that cannot be read is set aside, not trusted and not fatal: an unreadable record can approve nothing (the in-memory gate of
      // an approved card never survives a restart), so starting empty fails closed.
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: PayRecord[] };
        for (const record of parsed.records ?? []) if (record && typeof record.id === 'string' && record.state in NEXT) this.records.set(record.id, record);
      } catch { try { renameSync(file, `${file}.damaged-${Date.now()}`); } catch { /* left in place; nothing is read from it */ } this.records.clear(); }
    }
  }
  get(id: string) { const record = this.records.get(id); return record ? { ...record } : undefined; }
  all() { return [...this.records.values()].map(record => ({ ...record })); }
  /** write, fsync, rename, fsync the directory. Throws when the state could not be made durable. */
  private persist(next: Map<string, PayRecord>) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify({ version: 1, records: [...next.values()] })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    try { const dir = openSync(path.dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* a directory fsync is not offered everywhere; the rename stands */ }
  }
  /** Saves first; memory follows only a durable save. */
  put(record: PayRecord) {
    this.hooks.beforeSave?.(record);
    const next = new Map(this.records); next.set(record.id, { ...record });
    this.persist(next); this.records = next;
  }
  /** One allowed transition, saved before it is true. false: not allowed from the current state (a second Approve, a race). */
  move(id: string, to: PayState, extra: Partial<PayRecord> = {}): boolean {
    const record = this.records.get(id);
    if (!record || !NEXT[record.state].includes(to)) return false;
    this.put({ ...record, ...extra, state: to });
    return true;
  }
  remove(id: string) { const next = new Map(this.records); next.delete(id); this.persist(next); this.records = next; }
  /** F1/F2: before the server listens, a card that was open or approved is closed (nothing was pressed) and a `spent` record
   *  with no result is `uncertain` (never replayed). Returns the records whose outcome row is still owed (F2c). */
  startup(): PayRecord[] {
    for (const record of [...this.records.values()]) {
      if (record.state === 'waiting' || record.state === 'allowed') this.move(record.id, 'closed');
      else if (record.state === 'spent') this.move(record.id, 'uncertain');
    }
    return this.all().filter(record => TERMINAL(record.state) && !record.rowWritten);
  }
}

export const PAY_TEXT = {
  denied: 'NOT DONE: the owner said no to this payment. Nothing was pressed. Do not try another way to pay.',
  changed: 'NOT DONE: the page changed after the owner approved (tab, page, button, terms or amount). Nothing was pressed. Try the step again so they can see the new details.',
  releaseChanged: 'NOT DONE: the page changed after the owner approved, while the button was being pressed. The pay button may have been pressed. Check the page before anything else is done, and do not press it again.',
  mayBePressed: 'NOT DONE: this step stopped after the pay button press had started. The pay button may have been pressed. Check the page before anything else is done, and do not press it again.',
  expired: 'NOT DONE: the owner did not answer in time. Nothing was pressed.',
  closed: 'NOT DONE: the settings or the turn changed while the owner was deciding. Nothing was pressed.',
  notPressed: 'NOT DONE: the page was not ready for the press in time. Nothing was pressed. Try the step again.',
  single: 'NOT DONE: a payment or agreement button is pressed with one single click only. Use a single click.',
  once: 'NOT DONE: the owner approved one press of this button, and it was pressed. A second press needs a new approval.',
} as const;
/** The owner's row after the card (one per request). */
export const OWNER_ROW: Readonly<Partial<Record<PayState, (rows: { button: string; site: string }) => string>>> = {
  pressed: rows => `Pressed "${rows.button}" on ${rows.site}. Check the site for its confirmation.`,
  denied: () => 'Not paid: you said no',
  changed: () => 'Not paid: the page changed',
  expired: () => 'Not paid: the request expired',
  closed: () => 'Not paid: your settings changed while this was open',
  'not-pressed': () => 'Not paid: nothing was pressed',
  uncertain: () => 'The pay button may have been pressed. Check the page before anything else is done.',
};

/** What the gate reads live at the final check: B' and E1..E9 again, a Stop (held or confirmed), the generation. */
export interface PayLive { binding: PayBinding | undefined; eligible: PayStepAnswer; stopped: boolean; generationActive: boolean }
export type PayAsk = (card: { id: string; rows: PayCardRows; summary: string; digest: string }) => Promise<'allow' | 'deny' | 'waiting' | 'cancelled'>;
export interface PayStepRequest {
  /** The running turn's own generation (a string id): the E8 caps and the record are per turn, never per binding. */
  thread: string; bot: string; generation: string;
  floor: FloorResult; operation: string; double: boolean;
  eligible: PayStepAnswer;
  site: string; ownerText: string; button: string;
  binding: PayBinding | undefined; page: PayPage | undefined;
  /** Shows the card to the owner (the caller's approvals queue). Without one there is no card: hand-off. */
  ask?: PayAsk;
}
/** The one-call floor pass: never returned to the bot, never written to disk. */
export interface PayPass {
  readonly id: string; readonly floor: string; readonly rule: string; readonly binding: PayBinding;
  /** True once its one activation was used. */
  pressed: boolean;
}
export type PayOutcome = { pending: PayPending } | { refuse: string } | null;
export interface PayPending { id: string; floor: string; rule: string; commit(live: PayLive): PayPass | { refuse: string }; abandon(): void }

/** A6/A7: the card flow. One instance per server; records survive a restart in `file`. */
export class PayCardFlow {
  readonly store: PayCardStore;
  private turns = new Map<string, { cards: number; denied: boolean }>();
  private readonly options: { file: string; ask?: PayAsk; now?: () => number; row?: (record: PayRecord, text: string) => void; beforeSave?: (record: PayRecord) => void };
  constructor(options: { file: string; ask?: PayAsk; now?: () => number; row?: (record: PayRecord, text: string) => void; beforeSave?: (record: PayRecord) => void }) {
    this.options = options;
    this.store = new PayCardStore(options.file, { beforeSave: options.beforeSave });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** Startup (before the server listens): F1, F2, then F2c rows. */
  startup() { for (const record of this.store.startup()) this.writeRow(record); }
  private writeRow(record: PayRecord) {
    const text = OWNER_ROW[record.state]?.({ button: /Button \(from the page\): (.*)/.exec(record.summary)?.[1] ?? 'the button', site: /Site: (.*)/.exec(record.summary)?.[1] ?? 'the site' });
    if (!text) return;
    try { this.options.row?.(record, text); this.store.put({ ...record, rowWritten: true }); } catch { /* the row is repaired at the next startup */ }
  }
  private end(id: string, to: PayState): void {
    let moved = false;
    try { moved = this.store.move(id, to); } catch { /* not durable: nothing is pressed either way */ }
    const record = this.store.get(id);
    if (moved && record) this.writeRow(record);
  }
  /** E1..E9 came from ownerPayStep; E5 (carded rules), E7 (amount rule, order row), E8 (caps) and the card are here.
   *  null = hand-off as today. */
  async confirm(request: PayStepRequest): Promise<PayOutcome> {
    const floor = request.floor;
    // FABLE 15482d2311: the terms (consent) card has no witness yet, so only a payment floor becomes a card; terms hand off as today.
    if (!floor || floor.unsure === true || floor.floor !== 'payment' || !CARDED_RULES[floor.floor].includes(floor.rule)) return null;
    if (!request.eligible.ok) return null;
    const turnKey = `${request.thread}\u0000${request.generation}`;
    const turn = this.turns.get(turnKey) ?? { cards: 0, denied: false };
    // E8: no card after a Deny in this turn; at most three cards a turn.
    if (turn.denied) return { refuse: PAY_TEXT.denied };
    if (turn.cards >= 3) return null;
    // A3: a double click is never carded and never sent on a carded kind.
    if (request.double) return { refuse: PAY_TEXT.single };
    const ask = request.ask ?? this.options.ask;
    if (!ask || !request.binding || !request.page) return null;
    const rows = payCardRows({ kind: request.eligible.kind, site: request.site, page: request.page, ownerText: request.ownerText, button: request.button });
    if (!rows) return null;
    const binding: PayBinding = { ...request.binding, agreed: createHash('sha256').update(`${request.page.digest}\u0000${rowsDigest(rows)}`).digest('hex') };
    const id = randomUUID();
    const summary = cardSummary(rows);
    const created = this.now();
    try { this.store.put({ id, thread: request.thread, bot: request.bot, generation: request.generation, kind: rows.kind, binding, summary, createdAt: created, expiresAt: created + PAY_CARD_LIFETIME_MS, state: 'waiting' }); }
    catch { return null; } // F8: no durable record, no card.
    turn.cards++; this.turns.set(turnKey, turn);
    let answer: Awaited<ReturnType<PayAsk>>;
    try { answer = await ask({ id, rows, summary, digest: binding.agreed }); } catch { answer = 'cancelled'; }
    if (answer === 'deny') { turn.denied = true; this.end(id, 'denied'); return { refuse: PAY_TEXT.denied }; }
    if (answer === 'waiting') { this.end(id, 'expired'); return { refuse: PAY_TEXT.expired }; }
    if (answer !== 'allow') { this.end(id, 'closed'); return { refuse: PAY_TEXT.closed }; }
    try { if (!this.store.move(id, 'allowed')) return { refuse: PAY_TEXT.closed }; } catch { this.end(id, 'closed'); return { refuse: PAY_TEXT.closed }; }
    const flow = this;
    let settled = false;
    return { pending: {
      id, floor: floor.floor, rule: floor.rule,
      // The final check: one synchronous section, right before the input.
      commit(live: PayLive): PayPass | { refuse: string } {
        if (settled) return { refuse: PAY_TEXT.closed };
        settled = true;
        const record = flow.store.get(id);
        if (!record || record.state !== 'allowed') { flow.end(id, 'closed'); return { refuse: PAY_TEXT.closed }; }
        if (flow.now() > record.expiresAt) { flow.end(id, 'expired'); return { refuse: PAY_TEXT.expired }; }
        if (!live.eligible.ok || live.stopped || !live.generationActive) { flow.end(id, 'closed'); return { refuse: PAY_TEXT.closed }; }
        if (!sameBinding(record.binding, live.binding)) { flow.end(id, 'changed'); return { refuse: PAY_TEXT.changed }; }
        try { if (!flow.store.move(id, 'spent')) return { refuse: PAY_TEXT.closed }; } catch { flow.end(id, 'closed'); return { refuse: PAY_TEXT.closed }; }
        return { id, floor: floor.floor as string, rule: floor.rule, binding: record.binding, pressed: false };
      },
      abandon() { if (!settled) { settled = true; flow.end(id, 'closed'); } },
    } };
  }
  /** The live agreed digest for B', from a fresh page read and the same rows the card showed. */
  liveAgreed(_id: string, page: PayPage | undefined, request: Omit<PayStepRequest, 'binding' | 'page' | 'eligible' | 'floor' | 'operation' | 'double'> & { kind: 'pay' | 'terms' }): string | undefined {
    if (!page) return undefined;
    const rows = payCardRows({ kind: request.kind, site: request.site, page, ownerText: request.ownerText, button: request.button });
    return rows ? createHash('sha256').update(`${page.digest}\u0000${rowsDigest(rows)}`).digest('hex') : undefined;
  }
  /** PRESSING -> terminal. `inputSent` false: nothing reached the page. */
  settle(pass: PayPass, outcome: 'pressed' | 'uncertain' | 'not-pressed' | 'changed') { this.end(pass.id, outcome); }
}
