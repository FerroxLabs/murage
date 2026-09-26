// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Product copy rules, held for every string a person can read: no em dash,
// never "safe", "safely" or "safety", and never the connection service's
// name. The Linux customer pass for 0.1.60 found each of them on screen
// after a string-by-string fix, so this scans the source instead.
//
// What counts as copy: every string literal, template text and JSX text in
// the renderer (src/), every value in the translated catalogues, and the
// strings the server hands the window. Comments are not copy and are never
// scanned: the TypeScript parser reads the literals, so a comment cannot be
// mistaken for one. Tests and end-to-end specs describe copy; they are not
// copy. Type positions, import paths, class names and console output never
// reach a person.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

type Rule = { name: string; pattern: RegExp };
const EM_DASH: Rule = { name: "an em dash", pattern: /—/ };
const SAFE: Rule = { name: "safe, safely or safety", pattern: /\b[Ss]af(?:e|ely|ety)\b(?!-area)/ };
const SERVICE: Rule = { name: "the connection service's name", pattern: /\bComposio\b/ };
const RULES = [EM_DASH, SAFE, SERVICE];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "e2e" || entry === "__fixtures__" || entry === "node_modules" || entry === "testing") continue;
      walk(full, out);
      continue;
    }
    if (!/\.(?:tsx|ts)$/.test(entry) || /\.(?:test|spec|fixture)\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

const QUIET_ATTRIBUTES = new Set(["className", "class", "style", "key", "id", "href", "src", "rel", "target", "type", "role", "name", "value", "autoComplete", "inputMode", "pattern", "d", "viewBox", "fill", "stroke"]);

/** Where a literal sits decides whether anyone reads it. */
function isQuiet(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let at: ts.Node | undefined = node.parent; at; child = at, at = at.parent) {
    if (ts.isTypeNode(at) || ts.isImportDeclaration(at) || ts.isExportDeclaration(at) || ts.isImportTypeNode(at)) return true;
    if (ts.isJsxAttribute(at)) return QUIET_ATTRIBUTES.has(at.name.getText()) || at.name.getText().startsWith("data-");
    if (ts.isCallExpression(at)) {
      const callee = at.expression.getText();
      if (/^console\.|^(?:log|debug|logError|logWarn)$|\.(?:log|debug|warn|error|info)$|^(?:cn|clsx|classNames)$|^RegExp$|^require$/.test(callee)) return true;
      // text being searched for or split on is read, not shown
      if (/\.(?:indexOf|lastIndexOf|includes|split|startsWith|endsWith|replace|replaceAll)$/.test(callee) && at.arguments[0] === child) return true;
      // a catalogue key: the catalogue's own values are checked below
      if (/^(?:t|i18n\.t)$/.test(callee) && at.arguments[0] === child) return true;
    }
    // a code compared against, never a sentence
    if (ts.isBinaryExpression(at) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(at.operatorToken.kind)) return true;
    if (ts.isCaseClause(at) && at.expression === child) return true;
    // search keywords are matched against what a person types, not shown
    if (ts.isPropertyAssignment(at) && at.name.getText() === "keywords") return true;
    if (ts.isNewExpression(at) && at.expression.getText() === "RegExp") return true;
    if (ts.isElementAccessExpression(at)) return true;
    if (ts.isPropertyAssignment(at) && ["className", "class"].includes(at.name.getText())) return true;
    if (ts.isBlock(at) || ts.isSourceFile(at)) return false;
  }
  return false;
}

/** Every piece of text in a file a person could read, with its line. */
export function copyStrings(file: string, source: string): Array<{ line: number; end: number; text: string }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; end: number; text: string }> = [];
  const lineOf = (at: number) => sf.getLineAndCharacterOfPosition(at).line + 1;
  const push = (node: ts.Node, text: string) => out.push({ line: lineOf(node.getStart(sf)), end: lineOf(node.getEnd()), text });
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isQuiet(node)) push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isQuiet(node)) push(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(" "));
    } else if (ts.isJsxText(node)) {
      if (node.text.trim()) push(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hits(files: string[], rules: Rule[], allow: Record<string, string> = {}): string[] {
  const found: string[] = [];
  for (const file of files) {
    const label = file.slice(ROOT.length);
    if (allow[label]) continue;
    for (const { line, text } of copyStrings(file, readFileSync(file, "utf8"))) {
      if (PENDING.some(entry => entry.file === label && text === entry.text)) continue;
      if (MODEL_FACING_TEXT.some(entry => entry.file === label && text.startsWith(entry.starts))) continue;
      for (const rule of rules) if (rule.pattern.test(text)) found.push(`${label}:${line}: ${rule.name}: ${text.trim().slice(0, 120)}`);
    }
  }
  return found;
}

function catalogueHits(file: string, rules: Rule[], allowKeys: Set<string>): string[] {
  const catalogue = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const found: string[] = [];
  for (const [key, value] of Object.entries(catalogue)) {
    if (typeof value !== "string" || allowKeys.has(key)) continue;
    for (const rule of rules) if (rule.pattern.test(value)) found.push(`${file.slice(ROOT.length)}: ${key}: ${rule.name}`);
  }
  return found;
}

// A person who brings their own key for connected apps has to be told which
// service the key comes from; that is the one place the name is the label.
const OWN_KEY_COPY = new Set(["connectedApps.lock.ownKey", "connectedApps.flux.ctaByok", "connectedApps.flux.notInBuild"]);

// Copy another lane owns and is changing now. Each entry is exact, so the
// string it names is still caught the moment it changes, and each one goes
// when that lane lands.
const PENDING: Array<{ file: string; text: string; why: string }> = [
  { file: "src/components/RoutineCalendarPage.tsx", text: "Routine safety limit", why: "routine editor, lane/0160-fixes" },
];

// Server files whose strings are instructions to a bot or a model, never
// shown in the window. Each needs its reason.
const MODEL_FACING: Record<string, string> = {
  "server/skill-guard/spector-patterns.generated.ts": "generated scanner patterns, matched against skill text",
  "shared/help-index.ts": "generated from apps/docs; its copy is fixed at the docs source",
  "shared/announcements.ts": "the announcement copy check names the words it refuses",
  "shared/intake-matches.ts": "keywords matched against what the owner types",
  "server/bot-shapes.ts": "a bot's system prompt",
  "server/section-context.ts": "a bot's system prompt",
  "server/installed-playbooks.ts": "a bot's system prompt",
  "server/computer-proxy.ts": "computer tool descriptions a model reads",
  "server/drivers/agents-proxy.ts": "bot tool descriptions a model reads",
  "server/desktop-policy.ts": "route purposes for the audit log",
};

// Single strings a model reads, in files that also hold copy.
const MODEL_FACING_TEXT: Array<{ file: string; starts: string }> = [
  { file: "server/drivers/acp/core.ts", starts: "The user denied this operation." },
];

describe("product copy rules", () => {
  it("the renderer shows no em dash, no safe and never the connection service's name", () => {
    expect(hits(walk(join(ROOT, "src")), RULES)).toEqual([]);
  });

  it("no translated catalogue does either", () => {
    const dir = join(ROOT, "src/locales");
    const found = readdirSync(dir).filter(name => name.endsWith(".json"))
      .flatMap(name => catalogueHits(join(dir, name), RULES, OWN_KEY_COPY));
    expect(found).toEqual([]);
  });

  it("the server hands the window no em dash and no safe", () => {
    const files = [...walk(join(ROOT, "server")), ...walk(join(ROOT, "shared"))];
    expect(hits(files, [EM_DASH, SAFE], MODEL_FACING)).toEqual([]);
  });

  it("reads literals and JSX text, never comments", () => {
    const found = copyStrings("x.tsx", '// a comment — here\nconst a = "one — two";\nconst b = <p className="pb-[env(safe-area-inset-bottom)]">Keep it safe</p>;');
    expect(found.map(entry => entry.text.trim())).toEqual(["one — two", "Keep it safe"]);
  });
});
