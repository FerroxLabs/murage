import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { gitFixture } from "./testing/git-fixture.mjs";
import { afterAll, beforeAll, expect, it } from "vitest";

let repository: ReturnType<typeof gitFixture>;
beforeAll(() => { repository = gitFixture(); }, 120_000);
afterAll(() => repository?.dispose());

const owner = "server/thread-summary.ts";
const permitted = new Set(["bumpChatsGen", "remintChatsGen"]);
function inspect(path: string, source: string) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = new Set(["CHATS_GEN_TABLE"]);
  const literals: string[] = [], writers: string[] = [], violations: string[] = [];
  function imports(node: ts.Node) {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "CHATS_GEN_TABLE") names.add(node.name.text);
    ts.forEachChild(node, imports);
  }
  imports(file);
  function visit(node: ts.Node, enclosing = "<module>") {
    if (ts.isFunctionDeclaration(node)) enclosing = node.name?.text ?? "<anonymous>";
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const value = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map(span => `${names.has(span.expression.getText(file)) ? "chats_gen" : "?"}${span.literal.text}`).join("")
        : node.text;
      if (/\bchats_gen\b/.test(value)) {
        literals.push(path);
        if (path !== owner) violations.push(`${path}: generation SQL/name must use the owning module`);
        if (/\b(?:UPDATE\s+|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+|REPLACE\s+INTO\s+|DELETE\s+FROM\s+)["`\[]?chats_gen\b/i.test(value)) {
          writers.push(enclosing);
          if (path !== owner || !permitted.has(enclosing)) violations.push(`${path}: forbidden generation writer ${enclosing}`);
        }
      }
      // Template spans have been inspected as one SQL statement.
      if (ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, child => visit(child, enclosing));
  }
  visit(file);
  return { literals, writers, violations };
}

it("T-G2-writers: production names and SQL belong to the exported-name boundary with exactly two writers", () => {
  const paths = repository.git("ls-files", "-z").split("\0").filter(path =>
    /\.(?:[cm]?js|tsx?)$/.test(path) && !/(?:^|\/)(?:testing|test|tests|fixtures|__fixtures__)(?:\/)|\.(?:test|spec|fixture)\./.test(path));
  const results = paths.map(path => inspect(path, readFileSync(join(repository.root, path), "utf8")));
  expect(results.flatMap(result => result.violations)).toEqual([]);
  expect([...new Set(results.flatMap(result => result.literals))]).toEqual([owner]);
  expect([...new Set(results.flatMap(result => result.writers))].sort()).toEqual([...permitted].sort());
});

it("T-G2-writers guard rejects outside literals, aliased table SQL and a third owner-module writer", () => {
  expect(inspect("server/other.ts", 'const table = "chats_gen";').violations).toHaveLength(1);
  expect(inspect("server/other.ts", 'import { CHATS_GEN_TABLE as table } from "./thread-summary.ts"; function third() { db.exec(`UPDATE ${table} SET rev=0`); }').violations).toHaveLength(2);
  expect(inspect(owner, 'function third() { db.exec("UPDATE chats_gen SET rev=0"); }').violations).toEqual([`${owner}: forbidden generation writer third`]);
  expect(inspect("server/other.ts", 'import { CHATS_GEN_TABLE, CHATS_PREVIEW_TABLES, bumpChatsGen } from "./thread-summary.ts"; const names = [...CHATS_PREVIEW_TABLES]; bumpChatsGen(db);').violations).toEqual([]);
});
