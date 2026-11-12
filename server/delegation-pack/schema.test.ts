// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect the migration without importing its module or executing any SQL.
function migrationSql(): string {
  const source = ts.createSourceFile("schema.ts", readFileSync(new URL("./schema.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const initializer = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "initializeDelegationPacks");
  expect(initializer?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
  const statements: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "db" && node.expression.name.text === "exec") {
      const sql = node.arguments[0];
      expect(sql && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))).toBe(true);
      if (sql && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))) statements.push(sql.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer!);
  return statements.join("\n").replace(/\s+/g, " ").trim();
}

describe("delegation_packs migration declaration", () => {
  const guards: Array<[string, RegExp, (sql: string) => string]> = [
    ["T-SCHEMA-IDEMPOTENT: mutant removes IF NOT EXISTS", /CREATE TABLE IF NOT EXISTS delegation_packs\s*\(/i, sql => sql.replace("IF NOT EXISTS", "")],
    ["T-SCHEMA-DELEGATION: mutant removes unique delegation binding", /delegation_id TEXT NOT NULL UNIQUE/i, sql => sql.replace("delegation_id TEXT NOT NULL UNIQUE", "delegation_id TEXT NOT NULL")],
    ["T-SCHEMA-DESTINATION: mutant requires a destination at enqueue", /destination_thread_id TEXT\s*,/i, sql => sql.replace("destination_thread_id TEXT", "destination_thread_id TEXT NOT NULL")],
    ["T-SCHEMA-PREPARED: mutant stores released instead of prepared", /prepared TEXT NOT NULL DEFAULT '\[\]'/i, sql => sql.replace("prepared TEXT", "released TEXT")],
  ];
  it.each(guards)("%s", (_name, guard, mutate) => {
    const sql = migrationSql();
    expect(sql).toMatch(guard);
    expect(mutate(sql)).not.toMatch(guard);
  });

  it("T-SCHEMA-REPLAY: packs survive queue cleanup; mutant adds a pending-delegations foreign key", () => {
    const sql = migrationSql();
    const foreignKey = /REFERENCES\s+pending_delegations/i;
    expect(sql).not.toMatch(foreignKey);
    expect(sql.replace("delegation_id TEXT NOT NULL UNIQUE", "delegation_id TEXT NOT NULL UNIQUE REFERENCES pending_delegations(id)")).toMatch(foreignKey);
  });

  it("T-SCHEMA-ROW: storage has the ten metadata columns and no copied text", () => {
    const sql = migrationSql();
    const body = sql.match(/CREATE TABLE IF NOT EXISTS delegation_packs\s*\(([^)]+)\)/i)?.[1];
    expect(body?.split(",").map(column => column.trim().split(/\s+/)[0])).toEqual([
      "id", "delegation_id", "source_thread_id", "source_bot_id", "target_bot_id", "destination_thread_id", "refs", "prepared", "cut_at", "created_at",
    ]);
    expect(sql).toMatch(/refs TEXT NOT NULL/);
    expect(sql).toMatch(/cut_at INTEGER NOT NULL/);
    expect(sql).toMatch(/created_at INTEGER NOT NULL/);
  });
});
