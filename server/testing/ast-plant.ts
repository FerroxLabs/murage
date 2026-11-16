// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface AstLocator {
  kind: "call" | "prop" | "stmt" | "decl" | "body";
  name?: string;
  in?: string;
  nth?: number;
  text?: string;
  pattern?: string;
}
export interface AstEdit {
  kind: "replace" | "before" | "after" | "body" | "drop" | "replaceText";
  text?: string;
  from?: string;
  to?: string;
}
export type PlantEdit = string | AstEdit | ((node: ts.Node, text: string) => string);
export const call = (name: string, options: Omit<AstLocator, "kind" | "name"> = {}): AstLocator => ({ kind: "call", name, ...options });
export const prop = (name: string, options: Omit<AstLocator, "kind" | "name"> = {}): AstLocator => ({ kind: "prop", name, ...options });
export const stmt = (pattern: RegExp, options: Omit<AstLocator, "kind" | "pattern"> = {}): AstLocator => ({ kind: "stmt", pattern: pattern.source, ...options });
export const decl = (name: string, options: Omit<AstLocator, "kind" | "name"> = {}): AstLocator => ({ kind: "decl", name, ...options });

function functionName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText() ?? "";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
  }
  return "";
}
function within(node: ts.Node, name?: string): boolean {
  if (!name) return true;
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (functionName(current) === name) return true;
  return false;
}
function matches(node: ts.Node, locator: AstLocator): boolean {
  let selected = false;
  switch (locator.kind) {
    case "call": selected = ts.isCallExpression(node) && (ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText()) === locator.name; break;
    case "prop": selected = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAccessExpression(node)) && node.name.getText() === locator.name; break;
    case "stmt": selected = ts.isStatement(node) && !ts.isBlock(node); break;
    case "decl": selected = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText() === locator.name; break;
    case "body": selected = ts.isBlock(node) && functionName(node.parent) === locator.name; break;
  }
  return selected && within(node, locator.in) && (locator.text === undefined || node.getText().includes(locator.text)) && (locator.pattern === undefined || new RegExp(locator.pattern).test(node.getText()));
}
export function locate(file: string, locator: AstLocator, source = readFileSync(file, "utf8")): ts.Node {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => { if (matches(node, locator)) found.push(node); ts.forEachChild(node, visit); };
  visit(sf);
  const node = locator.nth === undefined ? found.length === 1 ? found[0] : undefined : Number.isInteger(locator.nth) && locator.nth >= 0 ? found[locator.nth] : undefined;
  if (!node) throw new Error(`MUTANT_NOT_ACTIVATED ${file}: ${JSON.stringify(locator)} matched ${found.length} nodes`);
  return node;
}
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
export function plantWithProof(file: string, locator: AstLocator, edit: PlantEdit, source = readFileSync(file, "utf8")): { text: string; proof: { matches: 1; start: number; end: number; before: string; after: string } } {
  const node = locate(file, locator, source), original = node.getText();
  let replacement: string;
  if (typeof edit === "function") replacement = edit(node, original);
  else if (typeof edit === "string") replacement = edit;
  else switch (edit.kind) {
    case "replace": replacement = edit.text ?? ""; break;
    case "drop": replacement = ""; break;
    case "before": replacement = (edit.text ?? "") + original; break;
    case "after": replacement = original + (edit.text ?? ""); break;
    case "body": {
      const body = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ? node.body : undefined;
      if (!body) throw new Error(`MUTANT_NOT_ACTIVATED ${file}: selected declaration has no body`);
      replacement = original.slice(0, body.getStart() - node.getStart()) + (edit.text ?? "{}") + original.slice(body.getEnd() - node.getStart());
      break;
    }
    case "replaceText": {
      if (!edit.from || original.split(edit.from).length !== 2) throw new Error(`MUTANT_NOT_ACTIVATED ${file}: edit must match exactly once`);
      replacement = original.replace(edit.from, edit.to ?? "");
      break;
    }
  }
  if (digest(original) === digest(replacement)) throw new Error(`MUTANT_NOT_ACTIVATED ${file}: selected node did not change`);
  return { text: source.slice(0, node.getStart()) + replacement + source.slice(node.getEnd()), proof: { matches: 1, start: node.getStart(), end: node.getEnd(), before: digest(original), after: digest(replacement) } };
}
export function plant(file: string, locator: AstLocator, edit: PlantEdit, source?: string): string { return plantWithProof(file, locator, edit, source).text; }
