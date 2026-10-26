// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B-201 / U47: the release build stages curated notes where electron-builder writes them into the update feeds, so
// the update card says what is new instead of showing a list of pull requests.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { checkReleaseNotes, curatedNotesPath, notesRequired, releaseNotesProblems, stageReleaseNotes, STAGED_NOTES } from "./release-notes.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const tree = (notes) => {
  const root = mkdtempSync(join(tmpdir(), "notes-"));
  roots.push(root);
  if (notes !== undefined) { mkdirSync(join(root, "release-notes")); writeFileSync(join(root, curatedNotesPath("1.0.4")), notes); }
  return root;
};

describe("curated release notes for the update card", () => {
  it("stages the version's notes as build/release-notes.md, the file electron-builder reads into latest*.yml", () => {
    const root = tree("- **Settings keep your words.** A search no longer clears a skill you are writing.\n");
    expect(stageReleaseNotes("1.0.4", { root, required: true })).toBe(join(root, STAGED_NOTES));
    expect(readFileSync(join(root, "build", "release-notes.md"), "utf8")).toBe("- **Settings keep your words.** A search no longer clears a skill you are writing.\n");
  });

  it("stops the Release workflow when the version has no curated notes", () => {
    expect(() => stageReleaseNotes("1.0.4", { root: tree(), required: true })).toThrow(/release-notes\/1\.0\.4\.md is missing/);
    expect(notesRequired({ GITHUB_WORKFLOW: "Release" })).toBe(true);
    expect(notesRequired({ GITHUB_WORKFLOW: "CI" })).toBe(false);
  });

  it("drops a stale staged copy when another version is packaged locally", () => {
    const root = tree();
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, STAGED_NOTES), "old notes");
    expect(stageReleaseNotes("1.0.4", { root })).toBeUndefined();
    expect(existsSync(join(root, STAGED_NOTES))).toBe(false);
  });

  it("holds the notes to the copy rules", () => {
    expect(releaseNotesProblems("Faster — and safe")).toHaveLength(2);
    expect(releaseNotesProblems("Composio apps")).toHaveLength(1);
    expect(releaseNotesProblems("<b>new</b>")).toHaveLength(1);
    expect(releaseNotesProblems("Now $5 a month")).toHaveLength(1);
    expect(releaseNotesProblems("  ")).toEqual(["the notes are empty"]);
    expect(releaseNotesProblems("x".repeat(8001))).toHaveLength(1);
    expect(releaseNotesProblems("- **Replies read in your language.**")).toEqual([]);
    expect(() => stageReleaseNotes("1.0.4", { root: tree("A safety fix"), required: true })).toThrow(/safety/);
  });

  it("runs before every package build", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["package:prepare"]).toMatch(/ && node scripts\/release-notes\.mjs stage$/);
    expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8")).toContain("/build/release-notes.md");
  });

  it("check fails fast with a message naming the missing file", () => {
    expect(() => checkReleaseNotes("1.0.4", { root: tree() })).toThrow(
      /^release-notes\/1\.0\.4\.md is missing: write the notes the update card shows for 1\.0\.4/,
    );
    expect(() => checkReleaseNotes("1.0.4", { root: tree("A safety fix") })).toThrow(/release-notes\/1\.0\.4\.md:\n- the word "safety"/);
    expect(checkReleaseNotes("1.0.4", { root: tree("- **Replies read in your language.**") })).toBe(curatedNotesPath("1.0.4"));
    expect(() => checkReleaseNotes("not-a-version", { root: tree() })).toThrow(/not a release version/);
  });

  it("the Release workflow checks the notes before any build starts", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const prepare = workflow.slice(workflow.indexOf("\n  prepare:"), workflow.indexOf("\n  ci-gate:"));
    expect(prepare).toMatch(/node scripts\/release-notes\.mjs check "\$\(node scripts\/release-guard\.mjs version\)"/);
    // Every platform build waits on prepare, so the check runs before any of them.
    for (const job of ["mac", "windows", "linux"]) {
      const at = workflow.indexOf(`\n  ${job}:`);
      expect(at).toBeGreaterThan(0);
      expect(workflow.slice(at, at + 400)).toMatch(/needs: (?:prepare|\[prepare)/);
    }
  });
});
