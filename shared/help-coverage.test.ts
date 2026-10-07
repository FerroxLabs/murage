// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps the shipped help from falling behind the app. Bots answer "how does X
// work in Murage?" from `murage_help`, which only knows what the docs say, so a
// release whose features are missing from the docs leaves every bot guessing.
// Bumping the version in package.json fails this file until the release has a
// changelog page. What the help must cover is no longer a hand-kept list: it is
// generated from the code (scripts/build-capabilities.mjs) and checked in
// shared/help-capabilities.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG = `${root}apps/docs/content/docs/changelog/`;
const version: string = JSON.parse(readFileSync(`${root}package.json`, "utf8")).version;

function changelogPage(release: string): string {
  return `${CHANGELOG}v${release.replaceAll(".", "-")}.mdx`;
}

describe("help keeps up with the release", () => {
  it(`has a changelog page for the version in package.json (${version})`, () => {
    const page = changelogPage(version);
    expect(existsSync(page), `missing changelog page for ${version}`).toBe(true);
    expect(readFileSync(page, "utf8")).toMatch(new RegExp(`^title: .*${version.replaceAll(".", "\\.")}`, "m"));
    const meta = JSON.parse(readFileSync(`${CHANGELOG}meta.json`, "utf8")) as { pages: string[] };
    expect(meta.pages).toContain(`v${version.replaceAll(".", "-")}`);
  });
});
