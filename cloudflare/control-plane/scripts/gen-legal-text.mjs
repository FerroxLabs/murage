// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds src/legal-docs.generated.ts: complete plain-text copies of the Murage Cloud terms, Terms of Service and Privacy Policy (for the
// durable confirmation email and the acceptance archive), plus a version id per document (content hash, so every revision is unique).
// Usage: node scripts/gen-legal-text.mjs <path-to-site-(legal)-dir> [out-file] [site-ref]
// The site repo is read, never edited. Re-run when the site terms change; the committed output is what the Worker ships.
//
// The pages are parsed as TSX (TypeScript compiler API) and rendered element by element: the title, the effective and last-updated
// dates (resolved from the page constants and _components/legal.tsx), sections, subheadings, paragraphs, lists, TABLES, links (with
// their addresses) and the shared components (LegalEntity, PrivacyContact, LegalRepresentatives, evaluated from their source).
// Anything the renderer does not know FAILS the build instead of being dropped silently.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const dir = process.argv[2];
const out = process.argv[3] ?? new URL("../src/legal-docs.generated.ts", import.meta.url).pathname;
const site = process.argv[4] ?? "draft/murage-cloud";
const SITE_ORIGIN = "https://murage.ai";
if (!dir) { console.error("usage: gen-legal-text.mjs <legal dir> [out] [site-ref]"); process.exit(2); }

const ENTITIES = { "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&amp;": "&", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–",
  "&apos;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&hellip;": "…", "&middot;": "·", "&copy;": "©", "&eacute;": "é" };
const decode = (s) => s.replace(/&[a-z]+;|&#\d+;/g, (e) => {
  if (e.startsWith("&#")) return String.fromCodePoint(Number(e.slice(2, -1)));
  if (!(e in ENTITIES)) throw new Error(`unknown HTML entity ${e}`);
  return ENTITIES[e];
});
const parse = (file) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Module scope: top-level const values and function components (from the page and from _components/legal.tsx). */
function scopeOf(sf, into = { consts: new Map(), components: new Map() }) {
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) into.consts.set(d.name.text, d.initializer);
    if (ts.isFunctionDeclaration(st) && st.name && st.body) into.components.set(st.name.text, st);
  }
  return into;
}

function evalExpr(e, scope) {
  if (ts.isParenthesizedExpression(e)) return evalExpr(e.expression, scope);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => String(evalExpr(s.expression, scope)) + s.literal.text).join("");
  if (ts.isIdentifier(e)) {
    const v = scope.consts.get(e.text);
    if (!v) throw new Error(`unresolved identifier ${e.text}`);
    return evalExpr(v, scope);
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return !evalExpr(e.operand, scope);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return evalExpr(e.left, scope) && evalExpr(e.right, scope);
    if (op === ts.SyntaxKind.BarBarToken) return evalExpr(e.left, scope) || evalExpr(e.right, scope);
    if (op === ts.SyntaxKind.PlusToken) return evalExpr(e.left, scope) + evalExpr(e.right, scope);
  }
  if (ts.isAsExpression(e)) return evalExpr(e.expression, scope);
  throw new Error(`cannot evaluate expression: ${e.getText().slice(0, 80)}`);
}

/** JSX text whitespace, the way React renders it. */
function jsxText(raw) {
  const lines = raw.split(/\r?\n/);
  const kept = [];
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i > 0) l = l.replace(/^ +/, "");
    if (i < lines.length - 1) l = l.replace(/ +$/, "");
    if (l) kept.push(l);
  });
  return decode(kept.join(" "));
}

const attr = (el, name) => el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
function attrValue(el, name, scope, fallback) {
  const a = attr(el, name);
  if (!a) {
    if (fallback !== undefined) return fallback;
    throw new Error(`<${el.tagName.getText()}> needs ${name}`);
  }
  if (!a.initializer) return true;
  if (ts.isStringLiteral(a.initializer)) return decode(a.initializer.text);
  if (ts.isJsxExpression(a.initializer)) return a.initializer.expression;
  throw new Error(`attribute ${name}`);
}
const absUrl = (href) => href.startsWith("/") ? `${SITE_ORIGIN}${href}` : href;

function renderChildren(children, scope) { return children.map((c) => render(c, scope)).join(""); }

/** Renders a function component from its source: if-statements over known constants are evaluated, then its return value is rendered. */
function renderComponent(fn, scope) {
  const run = (stmts) => {
    for (const st of stmts) {
      if (ts.isReturnStatement(st)) return st.expression ? render(st.expression, scope) : "";
      if (ts.isIfStatement(st)) {
        const branch = evalExpr(st.expression, scope) ? st.thenStatement : st.elseStatement;
        if (branch) { const r = run(ts.isBlock(branch) ? branch.statements : [branch]); if (r !== undefined) return r; }
        continue;
      }
      if (ts.isExpressionStatement(st) || ts.isEmptyStatement(st)) continue;
      throw new Error(`component ${fn.name.text}: unsupported statement ${ts.SyntaxKind[st.kind]}`);
    }
    return undefined;
  };
  const r = run(fn.body.statements);
  if (r === undefined) throw new Error(`component ${fn.name.text} returned nothing`);
  return r;
}

function renderTable(el, scope) {
  const head = attrValue(el, "head", scope); const rows = attrValue(el, "rows", scope);
  if (!ts.isArrayLiteralExpression(head) || !ts.isArrayLiteralExpression(rows)) throw new Error("LegalTable needs literal head and rows");
  const cell = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? decode(n.text) : render(n, scope)).replace(/\s+/g, " ").trim();
  const headCells = head.elements.map(cell);
  const lines = ["", headCells.join(" | ")];
  for (const row of rows.elements) {
    if (!ts.isArrayLiteralExpression(row)) throw new Error("LegalTable row must be an array");
    const cells = row.elements.map(cell);
    if (cells.length !== headCells.length) throw new Error("LegalTable row width differs from its head");
    lines.push(`- ${cells.join(" | ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function render(node, scope) {
  if (ts.isParenthesizedExpression(node)) return render(node.expression, scope);
  if (ts.isJsxText(node)) return jsxText(node.text);
  if (ts.isJsxExpression(node)) {
    if (!node.expression) return ""; // {/* comment */}
    return render(node.expression, scope);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isIdentifier(node) || ts.isBinaryExpression(node)) {
    const v = evalExpr(node, scope);
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`non-text expression ${node.getText().slice(0, 60)}`);
    return decode(String(v));
  }
  if (ts.isConditionalExpression(node)) return render(evalExpr(node.condition, scope) ? node.whenTrue : node.whenFalse, scope);
  if (node.kind === ts.SyntaxKind.NullKeyword) return "";
  if (ts.isJsxFragment(node)) return renderChildren(node.children, scope);
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
    const open = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = open.tagName.getText();
    const kids = ts.isJsxElement(node) ? node.children : [];
    const inner = () => renderChildren(kids, scope);
    switch (tag) {
      case "LegalPage": {
        const title = attrValue(open, "title", scope); const subtitle = attrValue(open, "subtitle", scope);
        const val = (name, def) => { const v = attrValue(open, name, scope, null); return v === null ? evalExpr(scope.consts.get(def) ?? ts.factory.createStringLiteral(""), scope) : typeof v === "string" ? v : evalExpr(v, scope); };
        const effective = val("effectiveDate", "LEGAL_EFFECTIVE_DATE"); const updated = val("lastUpdated", "LEGAL_LAST_UPDATED");
        if (!effective || !updated) throw new Error("effective / last-updated date missing");
        return `# ${typeof title === "string" ? title : evalExpr(title, scope)}\n\n${typeof subtitle === "string" ? subtitle : evalExpr(subtitle, scope)}\n\nEffective ${effective} · Last updated ${updated}\n${inner()}`;
      }
      case "LegalSection": return `\n\n## ${(() => { const t = attrValue(open, "title", scope); return typeof t === "string" ? t : evalExpr(t, scope); })()}\n${inner()}`;
      case "LegalSubheading": return `\n\n### ${inner().trim()}\n`;
      case "p": return `\n${inner()}\n`;
      case "LegalList": case "ul": case "ol": return `${inner()}\n`;
      case "li": return `\n- ${inner().trim()}`;
      case "LegalTable": return renderTable(open, scope);
      case "strong": case "em": case "b": case "i": case "span": case "code": case "abbr": case "small": return inner();
      case "br": return "\n";
      case "Link": case "a": {
        const href = attrValue(open, "href", scope);
        const h = typeof href === "string" ? href : String(evalExpr(href, scope));
        const text = inner().trim();
        if (h.startsWith("mailto:")) return text === h.slice(7) ? text : `${text} (${h.slice(7)})`;
        if (h.startsWith("#")) return text;
        const url = absUrl(h);
        return text === url ? text : `${text} (${url})`;
      }
      // Site navigation under the page, not part of the document.
      case "LegalCrossLinks": return "";
      default: {
        const fn = scope.components.get(tag);
        if (fn) return renderComponent(fn, scope);
        throw new Error(`unknown element <${tag}>: teach gen-legal-text.mjs how to render it`);
      }
    }
  }
  throw new Error(`unsupported node ${ts.SyntaxKind[node.kind]}: ${node.getText().slice(0, 60)}`);
}

function pageRoot(sf) {
  let found = null;
  const visit = (n) => { if (!found && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText() === "LegalPage") found = n; else ts.forEachChild(n, visit); };
  visit(sf);
  if (!found) throw new Error(`${sf.fileName}: no <LegalPage>`);
  return found;
}
const tidy = (s) => s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

const shared = scopeOf(parse(join(dir, "_components", "legal.tsx")));
const docs = {};
for (const [key, folder] of [["cloudTerms", "cloud-terms"], ["termsOfService", "terms-of-service"], ["privacyPolicy", "privacy-policy"]]) {
  const sf = parse(join(dir, folder, "page.tsx"));
  const scope = scopeOf(sf, { consts: new Map(shared.consts), components: new Map(shared.components) });
  const root = pageRoot(sf);
  const text = tidy(render(root, scope));
  const title = (() => { const t = attrValue(ts.isJsxElement(root) ? root.openingElement : root, "title", scope); return typeof t === "string" ? t : String(evalExpr(t, scope)); })();
  const hash = createHash("sha256").update(text).digest("hex");
  docs[key] = { title, versionId: `${folder}-${hash.slice(0, 12)}`, sha256: hash, text };
}
let tsOut = `// SPDX-License-Identifier: AGPL-3.0-or-later\n// GENERATED by scripts/gen-legal-text.mjs from the site terms pages (${site}). Do not edit by hand.\n`;
tsOut += "export interface LegalDoc { title: string; versionId: string; sha256: string; text: string }\n";
tsOut += `export const LEGAL_DOCS: { cloudTerms: LegalDoc; termsOfService: LegalDoc; privacyPolicy: LegalDoc } = ${JSON.stringify(docs, null, 2)};\n`;
writeFileSync(out, tsOut);
for (const [k, d] of Object.entries(docs)) console.log(k, d.versionId, d.text.length);
