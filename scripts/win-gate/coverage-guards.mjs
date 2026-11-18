// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import ts from 'typescript';

/** Read Vitest registrations, including imported/constant aliases and each().
 * Unknown qualification inputs stay unknown; only proven Windows exclusions
 * are returned. No test module or callback is executed by this contract.
 */
export function windowsExclusions(source) {
  const tree = ts.createSourceFile('coverage.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unknown = Symbol('unknown');
  const bindings = new Map();
  const registrar = (kind, skipped = false) => ({ kind, skipped });
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'vitest') continue;
    for (const entry of statement.importClause?.namedBindings?.elements ?? []) {
      const original = (entry.propertyName ?? entry.name).text;
      if (['it', 'test', 'describe', 'suite'].includes(original)) bindings.set(entry.name.text, registrar(['describe', 'suite'].includes(original) ? 'suite' : 'test'));
    }
  }
  function value(node) {
    if (!node) return unknown;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return value(node.expression);
    if (ts.isIdentifier(node)) return bindings.get(node.text) ?? unknown;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = value(node.operand); return operand === unknown ? unknown : !operand;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.getText(tree) === 'process' && node.name.text === 'platform') return 'win32';
      const owner = value(node.expression);
      if (owner?.kind && node.name.text === 'skip') return registrar(owner.kind, true);
      if (owner?.kind && ['only', 'concurrent', 'sequential'].includes(node.name.text)) return owner;
      return unknown;
    }
    if (ts.isBinaryExpression(node)) {
      const left = value(node.left), right = value(node.right);
      if (left === unknown || right === unknown) return unknown;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsToken: return left === right;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: case ts.SyntaxKind.ExclamationEqualsToken: return left !== right;
        case ts.SyntaxKind.AmpersandAmpersandToken: return left && right;
        case ts.SyntaxKind.BarBarToken: return left || right;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = value(node.expression.expression), method = node.expression.name.text;
      if (!owner?.kind) return unknown;
      if (method === 'each' || method === 'for') return owner;
      if (method === 'skipIf' || method === 'runIf') {
        const condition = value(node.arguments[0]);
        if (condition === unknown) return unknown;
        return registrar(owner.kind, owner.skipped || (method === 'skipIf' ? !!condition : !condition));
      }
    }
    return unknown;
  }
  function bind(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const resolved = value(node.initializer);
      if (resolved !== unknown) bindings.set(node.name.text, resolved);
    }
    ts.forEachChild(node, bind);
  }
  bind(tree);
  const exclusions = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const target = value(node.expression), title = value(node.arguments[0]);
      if (target?.kind && target.skipped && typeof title === 'string') {
        exclusions.push({ kind: target.kind, title, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return exclusions;
}
