// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps the shipped help from falling behind the app. Bots answer "how does X
// work in Murage?" from `murage_help`, which only knows what the docs say, so a
// release whose features are missing from the docs leaves every bot guessing.
// Bumping the version in package.json fails this file until the release has a
// changelog page and its headline features can be found by help search.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { searchHelp, stem, tokenize } from "./help-search.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG = `${root}apps/docs/content/docs/changelog/`;
const version: string = JSON.parse(readFileSync(`${root}package.json`, "utf8")).version;

/** Terms a person would use to ask about each release's features. Every term
 * must find a help section that actually talks about it. Add the next
 * release's list when you bump the version: the test below insists on it. */
const RELEASE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "0.1.59": [
    "no limits",
    "full access",
    "allow for this task",
    "always allow",
    "approved steps",
    "house rules",
    "what shapes a bot",
    "skill guard",
    "import a skill",
    "duplicate a skill",
    "what's new",
    "tray",
    "new team",
    "engine commands",
    "voice picker",
    "voice note",
    "web search",
  ],
  "0.1.60": [
    "routine approval level",
    "waiting on you",
    "always allow for this routine",
    "always allow this exact command",
    "engines that cannot ask",
    "pi engine",
    "snooze",
    "about me",
    "manage teams",
    "team lead",
    "notification sounds",
    "play button",
    "connected apps",
  ],
};

function changelogPage(release: string): string {
  return `${CHANGELOG}v${release.replaceAll(".", "-")}.mdx`;
}

/** Every word of the term (after stopwords) appears, in some form, in what
 * the top results say. A result that merely shares one word is not coverage. */
function covers(term: string, results: ReturnType<typeof searchHelp>): boolean {
  const said = new Set(
    tokenize(results.map((result) => `${result.title} ${result.heading ?? ""} ${result.text}`).join(" ")).map(stem),
  );
  return tokenize(term).every((word) => said.has(stem(word)));
}

describe("help keeps up with the release", () => {
  it(`has a changelog page for the version in package.json (${version})`, () => {
    const page = changelogPage(version);
    expect(existsSync(page), `missing changelog page for ${version}`).toBe(true);
    expect(readFileSync(page, "utf8")).toMatch(new RegExp(`^title: .*${version.replaceAll(".", "\\.")}`, "m"));
    const meta = JSON.parse(readFileSync(`${CHANGELOG}meta.json`, "utf8")) as { pages: string[] };
    expect(meta.pages).toContain(`v${version.replaceAll(".", "-")}`);
  });

  it(`lists help keywords for ${version}`, () => {
    expect(RELEASE_KEYWORDS[version]?.length ?? 0, `add RELEASE_KEYWORDS["${version}"]`).toBeGreaterThan(0);
  });

  for (const [release, terms] of Object.entries(RELEASE_KEYWORDS)) {
    it(`finds every ${release} feature in the help`, () => {
      expect(existsSync(changelogPage(release)), `missing changelog page for ${release}`).toBe(true);
      for (const term of terms) {
        const results = searchHelp(term);
        expect(results.length, term).toBeGreaterThan(0);
        expect(covers(term, results), `help results for "${term}" do not talk about it`).toBe(true);
      }
    });
  }
});

describe("help answers the questions 0.1.59 and 0.1.60 raise", () => {
  const questions: Array<[string, RegExp]> = [
    ["routine approval level", /routine[\s\S]*(level|Ask|Auto|Full access|No limits)/i],
    ["waiting on you", /waiting on you/i],
    ["always allow this exact command", /Always allow this exact command/i],
    ["snooze", /snooze/i],
    ["about me", /About me/i],
    ["house rules", /House rules/i],
    ["skill guard", /Skill Guard/i],
    ["what's new", /What's new/i],
    ["no limits", /No limits/i],
    ["connected apps not working", /Connected apps[\s\S]*refresh/i],
  ];
  for (const [question, shape] of questions) {
    it(`answers "${question}"`, () => {
      const results = searchHelp(question);
      expect(results.length, question).toBeGreaterThan(0);
      expect(results.map((result) => `${result.title} ${result.heading ?? ""} ${result.text}`).join(" ")).toMatch(shape);
    });
  }
});
