import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

// Structural regression only. This does not replace the required driver
// observables (no live.turn / turn.started during a delayed S2 reconnect).
it("T-S2-START-ORDER-STATIC: no unconditional turn start before the reused readiness await", () => {
  const source = readFileSync(new URL("claude.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("claude.ts", source, ts.ScriptTarget.Latest, true);
  let inspected = 0;
  function visit(node: ts.Node) {
    if (ts.isBlock(node)) {
      const index = node.statements.findIndex(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(declaration => declaration.name.getText(file) === "reused"
          && declaration.initializer && ts.isAwaitExpression(declaration.initializer)));
      if (index >= 0) {
        inspected++;
        const early = node.statements.slice(0, index).filter(statement => ts.isExpressionStatement(statement)
          && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(file) === "startLiveTurn");
        expect(early.map(statement => statement.getText(file))).toEqual([]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); expect(inspected).toBe(1);
});
