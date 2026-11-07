// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY LINT r3 (1.0.18), design section 2: the review CLI. Run it on the build host build box, never in CI
// (CI never writes records or the ledger).
//
//   node scripts/copy-review.mjs propose <bundle.json> --base <sha> --author <who wrote the strings>
//        [--scope <what>] [--since <sha>] [--only <ids, comma-separated; "*" ends a prefix>]
//     Writes a bundle of every shipped string and pinned lint file with no valid ledger entry: its text, the English,
//     and with --since the text at that commit. A string that fails a deterministic rule is refused (listed, left
//     out, exit code 1): fix it first. The reviewer fills each "verdict" ("pass" or "fail") and an optional "note".
//
//   node scripts/copy-review.mjs record <bundle.json> --reviewer <name on copy-lint/reviewers.json> [--slug <slug>]
//        [--date <YYYY-MM-DD, not after today UTC>]
//     Checks the bundle still matches what ships, writes copy-lint/reviews/<date>-<slug>-<h12>.json (never edited
//     after), and writes the ledger (copy-lint/reviewed.json) by the same rule as rebuild, with this record counted. A
//     refusal writes neither file. "fail" entries are kept in the record as evidence and get no ledger entry: a known
//     fail counts at once.
//
//   node scripts/copy-review.mjs rebuild
//     Writes the ledger again from the records alone. This is how a merge conflict in reviewed.json resolves. For each
//     string or lint file only the newest date of the records holding its live text decides, and on that date a fail
//     beats a pass. A refusal (a record date that cannot stand) writes nothing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPY_LINT_DIR,
  LEDGER_FILE,
  PENDING_FILE,
  PINNED_FILES,
  REVIEWS_DIR,
  RULE_NAMES,
  SAME_DATE_FAIL_ROUTES,
  ledgerProblems,
  loadCopy,
  readLintFile,
  readPendingList,
  readReviewInputs,
  recordHoldsFail,
  recordId,
  resolveLedger,
  reviewDateProblem,
  ruleIds,
  shippedMap,
} from "./copy-lint.mjs";
import { LOCALES_DIR, exactHash, packPath } from "./locale-partitions.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function emptyLedger() {
  return { version: 1, strings: {}, files: {} };
}

function readLedger(dir) {
  const text = readLintFile(dir, LEDGER_FILE);
  return text === undefined ? emptyLedger() : JSON.parse(text);
}

/** Ledger entries that are valid today: everything the lint would not complain about for that id. */
function validIds(dir, copy) {
  const inputs = readReviewInputs(dir);
  const ledger = readLedger(dir);
  const shipped = shippedMap(copy);
  const problems = ledgerProblems({ ...inputs, shipped, english: copy.english, required: false });
  const bad = new Set();
  for (const problem of problems) {
    const match = /^reviewed\.json: (?:string|file) (\S+):/.exec(problem);
    if (match) bad.add(match[1]);
  }
  // A record-level problem (bad h12, unknown reviewer, reviewer == author) invalidates every entry that names it.
  const badRecords = new Set(problems.map((p) => /^reviews\/(\S+)\.json:/.exec(p)?.[1]).filter(Boolean));
  const ok = new Set();
  for (const [id, entry] of Object.entries(ledger.strings)) if (!bad.has(id) && !badRecords.has(entry.review)) ok.add(id);
  for (const [name, entry] of Object.entries(ledger.files)) if (!bad.has(name) && !badRecords.has(entry.review)) ok.add(`file:${name}`);
  return ok;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The text of one shipped string at an older commit, via git show (undefined when it did not exist). */
function textAt(sha, dir, entry, cwd, cache) {
  // English lives in several source files; the bundle shows only the live English for it.
  if (entry.locale === "en" || entry.partition === "stepup") return undefined;
  // Before r3 the Help words sat in the main pack, so a Help string also looks there.
  const partitions = entry.partition === "help" ? ["help", "main"] : ["main"];
  for (const partition of partitions) {
    const rel = relative(cwd, packPath(dir, partition, entry.locale)).split("\\").join("/");
    if (!cache.has(rel)) {
      let pack = {};
      try {
        pack = JSON.parse(execFileSync("git", ["show", `${sha}:${rel}`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
      } catch {
        // The file did not exist at that commit: nothing to show from it.
      }
      cache.set(rel, pack);
    }
    const value = cache.get(rel)[entry.key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function propose({ dir = LOCALES_DIR, base, author, scope = "strings and lint files without a valid review", since, only, repoRoot } = {}) {
  if (!base || !author) throw new Error("propose needs --base <sha> and --author <who wrote the strings>");
  const copy = loadCopy(dir);
  const links = JSON.parse(readLintFile(dir, "links.json") ?? "{}");
  const same = JSON.parse(readLintFile(dir, "same-as-english.json") ?? "{}");
  const ok = validIds(dir, copy);
  const listed = readPendingList(readLintFile(dir, PENDING_FILE));
  const bundle = { version: 1, base, since: since ?? null, author, scope, strings: {}, files: {} };
  const refused = [];
  const gitCache = new Map();
  // --only: a lane's own strings. Comma-separated: a string id ending in ":<key>" or "*"-ended id prefixes.
  const wanted = only ? only.split(",").map((part) => part.trim()).filter(Boolean) : null;
  const isWanted = (id) => !wanted || wanted.some((part) => (part.endsWith("*") ? id.startsWith(part.slice(0, -1)) : id === part));
  for (const entry of copy.entries) {
    if (ok.has(entry.id) || !isWanted(entry.id) || listed[entry.id] === exactHash(entry.value)) continue;
    const ids = ruleIds(entry, { english: copy.english[entry.key], links: links[entry.id], sameOk: Object.hasOwn(same, entry.id) });
    if (ids.length > 0) {
      refused.push(`${entry.id}: ${ids.map((id) => RULE_NAMES[id] ?? id).join("; ")}`);
      continue;
    }
    const item = { text: entry.value, en: copy.english[entry.key], verdict: "", note: "" };
    if (since && repoRoot) {
      const old = textAt(since, dir, entry, repoRoot, gitCache);
      if (old !== entry.value) item.old = old ?? null;
    }
    bundle.strings[entry.id] = item;
  }
  for (const name of PINNED_FILES) {
    const text = readLintFile(dir, name);
    if (wanted || text === undefined || ok.has(`file:${name}`)) continue;
    bundle.files[name] = { text, verdict: "" };
  }
  return { bundle, refused };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function record({ dir = LOCALES_DIR, bundle, reviewer, slug = "review", date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!bundle || bundle.version !== 1) throw new Error("record needs a version 1 bundle from propose");
  if (!SLUG.test(slug)) throw new Error(`slug must be lowercase words joined by -: ${slug}`);
  const dateProblem = reviewDateProblem(date);
  if (dateProblem) throw new Error(`date ${dateProblem}: ${date}`);
  const reviewersText = readLintFile(dir, "reviewers.json");
  const reviewers = reviewersText ? JSON.parse(reviewersText).reviewers ?? [] : [];
  const who = reviewers.find((r) => r.name === reviewer);
  if (!who) throw new Error(`reviewer ${reviewer} is not on copy-lint/reviewers.json`);
  if (who.name === bundle.author) throw new Error(`the reviewer is the author (${bundle.author})`);

  const copy = loadCopy(dir);
  const shipped = shippedMap(copy);
  const problems = [];
  const strings = {};
  for (const [id, item] of Object.entries(bundle.strings ?? {})) {
    const key = id.slice(id.indexOf(":") + 1);
    if (!["pass", "fail"].includes(item.verdict)) problems.push(`${id}: verdict must be pass or fail`);
    if (shipped.get(id) !== item.text) problems.push(`${id}: the shipped text changed since propose`);
    if (copy.english[key] !== item.en) problems.push(`${id}: the English changed since propose`);
    strings[id] = { text: item.text, en: item.en, verdict: item.verdict, ...(item.note ? { note: item.note } : {}) };
  }
  const files = {};
  for (const [name, item] of Object.entries(bundle.files ?? {})) {
    if (!PINNED_FILES.includes(name)) problems.push(`${name}: not a pinned lint file`);
    if (!["pass", "fail"].includes(item.verdict)) problems.push(`${name}: verdict must be pass or fail`);
    if (readLintFile(dir, name) !== item.text) problems.push(`${name}: the file changed since propose`);
    files[name] = { text: item.text, verdict: item.verdict };
  }
  if (problems.length > 0) throw new Error(`refusing the bundle:\n${problems.join("\n")}`);
  if (Object.keys(strings).length + Object.keys(files).length === 0) throw new Error("the bundle reviews nothing");

  const doc = {
    version: 1,
    reviewer: { kind: who.kind, name: who.name, account: who.account },
    author: bundle.author,
    date,
    base: bundle.base,
    scope: bundle.scope,
    strings,
    files,
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const id = recordId(date, slug, text);
  const reviewsDir = join(dir, COPY_LINT_DIR, REVIEWS_DIR);
  const path = join(reviewsDir, `${id}.json`);
  if (existsSync(path)) throw new Error(`${id}.json already exists`);

  // Everything is decided before anything is written, so a refusal leaves no record and no ledger change.
  const before = readLedger(dir);
  const previous = new Set([...Object.values(before.strings), ...Object.values(before.files)].map((entry) => entry.review));
  const { ledger: next, conflicts, ignored } = resolveFromDisk(dir, { [id]: text });
  const entries = [...Object.values(next.strings), ...Object.values(next.files)];
  const still = new Set(entries.map((entry) => entry.review));
  const { records } = readReviewInputs(dir);
  const holdsFail = (rid) => {
    try {
      return recordHoldsFail(JSON.parse(records[rid] ?? "null"));
    } catch {
      return false; // Unreadable bytes: its own problem is in the lint and in ignored, never a throw here.
    }
  };
  const orphaned = [...previous].filter((rid) => !still.has(rid) && !holdsFail(rid));

  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(path, text, { flag: "wx" });
  writeFileSync(join(dir, COPY_LINT_DIR, LEDGER_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { id, path, passed: Object.values(next.strings).filter((entry) => entry.review === id).length, orphaned, conflicts, ignored };
}

/** The ledger the records alone give (how a reviewed.json merge conflict resolves). The rule is resolveLedger. */
export function ledgerFromRecords({ dir = LOCALES_DIR } = {}) {
  return resolveFromDisk(dir).ledger;
}

/** resolveLedger on what is on disk; `extra` is a record about to be written. A date that cannot stand is refused. */
function resolveFromDisk(dir, extra = {}) {
  const copy = loadCopy(dir);
  const { records, files, reviewersText } = readReviewInputs(dir);
  const resolved = resolveLedger({ shipped: shippedMap(copy), english: copy.english, files, reviewersText, records: { ...records, ...extra } });
  if (resolved.badDates.length > 0) throw new Error(`refusing to rebuild the ledger from these records:\n${resolved.badDates.join("\n")}`);
  return resolved;
}

export function rebuild({ dir = LOCALES_DIR } = {}) {
  const { ledger: next, conflicts, ignored } = resolveFromDisk(dir);
  writeFileSync(join(dir, COPY_LINT_DIR, LEDGER_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { strings: Object.keys(next.strings).length, files: Object.keys(next.files).length, conflicts, ignored };
}

function reportConflicts({ conflicts, ignored }) {
  if (ignored.length > 0) console.error(ignored.join("\n"));
  if (conflicts.length > 0) console.error(`${conflicts.join("\n")}\n${SAME_DATE_FAIL_ROUTES}`);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv = process.argv.slice(2), { dir = LOCALES_DIR, repoRoot = resolve(dir, "..", "..") } = {}) {
  const [command, file] = argv;
  if (command === "propose" && file) {
    const { bundle, refused } = propose({
      dir,
      base: option(argv, "--base"),
      author: option(argv, "--author"),
      scope: option(argv, "--scope"),
      since: option(argv, "--since"),
      only: option(argv, "--only"),
      repoRoot,
    });
    writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
    console.error(`wrote ${file}: ${Object.keys(bundle.strings).length} strings, ${Object.keys(bundle.files).length} files to review`);
    if (refused.length > 0) {
      console.error(`refused ${refused.length} strings that fail a rule (fix them first):\n${refused.join("\n")}`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "record" && file) {
    const result = record({
      dir,
      bundle: readJsonFile(file),
      reviewer: option(argv, "--reviewer"),
      slug: option(argv, "--slug"),
      date: option(argv, "--date"),
    });
    console.error(`wrote ${result.path}; ledger points ${result.passed} strings at it`);
    if (result.orphaned.length > 0) console.error(`records no longer referenced (delete them in this commit): ${result.orphaned.join(", ")}`);
    reportConflicts(result);
    return;
  }
  if (command === "rebuild") {
    const result = rebuild({ dir });
    console.log(`ledger rebuilt from the records: ${result.strings} strings, ${result.files} files`);
    reportConflicts(result);
    return;
  }
  throw new Error("usage: copy-review.mjs rebuild\n       copy-review.mjs propose <bundle> --base <sha> --author <who> [--scope <s>] [--since <sha>]\n       copy-review.mjs record <bundle> --reviewer <name> [--slug <slug>] [--date <YYYY-MM-DD>]");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
