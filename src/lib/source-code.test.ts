// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AGPL section 13: anyone using Murage over a network, in the desktop app or
// in the browser door, is offered the source. Source contract, not a render
// test: the renderer suite runs with no DOM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { resolveBuildCommit } from "../../scripts/build-commit.mjs";
import { SOURCE_CODE_URL, sourceCodeLink, sourceVersionLabel } from "./source-code";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const KEYS = ["settings.about.sourceTitle", "settings.about.sourceNote", "settings.about.sourceOpen"] as const;

describe("source code offer (AGPL section 13)", () => {
  it("points at the public repository", () => {
    expect(SOURCE_CODE_URL).toBe("https://github.com/FerroxLabs/murage");
  });

  it("renders in the About section on every surface, not only the desktop", () => {
    const page = read("../components/settings/pages/AboutPage.tsx");
    const block = page.slice(page.indexOf('id: "about.shortcuts"'), page.indexOf("\n  ];"));
    expect(block).toMatch(/<SourceCodeRow\s*\/>/);
    expect(block).not.toMatch(/desktop === true && <SourceCodeRow/);
    expect(block).not.toMatch(/desktop[^\n]*\?[^\n]*<SourceCodeRow/);
    expect(block).toContain('subtitle={t("settings.about.sourceNote")}');
    expect(block).toMatch(/<Card\b[^>]*><SourceCodeRow\s*\/><\/Card>/);
    const sections = read("./settings-sections.ts");
    expect(sections).toMatch(/\{ id: "about", group: "app" \}/); // not desktopOnly: the browser door shows it
  });

  it("links to the repository with the running version", () => {
    const rows = read("../components/settings/pages/about-rows.tsx");
    const row = rows.slice(rows.indexOf("function SourceCodeRow"));
    const body = row.slice(0, row.indexOf("\n}\n"));
    expect(body).toContain("sourceCodeLink()");
    expect(body).toContain('rel="noopener noreferrer"');
    // About owns the surrounding Card; the retained row names the running version and links to its exact commit.
    expect(body).toContain("sourceVersionLabel(APP_VERSION)");
  });

  it("links to the exact commit when the build knows it, else the repository", () => {
    const sha = "a".repeat(40);
    expect(sourceCodeLink(sha)).toBe(`${SOURCE_CODE_URL}/tree/${sha}`);
    expect(sourceCodeLink(null)).toBe(SOURCE_CODE_URL);
    expect(sourceCodeLink("not-a-sha")).toBe(SOURCE_CODE_URL);
    expect(sourceVersionLabel("0.1.62", sha)).toBe("Murage 0.1.62 (commit aaaaaaa)");
    expect(sourceVersionLabel("0.1.62", null)).toBe("Murage 0.1.62");
  });

  it("resolves the build commit from git, and falls back to null without it", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveBuildCommit(() => `${sha}\n`)).toBe(sha);
    expect(resolveBuildCommit(() => { throw new Error("git: not found"); })).toBeNull();
    expect(resolveBuildCommit(() => "fatal: not a git repository")).toBeNull();
  });

  it("has copy in every locale, without em dashes", async () => {
    const packs = await allLocalePacks();
    for (const key of KEYS) {
      expect(en[key]).toBeTruthy();
      for (const [code, pack] of Object.entries(packs)) {
        const value = (pack as Record<string, string>)[key];
        expect(value, `${code} ${key}`).toBeTruthy();
        expect(value).not.toMatch(/—/);
      }
    }
    expect(en["settings.about.sourceNote"]).toMatch(/AGPL/);
  });
});
