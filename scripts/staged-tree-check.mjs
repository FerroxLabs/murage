// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checks the hoisted runtime tree under <server>/node_modules (dist-server by default) the way Node will use
// it: for every staged package, every declared dependency (and every installed optional dependency) must be
// found by Node's upward node_modules lookup from that package's directory, at a version that satisfies the
// declared range, and the package's `main` file must exist. Prints the package count, file count and the
// longest relative path (the Windows MAX_PATH budget). Exits 1 on any problem.
//
//   node scripts/staged-tree-check.mjs [server-dir] [--max-path N]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isPrunableDocFile, lookupStaged } from "./stage-hoisted.mjs";

function loadSemver() {
  const here = dirname(fileURLToPath(import.meta.url));
  try { return createRequire(import.meta.url)("semver"); } catch { /* look in the pnpm store */ }
  const store = join(here, "..", "node_modules", ".pnpm");
  const match = existsSync(store) ? readdirSync(store).find(name => /^semver@\d/.test(name)) : undefined;
  if (!match) throw Error("semver is not installed; run pnpm install");
  return createRequire(join(store, match, "node_modules", "semver", "package.json"))(join(store, match, "node_modules", "semver"));
}

/** The repository's plain-name pnpm overrides (pnpm-workspace.yaml). They deliberately replace a declared range
 * (for example the sharp security floor), so the check holds the staged version to the override instead. */
function repositoryOverrides() {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "pnpm-workspace.yaml");
  if (!existsSync(file)) return {};
  const overrides = parse(readFileSync(file, "utf8"))?.overrides ?? {};
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => /^(@[^/@]+\/)?[^/@<>=\s]+$/.test(key)));
}


const FILE_EXTENSIONS = ["", ".js", ".cjs", ".mjs", ".json", ".node"];
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
/** Node's file resolution for a path: exact, with an extension, or a directory index. Returns the file or null. */
function resolveFile(path) {
  for (const ext of FILE_EXTENSIONS) if (isFile(path + ext)) return path + ext;
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); } catch { /* no manifest */ }
  if (typeof manifest?.main === "string" && manifest.main) {
    const main = join(path, manifest.main);
    for (const ext of FILE_EXTENSIONS) if (isFile(main + ext)) return main + ext;
    for (const ext of FILE_EXTENSIONS.slice(1)) if (isFile(join(main, "index" + ext))) return join(main, "index" + ext);
  }
  for (const ext of FILE_EXTENSIONS.slice(1)) if (isFile(join(path, "index" + ext))) return join(path, "index" + ext);
  return null;
}
const walkFiles = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, base, out); else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
};

/** Finds the unpruned installed copy of name@version (the stager's source) under the repository's node_modules,
 * including the pnpm store. Returns the directory or null. Memoised. */
export function makeSourceLookup(sourceRoot) {
  const cache = new Map();
  const store = join(sourceRoot, "node_modules", ".pnpm");
  let storeEntries;
  return (name, version) => {
    const key = `${name}@${version}`;
    if (cache.has(key)) return cache.get(key);
    const wanted = (dir) => { try { const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); return p.name === name && p.version === version; } catch { return false; } };
    let found = null;
    const top = join(sourceRoot, "node_modules", name);
    if (wanted(top)) found = top;
    else if (existsSync(store)) {
      storeEntries ??= readdirSync(store);
      const prefix = `${name.replace("/", "+")}@${version}`;
      for (const entry of storeEntries) {
        if (entry !== prefix && !entry.startsWith(prefix + "_")) continue;
        const dir = join(store, entry, "node_modules", name);
        if (wanted(dir)) { found = dir; break; }
      }
    }
    cache.set(key, found);
    return found;
  };
}

/** Every file target named by an `exports` value (all conditions, arrays, subpaths). Each is { key, target }. */
export function exportTargets(exportsField) {
  const out = [];
  const visit = (value, key) => {
    if (typeof value === "string") { out.push({ key, target: value }); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    if (value && typeof value === "object") {
      const subpaths = Object.keys(value).some(k => k.startsWith("."));
      for (const [k, v] of Object.entries(value)) visit(v, subpaths ? k : key);
    }
  };
  visit(exportsField, ".");
  return out.filter(({ target }) => target.startsWith("./") && !target.endsWith("/"));
}

/** Resolves a package-relative `exports` target (or pattern) in `dir`. Wildcard targets expand against the
 * unpruned source file list when there is one, so every file the pattern reaches must be staged. */
function exportProblems(dir, source, targets) {
  const problems = [], warnings = [];
  let stagedFiles, sourceFiles;
  for (const { key, target } of targets) {
    if (!target.includes("*")) {
      if (isFile(join(dir, target))) continue;
      // A target the unpruned package does not ship either is the package's own defect, not the stager's: warn.
      if (source && !isFile(join(source, target))) warnings.push(`exports ${key} -> ${target} is missing from the installed package too`);
      else problems.push(`exports ${key} -> ${target} is missing${source ? " (removed by pruning)" : ""}`);
      continue;
    }
    // Every `*` stands for the same subpath (Node substitutes one value everywhere).
    const [first, ...rest] = target.slice(2).split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    // A named group and named backreferences: a numbered `\1` followed by a digit in the target would read as `\11`.
    const pattern = new RegExp("^" + first + "(?<star>.+)" + rest.join("\\k<star>") + "$");
    const matches = (files) => files.filter(f => pattern.test(f));
    stagedFiles ??= walkFiles(dir);
    if (!source) { problems.push(`exports ${key} -> ${target}: the installed source inventory is unavailable, so the pattern cannot be verified (run pnpm install)`); continue; }
    const staged = new Set(stagedFiles);
    sourceFiles ??= walkFiles(source);
    // Documentation text and source maps matched by a catch-all pattern are never loaded code or data.
    const wanted = matches(sourceFiles).filter(f => !isPrunableDocFile(basename(f), dirname(f) === "." ? "" : dirname(f)));
    const missing = wanted.filter(f => !staged.has(f));
    if (wanted.length === 0) warnings.push(`exports ${key} -> ${target} matches no installed file`);
    for (const f of missing.slice(0, 5)) problems.push(`exports ${key} -> ${target}: ./${f} is missing (removed by pruning)`);
    if (missing.length > 5) problems.push(`exports ${key} -> ${target}: ${missing.length - 5} more pruned files`);
  }
  return { problems, warnings };
}

const SPECIFIER = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
/** Resolves `spec` (a relative path or a bare package specifier) from a staged file. `root` is the package dir
 * the file lives in; `stagedRoot`/`lookup` say where a bare package is searched. Returns the resolved file, "skip"
 * for something not checkable, or null when it does not resolve. */
function resolveSpecifier(spec, fromFile, tree) {
  if (spec.startsWith(".")) return resolveFile(join(dirname(fromFile), spec));
  if (/^(node:|data:|https?:)/.test(spec) || spec.startsWith("#") || isAbsoluteLike(spec)) return "skip";
  const parts = spec.split("/"), name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0], sub = spec.slice(name.length);
  const pkgDir = tree.lookup(name, dirname(fromFile));
  if (!pkgDir) return "skip"; // builtins and packages outside the staged tree are the dependency check's job
  if (!sub) return "skip";    // bare package name: covered by the main/exports checks
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) || typeof pkg.exports === "string") {
    const map = typeof pkg.exports === "string" || !Object.keys(pkg.exports).some(k => k.startsWith(".")) ? { ".": pkg.exports } : pkg.exports;
    const key = "." + sub;
    let entry = map[key], star = "";
    if (entry === undefined) for (const k of Object.keys(map)) { const i = k.indexOf("*"); if (i >= 0 && key.startsWith(k.slice(0, i)) && key.endsWith(k.slice(i + 1)) && key.length >= k.length - 1) { entry = map[k]; star = key.slice(i, key.length - (k.length - i - 1)); break; } }
    if (entry === undefined) return null;
    const targets = exportTargets(entry).map(t => join(pkgDir, t.target.replaceAll("*", star)));
    return targets.length === 0 || targets.some(isFile) ? (targets.find(isFile) ?? "skip") : null;
  }
  return resolveFile(join(pkgDir, sub));
}
const isAbsoluteLike = spec => spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec);

/** Static requires/imports of a staged JS file that no longer resolve in the staged tree although they do in
 * the unpruned source package (so pruning, not the package itself, removed the target). */
function requireProblems(dir, source, tree) {
  const problems = [];
  for (const rel of walkFiles(dir)) {
    if (!/\.(c|m)?js$/.test(rel)) continue;
    const file = join(dir, rel);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[2];
      if (resolveSpecifier(spec, file, tree) !== null) continue;
      if (source || !spec.startsWith(".")) {
        let inSource;
        if (spec.startsWith(".")) inSource = resolveFile(join(dirname(join(source, rel)), spec)) !== null;
        else {
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          const staged = tree.lookup(name, dirname(file)), meta = staged && JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
          const original = meta && tree.sourceFor(meta.name, meta.version);
          inSource = original ? resolveSpecifier(spec, file, { lookup: (n, from) => n === name ? original : tree.lookup(n, from) }) !== null : true;
        }
        if (!inSource) continue; // not even the unpruned package has it (optional or guarded require)
        problems.push(`${rel}: ${spec} is required but was removed by pruning`);
      } else problems.push(`${rel}: ${spec} does not resolve`);
    }
  }
  return problems;
}

function checkPackageFiles(dir, pkg, id, { modules, sourceFor }) {
  const problems = [], warnings = [];
  const source = sourceFor(pkg.name, pkg.version);
  const missing = (what, rel) => (source && !isFile(join(source, rel)) ? warnings : problems).push(`${id}: ${what} is missing${source && isFile(join(source, rel)) ? " (removed by pruning)" : source ? " from the installed package too" : ""}`);
  if (typeof pkg.main === "string" && pkg.main.length > 0 && !resolveFile(join(dir, pkg.main))) {
    if (source && !resolveFile(join(source, pkg.main))) warnings.push(`${id}: main ${pkg.main} is missing from the installed package too`);
    else problems.push(`${id}: main ${pkg.main} is missing`);
  }
  const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {}).filter(v => typeof v === "string");
  for (const bin of bins) if (!isFile(join(dir, bin))) missing(`bin ${bin}`, bin);
  if (pkg.exports) {
    const found = exportProblems(dir, source, exportTargets(pkg.exports));
    problems.push(...found.problems.map(text => `${id}: ${text}`)); warnings.push(...found.warnings.map(text => `${id}: ${text}`));
  }
  const tree = { lookup: (name, from) => lookupStaged(name, from, modules), sourceFor };
  problems.push(...requireProblems(dir, source, tree).map(text => `${id}: ${text}`));
  return { problems, warnings };
}

const SPEC_NOT_RANGE = /^(npm:|file:|link:|workspace:|git|http|github:)/;

export function checkStagedTree(server, { semver = loadSemver(), overrides = repositoryOverrides(), sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  const sourceFor = makeSourceLookup(sourceRoot);
  const modules = join(resolve(server), "node_modules"), problems = [], warnings = [], packages = [];
  const collect = (nodeModulesDir) => {
    if (!existsSync(nodeModulesDir)) return;
    for (const entry of readdirSync(nodeModulesDir).sort()) {
      if (entry.startsWith(".")) continue;
      const dir = join(nodeModulesDir, entry);
      if (entry.startsWith("@")) { for (const child of readdirSync(dir).sort()) add(join(dir, child)); } else add(dir);
    }
  };
  const add = (dir) => {
    if (!existsSync(join(dir, "package.json"))) { problems.push(`${relative(server, dir)}: no package.json`); return; }
    packages.push(dir); collect(join(dir, "node_modules"));
  };
  collect(modules);
  for (const dir of packages) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), id = `${relative(modules, dir)} (${pkg.name}@${pkg.version})`;
    const edges = [
      ...Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).map(([name, range]) => ({ name, range, optional: Boolean(pkg.optionalDependencies?.[name]), kind: "dependency" })),
      ...Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => !pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name])
        .map(([name, range]) => ({ name, range, optional: Boolean(pkg.peerDependenciesMeta?.[name]?.optional), kind: "peer dependency" })),
    ];
    for (const { name: dependency, range, optional, kind } of edges) {
      const found = lookupStaged(dependency, dir, modules);
      if (!found) { if (!optional) problems.push(`${id}: ${kind} ${dependency}@${range} does not resolve`); continue; }
      const wanted = kind === "peer dependency" ? range : overrides[dependency] ?? range;
      if (typeof wanted !== "string" || SPEC_NOT_RANGE.test(wanted)) continue;
      const version = JSON.parse(readFileSync(join(found, "package.json"), "utf8")).version;
      if (!semver.satisfies(version, wanted, { includePrerelease: true })) problems.push(`${id}: ${kind} ${dependency}@${version} (at ${relative(modules, found)}) does not satisfy ${wanted}`);
    }
    const found = checkPackageFiles(dir, pkg, id, { modules, sourceFor });
    problems.push(...found.problems); warnings.push(...found.warnings);
  }
  let files = 0, longest = { length: 0, path: "" };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else {
        files++;
        const rel = relative(modules, path).split("\\").join("/");
        if (rel.length > longest.length) longest = { length: rel.length, path: rel };
      }
    }
  };
  if (existsSync(modules)) walk(modules);
  return { packages: packages.length, files, longest, problems, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), limitAt = args.indexOf("--max-path");
  const limit = limitAt >= 0 ? Number(args.splice(limitAt, 2)[1]) : null;
  const server = resolve(args[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist-server"));
  const result = checkStagedTree(server);
  console.log(`staged packages: ${result.packages}\nfiles: ${result.files}\nlongest relative path: ${result.longest.length} (${result.longest.path})`);
  if (limit !== null && result.longest.length > limit) result.problems.push(`longest relative path ${result.longest.length} exceeds ${limit}`);
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const problem of result.problems) console.error(`PROBLEM ${problem}`);
  if (result.problems.length) process.exit(1);
  console.log("staged tree OK");
}
