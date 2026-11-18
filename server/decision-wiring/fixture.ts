// SPDX-License-Identifier: AGPL-3.0-or-later
// Evaluate the actual index.ts functions without starting its process-wide app.
// Dependencies are injected at the S0 boundary; no second implementation of S4.
// Production wiring owner: MAIN; fixture dependency owner: x3-restore.
import ts from 'typescript';
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { setRuntimeCredentialRoot } from '../../shared/runtime-credential-paths.ts';
import { ShellSessionRegistry } from '../shell-session-state.ts';
export const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
export function wiring(names: string[], globals: Record<string, unknown> = {}) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies = names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  }).join('\n');
  const js = ts.transpileModule(`${bodies}\n;globalThis.result={${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ console, Date, Map, Set, Object, JSON, Promise, URL, autoAnsweredAsks: new Set<string>(),
    internalTurnOwners: new Map(), readApproval: () => undefined, setRuntimeCredentialRoot, randomUUID, realpathSync,
    shellSessions: new ShellSessionRegistry(),
    // LLS (nativecrash): Stop reads the turn refusal of its generation; a fixture that models no refusal has none (a suite that
    // extracts refusedTurnOf, or passes its own, overrides these).
    refusedTurnOf: () => undefined, stopInterrupts: new Map(), refusalStopGenerations: new Set(),
    highlevel: { host: { onLevelChange: async () => {} } }, ...globals });
  vm.runInContext(js, context);
  return context.result as Record<string, (...args: any[]) => any>;
}
export const owner = { personId: 'workspace-owner', bindingId: 'local', revision: 1 };
export const routine = { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'bot', recipientGeneration: 'g', trigger: 'manual' };

/** Extract an existing callback or block, retaining production syntax. */
export function wiringCallArg(callee: string, firstArg: string, globals: Record<string, unknown> = {}) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === callee) {
      if (callee === 'installProducerBindings') {
        const object = node.arguments[0];
        if (ts.isObjectLiteralExpression(object)) {
          const property = object.properties.find(p => p.name?.getText(ast) === firstArg);
          if (property && ts.isPropertyAssignment(property)) body = property.initializer.getText(ast);
        }
      } else if (ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === firstArg) body = node.arguments[1].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!body) throw Error(`Missing callback: ${callee}/${firstArg}`);
  return evaluate(`(${body})`, globals);
}
export function wiringBlock(fn: string, anchor: string, globals: Record<string, unknown> = {}) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // startTurn delegates admission to startTurnAdmitting on this base. Resolve
  // that production entry's block without duplicating or inventing its body.
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && (n.name?.text === fn || n.name?.text === fn + 'Admitting')) as ts.FunctionDeclaration[];
  function findBlock(node: ts.Node): ts.Node | undefined {
    if (node.getText(ast).startsWith(anchor)) return node;
    return ts.forEachChild(node, findBlock);
  }
  const block = declarations.map(n => n.body ? findBlock(n.body) : undefined).find(n => n !== undefined);
  if (!block) throw Error(`Missing block: ${fn}/${anchor}`);
  return evaluate(`async (opts) => { ${block.getText(ast)}; return opts; }`, globals);
}
function evaluate(expression: string, globals: Record<string, unknown>) {
  const js = ts.transpileModule(`globalThis.result = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ console, Date, Map, Set, Object, JSON, Promise, URL, ...globals });
  vm.runInContext(js, context);
  return context.result as (...args: any[]) => any;
}
