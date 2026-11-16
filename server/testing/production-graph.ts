// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only: the production import graph. Starts at server/index.ts and every server bundle entry point, follows static imports, re-exports,
// `import("x")` and `require("x")` with a literal specifier (relative ones only), and reports the first path that reaches a test-only file.
// A build exclusion does not count: only the edges in the source do.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "..", "..");
export const rel = (p: string) => relative(repo, p).replace(/\\/g, "/");
export const isTestOnly = (r: string) => /\.test\.(ts|mjs)$/.test(r) || /(^|\/)testing\//.test(r);

export function entryPoints(): string[] {
  const bundle = readFileSync(join(repo, "scripts", "bundle-server.mjs"), "utf8");
  const out = [join(repo, "server", "index.ts")];
  for (const list of [/const ENTRY_POINTS = \[([\s\S]*?)\];/, /const WHATSAPP_ENTRY_POINTS = \[([\s\S]*?)\]\.filter/]) {
    const m = list.exec(bundle);
    for (const s of m?.[1]?.matchAll(/"([^"]+\.(?:ts|mjs))"/g) ?? []) { const p = join(repo, "server", s[1]!); if (existsSync(p)) out.push(p); }
  }
  return out;
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8"), found: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) found.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]!) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push((n.arguments[0] as ts.StringLiteralLike).text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a package or node: builtin
  const base = resolve(dirname(from), spec), stem = base.replace(/\.(m?js|ts)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.mjs`, join(base, "index.ts")]) if (existsSync(c) && /\.(ts|mjs)$/.test(c)) return c;
  return null;
}
/** Every file reachable from the entry points, each with the import path that first reached it. */
export function productionGraph(entries: string[] = entryPoints()): Map<string, string[]> {
  const seen = new Map<string, string[]>(), queue: string[] = [];
  for (const e of entries) { seen.set(e, [rel(e)]); queue.push(e); }
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of specifiers(file)) {
      const to = resolveSpec(file, spec);
      if (to && !seen.has(to)) { seen.set(to, [...seen.get(file)!, rel(to)]); queue.push(to); }
    }
  }
  return seen;
}
/** The import chains that end in a test-only file (empty when production never reaches one). */
export function pathsIntoTesting(graph = productionGraph()): string[] {
  return [...graph].filter(([f]) => isTestOnly(rel(f))).map(([, chain]) => chain.join(" -> "));
}

/** Busy-waits on the wall clock: `while (<cond with Date.now()>) {}` or `while (<cond>);`, the body empty or only comments. Parenthesis-balanced, so a
 *  loop whose body awaits or does work is not reported. */
export function dateNowBusyWaits(text: string): string[] {
  const out: string[] = [], re = /\bwhile\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth > 0) { const c = text[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
    const cond = text.slice(re.lastIndex, i - 1), after = text.slice(i);
    if (!/Date\.now\(\)/.test(cond)) continue;
    if (/^\s*(;|\{\s*(\/\*[^]*?\*\/\s*|\/\/[^\n]*\n\s*)*\})/.test(after)) out.push(`while (${cond.trim()})`);
  }
  return out;
}
