import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

// A-M1 named exception: these are separately spawned, mount-free children.
// This exception must never cover a session spawned by claude.ts.
const HEADLESS_MOUNT_FREE_ALLOW_ENTRY = "headless-text-only.ts";
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

function stdinAccesses(source: string): string[] {
  const file = ts.createSourceFile("driver.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  function visit(node: ts.Node, owner = ""): void {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? "";
    const access = ts.isPropertyAccessExpression(node) && node.name.text === "stdin"
      || ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "stdin"
      || ts.isBindingElement(node) && (node.propertyName?.getText(file) ?? node.name.getText(file)) === "stdin";
    if (access && owner !== "cliStdinWrite" && owner !== "cliStdinEnd") found.push(node.getText(file));
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(file);
  return found;
}

it("T-S2-ONE-WRITER: claude.ts stdin access is confined to the primitives", () => {
  expect(stdinAccesses(read("claude.ts"))).toEqual([]);
});
it("T-S2-ONE-WRITER-PLANTED: AST rejects write/end, aliases, cork and pipe targets", () => {
  for (const planted of [
    'child.stdin.write("bypass")', 'child.stdin.end()', 'child.stdin.cork()',
    'source.pipe(child.stdin)', 'const sink = child["stdin"]', 'const { stdin: sink } = child',
  ]) expect(stdinAccesses(planted), planted).not.toEqual([]);
});
it("T-S2-ONE-WRITER-HEADLESS-ALLOW: mount-free child exception is explicit", () => {
  expect(HEADLESS_MOUNT_FREE_ALLOW_ENTRY).toBe("headless-text-only.ts");
  expect(stdinAccesses(read(HEADLESS_MOUNT_FREE_ALLOW_ENTRY)).length).toBeGreaterThan(0);
});
it("T-S2-ONE-WRITER-RELAY: a relay cannot end the retained Claude child's stdin", () => {
  // Intentionally exposes the fenced S1 interface blocker. Do not allowlist:
  // finish(cli) receives the very child whose stdin S2 must exclusively own.
  const file = ts.createSourceFile("relay.ts", read("cli-mount-relay.ts"), ts.ScriptTarget.Latest, true);
  const accesses: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "stdin" && node.expression.getText(file) === "cli") accesses.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(accesses).toEqual([]);
});
