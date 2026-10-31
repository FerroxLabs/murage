// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The jargon lint: a non-technical owner never meets a word they have to look
// up. Terms and their plain replacements are src/lib/glossary.ts (readable
// copy: designs/PLAIN-WORDS-1014.md). Surfaces read:
//   catalogue  src/locales/en.json
//   fragments  src/locales/en-ux/*.json (the UX lanes' new keys)
//   help       shared/help-index.ts answers (generated from the docs)
//   errors     shared/*error*.ts string literals
//   jsx        JSX text and visible JSX attributes in src/components
// Mode: REPORT for the old copy in 1.0.12 and 1.0.13 (counts are printed, the
// run never fails on them); BLOCKING for the fragments now, because every key
// in them is new; BLOCKING everywhere from the 1.0.14 last merge (flip
// BLOCKING below). Set COPY_JARGON_REPORT=<file> to write every hit as JSON
// (the per-file hit lists for the copy lanes).
// The frozen names (Ask, Auto, Full access, No limits, Today, Chats, Routines,
// Needs you, bot names) are never a term here: copy-frozen-names.test.ts.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HELP_INDEX } from "../shared/help-index";
import { FROZEN_NAMES, GLOSSARY, jargonIn } from "./lib/glossary";

type Surface = "catalogue" | "fragments" | "help" | "errors" | "jsx";
const BLOCKING: Record<Surface, boolean> = { catalogue: false, fragments: true, help: false, errors: false, jsx: false };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rel = (file: string) => file.slice(ROOT.length).split(sep).join("/");

/** Reviewed exceptions: "<surface>:<key or file:line text start>" to why. Every row needs a reason. */
const ALLOW: Record<string, string> = {};

interface Hit { surface: Surface; at: string; terms: string[]; text: string }

function catalogueHits(surface: Surface, file: string): Hit[] {
  const pack = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return Object.entries(pack).flatMap(([key, value]) => {
    if (typeof value !== "string") return [];
    const terms = jargonIn(value);
    return terms.length ? [{ surface, at: key, terms, text: value }] : [];
  });
}

function fragmentFiles(): string[] {
  const dir = join(ROOT, "src/locales/en-ux");
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
}

function helpHits(): Hit[] {
  return HELP_INDEX.flatMap((section) => {
    const record = section as unknown as Record<string, unknown>;
    const text = ["title", "heading", "description", "text"].map((field) => record[field]).filter((value): value is string => typeof value === "string").join("\n");
    const terms = jargonIn(text);
    return terms.length ? [{ surface: "help" as const, at: section.id, terms, text: text.slice(0, 160) }] : [];
  });
}

const SHOWN_ATTRIBUTES = new Set(["title", "aria-label", "placeholder", "label", "alt", "aria-description"]);

/** Text a person reads in a file: JSX text and visible attributes (jsx), or every sentence-like literal (errors). */
function fileHits(surface: Surface, file: string): Hit[] {
  return fileHitsFrom(surface, file, readFileSync(file, "utf8"));
}

function fileHitsFrom(surface: Surface, file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Hit[] = [];
  const add = (node: ts.Node, text: string) => {
    const terms = jargonIn(text);
    if (terms.length) out.push({ surface, at: `${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`, terms, text: text.trim().slice(0, 160) });
  };
  const sentence = (text: string) => /\s/.test(text.trim()) && /[A-Za-z]{3}/.test(text);
  // A literal is on screen when it is a JSX child expression or a shown attribute's value,
  // directly or as a branch of a condition (or `a && b`); never a condition or a call's argument.
  const onScreen = (node: ts.Node): boolean => {
    let at = node;
    for (;;) {
      const parent = at.parent;
      if (!parent) return false;
      if (ts.isJsxAttribute(parent)) return SHOWN_ATTRIBUTES.has(parent.name.getText());
      if (ts.isJsxExpression(parent)) {
        const owner = parent.parent;
        if (ts.isJsxAttribute(owner)) return SHOWN_ATTRIBUTES.has(owner.name.getText());
        return ts.isJsxElement(owner) || ts.isJsxFragment(owner);
      }
      if (ts.isParenthesizedExpression(parent)) at = parent;
      else if (ts.isConditionalExpression(parent) && parent.condition !== at) at = parent;
      else if (ts.isBinaryExpression(parent) && parent.right === at && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) at = parent;
      else return false;
    }
  };
  const literalText = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text
      : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ") : undefined;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (surface === "jsx") {
      if (ts.isJsxText(node) && node.text.trim()) add(node, node.text);
      const text = literalText(node);
      if (text !== undefined && text.trim() && onScreen(node)) add(node, text);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && sentence(node.text)) {
      add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
      if (sentence(text)) add(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (!["e2e", "__fixtures__", "fixtures", "testing"].includes(name)) walk(full, out); continue; }
    if (/\.tsx$/.test(name) && !/\.(?:test|spec)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

function errorFiles(): string[] {
  const dir = join(ROOT, "shared");
  return readdirSync(dir).filter((name) => /error/i.test(name) && /\.ts$/.test(name) && !/\.test\.ts$/.test(name)).map((name) => join(dir, name));
}

const allowed = (hit: Hit) => Object.hasOwn(ALLOW, `${hit.surface}:${hit.at}`);

function allHits(): Hit[] {
  return [
    ...catalogueHits("catalogue", join(ROOT, "src/locales/en.json")),
    ...fragmentFiles().flatMap((file) => catalogueHits("fragments", file)),
    ...helpHits(),
    ...errorFiles().flatMap((file) => fileHits("errors", file)),
    ...walk(join(ROOT, "src/components")).flatMap((file) => fileHits("jsx", file)),
  ];
}

describe("jargon lint", () => {
  const hits = allHits();

  it("reports the jargon count per surface and term (report mode for old copy)", () => {
    const bySurface: Record<string, number> = {};
    const byTerm: Record<string, number> = {};
    for (const hit of hits) {
      bySurface[hit.surface] = (bySurface[hit.surface] ?? 0) + 1;
      for (const term of hit.terms) byTerm[term] = (byTerm[term] ?? 0) + 1;
    }
    console.info(`copy-jargon: ${hits.length} strings with jargon`, JSON.stringify(bySurface), JSON.stringify(byTerm));
    if (process.env.COPY_JARGON_REPORT) writeFileSync(process.env.COPY_JARGON_REPORT, JSON.stringify(hits, null, 2));
    expect(Object.keys(bySurface).every((surface) => surface in BLOCKING)).toBe(true);
  });

  for (const surface of Object.keys(BLOCKING) as Surface[]) {
    it(`${surface}: ${BLOCKING[surface] ? "blocking, no jargon outside the reviewed exceptions" : "report mode"}`, () => {
      const open = hits.filter((hit) => hit.surface === surface && !allowed(hit)).map((hit) => `${hit.at}: [${hit.terms.join(", ")}] ${hit.text}`);
      if (BLOCKING[surface]) expect(open).toEqual([]);
      else expect(Array.isArray(open)).toBe(true);
    });
  }

  it("every reviewed exception gives a reason and still matches a hit", () => {
    for (const [key, why] of Object.entries(ALLOW)) {
      expect(why.trim().length, key).toBeGreaterThan(10);
      expect(hits.some((hit) => `${hit.surface}:${hit.at}` === key), key).toBe(true);
    }
  });

  it("the glossary has a unique id, a plain replacement and an explanation for every term", () => {
    const fragment = JSON.parse(readFileSync(join(ROOT, "src/locales/en-ux/lcopya.json"), "utf8")) as Record<string, string>;
    expect(new Set(GLOSSARY.map((item) => item.id)).size).toBe(GLOSSARY.length);
    for (const item of GLOSSARY) {
      expect(item.plain.trim(), item.id).not.toBe("");
      const explanation = fragment[`ux.lcopya.glossary.${item.id}`];
      expect(explanation, item.id).toBeTruthy();
      expect(explanation.length, item.id).toBeLessThanOrEqual(80);
      expect(jargonIn(explanation), `${item.id}: the explanation uses jargon`).toEqual([]);
    }
  });

  it("never treats a frozen name as jargon", () => {
    for (const name of [...FROZEN_NAMES.levels, ...FROZEN_NAMES.doors, ...FROZEN_NAMES.bots]) expect(jargonIn(name), name).toEqual([]);
  });

  it("finds the terms the inventory counts, and not the ordinary words around them (self-check)", () => {
    expect(jargonIn("The provider rejected this request with HTTP 402.")).toEqual(["provider", "httpCode"]);
    expect(jargonIn("Paste your API key")).toEqual(["apiKey"]);
    expect(jargonIn("Nothing at this address answers as an MCP server.")).toEqual(["mcp"]);
    expect(jargonIn("Another program is using the sign-in port.")).toEqual(["port"]);
    expect(jargonIn("Bring-your-own-key (BYOK) settings")).toEqual(["byok"]);
    expect(jargonIn("Open the report and import it")).toEqual([]);
    expect(jargonIn("Your AI service is busy right now.")).toEqual([]);
    expect(jargonIn("Paste your key")).toEqual([]);
    expect(jargonIn("open the mcp list")).toEqual(["mcp"]);
    expect(jargonIn("HTTP402 from the service")).toEqual(["httpCode"]);
    expect(jargonIn("It failed with code 402")).toEqual(["httpCode"]);
    expect(jargonIn("{provider} needs credits")).toEqual([]);
    expect(jargonIn("Send it to api.example.com")).toEqual([]);
  });

  it("reads JSX child expressions and conditional branches, not conditions or call arguments (self-check)", () => {
    const file = join(ROOT, "src/components/__jargon_probe__.tsx");
    const source = `export const A = (p: { x: boolean }) => <div title={p.x ? "Open the MCP list" : "Close"}>{p.x && "The provider blocked this"}{p.x ? "Paste your API key" : null}{track("the provider event")}<span aria-label="SSH door" className="token" /></div>;`;
    const found = fileHitsFrom("jsx", file, source).map((hit) => hit.terms.join(","));
    expect(found.sort()).toEqual(["apiKey", "mcp", "provider", "ssh"]);
  });
});
