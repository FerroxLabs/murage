import { fixtureSpec } from '../testing/highlevel-r4-fixtures.ts';
import { z } from 'zod';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { HIGHLEVEL_OPERATION_MANIFEST, operationSpec } from './operations/registry.ts';
import { HIGHLEVEL_FAMILY_TOOLS } from '../../shared/highlevel.ts';
import { highLevelHarness } from '../testing/fake-highlevel.ts';
import { HighLevelHost } from './host.ts';
import { completeReconciliationCollection, readReconciliation } from './reconciliation-read.ts';
import { COLLECTION_IDENTITY_POLICY } from './recovery-contract.ts';
const source = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
function all(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const rows: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) rows.push(node); ts.forEachChild(node, visit); };
  visit(root); return rows;
}
it('MAIN P1 AST inventory: all reconciliation reads use the shared typed guard', () => {
  const files = readdirSync('server/highlevel').filter(name => /(?:recover|replay).*\.ts$/.test(name) && !name.endsWith('.test.ts'));
  const inventory: string[] = [];
  for (const file of files) {
    const ast = source(`server/highlevel/${file}`);
    const direct = all(ast, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'read');
    expect(direct.map(n => n.getText(ast)), file).toEqual([]);
    for (const call of all(ast, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'readReconciliation')) inventory.push(`${file}:${ast.getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
  }
  const host = source('server/highlevel/host.ts');
  const recovery = all(host, n => ts.isMethodDeclaration(n) && /reconcile/i.test(n.name.getText(host)));
  for (const method of recovery) expect(all(method, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'read')).toEqual([]);
  expect(inventory.length).toBeGreaterThanOrEqual(8);
  console.log('Reconciliation read inventory:', inventory.join(', '));
});
it.each(HIGHLEVEL_OPERATION_MANIFEST.map(row => [row.id, row.family] as const))('MAIN P1 one entry: %s', async (operation, family) => {
  const h = highLevelHarness();
  const call = vi.spyOn(h.host, 'call').mockResolvedValue({ content: [{ type: 'text', text: 'entry' }] });
  try {
    await h.host.handle(h.claim, { jsonrpc: '2.0', id: operation, method: 'tools/call', params: { name: HIGHLEVEL_FAMILY_TOOLS[family], arguments: { operation, args: {} } } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe(HIGHLEVEL_FAMILY_TOOLS[family]);
  } finally { h.stop(); }
});
it('MAIN P1 runtime supplies exactly one approval journal and legacy call journal', () => {
  const ast = source(process.env.HLINT_RUNTIME_SOURCE ?? 'server/highlevel/runtime.ts');
  const hosts = all(ast, n => ts.isNewExpression(n) && n.expression.getText(ast) === 'HighLevelHost') as ts.NewExpression[];
  expect(hosts).toHaveLength(1);
  const properties = (hosts[0].arguments![0] as ts.ObjectLiteralExpression).properties.map(p => p.name?.getText(ast));
  expect(properties.filter(p => p === 'approvalJournal')).toHaveLength(1);
  expect(properties.filter(p => p === 'callJournal')).toHaveLength(1);
  expect(properties).not.toContain('approvals'); expect(properties).not.toContain('calls');
  const host = source('server/highlevel/host.ts');
  const boundary = all(host, n => ts.isMethodDeclaration(n) && n.name.getText(host) === '#dispatchWrite');
  expect(boundary).toHaveLength(1);
  expect(boundary[0].getText(host)).toContain('this.#deps.approvalJournal');
  const sends = all(host, n => ts.isCallExpression(n) && n.expression.getText(host) === 'sendFrozen');
  expect(sends).toHaveLength(2); // One write boundary, one guarded reviewed read.
  expect(all(boundary[0], n => ts.isCallExpression(n) && n.expression.getText(host) === 'sendFrozen')).toHaveLength(1);
});
it.each(HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.risk !== 'R' && row.disposition === 'ready').map(row => row.id))('MAIN P1 journal is mandatory: %s', async operation => {
  const h = highLevelHarness();
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === operation)!;
  const spec = operationSpec(operation) ?? fixtureSpec({ id: operation, family: row.family, risk: row.risk, nested: false, preflight: [], args: z.object({}), recordRefs: () => [], fields: () => [], targets: () => 1, project: (v: unknown) => v }, () => { throw new Error('Unjournaled preparation'); });
  const host = new HighLevelHost({ ...h, approvalJournal: undefined, bot: () => h.bot,
    operationSpec: id => id === operation ? { ...spec, args: { safeParse: () => ({ success: true, data: {} }) } } as any : operationSpec(id) });
  try {
    const result = await host.call(h.claim, HIGHLEVEL_FAMILY_TOOLS[spec.family], { operation, args: {} });
    expect(JSON.stringify(result)).toMatch(/journal.*unavailable/);
    expect(h.api.requests).toHaveLength(0);
  } finally { h.stop(); }
});
it.each(['contacts.search', 'opportunities.search'] as const)('HL-RECOVERY-2 separates %s completeness from raw-page admission', operation => {
  const key = operation.split('.')[0];
  // Astra-agreed r2.1 §2.1 supersedes the structural demand to reject every partial first page.
  // C2 owns raw-page admission/accumulation; incomplete observations never prove absence/application.
  expect(COLLECTION_IDENTITY_POLICY.firstPageCompleteness).toBe('not-required');
  expect(COLLECTION_IDENTITY_POLICY.absenceProvesEffect).toBe(false);
  for (const extra of [{ total: 0, hasMore: true }, { total: 0, nextCursor: 'more' }, { total: 1 }, {}, { total: 0, meta: { total: 1 } }]) {
    expect(completeReconciliationCollection({ [key]: [], ...extra }, 0, true)).toBe(false);
  }
  expect(completeReconciliationCollection({ [key]: [], total: 0 }, 0, true)).toBe(true);
});
it('HL-RECOVERY-2 raw negative flags remain a refusal before projection', async () => {
  await expect(readReconciliation({ read: async () => ({ contacts: [], total: 0, meta: { success: false } }) }, 'contacts.search', { path: '/unused' })).rejects.toThrow('Unconfirmed');
});

it.each(['contacts', 'opportunities', 'pipelines', 'notes', 'tasks'])('MAIN P1 continuation also invalidates the %s collection', key => {
  for (const extra of [{ hasMore: true }, { nextCursor: 'more' }, { total: 1 }, { meta: { total: 0, hasMore: true } }]) {
    expect(completeReconciliationCollection({ [key]: [], total: 0, ...extra }, 0, false)).toBe(false);
  }
});
