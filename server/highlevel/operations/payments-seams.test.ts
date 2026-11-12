// Regression coverage for the audited F7 shared boundaries.
import { expect, it } from 'vitest';
import { createPaymentFixture } from '../fake/payments.ts';
import { paymentsOperations } from './payments.ts';
import { HeldRequest } from '../held-request.ts';
const locationId = 'loc_fixture_01', scope = { altId: locationId, altType: 'location' };
const item = { name: 'Fixture service', currency: 'USD', amount: 12.34, qty: 2 };
const update = { ...scope, invoiceId: 'invoice_1', status: 'draft', name: 'Fixture invoice', currency: 'USD', invoiceItems: [item], issueDate: '2026-11-10', dueDate: '2026-12-10' };
const contactDetails = { id: 'contact_1', name: 'Fixture buyer', email: 'buyer@fixture.test', phoneNo: '+15550000001' };
it('F7 recovery allows invoice.create to reach the single journaled send', async () => {
  const f = createPaymentFixture({ level: 'change', autoApprove: true });
  await f.call('invoice.create', { ...scope, status: 'draft', name: 'Fixture invoice', currency: 'USD', businessDetails: { name: 'Fixture seller' }, items: [identifiedItem], discount: { type: 'fixed', value: 0 }, contactDetails, issueDate: '2026-11-10', dueDate: '2026-12-10', sentTo: { email: [contactDetails.email], phoneNo: [contactDetails.phoneNo] }, liveMode: false });
  expect(f.api.calls('POST')).toHaveLength(1);
});
it('F7 returned identity recognizes the documented invoice _id and altId response', async () => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true }); await f.call('invoice.update', update);
  expect(f.api.calls('PUT')).toHaveLength(1);
  expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('applied');
});
it('F7 review includes the exact invoice total and snapshot', async () => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true }); await f.call('invoice.update', update);
  expect(f.reviews[0]!.values).toMatchObject({ total: 24.68, invoiceReview: { total: 24.68, status: 'draft' } });
});
it('F7 read release supplies frozen location context before projection', async () => {
  const f = createPaymentFixture({ level: 'read' });
  f.api.first('GET', /^\/invoices\/invoice_1$/u, { status: 200, body: { _id: 'invoice_1', altId: 'foreign_location', altType: 'location', name: 'FOREIGN_INVOICE_SENTINEL' } });
  const result = await f.call('invoices.get', { ...scope, invoiceId: 'invoice_1' });
  expect(JSON.stringify(result)).not.toContain('FOREIGN_INVOICE_SENTINEL');
});
it('F7 freeze binds altId just like locationId', async () => {
  const op = paymentsOperations.find(s => s.id === 'payments.invoices.get')!;
  expect(op.risk).toBe('R'); if (op.risk !== 'R') return;
  const draft = await op.prepareRead({ ...scope, invoiceId: 'invoice_1' }, { locationId });
  expect(() => HeldRequest.freeze(op, draft, { locationId: 'foreign_location' })).toThrow();
});

const identifiedItem = { ...item, productId: 'product_1', taxes: [{ _id: 'tax_1', taxId: 'tax_1', name: 'Fixture tax', rate: 0, calculation: 'exclusive' }] };
const create = { ...scope, status: 'draft', name: 'Fixture invoice', currency: 'USD', businessDetails: { name: 'Fixture seller' }, items: [identifiedItem], discount: { type: 'fixed', value: 0 }, contactDetails, issueDate: '2026-11-10', dueDate: '2026-12-10', sentTo: { email: [contactDetails.email], phoneNo: [contactDetails.phoneNo] }, liveMode: false };
const text2pay = { ...scope, name: create.name, currency: 'USD', items: [identifiedItem], contactDetails, issueDate: create.issueDate, dueDate: create.dueDate, sentTo: create.sentTo, liveMode: false, userId: 'user_1', action: 'send' };

it.each(['invoice.create', 'invoice.text2pay'])('F7 %s applies a documented new invoice and caches an RPC replay', async verb => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  const input = verb.endsWith('create') ? create : text2pay;
  const path = verb.endsWith('create') ? /^\/invoices\/$/u : /^\/invoices\/text2pay$/u;
  f.api.first('POST', path, req => {
    const body = req.body as Record<string, unknown>;
    const { items, ...fields } = body;
    const invoice = { ...fields, _id: 'invoice_new', invoiceItems: items, total: 24.68 };
    return { status: 200, body: verb.endsWith('create') ? invoice : { success: true, invoice } };
  });
  const message = f.message(verb, input, 'create-replay');
  const result = await f.host.handle(f.claim, message);
  expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('applied');
  expect(f.reviews[0]!.values.total).toBe(24.68);
  expect(await f.host.handle(f.claim, message)).toEqual(result);
  expect(f.api.calls('POST')).toHaveLength(1);
  expect(f.api.calls('GET').filter(r => r.path === '/invoices/')).toHaveLength(0);
});

it.each([
  { id: 'wrong_invoice' }, { altId: 'foreign_location' },
  { contactDetails: { id: 'foreign_contact' } }, { nested: [{ invoice: { _id: 'wrong_invoice' } }] },
])('F7 complete invoice identity walk refuses conflicting response %j', async conflicting => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.api.first('PUT', /^\/invoices\/invoice_1$/u, { status: 200, body: { ...f.state.invoice, ...conflicting } });
  await f.call('invoice.update', update);
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  expect(f.api.calls('PUT')).toHaveLength(1);
  expect(row.phase).toBe('outcome_unknown');
  expect(row.receipt).toBeUndefined();
});

it.each([false, true])('F7 read location binding covers reviewed=%s and nested collection data', async reviewed => {
  const f = createPaymentFixture({ level: 'read', autoApprove: true });
  if (reviewed) (f.bot.highlevelAccess as { denyRules?: string[] }).denyRules = ['HIGHLEVEL:R'];
  f.api.first('GET', /^\/invoices\/$/u, { status: 200, body: { invoices: [{ ...f.state.invoice, altId: 'foreign_location', name: 'FOREIGN_NESTED_SENTINEL' }], total: 1 } });
  const result = await f.call('invoices.list', { ...scope, limit: '20', offset: '0' });
  expect(f.api.requests).toHaveLength(1);
  expect(f.reviews).toHaveLength(reviewed ? 1 : 0);
  expect(JSON.stringify(result)).not.toContain('FOREIGN_NESTED_SENTINEL');
  expect(JSON.stringify(result)).toContain('isError');
});

it('F7 immutable review snapshot is hashed, never journaled or placed on the wire', async () => {
  const { until } = await import('../../testing/fake-highlevel.ts');
  const { reviewDigestFor } = await import('../actions.ts');
  const f = createPaymentFixture({ level: 'full' });
  const pending = f.call('invoice.update', { ...update, invoiceItems: [{ ...item, amount: 20 }] });
  await until(() => f.reviews.length > 0);
  const review = f.reviews[0]!;
  expect(review.values).toMatchObject({ total: 40, invoiceReview: { total: 24.68, contactDetails } });
  const row = f.actions.get(review.actionId)!;
  expect(row.approvalContextDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(reviewDigestFor({ ...row, approvalContextDigest: 'changed' })).not.toBe(row.reviewDigest);
  review.values.total = 1;
  (review.values.invoiceReview as Record<string, unknown>).total = 1;
  f.state.invoice.total = 99;
  expect(f.actions.review(review.actionId)!.values).toMatchObject({ total: 40, invoiceReview: { total: 24.68 } });
  expect(JSON.stringify(row)).not.toContain(contactDetails.email);
  expect(JSON.stringify(row)).not.toContain('invoiceReview');
  f.state.invoice.total = 24.68;
  f.actions.approve(review.actionId, review.reviewDigest);
  await pending;
  const body = f.api.calls('PUT')[0]!.body as Record<string, unknown>;
  for (const key of ['total', 'invoiceReview', 'approvalContext']) expect(body).not.toHaveProperty(key);
});

it.each(['invoice.create', 'invoice.text2pay'])('F7 %s recovery binds the complete new effect and refuses partial or foreign evidence', async verb => {
  const { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery } = await import('../write-recovery.ts');
  const { bindReturnedIdentities, returnedIdentitySchemaFor } = await import('../returned-identities.ts');
  const input = verb.endsWith('create') ? create : text2pay;
  const op = paymentsOperations.find(s => s.id === `payments.${verb}`)!;
  if (op.risk === 'R') throw new Error('Expected a mutation');
  const draft = await op.prepare({ read: async () => ({ contact: { id: contactDetails.id, locationId } }) }, op.args.parse(input), { locationId });
  const held = HeldRequest.freeze(op, draft, { locationId });
  const plan = prepareWriteRecovery(held, locationId);
  expect(plan).toMatchObject({ collection: 'invoices', create: true });
  await captureRecoveryPreState(plan, { read: async (id, request) => {
    expect(id).toBe('payments.invoices.list'); expect(request.query).toMatchObject(scope);
    return { invoices: [], total: 0 };
  } });
  const { items, ...invoiceFields } = input;
  const invoice = { ...invoiceFields, _id: 'invoice_new', invoiceItems: items, createdAt: new Date(Date.now() + 1000).toISOString() };
  const result = compareWriteRecovery(plan, { invoices: [invoice], total: 1 }, op);
  expect('held' in result).toBe(true);
  if ('held' in result) expect(bindReturnedIdentities(result.value, result.held.frozen, returnedIdentitySchemaFor(result.held.frozen))).toEqual({ status: 'applied' });
  for (const bad of [
    { invoices: [invoice] }, { invoices: [invoice], total: 2 }, { invoices: [invoice], total: 1, nextPage: 2 },
    { invoices: [{ ...invoice, altId: 'foreign_location' }], total: 1 },
    { invoices: [{ ...invoice, _id: 'old_invoice', id: 'different_alias' }], total: 1 },
    { invoices: [{ ...invoice, contactDetails: { ...contactDetails, id: 'foreign_contact' } }], total: 1 },
  ]) expect(compareWriteRecovery(plan, bad, op)).toHaveProperty('outcome.status', 'conflict');
  expect(compareWriteRecovery(plan, { invoices: [{ ...invoice, createdAt: '2020-01-01T00:00:00Z' }], total: 1 }, op)).toHaveProperty('outcome.status', 'conflict');
});

it('F7 recovery persists invoice ownership IDs without persisting review values', async () => {
  const { prepareWriteRecovery, captureRecoveryPreState, saveWriteRecovery, loadWriteRecovery, compareWriteRecovery } = await import('../write-recovery.ts');
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  await f.call('invoice.update', update);
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  const op = paymentsOperations.find(s => s.id === 'payments.invoice.update')!;
  if (op.risk === 'R') throw new Error('Expected a mutation');
  const draft = await op.prepare({ read: async () => f.state.invoice }, op.args.parse(update), { locationId });
  const plan = prepareWriteRecovery(HeldRequest.freeze(op, draft, { locationId }), locationId);
  await captureRecoveryPreState(plan, { read: async () => { throw new Error('Update has no collection prestate'); } });
  // Re-save must compare exactly with the production host's durable plan.
  saveWriteRecovery(f.approvalJournal, row, plan);
  const saved = loadWriteRecovery(f.approvalJournal, row)!;
  expect(saved).toMatchObject({ recordId: 'invoice_1', approvedIdentities: { contactId: ['contact_1'] } });
  expect(JSON.stringify(saved)).not.toContain(contactDetails.email);
  expect(JSON.stringify(saved)).not.toContain('invoiceReview');
  const witness = compareWriteRecovery(saved, { ...update, _id: 'invoice_1', contactDetails }, op);
  expect('held' in witness).toBe(true);
});


it('F7 review total includes a retained invoice discount when update omits it', async () => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.state.invoice.discount = { type: 'fixed', value: 4.68 };
  f.state.invoice.total = 20;
  await f.call('invoice.update', update);
  expect(f.reviews[0]!.values).toMatchObject({ total: 20, invoiceReview: { total: 20 } });
});

it('F7 update refuses retained automatic taxes without a reviewable quote', async () => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.state.invoice.automaticTaxesEnabled = true;
  await f.call('invoice.update', update);
  expect(f.reviews).toHaveLength(0);
  expect(f.api.calls('PUT')).toHaveLength(0);
});

it.each(['total', 'discount'])('F7 financial snapshot change during owner review stales before PUT: %s', async field => {
  const { until } = await import('../../testing/fake-highlevel.ts');
  const f = createPaymentFixture({ level: 'full' });
  const pending = f.call('invoice.update', update);
  await until(() => f.reviews.length > 0);
  f.state.invoice[field] = field === 'total' ? 99 : { type: 'fixed', value: 5 };
  f.actions.approve(f.reviews[0]!.actionId, f.reviews[0]!.reviewDigest);
  await pending;
  expect(f.api.calls('PUT')).toHaveLength(0);
  expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('stale');
});


it.each([0, 101, 1000, 100000].flatMap(total => ['invoice.create', 'invoice.text2pay'].map(verb => ({ total, verb }))))('F7 bounded creation ignores $total existing invoices: $verb', async ({ total, verb }) => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.api.first('GET', /^\/invoices\/$/u, { status: 200, body: { invoices: Array.from({ length: Math.min(total, 100) }, (_, i) => ({ ...f.state.invoice, _id: `existing_${i}` })), total } });
  f.api.first('POST', verb.endsWith('create') ? /^\/invoices\/$/u : /^\/invoices\/text2pay$/u, req => {
    const { items, ...fields } = req.body as Record<string, unknown>;
    return { status: 200, body: { ...fields, _id: 'invoice_new', invoiceItems: items } };
  });
  await f.call(verb, verb.endsWith('create') ? create : text2pay);
  expect(f.api.calls('POST')).toHaveLength(1);
  expect(f.actions.get(f.reviews[0]!.actionId)?.phase).toBe('applied');
  expect(f.api.calls('GET').filter(r => r.path === '/invoices/')).toHaveLength(0);
});

it.each(['lines', 'string', 'budget', 'depth'])('F7 refuses an incomplete financial approval snapshot: %s', async kind => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  if (kind === 'lines') f.state.invoice.invoiceItems = Array.from({ length: 101 }, (_, i) => ({ ...item, name: `Line ${i}` }));
  if (kind === 'string') f.state.invoice.invoiceItems[0].description = 'x'.repeat(4001);
  if (kind === 'budget') f.state.invoice.invoiceItems = Array.from({ length: 100 }, () => ({ ...item, description: 'x'.repeat(1000) }));
  if (kind === 'depth') f.state.invoice.totalSummary = { a: { b: { c: { d: { e: { f: { g: { h: { total: 1 } } } } } } } } };
  const result = await f.call('invoice.send', { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false });
  expect(f.reviews).toHaveLength(0);
  expect(f.api.calls('POST')).toHaveLength(0);
  expect(JSON.stringify(result)).toContain('The full invoice details could not be shown for approval. Nothing was sent.');
});

it('F7 complete financial snapshot retains every item, tax, total and currency', async () => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.state.invoice.invoiceItems = Array.from({ length: 20 }, (_, i) => ({ ...identifiedItem, name: `Line ${i}` }));
  await f.call('invoice.send', { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false });
  expect(f.reviews[0]!.values.invoiceReview).toMatchObject({ invoiceItems: f.state.invoice.invoiceItems, currency: 'USD', total: 24.68 });
});

it.each(['missing', 'null', 'empty', 'references', 'partial', 'missing-name', 'missing-currency', 'missing-amount', 'missing-qty', 'null-taxes', 'partial-tax'])('F7 refuses unreviewable fetched invoice items before approval and send: %s', async kind => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  if (kind === 'missing') delete f.state.invoice.invoiceItems;
  else if (kind === 'null') f.state.invoice.invoiceItems = null;
  else if (kind === 'empty') f.state.invoice.invoiceItems = [];
  else if (kind === 'references') f.state.invoice.invoiceItems = ['product_1'];
  else if (kind === 'partial') f.state.invoice.invoiceItems = [identifiedItem, {}];
  else {
    const line: Record<string, unknown> = structuredClone(identifiedItem);
    if (kind === 'null-taxes') line.taxes = null;
    else if (kind === 'partial-tax') line.taxes = [{ name: 'Tax' }];
    else delete line[kind.slice('missing-'.length)];
    f.state.invoice.invoiceItems = [line];
  }
  const result = await f.call('invoice.send', { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false });
  expect(f.api.calls('GET').some(r => r.path === '/invoices/invoice_1')).toBe(true);
  expect(f.reviews).toHaveLength(0);
  expect(f.api.calls('POST')).toHaveLength(0);
  expect(JSON.stringify(result)).toContain('The full invoice details could not be shown for approval. Nothing was sent.');
});


it.each(['product', 'tax', 'alias'])('F7 normal invoiceItems success path withholds a conflicting %s identity', async kind => {
  const f = createPaymentFixture({ level: 'full', autoApprove: true });
  f.api.first('POST', /^\/invoices\/$/u, req => {
    const { items, ...fields } = req.body as any;
    const changed = structuredClone(items);
    if (kind === 'product') changed[0].productId = 'foreign_product';
    if (kind === 'tax' || kind === 'alias') changed[0].taxes[0].taxId = 'foreign_tax';
    return { status: 200, body: { ...fields, _id: 'invoice_new', invoiceItems: changed, ...(kind === 'alias' ? { items } : {}) } };
  });
  await f.call('invoice.create', create);
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  expect(row.phase).toBe('outcome_unknown');
  expect(row.receipt).toBeUndefined();
  expect(f.api.calls('POST')).toHaveLength(1);
});
