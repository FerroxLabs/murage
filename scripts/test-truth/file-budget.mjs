// SPDX-License-Identifier: AGPL-3.0-or-later
import ts from 'typescript';

/** Read declared Vitest budgets without evaluating test code or fixture data. */
export function declaredTestTimeout(source, filename = 'test.ts') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let largest = 0;
  const value = node => {
    if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
    if (ts.isParenthesizedExpression(node)) return value(node.expression);
    if (ts.isBinaryExpression(node)) {
      const a = value(node.left), b = value(node.right);
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    }
    return NaN;
  };
  const root = node => ts.isIdentifier(node) ? node.text
    : ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? root(node.expression) : '';
  const note = node => { const n = value(node); if (Number.isFinite(n) && n > largest) largest = n; };
  const visit = node => {
    if (ts.isCallExpression(node) && ['it', 'test', 'describe'].includes(root(node.expression))) {
      for (const argument of node.arguments) if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) if (ts.isPropertyAssignment(property)
          && property.name.getText(ast).replaceAll(/['"]/g, '') === 'timeout') note(property.initializer);
      }
      if (node.arguments.length >= 3) note(node.arguments.at(-1));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return largest;
}

export function dedicatedFileBudget(source, filename) {
  const declared = declaredTestTimeout(source, filename);
  // Ordinary batches have a 15-minute process deadline. Long cases run alone
  // with room for two maximum-budget cases and setup/teardown. A timeout still
  // fails; the supervisor must not kill a case before its own declared budget.
  return declared >= 600_000 ? Math.max(3_900_000, declared * 2 + 120_000) : null;
}
