// SPDX-License-Identifier: AGPL-3.0-or-later
// House rule: the name of the service behind connected apps is never shown to
// a person. Nothing is allowlisted: a locale value or a piece of component
// prose that names it fails this test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NAME = /composio/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "e2e" || entry === "locales") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.|\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Prose inside a string literal or between JSX tags. Identifiers, imports,
 * regular expressions and comments are code, not text a person reads. */
function visibleText(source: string): string[] {
  const found: string[] = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of stripped.split("\n")) {
    const code = line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, "");
    if (!code.trim() || /^\s*import /.test(code)) continue;
    for (const [, text] of code.matchAll(/["'`]([^"'`\\\n]{2,})["'`]/g)) if (/\s/.test(text)) found.push(text);
    for (const [, text] of code.matchAll(/>([^<>{}]{2,})</g)) found.push(text);
  }
  return found;
}

describe("the service behind connected apps is never named to a person", () => {
  it("appears in no value of any locale", () => {
    const dir = join(here, "locales");
    const files = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "source-hashes.json");
    expect(files.length).toBeGreaterThanOrEqual(8);
    const hits: string[] = [];
    for (const file of files) {
      const catalogue = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, string>;
      for (const [key, value] of Object.entries(catalogue)) if (NAME.test(value)) hits.push(`${file}: ${key}`);
    }
    expect(hits).toEqual([]);
  });

  it("appears in no prose of any component, store or helper", () => {
    const files = [...walk(here), join(root, "shared/key-extract.ts")];
    const hits: string[] = [];
    for (const file of files) {
      for (const text of visibleText(readFileSync(file, "utf8"))) {
        if (NAME.test(text)) hits.push(`${relative(root, file)}: ${text.slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
