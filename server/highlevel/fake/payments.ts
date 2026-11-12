import { fixtureFamilyLevels } from '../testing/family-grants.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FakeHighLevelRoute } from '../fake-provider.ts';
import { paymentsOperations } from '../operations/payments.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../../testing/fake-highlevel.ts';
import { HighLevelHost, type HighLevelOutcomeRecord } from '../host.ts';
import { operationSpec } from '../operations/registry.ts';
import type { FamilyLevel } from '../../../shared/highlevel.ts';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const PAYMENT_FIXTURE_INVOICE = {
  _id: 'invoice_1', altId: FAKE_LOCATION_ID, altType: 'location', status: 'draft', name: 'Fixture invoice', currency: 'USD',
  invoiceItems: [{ name: 'Fixture service', currency: 'USD', amount: 12.34, qty: 2 }], total: 24.68, amountDue: 24.68, amountPaid: 0,
  contactDetails: { id: 'contact_1', name: 'Fixture buyer', email: 'buyer@fixture.test', phoneNo: '+15550000001' }, liveMode: false,
  updatedAt: '2026-11-10T00:00:00Z',
};
function reply(operation: string, path: string, locationId: string, invoice: Record<string, unknown>) {
  if (operation.startsWith('payments.invoice')) {
    if (operation.endsWith('.list')) return { invoices: [{ ...invoice, altId: locationId }], total: 1 };
    const saved = { ...invoice, altId: locationId };
    return operation.endsWith('recordPayment') || operation.endsWith('text2pay') ? { success: true, invoice: saved } : saved;
  }
  const kind = operation.split('.')[1]!;
  const single = { _id: `${kind.slice(0, -1)}_1`, ...(kind === 'products' ? { locationId } : { altId: locationId, altType: 'location' }), currency: 'USD', amount: 25, name: 'Fixture record' };
  return operation.endsWith('.list') ? { [kind === 'products' ? 'products' : 'data']: [single], total: 1, totalCount: 1 } : { ...single, _id: decodeURIComponent(path.split('/').at(-1)!) };
}
export const paymentsRoutes: readonly FakeHighLevelRoute[] = paymentsOperations.map(op => ({
  operation: op.id, method: op.endpoint.method, path: op.endpoint.path,
  handle(request) {
    const body = object(request.body); const locationId = request.query?.altId ?? request.query?.locationId ?? body.altId;
    if (typeof locationId !== 'string') throw new Error('Payment fixture requires a location');
    return reply(op.id, request.path, locationId, PAYMENT_FIXTURE_INVOICE);
  },
}));
export default paymentsRoutes;

/** Real host, leases, held requests, action journal and approval journal, with
 * only the provider transport replaced by the repository's in-memory fixture. */
export function createPaymentFixture(options: { level?: FamilyLevel; autoApprove?: boolean; manualSleep?: boolean } = {}) {
  const h = highLevelHarness({ deadlineMs: 2000, manualSleep: options.manualSleep });
  const access = h.bot.highlevelAccess as any;
  access.grantsVersion = 2;
  access.grants[0].families = fixtureFamilyLevels({ payments: options.level ?? 'off' });
  delete access.grants[0].operations.payments;
  const state = { invoice: structuredClone(PAYMENT_FIXTURE_INVOICE) as Record<string, any>, foreignContact: false };
  const outcomes: HighLevelOutcomeRecord[] = [];
  for (const op of paymentsOperations) h.api.always(op.endpoint.method, op.endpoint.path, req => ({ status: 200, body: reply(op.id, req.path, FAKE_LOCATION_ID, state.invoice) }));
  h.api.always('GET', /^\/contacts\/[^/]+$/u, req => ({ status: 200, body: { contact: { id: decodeURIComponent(req.path.split('/').at(-1)!), locationId: state.foreignContact ? 'foreign_location' : FAKE_LOCATION_ID } } }));
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec,
    operationScopes: () => [...new Set(paymentsOperations.map(op => op.endpoint.scope).concat('contacts.readonly'))],
    onReview: (_claim, review) => { h.reviews.push(review); if (options.autoApprove) h.actions.approve(review.actionId, review.reviewDigest); },
    onOutcome: (_claim, outcome) => outcomes.push(outcome),
  });
  let serial = 0;
  const message = (verb: string, args: unknown, id: string | number = ++serial) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'HIGHLEVEL_PAYMENTS', arguments: { operation: `payments.${verb}`, args } } });
  return { ...h, host, state, outcomes, message, call: (verb: string, args: unknown, id?: string | number) => host.handle(h.claim, message(verb, args, id)) };
}
