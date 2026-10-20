#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which Vitest files block a release, and on which OSes (docs/testing.md, "GATE and EXTENDED tests").
//
//   ci/gate-tests.txt      path <TAB> OSes <TAB> the user failure the test prevents. Blocking in ci.yml.
//   ci/extended-tests.txt  path <TAB> note. Runs on Linux in ci.yml's "extended (non-blocking)" job.
//
// Every file vite.config.ts includes must be in exactly one list. Tests over 60 s or with a wall-clock budget
// carry the `nightly` / `perf-budget` tags and run in nightly.yml, wherever their file is listed.
//
//   node scripts/ci-test-tiers.mjs check
//   node scripts/ci-test-tiers.mjs list --tier gate|extended [--os linux|mac|windows] [--shard i/n] [--skip path]...
//       Prints one vitest argument per line: the selected files, then `--exclude <file>` for every other test
//       file whose path contains a selected path (Vitest matches positional filters by substring).
//   node scripts/ci-test-tiers.mjs import <tiers.tsv>
//       Rewrites both lists from a tier table (path, decision, reason, ...). GATE/KEEP rows are gate files; every
//       other decision (EXTENDED, MERGE, NIGHTLY, DELETE) is extended until its change lands. A gate file already
//       listed keeps its OSes; a new one gets them from its own platform guards (see deriveOses).

import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = "ci/gate-tests.txt";
const EXTENDED = "ci/extended-tests.txt";
export const OSES = ["linux", "mac", "windows"];

function fail(message) {
  throw new Error(`ci-test-tiers: ${message}`);
}

/** The test files vite.config.ts includes (its `include` and `exclude` lists, plus node_modules). */
export function vitestFiles(root = ROOT) {
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  const block = name => {
    const match = config.match(new RegExp(`\\b${name}:\\s*\\[([\\s\\S]*?)\\]`));
    return match ? [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
  };
  const include = block("include");
  if (!include.length) fail("could not read test.include from vite.config.ts");
  const exclude = new Set(block("exclude"));
  const files = new Set();
  for (const pattern of include) {
    for (const file of globSync(pattern, { cwd: root, exclude: path => /(^|\/)node_modules(\/|$)/.test(path) })) {
      const posix = file.split("\\").join("/");
      if (!exclude.has(posix)) files.add(posix);
    }
  }
  return [...files].sort();
}

function parseOses(value, where) {
  if (value === "all") return [...OSES];
  const list = value.split("+");
  for (const os of list) if (!OSES.includes(os)) fail(`${where}: unknown OS "${os}" (use all, or ${OSES.join(", ")} joined by +)`);
  return list;
}

/** Both lists, validated: no duplicates, no file in both, every gate row has OSes and a reason. */
export function readLists(root = ROOT) {
  const rows = file => readFileSync(join(root, file), "utf8").split("\n")
    .map((line, index) => ({ line, where: `${file}:${index + 1}` }))
    .filter(({ line }) => line.trim() && !line.startsWith("#"));
  const gate = new Map();
  for (const { line, where } of rows(GATE)) {
    const [path, oses, reason] = line.split("\t");
    if (!path || !oses || !reason?.trim()) fail(`${where}: need "path<TAB>OSes<TAB>the user failure it prevents"`);
    if (gate.has(path)) fail(`${where}: ${path} is listed twice`);
    gate.set(path, { oses: parseOses(oses, where), osText: oses, reason: reason.trim() });
  }
  const extended = new Map();
  for (const { line, where } of rows(EXTENDED)) {
    const [path, note = ""] = line.split("\t");
    if (extended.has(path)) fail(`${where}: ${path} is listed twice`);
    if (gate.has(path)) fail(`${where}: ${path} is in both lists`);
    extended.set(path, note);
  }
  return { gate, extended };
}

export function check(root = ROOT) {
  const { gate, extended } = readLists(root);
  const files = vitestFiles(root);
  const known = new Set(files);
  const unlisted = files.filter(file => !gate.has(file) && !extended.has(file));
  const stale = [...gate.keys(), ...extended.keys()].filter(file => !known.has(file));
  const problems = [
    ...unlisted.map(file => `unclassified test file: ${file} (add it to ${GATE} or ${EXTENDED}; see docs/testing.md)`),
    ...stale.map(file => `listed but not a Vitest file: ${file}`),
  ];
  return { problems, gate: gate.size, extended: extended.size, files: files.length };
}

/** Stable, directory-spreading order: sort by a hash of the path, then deal round-robin. */
function shardOf(files, index, count) {
  const keyed = files.map(file => [createHash("sha1").update(file).digest("hex"), file]).sort(([a], [b]) => a.localeCompare(b));
  return keyed.filter((_, i) => i % count === index - 1).map(([, file]) => file).sort();
}

export function select({ tier, os, shard, skip = [] }, root = ROOT) {
  const { gate, extended } = readLists(root);
  let files = tier === "gate"
    ? [...gate].filter(([, entry]) => !os || entry.oses.includes(os)).map(([file]) => file)
    : [...extended.keys()];
  files = files.filter(file => !skip.includes(file)).sort();
  if (shard) {
    const [index, count] = shard.split("/").map(Number);
    if (!(count >= 1 && index >= 1 && index <= count)) fail(`bad --shard ${shard}`);
    files = shardOf(files, index, count);
  }
  const chosen = new Set(files);
  const lowered = files.map(file => file.toLowerCase());
  const collateral = vitestFiles(root).filter(file => !chosen.has(file) && lowered.some(f => file.toLowerCase().includes(f)));
  return { files, collateral };
}

/** OSes a gate file applies to, from its location and its own top-level platform guards. Unsure means all. */
export function deriveOses(path, source) {
  if (path.startsWith("server/cloud-home/")) return "linux";
  const platform = String.raw`process\.platform\s*(===|!==)\s*["'](win32|linux|darwin)["']`;
  const guard = new RegExp(String.raw`^(?:describe|it|test)\.(skipIf|runIf)\(\s*${platform}\s*\)`);
  const topLevel = source.split("\n").filter(line => /^(describe|it|test)[.(]/.test(line));
  if (!topLevel.length) return "all";
  const union = new Set();
  for (const line of topLevel) {
    const match = line.match(guard);
    if (!match) return "all";
    const [, kind, op, name] = match;
    const os = { win32: "windows", linux: "linux", darwin: "mac" }[name];
    const runsOnlyThere = (kind === "runIf") === (op === "===");
    for (const each of runsOnlyThere ? [os] : OSES.filter(other => other !== os)) union.add(each);
  }
  return union.size === OSES.length ? "all" : OSES.filter(os => union.has(os)).join("+");
}

function importTable(table, root = ROOT) {
  let previous = new Map();
  try { previous = readLists(root).gate; } catch { /* first import */ }
  const gate = [];
  const extended = [];
  // The table may also tier Playwright, Worker and phone-app tests; those run in their own jobs.
  const vitest = new Set(vitestFiles(root));
  for (const line of readFileSync(table, "utf8").split("\n")) {
    const [path, decision = "", reason = ""] = line.split("\t");
    if (!path || !vitest.has(path) || line.startsWith("#")) continue;
    const kind = decision.trim().toUpperCase();
    if (kind === "GATE" || kind === "KEEP") {
      const oses = previous.get(path)?.osText ?? deriveOses(path, readFileSync(join(root, path), "utf8"));
      gate.push(`${path}\t${oses}\t${(reason || "named in the tier review").replace(/\s+/g, " ").trim()}`);
    } else {
      extended.push(`${path}\t${kind === "EXTENDED" ? "extended" : `${kind.toLowerCase()} (pending review; runs here until then)`}`);
    }
  }
  const header = lines => lines.map(text => `# ${text}`).join("\n");
  writeFileSync(join(root, GATE), `${header([
    "GATE tests: they block CI and a release. One file per line: path <TAB> OSes <TAB> the user failure it prevents.",
    "OSes: all, or linux / mac / windows joined by + (only where the behaviour exists). Rule: docs/testing.md.",
  ])}\n${gate.sort().join("\n")}\n`);
  writeFileSync(join(root, EXTENDED), `${header([
    "EXTENDED tests: ci.yml runs them on Linux in the non-blocking \"extended\" job. Failures show, never block.",
    "One file per line: path <TAB> note.",
  ])}\n${extended.sort().join("\n")}\n`);
  console.log(`gate ${gate.length}, extended ${extended.length}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const option = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === "check") {
    const result = check();
    for (const problem of result.problems) console.error(`::error::${problem}`);
    if (result.problems.length) process.exit(1);
    console.log(`ok: ${result.files} Vitest files; ${result.gate} gate, ${result.extended} extended`);
  } else if (command === "list") {
    const tier = option("tier");
    if (tier !== "gate" && tier !== "extended") fail("list needs --tier gate|extended");
    const os = option("os");
    if (os && !OSES.includes(os)) fail(`unknown --os ${os}`);
    const skip = rest.flatMap((arg, i) => (arg === "--skip" ? [rest[i + 1]] : []));
    const { files, collateral } = select({ tier, os, shard: option("shard"), skip });
    for (const file of files) console.log(file);
    for (const file of collateral) console.log(`--exclude\n${file}`);
  } else if (command === "import") {
    if (!rest[0]) fail("import needs a tier table");
    importTable(rest[0]);
  } else {
    fail("usage: check | list --tier gate|extended [--os ...] [--shard i/n] [--skip path] | import <tsv>");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
