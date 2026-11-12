// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { canonicalBindingJson } from '../binding-json.ts';
import { InvoiceReviewRefused } from '../errors.ts';
import { HighLevelError } from '../response-contract.ts';
import { HIGHLEVEL_ENDPOINTS } from '../provider-contract.ts';
import type { FrozenRequest } from '../held-request.ts';
import type { ManifestRow, OperationSpec, OperationRunContext, PreflightRequester, RequestDraft, SpecBase } from './registry.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from './manifest.ts';
import { highlevelIdSchema } from './schemas/common.ts';
import { argsSchema as schemas } from './schemas/payments.ts';
import { bindReturnedIdentities, returnedIdentitySchemaFor } from '../returned-identities.ts';

type Args = Record<string, unknown>;
const object = (value: unknown): Args => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
const fail = (): never => { throw new HighLevelError('The invoice values or location could not be verified. Nothing was sent.', { status: 409 }); };
const snapshotDigest = (value: unknown) => createHash('sha256').update(canonicalBindingJson(value)).digest('hex');
const segment = (value: unknown): string => encodeURIComponent(highlevelIdSchema.parse(value));
const rows = HIGHLEVEL_OPERATION_MANIFEST.filter((r): r is Extract<ManifestRow, { disposition: 'ready' }> => r.family === 'payments' && r.disposition === 'ready');
const titles: Record<string, string> = {
  'invoices.list': 'List invoices', 'invoices.get': 'View an invoice', 'invoice.create': 'Create a draft invoice', 'invoice.update': 'Update a draft invoice',
  'invoice.send': 'Send an invoice', 'invoice.void': 'Void an invoice', 'invoice.delete': 'Delete an invoice', 'invoice.recordPayment': 'Record a payment', 'invoice.text2pay': 'Create and send a payment request',
  'orders.list': 'List orders', 'orders.get': 'View an order', 'transactions.list': 'List transactions', 'transactions.get': 'View a transaction',
  'subscriptions.list': 'List subscriptions', 'subscriptions.get': 'View a subscription', 'products.list': 'List products', 'products.get': 'View a product',
};
const ids = ['invoiceId', 'orderId', 'transactionId', 'subscriptionId', 'productId', 'contactId', 'userId'];
function owned(raw: unknown, locationId: string, id?: unknown): Args {
  const r = object(raw);
  if (!(r.locationId === locationId || (r.altId === locationId && r.altType === 'location')) ||
    (r.locationId !== undefined && r.locationId !== locationId) || (r.altId !== undefined && r.altId !== locationId) ||
    (r.altType !== undefined && r.altType !== 'location') ||
    (id !== undefined && (r._id ?? r.id) !== id) || (r._id !== undefined && r.id !== undefined && r._id !== r.id)) fail();
  return r;
}
function scaleFor(currency: unknown): number {
  if (typeof currency !== 'string' || !Intl.supportedValuesOf('currency').includes(currency)) return fail();
  return 10 ** (new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2);
}
function units(value: unknown, scale: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return fail();
  const n = Math.round(value * scale);
  if (!Number.isSafeInteger(n) || Math.abs(value * scale - n) > 0.000001) return fail();
  return n;
}
function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Exact minor-unit arithmetic for the explicit-price subset. Provider-computed
 * taxes, recurring prices and extra recipients need a separately reviewed quote. */
export function paymentInvoiceTotal(input: Args): number {
  const scale = scaleFor(input.currency);
  const items = input.items ?? input.invoiceItems;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) return fail();
  const amounts = items.map(value => {
    const item = object(value);
    if (item.currency !== input.currency || !Number.isSafeInteger(item.qty) || Number(item.qty) < 1 || Number(item.qty) > 100_000 ||
      item.type === 'recurring' || item.taxInclusive === true || item.automaticTaxCategoryId !== undefined || item.priceId !== undefined) fail();
    const amount = units(item.amount, scale) * Number(item.qty);
    if (!Number.isSafeInteger(amount)) fail();
    return amount;
  });
  const subtotal = amounts.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(subtotal)) fail();
  const discount = object(input.discount);
  if (discount.validOnProductIds !== undefined) fail();
  const discountValue = discount.value ?? 0;
  if (typeof discountValue !== 'number' || discountValue < 0 || !Number.isFinite(discountValue) || (discount.type === 'percentage' && discountValue > 100)) fail();
  const reduction = discount.type === 'percentage' ? Math.round(subtotal * Number(discountValue) / 100) : units(discountValue, scale);
  if (reduction > subtotal) fail();
  const fraction = subtotal ? (subtotal - reduction) / subtotal : 1;
  let tax = 0;
  items.forEach((value, index) => {
    const taxes = object(value).taxes;
    if (taxes !== undefined && (!Array.isArray(taxes) || taxes.length > 10)) fail();
    for (const raw of (taxes ?? []) as unknown[]) {
      const rate = object(raw);
      if (rate.calculation !== 'exclusive' || typeof rate.rate !== 'number' || !Number.isFinite(rate.rate) || rate.rate < 0 || rate.rate > 100) fail();
      tax += Math.round(amounts[index]! * fraction * Number(rate.rate) / 100);
    }
  });
  const total = subtotal - reduction + tax;
  if (!Number.isSafeInteger(total) || total > 1_000_000_000 * scale) fail();
  return total / scale;
}
function validateValues(a: Args, verb: string): void {
  if (a.items !== undefined || a.invoiceItems !== undefined) {
    paymentInvoiceTotal(a);
    if (!validDate(a.issueDate) || (a.dueDate !== undefined && (!validDate(a.dueDate) || String(a.dueDate) < String(a.issueDate)))) fail();
    for (const key of ['paymentSchedule', 'lateFeesConfiguration', 'tipsConfiguration', 'paymentMethods', 'attachments', 'miscellaneousCharges']) if (a[key] !== undefined) fail();
    if (a.automaticTaxesEnabled === true) fail();
    const contact = object(a.contactDetails), sent = object(a.sentTo);
    for (const key of ['emailCc', 'emailBcc']) if (Array.isArray(sent[key]) && sent[key].length) fail();
    if (Array.isArray(contact.additionalEmails) && contact.additionalEmails.length) fail();
    for (const [key, expected] of [['email', contact.email], ['phoneNo', contact.phoneNo]]) {
      const recipients = sent[String(key)];
      if (recipients !== undefined && (!Array.isArray(recipients) || recipients.length > 1 || recipients.some(v => v !== expected))) fail();
    }
  }
  if (verb === 'invoice.send' && a.autoPayment !== undefined) fail();
  if (verb === 'invoice.text2pay' && a.id !== undefined) fail(); // update uses its own draft-only contract
  if (verb === 'invoice.recordPayment') {
    if (typeof a.amount !== 'number' || a.amount <= 0 || a.paymentScheduleIds !== undefined) fail();
    const card = object(a.card), cheque = object(a.cheque);
    if (a.mode === 'card' ? typeof card.brand !== 'string' || !card.brand || !/^\d{4}$/u.test(String(card.last4)) : card.brand !== '' || card.last4 !== '') fail();
    if (a.mode === 'cheque' ? typeof cheque.number !== 'string' || !cheque.number : cheque.number !== '') fail();
  }
}
function argsFor(row: ManifestRow, input: Args, ctx: OperationRunContext): Args {
  if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) fail();
  const a = row.argsSchema.parse(input) as Args;
  highlevelIdSchema.parse(ctx.locationId);
  for (const key of ['altId', 'locationId']) if (a[key] !== undefined && a[key] !== ctx.locationId) fail();
  if (a.altType !== undefined && a.altType !== 'location') fail();
  for (const key of ['limit', 'offset']) if (a[key] !== undefined) {
    const n = Number(a[key]); if (!Number.isSafeInteger(n) || n < (key === 'limit' ? 1 : 0) || n > (key === 'limit' ? 100 : 1_000_000)) fail();
  }
  validateValues(a, row.id.slice(9));
  return a;
}
function draftFor(row: Extract<ManifestRow, { disposition: 'ready' }>, a: Args, ctx: OperationRunContext): RequestDraft {
  const keys: string[] = [];
  const path = row.path.replace(/:(\w+)/gu, (_, key: string) => { keys.push(key); return segment(a[key]); });
  const resource = row.pathResourceSegment === null ? `location:${ctx.locationId}` : `payments:record:${decodeURIComponent(path.split('/')[row.pathResourceSegment]!)}`;
  const request: RequestDraft = { path, resource };
  const payload = Object.fromEntries(Object.entries(a).filter(([key, value]) => !keys.includes(key) && value !== undefined));
  if (row.method === 'GET' || row.method === 'DELETE') {
    request.query = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]));
    if (row.id.endsWith('.list')) { request.query.limit ??= '20'; request.query.offset ??= '0'; }
  } else {
    if (row.id === 'payments.invoice.create' || row.id === 'payments.invoice.update') payload.status = 'draft';
    request.body = { kind: 'json', value: row.bodySchema!.parse(payload) };
  }
  return request;
}
async function own(row: ManifestRow, pre: PreflightRequester, a: Args, ctx: OperationRunContext): Promise<Args | undefined> {
  let snapshot: Args | undefined;
  if (typeof a.invoiceId === 'string' && row.risk !== 'R') {
    const invoice = owned(await pre.read('payments.invoices.get', { path: `/invoices/${segment(a.invoiceId)}`, query: { altId: ctx.locationId, altType: 'location' } }), ctx.locationId, a.invoiceId);
    snapshot = invoice;
    if (row.id === 'payments.invoice.update') {
      if (invoice.status !== 'draft') fail();
      // The frozen update allowlist has only invoice.get. A new recipient cannot
      // borrow the existing invoice's ownership proof.
      const previous = object(invoice.contactDetails), next = object(a.contactDetails);
      if ((a.contactId !== undefined && a.contactId !== previous.id) || (next.id !== undefined && next.id !== previous.id)) fail();
    }
    if (row.id === 'payments.invoice.send' && a.liveMode !== invoice.liveMode) fail();
    if (row.id === 'payments.invoice.recordPayment') {
      const scale = scaleFor(invoice.currency);
      if (units(a.amount, scale) > units(invoice.amountDue, scale) || !['sent', 'partially_paid', 'draft'].includes(String(invoice.status))) fail();
    }
  }
  if (row.preflight.includes('contacts.get')) {
    const contact = object(a.contactDetails);
    const raw = object(await pre.read('contacts.get', { path: `/contacts/${segment(contact.id)}` }));
    owned(raw.contact ?? raw, ctx.locationId, contact.id);
  }
  return snapshot;
}
function fieldNames(a: Args, prefix = ''): string[] {
  return Object.entries(a).flatMap(([key, value]) => {
    if (ids.includes(key) || key === 'id' || key === '_id' || key === 'altId' || key === 'altType' || key === 'locationId') return [];
    const name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) return [...new Set(value.flatMap(v => typeof v === 'object' && v !== null ? fieldNames(object(v), name) : [name]))];
    return value && typeof value === 'object' ? fieldNames(object(value), name) : [name];
  }).sort();
}
function requireReviewableItems(invoice: Args): void {
  const items = invoice.invoiceItems;
  if (!Array.isArray(items) || items.length === 0) throw new InvoiceReviewRefused();
  for (const value of items) {
    const item = object(value);
    if (typeof item.name !== 'string' || !item.name.trim() || item.currency !== invoice.currency ||
      typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0 ||
      typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0) throw new InvoiceReviewRefused();
    if (item.taxes !== undefined) {
      if (!Array.isArray(item.taxes) || item.taxes.some(value => {
        const tax = object(value);
        return typeof tax.name !== 'string' || !tax.name.trim() || typeof tax.rate !== 'number' || !Number.isFinite(tax.rate) || tax.rate < 0;
      })) throw new InvoiceReviewRefused();
    }
  }
}
function projection(row: ManifestRow, value: unknown, full = false): unknown {
  // Top-level keys are precisely the frozen projection. Nested financial objects
  // are bounded too; provider diagnostic/credential fields are never copied.
  let remaining = 48_000;
  const omit = /(?:token|secret|credential|password|authorization|fingerprint|traceId|trackingId|^meta$|^message$|^statusCode$)/iu;
  const incomplete = (): undefined => { if (full) throw new InvoiceReviewRefused(); return undefined; };
  const visit = (v: unknown, depth = 0): unknown => {
    if (depth > 8 || remaining < 16) return incomplete();
    if (typeof v === 'string') { if (full && (v.length > 4000 || v.length > Math.floor(remaining / 6))) return incomplete(); const s = v.slice(0, Math.min(4000, Math.floor(remaining / 6))); remaining -= JSON.stringify(s).length; return s; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) { remaining -= 24; return v; }
    if (Array.isArray(v)) {
      if (full && v.length > 100) return incomplete();
      return v.slice(0, 100).map(x => visit(x, depth + 1)).filter(x => x !== undefined);
    }
    const out: Args = {};
    for (const [key, child] of Object.entries(object(v))) {
      if (omit.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (remaining < key.length * 6 + 16) { incomplete(); continue; }
      remaining -= key.length * 6 + 8; const result = visit(child, depth + 1); if (result !== undefined) out[key] = result;
    }
    return out;
  };
  return visit(Object.fromEntries(Object.entries(object(value)).filter(([key]) => row.projection.includes(key))));
}
function validateRead(value: unknown, frozen: FrozenRequest): void {
  const query = Object.fromEntries(frozen.query), locationId = query.altId ?? query.locationId;
  if (!highlevelIdSchema.safeParse(locationId).success) fail();
  const seen = new Set<object>();
  let count = 0;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value) || ++count > 20_000) fail();
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'locationId' || key === 'altId') && child !== locationId) fail();
      if (key === 'altType' && child !== 'location') fail();
      walk(child);
    }
  };
  walk(value);
  if (frozen.operation.endsWith('.get')) owned(value, locationId, decodeURIComponent(frozen.path.split('/').at(-1)!));
}
function confirm(row: ManifestRow, value: unknown, frozen?: FrozenRequest): string | undefined {
  const refuse = (): never => { throw new HighLevelError('HighLevel did not confirm the reviewed invoice.', { outcome: 'outcome_unknown' }); };
  if (!frozen || frozen.operation !== row.id) return refuse();
  // Keep the integration base's complete identity walk. Missing provider aliases
  // must be fixed in its shared policy, never bypassed by a family projection.
  try { if (bindReturnedIdentities(value, frozen, returnedIdentitySchemaFor(frozen)).status !== 'applied') return refuse(); }
  catch { return refuse(); }
  const raw = object(value), invoice = object(raw.invoice ?? raw);
  if (['success', 'succeeded', 'succeded'].some(key => key in raw && raw[key] !== true)) return refuse();
  const id = invoice._id ?? invoice.id;
  if (!highlevelIdSchema.safeParse(id).success) return refuse();
  const expected = row.pathResourceSegment === null ? undefined : decodeURIComponent(frozen.path.split('/')[row.pathResourceSegment]!);
  if (expected !== undefined && id !== expected) return refuse();
  return id as string;
}
function make(row: Extract<ManifestRow, { disposition: 'ready' }>): OperationSpec {
  const verb = row.id.slice(9);
  const args = schemas[row.id as keyof typeof schemas];
  const base: SpecBase = {
    id: row.id, family: 'payments', title: titles[verb]!, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args,
    nested: row.preflight.length > 0, preflight: row.preflight,
    ownership: async (pre, input, ctx) => { await own(row, pre, argsFor(row, input, ctx), ctx); },
    recordRefs: input => {
      const a = row.argsSchema.parse(input) as Args;
      return [...new Set([...ids.map(key => a[key]), object(a.contactDetails).id,
        ...((a.items ?? a.invoiceItems ?? []) as unknown[]).map(i => object(i).productId)].filter((v): v is string => highlevelIdSchema.safeParse(v).success))];
    },
    fields: input => row.risk === 'R' ? [] : fieldNames(args.parse(input)), targets: () => 1,
    project: (value, frozen?: FrozenRequest) => { if (row.risk !== 'R') confirm(row, value, frozen); else if (frozen) validateRead(value, frozen); return projection(row, value); },
  };
  if (row.risk === 'R') return { ...base, risk: 'R', maxReads: 1, prepareRead: async (input, ctx) => draftFor(row, argsFor(row, input, ctx), ctx) };
  if (row.gate === 'R') throw new Error('Payment write requires a mutation gate');
  return { ...base, risk: row.risk, gate: row.gate, send: row.send, precondition: row.precondition,
    prepare: async (pre, input, ctx) => {
      const a = argsFor(row, input, ctx), draft = draftFor(row, a, ctx);
      const invoice = await own(row, pre, a, ctx);
      const values: Args = {};
      const priced = invoice && row.id === 'payments.invoice.update' ? { ...invoice, ...a, items: undefined } : a;
      validateValues(priced, verb);
      if (priced.items !== undefined || priced.invoiceItems !== undefined) values.total = paymentInvoiceTotal(priced);
      const identities: Record<string, string[]> = {};
      if (invoice) {
        requireReviewableItems(invoice);
        units(invoice.total, scaleFor(invoice.currency));
        const contactId = object(invoice.contactDetails).id;
        if (!highlevelIdSchema.safeParse(contactId).success) fail();
        identities.contactId = [contactId as string];
        values.total ??= invoice.total;
        values.invoiceReview = projection(rows.find(r => r.id === 'payments.invoices.get')!, invoice, true);
      }
      draft.approvalContext = { values, identities, ...(invoice ? { stateDigest: snapshotDigest(invoice) } : {}) };
      return draft;
    },
    recordId: (value, frozen?: FrozenRequest) => confirm(row, value, frozen),
    ...(row.gate === 'GDp' ? { recheck: async (pre: PreflightRequester, frozen: FrozenRequest, ctx: OperationRunContext) => {
      if (frozen.operation !== row.id || !row.path || !HIGHLEVEL_ENDPOINTS[row.id]!.path.test(frozen.path)) fail();
      const id = decodeURIComponent(frozen.path.split('/')[row.pathResourceSegment!]!);
      try {
        const invoice = owned(await pre.read('payments.invoices.get', { path: frozen.path, query: { altId: ctx.locationId, altType: 'location' } }), ctx.locationId, id);
        if (invoice.status !== 'draft') return { ok: false as const, reason: invoice.status === 'sent' ? 'sent' as const : 'not_draft' as const };
        const sameSnapshot = ctx.approvalContext?.stateDigest === snapshotDigest(invoice);
        if (!sameSnapshot) return { ok: false as const, reason: 'changed' as const };
        return { ok: true as const };
      } catch (error) { if (error instanceof HighLevelError && error.status === 404) return { ok: false as const, reason: 'gone' as const }; throw error; }
    } } : {}),
  };
}
export const paymentsOperations: readonly OperationSpec[] = rows.map(make);
export default paymentsOperations;
