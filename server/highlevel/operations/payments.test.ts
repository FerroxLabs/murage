// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paymentsOperations, paymentInvoiceTotal } from './payments.ts';
import { createPaymentFixture } from '../fake/payments.ts';
import { until } from '../../testing/fake-highlevel.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from './manifest.ts';
import { HIGHLEVEL_ENDPOINTS } from '../provider-contract.ts';
import type { MutationSpec, OperationSpec, PreflightRequester } from './registry.ts';
import { HeldRequest } from '../held-request.ts';

const locationId = 'loc_fixture_01';
const scope = { altId: locationId, altType: 'location' };
const item = { name: 'private_payment_sentinel_492817', currency: 'USD', amount: 12.34, qty: 2 };
const contact = { id: 'contact_1', name: 'Fixture buyer', email: 'buyer@fixture.test', phoneNo: '+15550000001' };
const draft = { ...scope, status: 'draft', name: 'Fixture invoice', currency: 'USD', businessDetails: { name: 'Fixture seller' }, items: [item], discount: { type: 'fixed', value: 0 }, contactDetails: contact, issueDate: '2026-11-10', dueDate: '2026-12-10', sentTo: { email: [contact.email], phoneNo: [contact.phoneNo] }, liveMode: false };
const update = { ...scope, invoiceId: 'invoice_1', status: 'draft', name: draft.name, currency: 'USD', invoiceItems: [item], issueDate: draft.issueDate, dueDate: draft.dueDate };
const invoice = { ...scope, _id: 'invoice_1', status: 'draft', currency: 'USD', invoiceItems: [item], total: 24.68, amountDue: 24.68, amountPaid: 0, contactDetails: contact, liveMode: false };
const inputs: Record<string, Record<string, unknown>> = {
  'invoices.list': { ...scope, limit: '20', offset: '0' }, 'invoices.get': { ...scope, invoiceId: 'invoice_1' },
  'invoice.create': draft, 'invoice.update': update,
  'invoice.send': { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false },
  'invoice.void': { ...scope, invoiceId: 'invoice_1' }, 'invoice.delete': { ...scope, invoiceId: 'invoice_1' },
  'invoice.recordPayment': { ...scope, invoiceId: 'invoice_1', mode: 'cash', amount: 10, notes: 'Fixture payment', card: { brand: '', last4: '' }, cheque: { number: '' } },
  'invoice.text2pay': { ...scope, name: draft.name, currency: 'USD', items: [item], contactDetails: contact, issueDate: draft.issueDate, dueDate: draft.dueDate, sentTo: draft.sentTo, liveMode: false, userId: 'user_1', action: 'send' },
  'orders.list': { altId: locationId }, 'orders.get': { altId: locationId, orderId: 'order_1' },
  'transactions.list': scope, 'transactions.get': { ...scope, transactionId: 'transaction_1' },
  'subscriptions.list': scope, 'subscriptions.get': { ...scope, subscriptionId: 'subscription_1' },
  'products.list': { locationId }, 'products.get': { locationId, productId: 'product_1' },
};
function spec(verb: string): OperationSpec {
  const op = paymentsOperations.find(s => s.id === `payments.${verb}`);
  expect(op, `payments.${verb} must be implemented`).toBeDefined();
  return op!;
}
function mutation(verb: string): MutationSpec { const op = spec(verb); expect(op.risk).not.toBe('R'); return op as MutationSpec; }
function preflight(current = invoice) {
  const calls: string[] = [];
  const pre: PreflightRequester = { async read(id, read) {
    calls.push(id); expect(typeof read).toBe('object');
    if (id === 'contacts.get') return { contact: { ...contact, locationId } };
    if (id === 'payments.invoices.get') return current;
    if (id === 'payments.invoices.list') return { invoices: [], total: 0 };
    throw new Error('Undeclared fixture preflight');
  } };
  return { pre, calls };
}
async function prepared(verb: string, input = inputs[verb]) {
  const op = spec(verb); const { pre, calls } = preflight();
  const args = op.args.parse(input);
  const request = op.risk === 'R' ? await op.prepareRead(args, { locationId }) : await op.prepare(pre, args, { locationId });
  return { op, request, calls, held: HeldRequest.freeze(op, request, { locationId }) };
}

describe('F7 frozen invoices and payments', () => {
  it('registry contains all 17 qualified payment rows and no absent refund', () => {
    expect(paymentsOperations.map(s => s.id).sort()).toEqual(Object.keys(inputs).map(v => `payments.${v}`).sort());
    expect(HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === 'payments.refund')?.disposition).toBe('provider_absent');
  });
  it('pay.sendVoidRecordAreD', () => { for (const verb of ['send', 'void', 'delete', 'recordPayment', 'text2pay']) expect(spec(`invoice.${verb}`).risk).toBe('D'); });
  it('pay.draftCreateIsC', async () => { const { op, held } = await prepared('invoice.create'); expect(op.risk).toBe('C'); expect(JSON.parse(Buffer.from(held.sendCopy().body!).toString()).status).toBe('draft'); });
  it('draft.updateIsDWithoutProviderPrecondition', () => { expect(mutation('invoice.update')).toMatchObject({ risk: 'D', gate: 'GDp', precondition: 'none' }); });
  it('registry.everyReadHasPrepareRead', () => { for (const verb of Object.keys(inputs).filter(v => !v.startsWith('invoice.'))) expect(typeof (spec(verb) as any).prepareRead).toBe('function'); });
  it('registry.gdpRequiresRecheck', () => { expect(typeof mutation('invoice.update').recheck).toBe('function'); });
  it('registry.noRunMember', () => { expect(paymentsOperations.length).toBe(17); for (const op of paymentsOperations) expect('run' in op).toBe(false); });
  it('interface.noLocalRedeclaration', () => { expect(readFileSync(new URL('./payments.ts', import.meta.url), 'utf8')).not.toMatch(/(?:interface|type) (?:RequestDraft|SpecBase|ReadSpec|MutationSpec|OperationSpec|PreflightRequester|OperationRunContext)\b/); });
  it('invoice.updateRefusesSent', async () => { const op = mutation('invoice.update'); const { pre } = preflight({ ...invoice, status: 'sent' }); await expect(op.prepare(pre, op.args.parse(update), { locationId })).rejects.toThrow(); });
  it('draft.publishedDuringRateWaitStales', async () => {
    const { held } = await prepared('invoice.update'); const op = mutation('invoice.update');
    expect(typeof op.recheck).toBe('function');
    expect(await op.recheck!(preflight({ ...invoice, status: 'sent' }).pre, held.frozen, { locationId })).toEqual({ ok: false, reason: 'sent' });
    expect(await op.recheck!(preflight().pre, held.frozen, { locationId, approvalContext: held.approvalContextCopy() })).toEqual({ ok: true });
  });
  it('draft.updateBodyCannotPublish', async () => {
    const op = mutation('invoice.update'); expect(op.args.safeParse({ ...update, status: 'sent' }).success).toBe(false);
    const { request, held } = await prepared('invoice.update');
    expect(JSON.parse(Buffer.from(held.sendCopy().body!).toString()).status).toBe('draft');
    expect(() => HeldRequest.freeze(op, { ...request, body: { kind: 'json', value: { ...(request.body as any).value, status: 'sent' } } }, { locationId })).toThrow();
  });
  it('draft.preconditionInBodyHash', async () => {
    const { held } = await prepared('invoice.update'); const changed = await prepared('invoice.update', { ...update, name: 'Different reviewed name' });
    expect(held.frozen.bodySha256).not.toBe(changed.held.frozen.bodySha256);
    expect(held.frozen.requestDigest).not.toBe(changed.held.frozen.requestDigest);
    expect(JSON.parse(Buffer.from(held.sendCopy().body!).toString())).toMatchObject({ status: 'draft', invoiceItems: [item] });
  });
  it.each(Object.keys(inputs))('%s uses frozen row/schema/preflight identities and grants', async verb => {
    const op = spec(verb); const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === op.id)!;
    expect(op.row).toBe(row); expect(op.args).toBe(row.argsSchema); expect(op.preflight).toBe(row.preflight); expect(op.endpoint).toBe(HIGHLEVEL_ENDPOINTS[op.id]);
    const { levelCovers } = await import('../../../shared/highlevel.ts');
    expect(levelCovers('read', op.risk)).toBe(op.risk === 'R'); expect(levelCovers('change', op.risk)).toBe(op.risk !== 'D');
    expect(levelCovers('off', op.risk)).toBe(false);
    if (op.nested) expect(typeof op.ownership).toBe('function');
  });
  it.each(Object.keys(inputs))('%s rejects unknown keys and URL-like values', verb => {
    const op = spec(verb); expect(op.args.safeParse(inputs[verb]).success).toBe(true);
    for (const key of ['unexpected', 'token', 'url', 'headers', 'path']) expect(op.args.safeParse({ ...inputs[verb], [key]: 'https://bad.test' }).success).toBe(false);
    const key = Object.keys(inputs[verb]).find(k => typeof inputs[verb][k] === 'string')!;
    expect(op.args.safeParse({ ...inputs[verb], [key]: 'https://bad.test' }).success).toBe(false);
  });
  it.each(Object.keys(inputs))('%s freezes exact path, location, bounded body and metadata', async verb => {
    const { op, request, held, calls } = await prepared(verb);
    expect(op.endpoint.path.test(request.path)).toBe(true);
    expect(calls.every(id => op.preflight.includes(id as any))).toBe(true);
    expect(JSON.stringify([op.fields(inputs[verb]), op.recordRefs(inputs[verb])])).not.toContain(item.name);
    expect(held.frozen.operation).toBe(op.id);
    await expect(op.risk === 'R' ? op.prepareRead(inputs[verb], { locationId: 'foreign_location' }) : op.prepare(preflight().pre, inputs[verb], { locationId: 'foreign_location' })).rejects.toThrow();
    if (op.row.pathResourceSegment === null || verb.startsWith('products.')) expect(() => HeldRequest.freeze(op, request, { locationId: 'foreign_location' })).toThrow();
    const first = held.sendCopy(); first.body?.fill(0);
    expect(held.sendCopy().body).not.toEqual(first.body ?? new Uint8Array([1]));
  });
  it.each(['invoice.create', 'invoice.update', 'invoice.text2pay'])('%s refuses unsafe money and unreviewable dynamic totals', async verb => {
    const op = mutation(verb); const key = verb === 'invoice.update' ? 'invoiceItems' : 'items';
    for (const bad of [{ amount: -1 }, { amount: 0.001 }, { qty: 0 }, { qty: 0.5 }, { amount: 1e16 }, { currency: 'EUR' }]) {
      await expect(op.prepare(preflight().pre, { ...inputs[verb], [key]: [{ ...item, ...bad }] }, { locationId })).rejects.toThrow();
    }
    await expect(op.prepare(preflight().pre, { ...inputs[verb], automaticTaxesEnabled: true }, { locationId })).rejects.toThrow();
  });
  it('payment refuses amounts beyond the invoice balance or currency precision', async () => {
    const op = mutation('invoice.recordPayment');
    for (const amount of [undefined, -1, 0, 24.69, 0.001]) await expect(op.prepare(preflight().pre, { ...inputs['invoice.recordPayment'], amount }, { locationId })).rejects.toThrow();
  });
  it.each(['invoice.update', 'invoice.send', 'invoice.void', 'invoice.delete', 'invoice.recordPayment'])('%s proves invoice location before preparing', async verb => {
    const op = mutation(verb);
    await expect(op.prepare(preflight({ ...invoice, altId: 'foreign_location' }).pre, inputs[verb], { locationId })).rejects.toThrow();
    await expect(op.prepare(preflight({ ...invoice, _id: 'different_invoice' }).pre, inputs[verb], { locationId })).rejects.toThrow();
  });
  it('foreign contact cannot create an invoice', async () => {
    const op = mutation('invoice.create'); const pre: PreflightRequester = { read: async () => ({ contact: { ...contact, locationId: 'foreign_location' } }) };
    await expect(op.prepare(pre, draft, { locationId })).rejects.toThrow();
  });
  it('payment response projections omit provider-only secrets and stay bounded', () => {
    const op = spec('invoices.get'); const projected = op.project({ ...invoice, name: 'x'.repeat(100_000), providerSecret: item.name });
    expect(JSON.stringify(projected)).not.toContain('providerSecret'); expect(JSON.stringify(projected).length).toBeLessThan(64 * 1024);
  });
});


describe('F7 real host with fixture transport', () => {
  it('pay.offByDefault', async () => {
    const f = createPaymentFixture();
    const result = await f.call('invoices.list', inputs['invoices.list']);
    expect(JSON.stringify(result)).toContain('required level'); expect(f.api.requests).toHaveLength(0);
  });
  it.each(Object.keys(inputs).filter(v => !v.startsWith('invoice.')))('%s runs through the read host on a read grant', async verb => {
    const f = createPaymentFixture({ level: 'read' }); const result = await f.call(verb, inputs[verb]);
    expect(JSON.stringify(result)).not.toContain('isError":true'); expect(f.api.requests).toHaveLength(1); expect(f.reviews).toHaveLength(0);
    const call = f.api.requests[0]!;
    expect(call.query.get(verb.startsWith('products.') ? 'locationId' : 'altId')).toBe(locationId);
  });
  it.each(Object.keys(inputs).filter(v => v.startsWith('invoice.')))('%s is refused before any lease on a read grant', async verb => {
    const f = createPaymentFixture({ level: 'read', autoApprove: true }); await f.call(verb, inputs[verb]);
    expect(f.api.requests).toHaveLength(0); expect(f.leases.leaseRequests).toHaveLength(0);
  });
  it.each(['invoice.update', 'invoice.send', 'invoice.void', 'invoice.delete', 'invoice.recordPayment', 'invoice.text2pay'])('%s needs Full control', async verb => {
    const f = createPaymentFixture({ level: 'change', autoApprove: true }); await f.call(verb, inputs[verb]); expect(f.api.requests).toHaveLength(0);
  });
  it('draft sent during owner review stales before the one journaled PUT', async () => {
    const f = createPaymentFixture({ level: 'full' });
    const pending = f.call('invoice.update', update);
    await until(() => f.reviews.length > 0);
    f.state.invoice.status = 'sent';
    f.actions.approve(f.reviews[0]!.actionId, f.reviews[0]!.reviewDigest);
    await pending;
    expect(f.api.calls('PUT')).toHaveLength(0);
    expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('stale');
  });
  it('a retry of a reviewed invoice update never sends twice', async () => {
    const f = createPaymentFixture({ level: 'full', autoApprove: true }); const message = f.message('invoice.update', update, 'same-payment-rpc');
    await f.host.handle(f.claim, message); await f.host.handle(f.claim, message);
    expect(f.api.calls('PUT')).toHaveLength(1);
  });
  it('provider-error values never reach payment outcomes or action journal', async () => {
    const f = createPaymentFixture({ level: 'full', autoApprove: true });
    f.api.first('PUT', /^\/invoices\/invoice_1$/u, { status: 503, body: { message: item.name } });
    await f.call('invoice.update', update);
    expect(f.api.calls('PUT')).toHaveLength(1);
    expect(JSON.stringify(f.outcomes)).not.toContain(item.name);
    expect(JSON.stringify(f.reviews.map(r => f.actions.get(r.actionId)))).not.toContain(item.name);
  });
  it('the exact priced line items determine a checked total', () => {
    expect(paymentInvoiceTotal(draft)).toBe(24.68);
    expect(paymentInvoiceTotal({ ...draft, discount: { type: 'percentage', value: 10 } })).toBe(22.21);
  });
});

it('draft.publishedDuringRateWaitStales through the production admission callback', async () => {
  const f = createPaymentFixture({ level: 'full', manualSleep: true });
  const pending = f.call('invoice.update', update);
  await until(() => f.reviews.length > 0);
  const connection = [...f.leases.views.values()][0]!;
  const ctx = { connection, assertActive() {}, signal: new AbortController().signal };
  const remaining = 90 - f.api.requests.length;
  for (let i = 0; i < remaining; i++) (await f.client.gate.admit(locationId, ctx)).spend();
  f.actions.approve(f.reviews[0]!.actionId, f.reviews[0]!.reviewDigest);
  await until(() => f.sleeps.length > 0);
  f.state.invoice.status = 'sent'; f.advance(11_000); f.releaseSleeps();
  await f.settle(pending);
  expect(f.api.calls('PUT')).toHaveLength(0);
  expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('stale');
});
