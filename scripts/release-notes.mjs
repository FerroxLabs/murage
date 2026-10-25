// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Curated release notes for the in-app update card (B-201).
//
// The card shows the update feed's `releaseNotes` (electron/release-notes-text.mjs). electron-builder writes that
// field into latest.yml, latest-mac.yml and latest-linux.yml from `build/release-notes.md` when the file exists
// (app-builder-lib updateInfoBuilder getReleaseInfo, buildResources = build). Without it the updater falls back to
// the GitHub release body, which starts life as a generated list of pull requests.
//
// So every package job stages `release-notes/<version>.md` (written and reviewed like code) as build/release-notes.md
// before electron-builder runs (package:prepare). In the Release workflow a version with no curated notes, or notes
// that break the copy rules, stops the build: the card never shows a pull-request list. Elsewhere (local packaging,
// qualification builds) a missing file only removes any stale staged copy.
//
//   node scripts/release-notes.mjs stage            (version from package.json)
//   node scripts/release-notes.mjs check [version]  (the Release workflow's first step, before any build)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_NOTES_MAX } from "../electron/release-notes-text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STAGED_NOTES = join("build", "release-notes.md");
const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;

export const curatedNotesPath = (version) => join("release-notes", `${version}.md`);

/** The copy rules every curated note follows. Returns the problems, empty when the notes are fine. */
export function releaseNotesProblems(text) {
  const problems = [];
  const body = String(text ?? "").trim();
  if (!body) return ["the notes are empty"];
  if (body.length > RELEASE_NOTES_MAX) problems.push(`the notes are ${body.length} characters; the update card shows at most ${RELEASE_NOTES_MAX}`);
  if (/—/.test(body)) problems.push("an em dash: use a comma, a colon or a full stop");
  const banned = body.match(/\b(?:safe|unsafe|safety|safely)\b/i);
  if (banned) problems.push(`the word "${banned[0]}": say what Murage does instead`);
  if (/composio/i.test(body)) problems.push('the word "Composio": say "connected apps"');
  if (/<\/?[a-z][^>]*>/i.test(body)) problems.push("HTML tags: the card shows plain text only");
  if (/[$€£]\s?\d|\bprice\b|\bpricing\b/i.test(body)) problems.push("price talk: the notes never mention prices");
  return problems;
}

/** What a Release run says when the version has no curated notes: the file to write, named in full. */
export const missingNotesMessage = (version) =>
  `${curatedNotesPath(version)} is missing: write the notes the update card shows for ${version} (plain text or Markdown, a few short lines) and commit it before releasing`;

/** The Release workflow's first check, run before any build: the curated notes for `version` exist and follow the
 * copy rules. Throws a message naming the file otherwise, so a release stops in minutes, not after every build. */
export function checkReleaseNotes(version, { root = ROOT } = {}) {
  if (!VERSION.test(String(version))) throw new Error(`not a release version: ${version}`);
  const source = join(root, curatedNotesPath(version));
  if (!existsSync(source)) throw new Error(missingNotesMessage(version));
  const problems = releaseNotesProblems(readFileSync(source, "utf8"));
  if (problems.length) throw new Error(`${curatedNotesPath(version)}:\n- ${problems.join("\n- ")}`);
  return curatedNotesPath(version);
}

/** Stages the curated notes for `version` where electron-builder reads them. Throws when `required` and they are
 * missing or break the copy rules. Returns the staged path, or undefined when nothing was staged. */
export function stageReleaseNotes(version, { root = ROOT, required = false } = {}) {
  if (!VERSION.test(String(version))) throw new Error(`not a release version: ${version}`);
  const source = join(root, curatedNotesPath(version));
  const staged = join(root, STAGED_NOTES);
  // A copy left from another version must never ride along in this build's feeds.
  rmSync(staged, { force: true });
  if (!existsSync(source)) {
    if (required) throw new Error(missingNotesMessage(version));
    return undefined;
  }
  const text = readFileSync(source, "utf8");
  const problems = releaseNotesProblems(text);
  if (problems.length) {
    const message = `${curatedNotesPath(version)}:\n- ${problems.join("\n- ")}`;
    if (required) throw new Error(message);
    console.warn(`release notes not staged, ${message}`);
    return undefined;
  }
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, `${text.trim()}\n`);
  return staged;
}

/** The Release workflow is the one place a missing note stops the build (GitHub sets GITHUB_WORKFLOW to its name). */
export const notesRequired = (env = process.env) => env.GITHUB_WORKFLOW === "Release" || env.MURAGE_RELEASE_NOTES_REQUIRED === "1";

function main(argv) {
  const [command, versionArg] = argv;
  const version = versionArg ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (command === "stage") {
    const staged = stageReleaseNotes(version, { required: notesRequired() });
    console.log(staged ? `staged ${curatedNotesPath(version)} as ${STAGED_NOTES}` : `no curated release notes for ${version}`);
    return;
  }
  if (command === "check") {
    console.log(`${checkReleaseNotes(version)} is ready for the update card`);
    return;
  }
  throw new Error("usage: node scripts/release-notes.mjs stage | check [version]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
