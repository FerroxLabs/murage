import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { test } from 'vitest';

function missingCauses(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const missing = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'quit' && /^(this\.)?app$/.test(node.expression.expression.getText(tree))) {
      let statement = node;
      while (statement.parent && !ts.isExpressionStatement(statement)) statement = statement.parent;
      const siblings = statement.parent?.statements;
      const previous = siblings?.[siblings.indexOf(statement) - 1]?.getText(tree) ?? '';
      const receiver = node.expression.expression.getText(tree);
      const marked = /^noteShutdownCause\(.+\);$/.test(previous) ||
        previous.startsWith(`${receiver}.murageShutdownCause = `);
      if (!marked) missing.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return missing;
}
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:mjs|cjs|js|ts)$/.test(path) && !/\.(?:node-test|test|spec)\./.test(path) ? [path] : [];
  });
}
test('DQ-2: every internal app.quit call sets a cause immediately before quitting', () => {
  const files = sources('electron');
  assert.deepEqual(files.flatMap(file => missingCauses(readFileSync(file, 'utf8'), file)), []);
});
test('DQ-2: scanner rejects unmarked calls in callbacks and ignores comments and strings', () => {
  assert.equal(missingCauses('setImmediate(() => app.quit()); this.app.quit();', 'fixture.js').length, 2);
  assert.deepEqual(missingCauses('// app.quit();\nconst text = "app.quit()";', 'fixture.js'), []);
  assert.deepEqual(missingCauses('noteShutdownCause("owner"); app.quit();', 'fixture.js'), []);
});
