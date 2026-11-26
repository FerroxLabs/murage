// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W, W-COMMIT (design 3.1): the static half. Every call site in server/** (tests and testing/ excluded) that runs a
// statement ending a transaction (COMMIT, END, RELEASE, ROLLBACK; a ROLLBACK TO alone ends nothing) through exec() or prepare(), found by
// the TypeScript parser, not by a line grep: a call split over lines, a template, a `cond ? a : b` choice and a `const X = "COMMIT"` named
// once and run elsewhere are all found. Each site is named `file:line:column function#k` (the column of the method name, as a stack frame reports the call) (k counts that function's sites in source order), so the
// list in commit-sites.txt changes whenever a site is added, removed or moved, and the per-site drivers key on `file function#k`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type EndKind = "commit" | "release" | "rollback" | "choice";
export interface CommitSite { file: string; line: number; col: number; fn: string; k: number; method: "exec" | "prepare"; text: string; kind: EndKind; embedded: boolean; callee: [number, number] }
export const siteId = (site: Pick<CommitSite, "file" | "fn" | "k">) => `${site.file} ${site.fn}#${site.k}`;
export const siteEntry = (site: CommitSite) => `${site.file}:${site.line}:${site.col} ${site.fn}#${site.k} ${site.kind}`;

const END = /(?:^|;)\s*(?:COMMIT|END)(?:\s+TRANSACTION)?\s*(?:;|$)|(?:^|;)\s*RELEASE\b|(?:^|;)\s*ROLLBACK(?!\s+TO\b)(?:\s+TRANSACTION)?\s*(?:;|$)/i;
/** The text with SQL comments and every CREATE TRIGGER ... BEGIN ... END body removed: a body's END (and a CASE ... END inside it) ends no
 *  transaction, wherever the trigger sits in a multi-statement text. */
function withoutTriggerBodies(text: string): string {
  let sql = text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (;;) {
    const head = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b/i.exec(sql);
    if (!head) return sql;
    const words = /\b(CASE|END)\b/gi;
    words.lastIndex = head.index + head[0].length;
    let depth = 0, stop = sql.length;
    for (let word = words.exec(sql); word; word = words.exec(sql)) {
      if (word[1]!.toUpperCase() === "CASE") depth++;
      else if (depth > 0) depth--;
      else { stop = word.index + word[0].length; break; }
    }
    sql = `${sql.slice(0, head.index)} ${sql.slice(stop)}`;
  }
}
const kindOf = (raw: string): EndKind | null => {
  const text = withoutTriggerBodies(raw);
  if (!END.test(text)) return null;
  if (/(?:^|;)\s*(?:COMMIT|END)\b/i.test(text)) return "commit"; // also after DDL or a ROLLBACK TO in the same text
  if (/(?:^|;)\s*ROLLBACK\s+TO\b/i.test(text)) return "rollback"; // ROLLBACK TO + RELEASE: the savepoint's work is undone
  if (/(?:^|;)\s*RELEASE\b/i.test(text)) return "release";
  return "rollback";
};

function files(dir: string, root: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "testing" && entry.name !== "fixtures" && entry.name !== "testdata") files(path, root, out); }
    else if (/\.(?:ts|mts)$/.test(entry.name) && !/\.test\.m?ts$|-test-support\.ts$|\.fixture\.ts$|fixtures?\.ts$|\.gen\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(relative(root, path).split("\\").join("/"));
  }
  return out;
}

function fnName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isGetAccessor(at) || ts.isSetAccessor(at)) {
      const own = at.name ? at.name.getText() : "default";
      const cls = ts.isClassLike(at.parent) && at.parent.name ? `${at.parent.name.getText()}.` : "";
      return cls + own;
    }
    if (ts.isConstructorDeclaration(at)) return `${ts.isClassLike(at.parent) && at.parent.name ? at.parent.name.getText() : "class"}.constructor`;
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
      const holder = at.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) return holder.name.getText();
    }
  }
  return "(module)";
}

/** The string texts an argument can take: literals, templates (`${...}` as `?`), both arms of a choice, and a const of this file. */
function texts(node: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): string[] {
  if (depth > 4) return [];
  if (ts.isParenthesizedExpression(node)) return texts(node.expression, consts, depth + 1);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map(span => `?${span.literal.text}`).join("")];
  if (ts.isConditionalExpression(node)) return [...texts(node.whenTrue, consts, depth + 1), ...texts(node.whenFalse, consts, depth + 1)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = texts(node.left, consts, depth + 1), right = texts(node.right, consts, depth + 1);
    return left.flatMap(a => (right.length ? right : ["?"]).map(b => a + b));
  }
  if (ts.isIdentifier(node) && consts.has(node.text)) return texts(consts.get(node.text)!, consts, depth + 1);
  return [];
}

/** A template that holds worker code (`new Worker(SOURCE, { eval: true })`): its text with every `${...}` blanked (newlines kept), so the
 *  code inside parses with the same line numbers it has in the file. */
function embedded(node: ts.TemplateLiteral, source: ts.SourceFile): string {
  const start = node.getStart(source) + 1, end = node.getEnd() - 1;
  const chars = source.text.slice(start, end).split("");
  if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) {
    for (let at = span.expression.getFullStart() - 2 - start; at < span.literal.getStart(source) + 1 - start; at++) if (chars[at] !== "\n") chars[at] = at === span.expression.getFullStart() - 2 - start ? "0" : " ";
  }
  return chars.join("").replace(/\\([`$])/g, " $1");
}

export function scanFile(root: string, file: string, text = readFileSync(join(root, file), "utf8"), lineOffset = 0, outer = ""): CommitSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, ts.Expression>();
  const sites: CommitSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) consts.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const inner: CommitSite[] = [];
  const calls = (node: ts.Node) => {
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /\.(?:exec|prepare)\(/.test(node.getText(source))) {
      const holder = fnName(node) === "(module)" ? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : ts.isTaggedTemplateExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.name.getText(source) : "(template)") : fnName(node);
      inner.push(...scanFile(root, file, embedded(node, source), lineOffset + source.getLineAndCharacterOfPosition(node.getStart(source)).line, `${outer}${holder}>`));
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (name === "exec" || name === "prepare") {
        const found = texts(node.arguments[0]!, consts).map(kindOf).filter((kind): kind is Exclude<EndKind, "choice"> => kind !== null);
        if (found.length) {
          const kinds = [...new Set(found)];
          const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
          sites.push({
            file, line: lineOffset + source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1, col: source.getLineAndCharacterOfPosition(at.getStart(source)).character + 1, fn: outer + fnName(node), k: 0, method: name,
            text: node.arguments[0]!.getText(source).replace(/\s+/g, " "), kind: kinds.length > 1 ? "choice" : kinds[0]!,
            embedded: outer !== "", callee: [callee.getStart(source), node.arguments.pos],
          });
        }
      }
    }
    ts.forEachChild(node, calls);
  };
  calls(source);
  if (outer) return [...sites, ...inner];
  sites.push(...inner); sites.sort((a, b) => a.line - b.line);
  // a RELEASE right after a ROLLBACK TO of the same savepoint (earlier on its line) closes undone work: it is a rollback end
  const lines = text.split("\n");
  for (const site of sites) {
    if (site.kind !== "release") continue;
    const point = /RELEASE\s+(?:SAVEPOINT\s+)?(\w+)/i.exec(site.text)?.[1];
    const before = (lines[site.line - lineOffset - 1] ?? "").slice(0, site.col - 1);
    if (point && new RegExp(`ROLLBACK\\s+TO\\s+(?:SAVEPOINT\\s+)?${point}\\b`, "i").test(before)) site.kind = "rollback";
  }
  const seen = new Map<string, number>();
  for (const site of sites) { const n = (seen.get(site.fn) ?? 0) + 1; seen.set(site.fn, n); site.k = n; }
  return sites;
}

/** Every transaction-ending call site in server/** in file, then source order. */
export function scanCommitSites(serverDir: string): CommitSite[] {
  return files(serverDir, serverDir, []).sort().flatMap(file => scanFile(serverDir, file));
}

/** The site's mutant for its receipt (one per site): the site's own end statement goes to the handle's un-instrumented method, so that end
 *  is not reported to the observer from this line (its notice removed). Only for a site in the file's own code (not embedded worker text). */
export function mutateSite(root: string, site: CommitSite): string {
  if (site.embedded) throw new Error(`embedded site has no in-process notice: ${siteId(site)}`);
  const text = readFileSync(join(root, site.file), "utf8");
  const [start, open] = site.callee;
  const callee = text.slice(start, open - 1);
  const dot = callee.lastIndexOf(".");
  if (dot < 0) throw new Error(`not a method call: ${callee}`);
  const receiver = callee.slice(0, dot).trim();
  return `${text.slice(0, start)}Object.getPrototypeOf(${receiver}).${site.method}.call(${receiver}, ${text.slice(open)}`;
}

/** Calls that reach a handle's exec or prepare without going through the instrumented method (`.exec.call(...)`, `.prepare.apply(...)`,
 *  `db["exec"](...)`): a transaction end made that way would bypass the observer and this list. Product code must hold none. */
export function scanBypassForms(serverDir: string): string[] {
  const found: string[] = [];
  for (const file of files(serverDir, serverDir, []).sort()) {
    const source = ts.createSourceFile(file, readFileSync(join(serverDir, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const viaCall = ts.isPropertyAccessExpression(callee) && (callee.name.text === "call" || callee.name.text === "apply") && ts.isPropertyAccessExpression(callee.expression) && /^(?:exec|prepare)$/.test(callee.expression.name.text);
        const viaIndex = ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && /^(?:exec|prepare)$/.test(callee.argumentExpression.text);
        if (viaCall || viaIndex) found.push(`${file}:${source.getLineAndCharacterOfPosition(callee.getStart(source)).line + 1} ${callee.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
