// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 design rev 2.5.1 (A16a S-sandbox). An AUDIT TRAIL, not a correctness proof: the recovery rule is path-blind (L7b's
// made-up route row proves that), so nothing here decides behavior. This test lists every place in the non-test sources of server/ and
// electron/ that can put a CSP `sandbox` directive on a response, and fails when a new one appears that is not in SANDBOX_ROUTES (add it,
// and an L7b row that models it) or when a listed one is gone. It parses every file with the TypeScript compiler, so comments and
// regular-expression literals are never scanned; it flags EVERY string or template literal whose text holds the directive token, whatever
// line or variable it sits on, plus every call and definition of the helpers that build a sandbox policy. A literal that is not a CSP
// directive maps to a NOT_A_CSP row with a one-line reason, instead of being skipped silently. It cannot discover a CSP value composed far
// from its header; the path-blind rule does not depend on it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const DIRECTIVE = /(?:^|[;\s])sandbox(?:\s|;|$)/;
const HELPERS = new Set(["mermaidFrameCsp", "frameCsp", "homePagePolicy", "sanitizeResponseHeaders"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-server", "testing", "fixtures", ".git", "codemap"]);
const TEST_FILE = /(?:\.test|\.node-test|\.spec)\.[cm]?[jt]s$|\.d\.ts$/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* sources(path.join(dir, entry.name)); continue; }
    if (/\.(?:ts|mjs|cjs)$/.test(entry.name) && !TEST_FILE.test(entry.name)) yield path.join(dir, entry.name);
  }
}

/** Every hit in one file: {file, kind: "literal" | "call" | "def", text}. */
export function scanSource(file, text) {
  const hits = [];
  if (!/sandbox/i.test(text) && ![...HELPERS].some((name) => text.includes(name))) return hits;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const literal = (node, value) => {
    if (!DIRECTIVE.test(value)) return;
    const p = node.parent;
    const key = p && ((ts.isPropertyAssignment(p) && p.name === node) || (ts.isElementAccessExpression(p) && p.argumentExpression === node));
    if (value === "sandbox" && key) return; // a property key or JSON field, not a header value
    hits.push({ file, kind: "literal", text: value });
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literal(node, node.text);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HELPERS.has(node.expression.text)) hits.push({ file, kind: "call", text: node.expression.text });
    else if (ts.isFunctionDeclaration(node) && node.name && HELPERS.has(node.name.text)) hits.push({ file, kind: "def", text: node.name.text });
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && HELPERS.has(node.name.text)) hits.push({ file, kind: "def", text: node.name.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

export function scanTree() {
  const hits = [];
  for (const top of ["server", "electron"]) {
    for (const file of sources(path.join(ROOT, top))) hits.push(...scanSource(path.relative(ROOT, file).split(path.sep).join("/"), readFileSync(file, "utf8")));
  }
  return hits;
}

// Every site that can send a CSP sandbox. `models` names the L7b rows (load-failure-recovery.node-test.mjs) that model its URL shape.
const MERMAID_ROWS = ["/mermaid-frame.html", "/mermaid-frame-0123456789abcdef.html", "/%6dermaid-frame.html", "/%6dermaid-frame-0123456789abcdef.html", "/mermaid%2Dframe-0123456789abcdef.html"];
const SANDBOX_ROUTES = [
  { file: "server/index.ts", kind: "call", includes: "mermaidFrameCsp", models: MERMAID_ROWS, note: "static branch: the chat's diagram frame, matched on the DECODED path" },
  { file: "server/index.ts", kind: "literal", includes: "default-src 'none'; sandbox", models: ["/any/new/route"], note: "inline audio bytes response" },
  { file: "server/artifacts.ts", kind: "literal", includes: "default-src 'none'; sandbox", models: ["/api/artifacts/a1/preview"], note: "artifact preview" },
  { file: "server/media-assets.ts", kind: "literal", includes: "default-src 'none'; sandbox", models: ["/any/new/route"], note: "media bytes response headers" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "def", includes: "mermaidFrameCsp", models: MERMAID_ROWS, note: "helper definition" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "def", includes: "frameCsp", models: MERMAID_ROWS, note: "helper definition" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "def", includes: "homePagePolicy", models: ["/any/new/route"], note: "helper definition: Cloud home HTML policy" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "call", includes: "frameCsp", models: MERMAID_ROWS, note: "homePagePolicy builds the frame policy" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "call", includes: "homePagePolicy", models: ["/any/new/route"], note: "the Cloud home response writer" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "literal", includes: "; style-src 'unsafe-inline'", models: MERMAID_ROWS, note: "frameCsp template tail (listed first: it also contains the directive text)" },
  { file: "server/cloud-home/b1b-policy.ts", kind: "literal", includes: "sandbox allow-scripts", models: MERMAID_ROWS, note: "the diagram frame's directive" },
  { file: "electron/cloud-home-protocol.mjs", kind: "def", includes: "sanitizeResponseHeaders", models: ["/any/new/route"], note: "helper definition: any HTML from /api gets a sandbox" },
  { file: "electron/cloud-home-protocol.mjs", kind: "literal", includes: "sandbox", models: ["/any/new/route"], note: "Content-Security-Policy: sandbox on /api HTML" },
  { file: "electron/cloud-home-protocol.mjs", kind: "call", includes: "sanitizeResponseHeaders", models: ["/any/new/route"], note: "the protocol handler" },
];
// Literals that hold the word but are prose, an engine setting name or a list entry, never a response header.
const NOT_A_CSP = [
  { file: "server/browser-engine.ts", kind: "literal", includes: "verify its host sandbox", count: 2, reason: "error message text about the browser's own OS sandbox" },
  { file: "server/browser-sandbox.ts", kind: "literal", includes: "Browser sandbox file access could not", reason: "error message text" },
  { file: "server/browser-sandbox.ts", kind: "literal", includes: "Windows browser sandbox file access needs repair", reason: "error message text" },
  { file: "server/browser-sandbox.ts", kind: "literal", includes: "Choose Enable browser", reason: "owner-facing message about Chrome's own sandbox on Ubuntu" },
  { file: "server/browser-sandbox.ts", kind: "literal", includes: "this copy of Murage (an AppImage", reason: "owner-facing message about Chrome's own sandbox on Ubuntu" },
  { file: "server/composio-standard-tools.ts", kind: "literal", includes: "remote sandbox", reason: "tool description for a remote code sandbox" },
  { file: "server/engine-commands.ts", kind: "literal", equals: "sandbox", reason: "an engine slash-command name in a list" },
];

const matches = (r, hit) => r.file === hit.file && r.kind === hit.kind && (r.equals !== undefined ? hit.text === r.equals : hit.text.includes(r.includes));
function classify(hits) {
  const counts = new Map();
  const unlisted = [];
  for (const hit of hits) {
    const row = SANDBOX_ROUTES.find((r) => matches(r, hit)) ?? NOT_A_CSP.find((r) => matches(r, hit));
    if (row) counts.set(row, (counts.get(row) ?? 0) + 1); else unlisted.push(hit);
  }
  return { counts, unlisted };
}

test("S-sandbox every site that can set a CSP sandbox is listed, and every listed site still exists", () => {
  const hits = scanTree();
  if (process.env.SANDBOX_DUMP) console.log(`SANDBOX_DUMP ${JSON.stringify(hits)}`);
  const seen = classify(hits);
  assert.deepEqual(seen.unlisted, [], `a new route sets a sandbox CSP: add it to SANDBOX_ROUTES and an L7b row (or map a non-CSP literal in NOT_A_CSP with a reason):\n${seen.unlisted.map((h) => `  ${h.file} ${h.kind} ${JSON.stringify(h.text.slice(0, 100))}`).join("\n")}`);
  // Each row names a number of SITES (default 1). A second identical literal in the same file is a new site, not a repeat of the listed one.
  const wrong = [...SANDBOX_ROUTES, ...NOT_A_CSP].filter((r) => (seen.counts.get(r) ?? 0) !== (r.count ?? 1)).map((r) => `${r.file} ${r.kind} ${r.includes ?? r.equals}: found ${seen.counts.get(r) ?? 0}, listed ${r.count ?? 1}`);
  assert.deepEqual(wrong, [], "a listed site is gone, or a site was added that an existing row would swallow: fix the row's count");
});

test("S-sandbox a duplicate site and a misclassified literal are both caught (regression)", () => {
  const row = SANDBOX_ROUTES.find((r) => r.file === "server/index.ts" && r.kind === "literal");
  const one = { file: row.file, kind: "literal", text: "default-src 'none'; sandbox" };
  // another identical literal in the same file: one row, two sites
  const dup = classify([one, { ...one }]);
  assert.equal(dup.counts.get(row), 2, "the duplicate site is counted, not collapsed");
  assert.notEqual(dup.counts.get(row), row.count ?? 1, "the count check would fail on the duplicate");
  // a new CSP literal in the file that holds the engine-command name must not hide behind that row
  const mis = classify([{ file: "server/engine-commands.ts", kind: "literal", text: "sandbox" }, { file: "server/engine-commands.ts", kind: "literal", text: "default-src 'none'; sandbox" }]);
  assert.equal(mis.unlisted.length, 1, "only the exact command name is the NOT_A_CSP literal");
  assert.equal(mis.unlisted[0].text, "default-src 'none'; sandbox");
});

test("S-sandbox the helper definitions and the known response sites are covered, and every route names L7b rows that exist", () => {
  const hits = scanTree();
  const has = (file, kind, text) => hits.some((h) => h.file === file && h.kind === kind && h.text.includes(text));
  assert.ok(has("server/cloud-home/b1b-policy.ts", "def", "mermaidFrameCsp"), "mermaidFrameCsp definition");
  assert.ok(has("server/cloud-home/b1b-policy.ts", "def", "frameCsp"), "frameCsp definition");
  assert.ok(has("server/cloud-home/b1b-policy.ts", "def", "homePagePolicy"), "homePagePolicy definition");
  assert.ok(has("electron/cloud-home-protocol.mjs", "def", "sanitizeResponseHeaders"), "sanitizeResponseHeaders definition");
  const l7 = readFileSync(path.join(here, "load-failure-recovery.node-test.mjs"), "utf8");
  for (const route of SANDBOX_ROUTES) {
    assert.ok(route.models?.length > 0, `${route.file}: names its L7b rows`);
    for (const row of route.models) assert.ok(l7.includes(`"${row}"`), `${route.file}: the L7b row ${row} exists`);
  }
});
