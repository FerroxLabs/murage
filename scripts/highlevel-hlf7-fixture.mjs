// Isolated F7 verification: no provider network or owner data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, runControlMurage, controlResultSucceeded } from './control-murage.ts';
const evidence = process.env.HLF7_EVIDENCE_DIR ?? '.test-tmp/afix2-hlf7-r3';
mkdirSync(evidence, { recursive: true });
const fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60000, instrumentationSource: `
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createPaymentFixture } = await import(${JSON.stringify(new URL('../server/highlevel/fake/payments.ts', import.meta.url).href)});
  const { until } = await import(${JSON.stringify(new URL('../server/testing/fake-highlevel.ts', import.meta.url).href)});
  const scope = { altId: 'loc_fixture_01', altType: 'location' };
  const update = { ...scope, invoiceId: 'invoice_1', status: 'draft', name: 'Fixture invoice', currency: 'USD', invoiceItems: [{ name: 'Fixture service', currency: 'USD', amount: 12.34, qty: 2 }], issueDate: '2026-11-10', dueDate: '2026-12-10' };
  const applied = createPaymentFixture({ level: 'full', autoApprove: true });
  const message = applied.message('invoice.update', update, 'isolated-replay');
  await applied.host.handle(applied.claim, message);
  await applied.host.handle(applied.claim, message);
  const row = applied.actions.get(applied.reviews[0].actionId);
  if (row.phase !== 'applied' || applied.api.calls('PUT').length !== 1 || applied.reviews[0].values.total !== 24.68 || applied.reviews[0].values.invoiceReview.total !== 24.68) throw new Error('Applied/review fixture failed');
  const read = createPaymentFixture({ level: 'read' });
  read.api.first('GET', /^\\/invoices\\/invoice_1$/u, { status: 200, body: { ...read.state.invoice, altId: 'foreign_location', name: 'FOREIGN_FIXTURE_SENTINEL' } });
  const result = await read.call('invoices.get', { ...scope, invoiceId: 'invoice_1' });
  if (JSON.stringify(result).includes('FOREIGN_FIXTURE_SENTINEL')) throw new Error('Foreign read released');
  const edit = createPaymentFixture({ level: 'full' });
  const pending = edit.call('invoice.update', update);
  await until(() => edit.reviews.length > 0);
  edit.state.invoice.status = 'sent';
  edit.actions.approve(edit.reviews[0].actionId, edit.reviews[0].reviewDigest);
  await pending;
  const stale = edit.actions.get(edit.reviews[0].actionId).phase;
  if (stale !== 'stale' || edit.api.calls('PUT').length !== 0) throw new Error('Stale draft fixture failed');
  const created = createPaymentFixture({ level: 'full', autoApprove: true });
  const items = [{ ...update.invoiceItems[0], productId: 'product_1', taxes: [{ _id: 'tax_1', taxId: 'tax_1', name: 'Tax', rate: 0, calculation: 'exclusive' }] }];
  const input = { ...scope, status: 'draft', name: 'New fixture invoice', currency: 'USD', businessDetails: {}, items, discount: { type: 'fixed', value: 0 }, contactDetails: applied.state.invoice.contactDetails, issueDate: update.issueDate, dueDate: update.dueDate, sentTo: { email: ['buyer@fixture.test'] }, liveMode: false };
  created.api.first('GET', /^\\/invoices\\/$/u, { status: 200, body: { invoices: [created.state.invoice], total: 1000 } });
  created.api.first('POST', /^\\/invoices\\/$/u, req => {
    const { items, ...fields } = req.body;
    return { status: 200, body: { ...fields, _id: 'invoice_new', invoiceItems: items } };
  });
  await created.call('invoice.create', input);
  const createdPhase = created.actions.get(created.reviews[0].actionId).phase;
  if (createdPhase !== 'applied' || created.api.calls('POST').length !== 1 || created.api.calls('GET', /^\\/invoices\\/$/u).length !== 0) throw new Error('Bounded create/identity fixture failed');
  const large = createPaymentFixture({ level: 'full', autoApprove: true });
  large.state.invoice.invoiceItems = Array.from({ length: 101 }, (_, i) => ({ ...update.invoiceItems[0], name: 'Line ' + i }));
  const largeResult = await large.call('invoice.send', { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false });
  if (large.reviews.length || large.api.calls('POST').length || !JSON.stringify(largeResult).includes('The full invoice details could not be shown for approval. Nothing was sent.')) throw new Error('Large financial approval fixture failed');
  const incompleteInvoices = [];
  for (const kind of ['missing', 'null']) {
    const incomplete = createPaymentFixture({ level: 'full', autoApprove: true });
    if (kind === 'missing') delete incomplete.state.invoice.invoiceItems;
    else incomplete.state.invoice.invoiceItems = null;
    const result = await incomplete.call('invoice.send', { ...scope, invoiceId: 'invoice_1', userId: 'user_1', action: 'email', liveMode: false });
    const evidence = { kind, result, reviews: incomplete.reviews.length, writes: incomplete.api.calls('POST').length };
    if (evidence.reviews || evidence.writes || !JSON.stringify(result).includes('The full invoice details could not be shown for approval. Nothing was sent.')) throw new Error('Incomplete financial approval fixture failed: ' + kind);
    incompleteInvoices.push(evidence);
  }
  writeFileSync(join(process.env.MURAGE_DATA_DIR, 'hlf7-result.json'), JSON.stringify({ incompleteInvoices, created: createdPhase, createWrites: created.api.calls('POST').length, createCollectionReads: created.api.calls('GET', /^\\/invoices\\/$/u).length, largeInvoiceRefusal: largeResult, largeInvoiceWrites: large.api.calls('POST').length, applied: row.phase, reviewValues: applied.reviews[0].values, replayWrites: applied.api.calls('PUT').length, foreignRead: result, stale, staleWrites: edit.api.calls('PUT').length }, null, 2));
` });
try {
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify(fixture.info, null, 2));
  const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]);
  writeFileSync(join(evidence, 'doctor.json'), JSON.stringify(doctor, null, 2));
  if (!controlResultSucceeded('doctor', doctor)) throw new Error('Isolated Doctor failed');
  writeFileSync(join(evidence, 'fixture-result.json'), readFileSync(join(fixture.info.dataDir, 'hlf7-result.json')));
  console.log('PASS isolated fixture: Doctor, exact invoice review, applied update, cached replay, foreign-read refusal, stale draft, bounded create with invoiceItems identity, 101-line refusal, missing/null item refusal');
} finally {
  await fixture.close();
  writeFileSync(join(evidence, 'fixture-server.log'), readFileSync(fixture.info.logPath));
}
