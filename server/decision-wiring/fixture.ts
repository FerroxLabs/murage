// SPDX-License-Identifier: AGPL-3.0-or-later
// Evaluate the actual index.ts functions without starting its process-wide app.
// Dependencies are injected at the S0 boundary; no second implementation of S4.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
export const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
export function wiring(names: string[], globals: Record<string, unknown> = {}) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies = names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  }).join('\n');
  const js = ts.transpileModule(`${bodies}\n;globalThis.result={${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ console, Date, Map, Set, Object, JSON, Promise, URL, ...globals });
  vm.runInContext(js, context);
  return context.result as Record<string, (...args: any[]) => any>;
}
export const owner = { personId: 'workspace-owner', bindingId: 'local', revision: 1 };
export const routine = { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'bot', recipientGeneration: 'g', trigger: 'manual' };
