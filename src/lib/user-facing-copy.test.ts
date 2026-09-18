import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Nothing a person reads in Murage should say what a developer would say.
 *
 * Three classes have all shipped at least once and are all screenshot-visible:
 *
 *  - a package-manager or terminal command in the main window
 *    ("Start it with `pnpm dev:server`"),
 *  - an internal codename ("Choose a EMBER"),
 *  - a path into the person's own config file that they are asked to edit
 *    ('add {"box":{"token":"…"}} to ~/.murage/config.json').
 *
 * This test fails on any of them so none can come back. Comments are stripped
 * first — an explanation of why the code does something is not copy — and the
 * renderer's source is scanned whole, so JSX text counts as much as a string
 * literal. The engine drivers are scanned through the three fields whose text
 * is shown verbatim on the setup and error cards.
 */

const ROOT = new URL("../..", import.meta.url).pathname;

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "a package-manager or shell command",
    pattern: /\b(?:pnpm\b|npm (?:run|install|i|exec)\b|npx \b|yarn \b|brew install\b|apt-get\b|pip install\b|sudo \b)/,
  },
  {
    // The bot noun is "bot". "Maus" and "Ember" are the codenames it has had
    // in the source; neither has ever been a word in the product's copy.
    name: "an internal codename",
    pattern: /\b(?:EMBER|EMBERS|MAUS|MAUSES|SupaMaus|OpenMaus(?:Bot)?)\b/,
  },
  {
    name: "a path into the person's own config file",
    pattern: /~[/\\]\.(?:murage|fuigo)\b|%USERPROFILE%\\\.(?:murage|fuigo)\b/,
  },
];

/** Comments explain the code to the next reader; they are never shown. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests and end-to-end specs describe the copy; they are not the copy.
      if (entry === "e2e" || entry === "__fixtures__" || entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (!/\.(?:tsx|ts)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function findings(label: string, text: string, rules = FORBIDDEN): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of rules) {
    for (const line of text.split("\n")) {
      // A URL is an address, not copy: an upstream project's own release link
      // keeps its own spelling and is never read as a sentence.
      if (/https?:\/\//.test(line) && !/[A-Za-z] [A-Za-z]/.test(line.replace(/https?:\/\/\S+/g, ""))) continue;
      const match = line.match(pattern);
      if (match) hits.push(`${label}: ${name} — ${line.trim().slice(0, 140)}`);
    }
  }
  return hits;
}

describe("user-facing copy", () => {
  it("never shows a terminal command, an internal codename or a config-file path in the renderer", () => {
    const hits: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      hits.push(...findings(file.slice(ROOT.length), stripComments(readFileSync(file, "utf8"))));
    }
    expect(hits).toEqual([]);
  });

  it("never shows one in the translated catalogue", () => {
    const catalogue = readFileSync(join(ROOT, "src/locales/en.json"), "utf8");
    expect(findings("src/locales/en.json", catalogue)).toEqual([]);
  });

  it("never asks anyone to edit a config file, and never leaks a codename, from the server", () => {
    // The server's own refusals and unavailable reasons are shown verbatim on
    // the engine and error cards. A shell command is allowed here and only
    // here: installing a command-line engine really is a terminal step, and
    // the setup card offers it as a copyable command on purpose. Editing the
    // person's config file by hand never is.
    const serverOnly = FORBIDDEN.filter((rule) => rule.name !== "a package-manager or shell command");
    const hits: string[] = [];
    for (const file of walk(join(ROOT, "server"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      hits.push(...findings(file.slice(ROOT.length), source, serverOnly));
    }
    expect(hits).toEqual([]);
  });
});
