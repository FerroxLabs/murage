// SPDX-License-Identifier: AGPL-3.0-or-later
import ts from "typescript";

const parsed = new Map<string, ts.SourceFile>();
function tree(source: string): ts.SourceFile {
  let file = parsed.get(source);
  if (!file) { file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true); parsed.set(source, file); }
  return file;
}

/** Select the complete declaration, including nested callbacks. A dispatcher
 * wrapper is a different declaration and must be selected explicitly. */
export function fixtureFunctionSource(source: string, name: string): string {
  const file = tree(source);
  const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (found.length !== 1) throw new Error(`fixture function ${name}: declarations=${found.length}`);
  return found[0]!.getText(file);
}

export function fixtureBindingStart(source: string, name: string): number {
  const file = tree(source), found: ts.VariableDeclaration[] = [];
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) found.push(declaration);
  }
  if (found.length !== 1) throw new Error(`fixture binding ${name}: declarations=${found.length}`);
  return found[0]!.getStart(file);
}

/** Count synchronous calls in a named callback property. Calls deferred into
 * another function do not establish that the hook invokes its validator. */
export function fixturePropertyCalls(source: string, property: string, callee: string, argument: string): number {
  const file = tree(source); let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === property
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const call = (part: ts.Node): void => {
        if (ts.isFunctionLike(part)) return;
        if (ts.isCallExpression(part) && part.expression.getText(file) === callee && part.arguments.length === 1
          && part.arguments[0]!.getText(file) === argument) count++;
        ts.forEachChild(part, call);
      };
      call(node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return count;
}

/** Lift exactly one actual subscription call, never a neighbouring substring
 * or a comment that happens to spell the previous event-bus API. */
export function fixtureSubscriptionSource(source: string, callee: string, marker: string): string {
  const file = tree(source), found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === callee
      && node.arguments[0] && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
      && node.arguments[0].getText(file).includes(marker)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found.length !== 1) throw new Error(`fixture subscription ${callee}: matches=${found.length}`);
  return found[0]!.getText(file);
}
