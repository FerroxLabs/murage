import { removeTempDirSync } from "../../testing/cleanup.ts";
import { expect, it, vi } from 'vitest';
import { paymentsOperations } from './payments.ts';
import { HeldRequest } from '../held-request.ts';
import { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery, recoveryReadDraft } from '../write-recovery.ts';
const locationId = 'loc_fixture_01';
const item = { name: 'Service', currency: 'USD', amount: 10, qty: 1, productId: 'product_1', taxes: [{ _id: 'tax_1', taxId: 'tax_1', name: 'Tax', rate: 0, calculation: 'exclusive' }] };
const input = { altId: locationId, altType: 'location', status: 'draft', name: 'Invoice', currency: 'USD', businessDetails: {}, items: [item], discount: { type: 'fixed', value: 0 }, contactDetails: { id: 'contact_1', name: 'Buyer', email: 'buyer@fixture.test', phoneNo: '+15550000001' }, issueDate: '2026-11-10', liveMode: false, sentTo: { email: ['buyer@fixture.test'] } };
async function prepared() {
  const op = paymentsOperations.find(s => s.id === 'payments.invoice.create')!;
  if (op.risk === 'R') throw new Error('Expected mutation');
  const draft = await op.prepare({ read: async () => ({ contact: { id: 'contact_1', locationId } }) }, op.args.parse(input), { locationId });
  const held = HeldRequest.freeze(op, draft, { locationId });
  const plan = prepareWriteRecovery(held, locationId);
  return { op, plan };
}
function invoice(createdAt: string) {
  const { items, ...fields } = input;
  return { ...fields, _id: 'invoice_new', invoiceItems: items, createdAt };
}
it('F7 bounded recovery never reads a collection before invoice creation', async () => {
  const { plan } = await prepared();
  const read = vi.fn(async () => ({ invoices: [], total: 100000 }));
  await expect(captureRecoveryPreState(plan, { read })).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it('F7 bounded recovery lookup has a contact filter, date window and one fixed page', async () => {
  const { plan } = await prepared();
  const query = recoveryReadDraft(plan, plan.readTargets[0]!).query!;
  expect(query).toMatchObject({ contactId: 'contact_1', limit: '100', offset: '0', startAt: new Date().toISOString().slice(0, 10) });
  expect(query.endAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
});
it('F7 bounded recovery binds invoiceItems with product and tax IDs', async () => {
  const { plan, op } = await prepared();
  await captureRecoveryPreState(plan, { read: async () => ({ invoices: [], total: 0 }) });
  const response = { invoices: [invoice(new Date(Date.now() + 1000).toISOString())], total: 1 };
  expect(compareWriteRecovery(plan, response, op)).toHaveProperty('held');
});
it.each(['empty', 'old', 'missing-time', 'truncated', 'ambiguous', 'foreign-product', 'foreign-tax', 'negative', 'over-cap', 'future', 'outside-contact'])('F7 bounded recovery leaves uncertain %s evidence unknown', async kind => {
  const { plan, op } = await prepared();
  await captureRecoveryPreState(plan, { read: async () => ({ invoices: [], total: 0 }) });
  const fresh = invoice(new Date(Date.now() + 1000).toISOString());
  let response: any = { invoices: [fresh], total: 1 };
  if (kind === 'empty') response = { invoices: [], total: 0 };
  if (kind === 'old') response.invoices[0].createdAt = '2020-01-01T00:00:00Z';
  if (kind === 'missing-time') delete response.invoices[0].createdAt;
  if (kind === 'truncated') response.total = 1000;
  if (kind === 'ambiguous') response = { invoices: [fresh, { ...structuredClone(fresh), _id: 'invoice_other' }], total: 2 };
  if (kind === 'foreign-product') response.invoices[0].invoiceItems = [{ ...item, productId: 'foreign_product' }];
  if (kind === 'foreign-tax') response.invoices[0].invoiceItems = [{ ...item, taxes: [{ ...item.taxes[0], taxId: 'foreign_tax' }] }];
  if (kind === 'negative') response.success = false;
  if (kind === 'over-cap') response = { invoices: [fresh, ...Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(fresh), _id: `old_${i}`, createdAt: '2020-01-01T00:00:00Z' }))], total: 101 };
  if (kind === 'future') response.invoices[0].createdAt = '2099-01-01T00:00:00Z';
  if (kind === 'outside-contact') response.invoices[0].contactDetails = { ...input.contactDetails, id: 'other_contact' };
  const result = compareWriteRecovery(plan, response, op);
  expect(result).toHaveProperty('outcome.status', 'conflict');
  expect(result).not.toHaveProperty('outcome.reason', 'negative_confirmation');
});


it.each(['applied', 'empty', 'partial', 'foreign'])('F7 durable invoice restart %s uses one filtered page and zero resends', async kind => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createPaymentFixture } = await import('../fake/payments.ts');
  const { HighLevelActions } = await import('../actions.ts');
  const { FileActionJournal } = await import('../journal-file.ts');
  const { FileRpcApprovalJournal } = await import('../rpc-approval-replay.ts');
  const { HighLevelHost } = await import('../host.ts');
  const { operationSpec } = await import('./registry.ts');
  const dir = mkdtempSync(join(tmpdir(), 'hlf7-bounded-'));
  const f = createPaymentFixture({ level: 'full' });
  const restart = () => {
    const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')), now: () => f.now });
    const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
    const host = new HighLevelHost({ ...f, actions, approvalJournal, operationSpec, bot: () => f.bot,
      operationScopes: () => ['invoices.write', 'invoices.readonly', 'contacts.readonly'],
      onReview: (_claim, review) => { f.reviews.push(review); actions.approve(review.actionId, review.reviewDigest); },
    });
    return { actions, approvalJournal, host };
  };
  try {
    const first = restart();
    const originalSettle = first.approvalJournal.settle.bind(first.approvalJournal);
    vi.spyOn(first.approvalJournal, 'settle').mockImplementation((id, digest, outcome) => {
      if (f.api.calls('POST').length) throw new Error('Fixture crash before settlement');
      return originalSettle(id, digest, outcome);
    });
    f.api.first('POST', /^\/invoices\/$/u, { status: 200, body: invoice(new Date(f.now + 1000).toISOString()) });
    const message = f.message('invoice.create', input, 'bounded-crash');
    await first.host.handle(f.claim, message);
    expect(f.api.calls('POST')).toHaveLength(1);
    const row = first.actions.get(f.reviews[0]!.actionId)!;
    const { loadWriteRecovery } = await import('../write-recovery.ts');
    expect(loadWriteRecovery(first.approvalJournal, row)!.invoiceLookup!.createdAfter).toBe(row.createdAt);
    expect(() => new FileActionJournal(join(dir, 'actions.jsonl'))).not.toThrow();
    const recovered = restart(); recovered.actions.recover();
    const fresh = invoice(new Date(f.now + 1000).toISOString());
    const response = kind === 'empty' ? { invoices: [], total: 0 }
      : { invoices: [kind === 'foreign' ? { ...fresh, altId: 'foreign_location' } : fresh], total: kind === 'partial' ? 1000 : 1 };
    f.api.first('GET', /^\/invoices\/$/u, req => {
      expect(Object.fromEntries(req.query)).toMatchObject({ contactId: 'contact_1', startAt: new Date(row.createdAt).toISOString().slice(0, 10), limit: '100', offset: '0' });
      return { status: 200, body: response };
    });
    const result = await recovered.host.handle(f.claim, message);
    expect(JSON.stringify(result)).toContain(kind === 'applied' ? '"outcome":"applied"' : '"outcome":"outcome_unknown"');
    expect(await recovered.host.handle(f.claim, message)).toEqual(result);
    expect(f.api.calls('POST')).toHaveLength(1);
    expect(f.api.calls('GET', /^\/invoices\/$/u)).toHaveLength(1);
  } finally { f.stop(); removeTempDirSync(dir); }
});
