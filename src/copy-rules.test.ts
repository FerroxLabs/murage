// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Product copy rules, held for every string a person can read: no em dash,
// never "safe", "safely", "safety" or "unsafe", and never the connection service's
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import ts from "typescript";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** A file's repository path with "/" on every OS, as the allowlists spell it. */
const rel = (file: string) => file.slice(ROOT.length).split(sep).join("/");

type Rule = { name: string; pattern: RegExp };
const EM_DASH: Rule = { name: "an em dash", pattern: /—/ };
const SAFE_WORDS = /\bsaf(?:e|ely|ety)\b(?!-area)/i;
// 0.1.61 G5: "unsafe" is held too. A lower-case code with no spaces (a status
// value such as "unsafe" or a reason code such as "unsafe-driver-owner") is
// compared, never read, and a quoted CSP keyword ('unsafe-inline',
// 'wasm-unsafe-eval') goes to a browser; everything else, "unsafe-looking"
// included, is a sentence.
const UNSAFE_WORD = /\bunsafe\b/i;
const CSP_KEYWORD = /'(?:wasm-)?unsafe-[a-z-]+'/g;
const SAFE: Rule = { name: "safe, safely, safety or unsafe", pattern: { test: (text: string) => SAFE_WORDS.test(text) || (!/^[a-z0-9._-]+$/.test(text.trim()) && UNSAFE_WORD.test(text.replace(CSP_KEYWORD, ""))) } as RegExp };
// On-screen text (JSX) has no codes: any "unsafe" there is held.
const SHOWN_SAFE: Rule = { name: "safe, safely, safety or unsafe", pattern: { test: (text: string) => SAFE_WORDS.test(text) || UNSAFE_WORD.test(text) } as RegExp };
const SERVICE: Rule = { name: "the connection service's name", pattern: /\bComposio\b/ };
const RULES = [EM_DASH, SAFE, SERVICE];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "e2e" || entry === "__fixtures__" || entry === "fixtures" || entry === "node_modules" || entry === "testing" || entry === "vendor" || entry === "resources") continue;
      walk(full, out);
      continue;
    }
    if (!/\.(?:tsx|ts|mjs|cjs|js)$/.test(entry) || /\.(?:test|spec|fixture|node-test|electron\.test)\.(?:tsx?|mjs|cjs|js)$/.test(entry) || /\.d\.m?ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const QUIET_ATTRIBUTES = new Set(["className", "class", "style", "key", "id", "href", "src", "rel", "target", "type", "role", "name", "value", "autoComplete", "inputMode", "pattern", "d", "viewBox", "fill", "stroke"]);

/** Where a literal sits decides whether anyone reads it. `terminal`: the
 * file is a command-line tool, whose console output IS what a person reads. */
function isQuiet(node: ts.Node, terminal = false): boolean {
  let child: ts.Node = node;
  for (let at: ts.Node | undefined = node.parent; at; child = at, at = at.parent) {
    if (ts.isTypeNode(at) || ts.isImportDeclaration(at) || ts.isExportDeclaration(at) || ts.isImportTypeNode(at)) return true;
    if (ts.isJsxAttribute(at)) return QUIET_ATTRIBUTES.has(at.name.getText()) || at.name.getText().startsWith("data-");
    if (ts.isCallExpression(at)) {
      const callee = at.expression.getText();
      if (!terminal && /^console\.|^(?:log|debug|logError|logWarn|slog)$|\.(?:log|debug|warn|error|info)$/.test(callee)) return true;
      if (/^(?:cn|clsx|classNames)$|^RegExp$|^require$/.test(callee)) return true;
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
export function copyStrings(file: string, source: string, { terminal = false }: { terminal?: boolean } = {}): Array<{ line: number; end: number; text: string; shown?: boolean }> {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(?:mjs|cjs|js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ line: number; end: number; text: string; shown?: boolean }> = [];
  const lineOf = (at: number) => sf.getLineAndCharacterOfPosition(at).line + 1;
  // `shown`: JSX text or a JSX attribute's value, on screen as written, so a
  // single lower-case word there is a label, never a code.
  const push = (node: ts.Node, text: string, shown = false) => out.push({ line: lineOf(node.getStart(sf)), end: lineOf(node.getEnd()), text, ...(shown ? { shown } : {}) });
  // A literal is on screen when it is a JSX attribute's value or expression,
  // or a branch of a condition (or `a && b`) that is one; never a condition,
  // a comparison operand or a call's argument.
  const onScreen = (node: ts.Node): boolean => {
    let at = node;
    for (;;) {
      const parent = at.parent;
      if (ts.isJsxAttribute(parent) || ts.isJsxExpression(parent)) return true;
      if (ts.isParenthesizedExpression(parent)) at = parent;
      else if (ts.isConditionalExpression(parent) && parent.condition !== at) at = parent;
      else if (ts.isBinaryExpression(parent) && parent.right === at && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) at = parent;
      else return false;
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isQuiet(node, terminal)) push(node, node.text, onScreen(node));
    } else if (ts.isTemplateExpression(node)) {
      if (!isQuiet(node, terminal)) push(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(" "), onScreen(node));
    } else if (ts.isJsxText(node)) {
      if (node.text.trim()) push(node, node.text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hits(files: string[], rules: Rule[], allow: Record<string, string> = {}, options: { terminal?: boolean } = {}): string[] {
  const found: string[] = [];
  for (const file of files) {
    const label = rel(file);
    if (allow[label]) continue;
    for (const { line, text: raw, shown } of copyStrings(file, readFileSync(file, "utf8"), options)) {
      // A whole page kept in a template: only its visible text is read, not
      // its inline script or style.
      const text = /^\s*<!doctype html>/i.test(raw) ? htmlText(raw).join(" ") : raw;
      if (PENDING.some(entry => entry.file === label && text === entry.text)) continue;
      if (MODEL_FACING_TEXT.some(entry => entry.file === label && text.startsWith(entry.starts))) continue;
      for (const rule of rules) if ((shown && rule === SAFE ? SHOWN_SAFE : rule).pattern.test(text)) found.push(`${label}:${line}: ${rule.name}: ${text.trim().slice(0, 120)}`);
    }
  }
  return found;
}

function catalogueHits(file: string, rules: Rule[], allowKeys: Set<string> = new Set()): string[] {
  const catalogue = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const found: string[] = [];
  for (const [key, value] of Object.entries(catalogue)) {
    if (typeof value !== "string" || allowKeys.has(key)) continue;
    for (const rule of rules) if (rule.pattern.test(value)) found.push(`${rel(file)}: ${key}: ${rule.name}`);
  }
  return found;
}

/** Every message in an extension's `_locales/<lang>/messages.json` that breaks a rule. Descriptions are notes for translators, never shown, so they are not scanned. */
export function extensionMessageHits(dir: string, rules: Rule[]): string[] {
  const found: string[] = [];
  const base = join(dir, "_locales");
  if (!existsSync(base)) return found;
  for (const lang of readdirSync(base).sort()) {
    const file = join(base, lang, "messages.json");
    if (!existsSync(file)) continue;
    const catalogue = JSON.parse(readFileSync(file, "utf8")) as Record<string, { message?: string }>;
    for (const [key, entry] of Object.entries(catalogue))
      for (const rule of rules) if (typeof entry?.message === "string" && rule.pattern.test(entry.message)) found.push(`${lang}/messages.json: ${key}: ${rule.name}`);
  }
  return found;
}

// Copy another lane owns and is changing now. Each entry is exact, so the
// string it names is still caught the moment it changes, and each one goes
// when that lane lands.
const PENDING: Array<{ file: string; text: string; why: string }> = [
];

// Server files whose strings are instructions to a bot or a model, never
// shown in the window. Each needs its reason.
const MODEL_FACING: Record<string, string> = {
  "server/skill-guard/spector-patterns.generated.ts": "generated scanner patterns, matched against skill text",
  "shared/help-index.ts": "generated from apps/docs; its copy is fixed at the docs source",
  "shared/announcements.ts": "the announcement copy check names the words it refuses",
  "shared/intake-matches.ts": "keywords matched against what the owner types",
  "shared/public-suffix-snapshot.ts": "generated Public Suffix List data (domain names such as safety.aero), matched against hostnames and never shown",
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

// Desktop files whose strings never reach a person: a model reads them, or
// they are storage keys and reason codes. Each needs its reason.
const DESKTOP_NOT_COPY: Record<string, string> = {
  "electron/browser-surface.cjs": "built-in browser tool results a model reads",
  "electron/browser-host.cjs": "built-in browser tool results a model reads",
  "electron/browser-snapshot.cjs": "page snapshots a model reads",
  "electron/flux-composio-token.mjs": "credential storage key names",
  "electron/managed-composio.mjs": "credential storage key names and broker wiring",
  "electron/capabilities.cjs": "capability reason codes; the window words them",
};

// Companion files whose strings never reach a person. Each needs its reason.
const COMPANION_NOT_COPY: Record<string, string> = {};

/** Text in a static HTML page: markup, comments and scripts stripped. */
export function htmlText(source: string): string[] {
  return source.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .split(/<[^>]+>/).map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}
function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (!["fixtures", "node_modules", "vendor", "resources"].includes(entry)) htmlFiles(full, out); continue; }
    if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

// Backup and restore copy has rules of its own (0.1.60 customer pass): no talk
// of what a storage provider may charge, none of the tools' names or internal
// words, and never a raw error code in brackets.
const BACKUP_COPY_FILES = ["src/components/BackupSettings.tsx", "src/components/BackupRemoteSettings.tsx", "src/components/backups-section-ui.ts", "src/components/backup-schedule-ui.ts",
  "src/components/FirstRunBackupsRow.tsx", "shared/backup-capture-failure.mjs", "electron/installation-recovery-window.mjs", "electron/recovery/renderer.js", "electron/recovery/messages.js"];
const BACKUP_RULES: Rule[] = [
  { name: "provider charges", pattern: /\b(?:charges?|charged|pricing|price|fees?|billing)\b/i },
  { name: "backup tool jargon", pattern: /age-keygen|\bage recovery key\b|native age|\bfidelity\b|application-data|\brestic\b|ownership record/i },
  { name: "a raw error code", pattern: /\([A-Z][A-Z0-9]*_[A-Z0-9_]+\)/ },
];

// A lower-case word with no spaces (a schema value or a file name) is not a
// sentence anyone reads.
const sentence = (rule: Rule): Rule => ({ name: rule.name, pattern: { test: (text: string) => !/^[a-z0-9._-]+$/.test(text.trim()) && rule.pattern.test(text) } as RegExp });
const BACKUP_WORDS = BACKUP_RULES.map(sentence);

// Price talk. The product never sells on price or mentions it. "free" is
// counted only in its price sense: to free memory, free disk space, a free
// slot and "free of" are other words.
// 0.1.60 Linux D13 added the phrasings the first rule let through: "Charges
// go to that connection's account", "testing a model costs nothing" and
// "may require a paid licence".
// 0.1.60 audit C2 added what that still let through: "may incur usage
// charges", "bills the Flux key", "to keep the cost down", "what a turn
// costs" and "asks before it spends". ("In charge" and a spending limit the
// person sets are other words.)
const PRICE: Rule = { name: "price talk", pattern: /\b(?:prices?|priced|pricing|cheap(?:er|est|ly)?|discount(?:s|ed)?|paid|charges? go|costs? (?:nothing|money))\b|\bat no cost\b|\bfree\b(?! (?:slot|memory|disk|space|up\b|of\b|text\b|-text\b))|\bincur\w*|\bcharges\b|\bbill(?:s|ed)\b|\bspends?\b(?!-)|\bcosts? down\b|\bwhat (?:a|an|each|the) \w+ costs\b/i };
// An engine's raw error text: an HTTP status or a provider's error type.
const RAW_ERROR: Rule = { name: "a raw error code", pattern: /\bstatus [45]\d\d\b|\bapi_error\b|\bHTTP [45]\d\d\b/ };

// Price wording that shipped before this rule, each exact, each waiting on
// the owner's word (listed in the 0.1.60 fix2-ui report). A new or changed
// string is caught.
const PRICE_KNOWN: Array<{ file: string; text: string; why: string }> = [
  { file: "src/components/ModelsSettings.tsx", text: "Price not listed", why: "model catalogue pricing column" },
  { file: "src/components/ModelsSettings.tsx", text: "Input price not listed", why: "model catalogue pricing column" },
  { file: "src/components/ModelsSettings.tsx", text: "output price not listed", why: "model catalogue pricing column" },
  { file: "src/lib/model-metadata.ts", text: "Price varies by route", why: "model catalogue pricing column" },
  { file: "src/lib/provider-model-picker.ts", text: "Price unavailable", why: "model catalogue pricing column" },
  { file: "src/lib/provider-model-picker.ts", text: "compatible chat model  · prices per million tokens", why: "model catalogue pricing column" },
  { file: "src/lib/usage.ts", text: "equivalent: on your subscription, not billed", why: "Usage page cost column caption, left for the owner in 0.1.60 fix3" },
  { file: "src/lib/usage.ts", text: "billed to your API key", why: "Usage page cost column caption, left for the owner in 0.1.60 fix3" },
  { file: "src/components/BrowserActivityLog.tsx", text: "free", why: "the activity log's internal decision key `free` means no approval was needed; the owner sees \"no approval needed\", never a price" },
  { file: "src/components/BrowserActivityLog.tsx", text: "browserExt.decision.free", why: "the activity log's internal decision key `free` means no approval was needed; the owner sees \"no approval needed\", never a price" },
];
const PRICE_KNOWN_KEYS = new Set([
  "providerError.payment.summary", // names HTTP 402; ProviderErrorCard's tests pin it
]);

describe("product copy rules", () => {
  it("the desktop app's own windows and dialogs show no em dash, no safe and never the connection service's name", () => {
    expect(hits(walk(join(ROOT, "electron")), RULES, DESKTOP_NOT_COPY)).toEqual([]);
    const found: string[] = [];
    for (const file of htmlFiles(join(ROOT, "electron"))) for (const text of htmlText(readFileSync(file, "utf8")))
      for (const rule of RULES) if (rule.pattern.test(text)) found.push(`${rel(file)}: ${rule.name}: ${text.slice(0, 120)}`);
    expect(found).toEqual([]);
  });

  // 0.1.61 G5: Murage for Chrome's side panel and service worker are read by
  // the person too. The extension arrives with its own lane; until then there
  // is nothing to scan.
  it("Murage for Chrome shows no em dash, no safe and never the connection service's name", () => {
    const dir = join(ROOT, "extensions/murage-browser");
    if (!existsSync(dir)) return;
    const ignore = (file: string) => file.includes("/store-assets/");
    expect(hits(walk(dir).filter(file => !ignore(file)), RULES)).toEqual([]);
    const found: string[] = [];
    for (const file of htmlFiles(dir).filter(file => !ignore(file))) for (const text of htmlText(readFileSync(file, "utf8")))
      for (const rule of RULES) if (rule.pattern.test(text)) found.push(`${file.slice(ROOT.length)}: ${rule.name}: ${text.slice(0, 120)}`);
    expect(found).toEqual([]);
  });

  it("backup and restore copy never talks price, tool names or raw error codes", () => {
    expect(hits(BACKUP_COPY_FILES.map(name => join(ROOT, name)), BACKUP_WORDS)).toEqual([]);
    const found: string[] = [];
    for (const text of htmlText(readFileSync(join(ROOT, "electron/recovery/index.html"), "utf8")))
      for (const rule of [...RULES, ...BACKUP_RULES]) if (rule.pattern.test(text)) found.push(`recovery/index.html: ${rule.name}: ${text.slice(0, 120)}`);
    expect(found).toEqual([]);
  });

  it("the backup dialogs in the desktop's main process follow the backup rules too", () => {
    const main = copyStrings("electron/main.mjs", readFileSync(join(ROOT, "electron/main.mjs"), "utf8"));
    const backup = main.filter(entry => /backup|recovery key|off-site|restore|Backup mode/i.test(entry.text));
    expect(backup.length).toBeGreaterThan(5);
    const found = backup.flatMap(entry => [...RULES, ...BACKUP_WORDS].filter(rule => rule.pattern.test(entry.text)).map(rule => `electron/main.mjs:${entry.line}: ${rule.name}: ${entry.text.slice(0, 120)}`));
    expect(found).toEqual([]);
  });

  it("the renderer shows no em dash, no safe and never the connection service's name", () => {
    expect(hits(walk(join(ROOT, "src")), RULES)).toEqual([]);
  });

  it("the browser extension follows the same visible copy rules", () => {
    const files: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) collect(full);
        else if (/\.(?:mjs|js|ts|html|json)$/.test(entry)) files.push(full);
      }
    };
    collect(join(ROOT, "extensions/murage-browser"));
    const scripts = files.filter(file => /\.(?:mjs|js|ts)$/.test(file));
    const markupHits = files.filter(file => /\.(?:html|json)$/.test(file)).flatMap(file => {
      const source = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      return RULES.filter(rule => rule.pattern.test(source)).map(rule => `${file.slice(ROOT.length)}: ${rule.name}`);
    });
    expect([...hits(scripts, RULES), ...markupHits]).toEqual([]);
  });

  // 0.1.62 T09: Murage for Chrome's own catalogues (_locales), side panel and
  // page overlay are read by the person: same rules, price talk included.
  it("the extension's message catalogues, side panel and overlay follow the copy rules, price talk included", () => {
    const dir = join(ROOT, "extensions/murage-browser");
    expect(extensionMessageHits(dir, [...RULES, PRICE]).length).toBe(0);
    expect(extensionMessageHits(dir, [...RULES, PRICE])).toEqual([]);
    const shown = [join(dir, "presence.mjs"), ...readdirSync(join(dir, "sidepanel")).filter(name => /\.(?:js|mjs)$/.test(name)).map(name => join(dir, "sidepanel", name))];
    expect(hits(shown, [PRICE])).toEqual([]);
    const found: string[] = [];
    for (const text of htmlText(readFileSync(join(dir, "sidepanel/index.html"), "utf8"))) if (PRICE.pattern.test(text)) found.push(text);
    expect(found).toEqual([]);
  });

  it("the extension catalogue scan reaches a bad string in a _locales fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-ext-copy-"));
    try {
      mkdirSync(join(root, "_locales/en"), { recursive: true });
      mkdirSync(join(root, "_locales/de"), { recursive: true });
      writeFileSync(join(root, "_locales/en/messages.json"), JSON.stringify({ ok: { message: "Pause" }, dash: { message: "Working — now" }, secure: { message: "Keep it safe" }, svc: { message: "Connect with Composio" }, cost: { message: "Only a low price" }, nested: { description: "ignored note", message: "Fine" } }));
      writeFileSync(join(root, "_locales/de/messages.json"), JSON.stringify({ dash: { message: "Arbeitet \u2014 jetzt" } }));
      const found = extensionMessageHits(root, [...RULES, PRICE]);
      expect(found.length).toBe(5);
      expect(found.join("\n")).toMatch(/en\/messages\.json: dash: an em dash/);
      expect(found.join("\n")).toMatch(/en\/messages\.json: secure: safe, safely/);
      expect(found.join("\n")).toMatch(/en\/messages\.json: svc: the connection service/);
      expect(found.join("\n")).toMatch(/en\/messages\.json: cost: price talk/);
      expect(found.join("\n")).toMatch(/de\/messages\.json: dash: an em dash/);
    } finally {
      safeWipeSync(root);
    }
  });

  it("no translated catalogue does either", () => {
    const dir = join(ROOT, "src/locales");
    const found = readdirSync(dir).filter(name => name.endsWith(".json"))
      .flatMap(name => catalogueHits(join(dir, name), RULES));
    expect(found).toEqual([]);
  });

  // 0.1.60 audit M1: every pairing refusal reached the phone's sign-in page
  // with an em dash, and neither the phone's door nor the headless installer
  // was scanned. The companion's console output is its log (not scanned);
  // the installer is a command-line tool, so its console output is copy.
  it("the phone's door and the headless installer show no em dash and no safe", () => {
    expect(hits(walk(join(ROOT, "companion/src")), [EM_DASH, SAFE], COMPANION_NOT_COPY)).toEqual([]);
    expect(hits(walk(join(ROOT, "installer")).filter(file => !rel(file).includes("/test/")), [EM_DASH, SAFE], {}, { terminal: true })).toEqual([]);
  });

  it("the server hands the window no em dash and no safe", () => {
    const files = [...walk(join(ROOT, "server")), ...walk(join(ROOT, "shared"))];
    expect(hits(files, [EM_DASH, SAFE], MODEL_FACING)).toEqual([]);
  });

  it("the renderer never talks price and shows no raw error code, beyond the reviewed exceptions", () => {
    const allowText = (entries: Array<{ file: string; text: string }>) => (found: string) =>
      !entries.some(entry => found.startsWith(`${entry.file}:`) && found.endsWith(`: ${entry.text.trim().slice(0, 120)}`));
    const found = hits(walk(join(ROOT, "src")), [PRICE, RAW_ERROR]).filter(allowText(PRICE_KNOWN));
    const dir = join(ROOT, "src/locales");
    expect([...found, ...catalogueHits(join(dir, "en.json"), [PRICE, RAW_ERROR], PRICE_KNOWN_KEYS)]).toEqual([]);
  });

  it("the price and raw-error rules catch what the 0.1.60 Mac pass found, and not the other senses of free", () => {
    for (const text of ["in a container on this machine, free and separate from your own desktop.", "Only engines that report a price show one.", "Cheaper models", "error: API error (status 429 Too Many Requests): api_error: Available credit is low",
      // 0.1.60 Linux D13
      "Images use Flux. Charges go to that connection’s account.", "Nothing here is sent to a cloud provider, and testing a model costs nothing.", "Docker Desktop may require a paid licence", "Free search: Parallel, then DuckDuckGo", "{count} free runs left today.",
      // 0.1.60 audit C2
      "Its model may incur usage charges; no skill is activated by this action.", "Uses your existing key and may incur model charges.", "It bills the Flux key saved in Settings.",
      "One low quality square draft, to keep the cost down. OpenAI bills your own API account.", "Flux Router picks a model for each turn, so what a turn costs depends on which one runs.",
      "API usage is billed to that provider account", "image generation still asks before it spends.", "Search queries are sent to the selected third-party provider and may incur separate charges."])
      expect([PRICE, RAW_ERROR].some(rule => rule.pattern.test(text)), text).toBe(true);
    for (const text of ["This page was paused to free memory.", "Check free disk space.", "Waiting for a free slot", "free up space", "free of secrets", "Waiting for a slot", "HTTP headers", "On email you stay in charge.", "Your spending limit requires reliable cost information before this check can run."])
      expect([PRICE, RAW_ERROR].some(rule => rule.pattern.test(text)), text).toBe(false);
  });

  it("a one-line preview of a failed turn goes through the plain-sentence mapping, never the raw name", () => {
    const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.tsx"), "utf8");
    const fallbacks = sidebar.match(/[^\n]*\?\? last\.tool\.name\b[^\n]*/g) ?? [];
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const line of fallbacks) expect(line, line.trim()).toContain("errorPreview(last.tool) ?? last.tool.name");
  });

  it("the safe rule holds unsafe in a sentence, and not a status code or a CSP keyword", () => {
    for (const text of ["The file location is unsafe or changed.", "Unsafe package bot addition", "unsafe support file", "The companion origin directory is unsafe", "Keep it safe", "This is an unsafe-looking file.", "This file is UNSAFE.", "This is SAFE."])
      expect(SAFE.pattern.test(text), text).toBe(true);
    for (const text of ["unsafe", "unsafe-driver-owner", "style-src 'self' 'unsafe-inline'", "pb-[env(safe-area-inset-bottom)]"])
      expect(SAFE.pattern.test(text), text).toBe(false);
  });

  it("reads literals and JSX text, never comments", () => {
    const found = copyStrings("x.tsx", '// a comment — here\nconst a = "one — two";\nconst b = <p className="pb-[env(safe-area-inset-bottom)]">Keep it safe</p>;');
    expect(found.map(entry => entry.text.trim())).toEqual(["one — two", "Keep it safe"]);
    // audit round 3 (Astra r2 L6): a one-word label on screen is not a code
    expect(copyStrings("y.tsx", 'const a = <p title="unsafe">unsafe</p>; const b = "unsafe";').map(entry => entry.shown ?? false)).toEqual([true, true, false]);
    expect(copyStrings("z.tsx", 'const a = <p title={"unsafe"}>{"unsafe"}</p>;').map(entry => entry.shown ?? false)).toEqual([true, true]);
    // audit round 4 (Astra r4 L2): a branch of a condition inside JSX is on screen too; a call's argument is not (a compared code is not read at all)
    expect(copyStrings("w.tsx", 'const a = <p title={on ? "unsafe" : ("ready")}>{on && "unsafe"}{mode === "unsafe" ? label("unsafe") : null}</p>;').map(entry => [entry.text, entry.shown ?? false]))
      .toEqual([["unsafe", true], ["ready", true], ["unsafe", true], ["unsafe", false]]);
    // audit round 5 (Kimi L1): a template shown in JSX is on screen too
    expect(copyStrings("t.tsx", 'const a = <p>{`unsafe ${kind}`}</p>; const b = `unsafe ${kind}`;').map(entry => entry.shown ?? false)).toEqual([true, false]);
  });
});
