// SPDX-License-Identifier: AGPL-3.0-or-later
// Internal relay response producer owner: tri3-g2. Relay consumer owner: tri3-g1.
import ts from 'typescript';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { source, wiring } from './decision-wiring/fixture.ts';

it('declares the remote relay audience refusal before writing its explanatory 403', async () => {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let block: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'mcpRemoteMatch' && ts.isBlock(node.thenStatement)) block = node.thenStatement;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(block).toBeDefined();
  const response = {}, declaration = vi.fn();
  const json = vi.fn((_response, status, body) => {
    expect(declaration, 'the consuming writer requires a provenance declaration').toHaveBeenCalledExactlyOnceWith(response, 403);
    return { status, body };
  });
  const { localJson } = wiring(['localJson'], { declareNoStoredResponse: declaration, json });
  const compiled = ts.transpileModule(`globalThis.run = async () => ${block!.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const context = vm.createContext({ method: 'POST', res: response, internalClaim: {}, internalOwner: {},
    relayAudienceRefusal: () => 'This conversation cannot use that connection.', turnAudienceIsOwner: () => false, json, localJson });
  vm.runInContext(compiled, context);
  expect(await context.run()).toEqual({ status: 403, body: { error: 'This conversation cannot use that connection.' } });
});
