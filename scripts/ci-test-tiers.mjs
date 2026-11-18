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
// Every *.node-test.mjs/ts must be reached by a blocking Node runner in ci.yml or nightly.yml.
//
//   node scripts/ci-test-tiers.mjs check
//   node scripts/ci-test-tiers.mjs list --tier gate|extended|nightly [--os linux|mac|windows] [--shard i/n] [--skip path]... [--config vitest.<name>.config.ts]
//       Prints one vitest argument per line: the selected files, then `--exclude <file>` for every other test
//       file whose path contains a selected path (Vitest matches positional filters by substring).
//       A test file that a root vitest.*.config.ts names runs only through that config (its transform, pool and
//       environment): plain lists leave it out, and `--config vitest.<name>.config.ts` selects the gate files it owns.
//       check refuses an owned gate file unless a blocking ci.yml step lists that config.
//   node scripts/ci-test-tiers.mjs run-node [--exclude path/glob] [--shard i/n] <node-test globs>...
//       Expands quoted globs, then runs Node with bounded file concurrency; preserves failures.
//   node scripts/ci-test-tiers.mjs import <tiers.tsv>
//       Rewrites both lists from a tier table (path, decision, reason, ...). GATE/KEEP rows are gate files; every
//       other decision (EXTENDED, MERGE, DELETE) is extended until its change lands; a NIGHTLY file is listed in
//       extended with the note "nightly": the extended job leaves it out and nightly.yml runs it whole. A gate file already
//       listed keeps its OSes; a new one gets them from its own platform guards (see deriveOses).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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

const nodeTestPath = /\.(?:node-test|test)\.(?:[cm]?[jt]s)$/;
const generatedDirectory = /(^|[/\\])(?:node_modules|\.git|\.next|dist|dist-server|release)([/\\]|$)/;

/** Discover independently of the runners: an orphan must not disappear from the inventory. */
export function nodeTestFiles(root = ROOT) {
  return [...globSync("**/*.node-test.{js,cjs,mjs,ts,cts,mts}", { cwd: root, exclude: path => generatedDirectory.test(path) })]
    .map(file => file.replaceAll("\\", "/")).sort();
}

/** The same glob expansion/exclusions are used by the checker and the Node runner. */
export function expandNodeTests(args, root = ROOT) {
  const excluded = new Set();
  const patterns = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exclude") {
      if (!args[i + 1]) fail("--exclude needs a path or glob");
      for (const file of globSync(args[++i], { cwd: root })) excluded.add(file.replaceAll("\\", "/"));
    } else if (nodeTestPath.test(args[i])) patterns.push(args[i]);
  }
  return [...new Set(patterns.flatMap(pattern => [...globSync(pattern, { cwd: root })]
    .map(file => file.replaceAll("\\", "/"))))].filter(file => !excluded.has(file)).sort();
}

/** Node tests reached by blocking CI/nightly steps, including package-script indirection.
 * Merely defining an unused package script is not wiring. This deliberately recognises
 * direct node --test commands and our glob runner, not arbitrary shell/JS source text.
 */
export function nodeGateFiles(root = ROOT) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const files = new Set();
  const visit = (source, seen = new Set()) => {
    // Only count the checked simple-command/&& subset. Shell alternatives,
    // pipelines, background jobs and disabled errexit can hide a failed test.
    // Refuse the whole unrecognised list rather than guess at shell semantics.
    if (/\|\||;|(?<!\|)\|(?!\|)|(?<!&)&(?!&)|\bset\s+\+e\b/.test(source)) return;
    for (const command of source.split(/\n|&&|\|\||;/)) {
      let words = [...command.trim().matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
      // The existing Linux host-worker gate uses this exact checked root runner.
      if (words[0] === "sudo" && words[1] === "-E" && words[2] === "$(command -v node)" && words[3] === "--test") words = ["node", ...words.slice(3)];
      if (words[0] === "node" && (words.includes("--test") || (words[1] === "scripts/ci-test-tiers.mjs" && words[2] === "run-node"))) {
        for (const file of expandNodeTests(words, root)) files.add(file);
      } else if (words[0] === "pnpm" || (words[0] === "npm" && words[1] === "run")) {
        const name = words[1] === "run" ? words[2] : words[1];
        if (scripts[name] && !seen.has(name)) visit(scripts[name], new Set([...seen, name]));
      }
    }
  };
  for (const workflow of ["ci.yml", "nightly.yml"]) {
    const path = join(root, ".github/workflows", workflow);
    if (!existsSync(path)) continue;
    const config = parse(readFileSync(path, "utf8"));
    for (const job of Object.values(config.jobs ?? {})) {
      if (job["continue-on-error"] || disabled(job.if) || job.defaults?.run?.["working-directory"]) continue;
      for (const step of job.steps ?? []) {
        if (!step.run || step["continue-on-error"] || disabled(step.if) || step["working-directory"]) continue;
        visit(step.run);
      }
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

/** Test files named by a root vitest.*.config.ts: file -> the configs that own it. */
export function configOwnedFiles(root = ROOT) {
  const owned = new Map();
  for (const config of globSync("vitest.*.config.ts", { cwd: root }).sort()) {
    for (const [, file] of readFileSync(join(root, config), "utf8").matchAll(/["']([^"'\s]+\.test\.[cm]?[jt]sx?)["']/g)) {
      owned.set(file, [...new Set([...(owned.get(file) ?? []), config])]);
    }
  }
  return owned;
}

const disabled = condition => condition === false || condition === 0 ||
  (typeof condition === 'string' && /^(?:false|0|null|''|"")$/.test(condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim()));

/** Configs that a blocking ci.yml step runs through `ci-test-tiers.mjs list --tier gate --config <config>`. */
export function configGateRunners(root = ROOT) {
  const path = join(root, ".github/workflows/ci.yml");
  const configs = new Set();
  if (!existsSync(path)) return configs;
  for (const job of Object.values(parse(readFileSync(path, "utf8")).jobs ?? {})) {
    if (job["continue-on-error"] || disabled(job.if)) continue;
    for (const step of job.steps ?? []) {
      if (!step.run || step["continue-on-error"] || disabled(step.if)) continue;
      // A step that lists gate files by config wires every root Vitest config its own text names (a loop over them counts).
      const run = String(step.run);
      if (!run.split("\n").some(line => /scripts\/ci-test-tiers\.mjs\s+list\b/.test(line) && /--tier\s+gate\b/.test(line) && /--config\s/.test(line))) continue;
      for (const [config] of run.matchAll(/\bvitest\.[\w-]+\.config\.ts\b/g)) configs.add(config);
    }
  }
  return configs;
}

/** Both lists, validated: no repeated row, no file in both, every gate row has OSes and a reason. A file may carry two valid
 * gate rows with different reasons (two merged branches each published one; MAIN ruling 2026-11-18 00:32Z): it blocks on the
 * union of their OSes and keeps both reasons, so a second row can only widen the gate. */
export function readLists(root = ROOT) {
  const rows = file => readFileSync(join(root, file), "utf8").split("\n")
    .map((line, index) => ({ line, where: `${file}:${index + 1}` }))
    .filter(({ line }) => line.trim() && !line.startsWith("#"));
  const gate = new Map();
  for (const { line, where } of rows(GATE)) {
    const [path, oses, reason] = line.split("\t");
    if (!path || !oses || !reason?.trim()) fail(`${where}: need "path<TAB>OSes<TAB>the user failure it prevents"`);
    const row = { oses: parseOses(oses, where), osText: oses, reason: reason.trim() };
    const first = gate.get(path);
    if (first) {
      if (first.reason.split("; ").includes(row.reason)) fail(`${where}: ${path} is listed twice with the same reason`);
      const union = OSES.filter(os => first.oses.includes(os) || row.oses.includes(os));
      gate.set(path, { oses: union, osText: union.length === OSES.length ? "all" : union.join("+"), reason: `${first.reason}; ${row.reason}` });
      continue;
    }
    gate.set(path, row);
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
  const nodeFiles = nodeTestFiles(root);
  const wired = new Set(nodeGateFiles(root));
  const known = new Set([...files, ...nodeFiles, ...wired]);
  const unlisted = files.filter(file => !gate.has(file) && !extended.has(file));
  const stale = [...gate.keys(), ...extended.keys()].filter(file => !known.has(file));
  const problems = [
    ...unlisted.map(file => `unclassified test file: ${file} (add it to ${GATE} or ${EXTENDED}; see docs/testing.md)`),
    ...stale.map(file => `listed but not a configured test file: ${file}`),
    ...nodeFiles.filter(file => !wired.has(file)).map(file => `unwired node-test file: ${file} (add a blocking CI/nightly Node runner)`),
  ];
  const runners = configGateRunners(root);
  for (const [file, configs] of configOwnedFiles(root)) {
    if (!gate.has(file)) continue;
    for (const config of configs.filter(config => !runners.has(config))) {
      problems.push(`gate file ${file} runs only through ${config}: add a blocking ci.yml step that runs \`ci-test-tiers.mjs list --tier gate --config ${config}\``);
    }
  }
  return { problems, gate: gate.size, extended: extended.size, files: files.length, nodeFiles: nodeFiles.length };
}

/** Stable, directory-spreading order: sort by a hash of the path, then deal round-robin. */
function shardOf(files, index, count) {
  const keyed = files.map(file => [createHash("sha1").update(file).digest("hex"), file]).sort(([a], [b]) => a.localeCompare(b));
  return keyed.filter((_, i) => i % count === index - 1).map(([, file]) => file).sort();
}

export function select({ tier, os, shard, skip = [], config }, root = ROOT) {
  const { gate, extended } = readLists(root);
  const nightly = note => note.startsWith("nightly");
  let files = tier === "gate"
    ? [...gate].filter(([, entry]) => !os || entry.oses.includes(os)).map(([file]) => file)
    : [...extended].filter(([, note]) => nightly(note) === (tier === "nightly")).map(([file]) => file);
  const nodeGates = new Set(nodeGateFiles(root));
  const owned = configOwnedFiles(root);
  files = files.filter(file => !skip.includes(file) && !nodeGates.has(file)
    && (config ? (owned.get(file) ?? []).includes(config) : !owned.has(file))).sort();
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
      const note = kind === "EXTENDED" ? "extended"
        : kind === "NIGHTLY" ? "nightly (whole file: scale or perf; nightly.yml runs it, the extended job does not)"
        : kind === "MERGE" ? `merge (pending; runs here until merged into ${reason.split(" :: ")[0] || "its target"})`
        : `${kind.toLowerCase()} (pending review; runs here until then)`;
      extended.push(`${path}\t${note}`);
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
    console.log(`ok: ${result.files} Vitest files; ${result.gate} gate, ${result.extended} extended; ${result.nodeFiles} Node files wired`);
  } else if (command === "run-node") {
    const files = expandNodeTests(rest.filter((arg, i) => arg !== "--shard" && rest[i - 1] !== "--shard"));
    const shard = option("shard");
    const args = ["--import", fileURLToPath(new URL("../server/testing/safe-wipe-preload.mjs", import.meta.url)), "--test", "--test-concurrency=2", ...(shard ? [`--test-shard=${shard}`] : []), ...files];
    if (!files.length) fail("run-node matched no test files");
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  } else if (command === "list") {
    const tier = option("tier");
    if (!["gate", "extended", "nightly"].includes(tier)) fail("list needs --tier gate|extended|nightly");
    const os = option("os");
    if (os && !OSES.includes(os)) fail(`unknown --os ${os}`);
    const skip = rest.flatMap((arg, i) => (arg === "--skip" ? [rest[i + 1]] : []));
    const config = option("config");
    if (config && ![...configOwnedFiles().values()].flat().includes(config)) fail(`--config ${config} is not a root vitest.*.config.ts that names a test file`);
    const { files, collateral } = select({ tier, os, shard: option("shard"), skip, config });
    for (const file of files) console.log(file);
    for (const file of collateral) console.log(`--exclude\n${file}`);
  } else if (command === "import") {
    if (!rest[0]) fail("import needs a tier table");
    importTable(rest[0]);
  } else {
    fail("usage: check | list --tier gate|extended|nightly [--os ...] [--shard i/n] [--skip path] [--config vitest.<name>.config.ts] | run-node [--exclude path/glob] [--shard i/n] <globs> | import <tsv>");
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
