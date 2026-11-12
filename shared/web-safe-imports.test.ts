import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

// Guard: any repo-local module reachable from src/ (shared/, and server/ files the web imports, such as server/phone-jobs-engines.ts)
// ends up in the browser bundle, so it must not import node:* or a Node builtin (the 1.0.9 phone card crashed on node:crypto this way).
const ROOT = resolve(__dirname, "..");
const SHARED = join(ROOT, "shared");
const SRC = join(ROOT, "src");
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));


function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.spec\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
function specs(file: string): string[] {
  // d9d9f8e08f and 4f6495f025 add import("...") type queries to renderer
  // contracts. TypeScript erases these; only value imports enter the bundle.
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  // createSourceFile retains parser errors even when it recovers a partial tree.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) {
    throw new Error(`Cannot parse ${file}: ${diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("; ")}`);
  }
  const r: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!onlyTypes) r.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!onlyTypes) r.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      r.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return r;
}
/** A repo-local module a specifier names: relative, `@/` (src) or `@shared/`. Anything under node_modules or outside the repo is not followed. */
function resolveLocal(from: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith(".")) p = resolve(dirname(from), spec);
  else if (spec.startsWith("@shared/")) p = join(SHARED, spec.slice(8));
  else if (spec.startsWith("@/")) p = join(SRC, spec.slice(2));
  else return null;
  for (const c of [p, p.replace(/\.js$/, ".ts"), p + ".ts", p + ".tsx", join(p, "index.ts"), join(p, "index.tsx")]) {
    if (c.startsWith(ROOT + sep) && !c.includes(`${sep}node_modules${sep}`) && existsSync(c) && statSync(c).isFile() && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}
function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

describe("web bundle loads no node modules", () => {
  it("sees a builtin import after a valid TypeScript generic arrow", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-safe-generic-"));
    try {
      const file = join(dir, "generic.ts");
      writeFileSync(file, 'const id = <T>(x: T) => x;\nimport { createHash } from "node:crypto";\n');
      expect(specs(file).filter(isBuiltin)).toEqual(["node:crypto"]);
    } finally { removeTempDirSync(dir); }
  });
  it("parses JSX in TSX and still sees a following builtin import", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-safe-tsx-"));
    try {
      const file = join(dir, "view.tsx");
      writeFileSync(file, 'const view = <div>Fixture</div>;\nimport { createHash } from "node:crypto";\n');
      expect(specs(file).filter(isBuiltin)).toEqual(["node:crypto"]);
    } finally { removeTempDirSync(dir); }
  });
  it.each(["ts", "tsx"])("rejects malformed %s instead of trusting a partial import tree", extension => {
    const dir = mkdtempSync(join(tmpdir(), "web-safe-parse-"));
    try {
      const file = join(dir, `broken.${extension}`);
      writeFileSync(file, 'const broken = ;\nimport { createHash } from "node:crypto";\n');
      expect(() => specs(file)).toThrow(/Cannot parse .*broken\.(ts|tsx)/);
    } finally { removeTempDirSync(dir); }
  });
  it("every module reachable from src/ (shared/ and server/ included) imports no Node builtins", () => {
    // the browser entry is everything in src/ except the Playwright specs and configs, which run under Node
    // .d.ts files only declare types (`import("...")` there is a type position), so they pull nothing into the bundle
    const queue: string[] = walk(SRC).filter((f) => !f.includes(`${join("src", "e2e")}${sep}`) && !f.endsWith(".d.ts"));
    const roots = new Set(queue);
    const seen = new Set<string>();
    const bad: string[] = [];
    const reached: string[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!roots.has(f)) reached.push(f.slice(ROOT.length + 1).split(sep).join("/"));
      for (const s of specs(f)) {
        if (isBuiltin(s)) bad.push(`${f.slice(ROOT.length + 1)} imports ${s}`);
        const t = resolveLocal(f, s);
        if (t) queue.push(t);
      }
    }
    expect(reached.some((f) => f.startsWith("shared/"))).toBe(true);
    // the walk follows into server/: the engine table the Phone card reads
    expect(reached).toContain("server/phone-jobs-engines.ts");
    expect(bad).toEqual([]);
  });
  it("the checks themselves: a builtin import is seen, a type-only one is not, and the card's server/ import resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-safe-"));
    try {
      const file = join(dir, "fake.ts");
      writeFileSync(file, 'import { createHash } from "node:crypto";\nimport type { Server } from "node:http";\nimport { z } from "zod";\ntype Contract = import("node:sqlite").DatabaseSync;\nimport { type ServerResponse } from "node:http";\nexport type { Stats } from "node:fs";\nvoid import("node:path");\n');
      const found = specs(file);
      expect(found).toEqual(["node:crypto", "zod", "node:path"]);
      expect(found.filter(isBuiltin)).toEqual(["node:crypto", "node:path"]);
    } finally { removeTempDirSync(dir); }
    expect(isBuiltin("fs/promises")).toBe(true);
    expect(isBuiltin("zod")).toBe(false);
    expect(resolveLocal(join(SRC, "components", "PhoneAccessCard.tsx"), "../../server/phone-jobs-engines.ts")).toBe(join(ROOT, "server", "phone-jobs-engines.ts"));
  });
});
