// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared stager for the runtime packages that ship under dist-server/node_modules (the WhatsApp bridge's
// baileys/jimp and the memory worker's Transformers runtime). It replaces a per-parent recursive copy,
// which duplicated every shared dependency under every requiring package (121k of 135k packaged files
// were jimp's @jimp/* tree) and produced paths past MAX_PATH on Windows.
//
// Placement follows Node resolution, so the result is correct and flat:
//   - a package is copied to dist-server/node_modules/<name> the first time it is needed;
//   - when the dependency a package needs resolves (walking up from that package, as Node does) to the
//     same name@version already staged, nothing is copied again;
//   - when the name is already staged at a DIFFERENT version, the needed version goes at the highest ancestor
//     level below the conflicting copy that shadows no other staged package's resolution (at worst a private
//     copy under the requiring package). Sharing ancestor levels lets dependency cycles close.
// Both stagers share the one tree, so a conflict between their graphs is resolved the same way.
// No network, install scripts, global environment or user profile mutations.
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

export const STAGE_MARKER_FILE = ".murage-runtime-stage";
export const STAGE_MARKER = "murage-runtime-stage";
const LICENCE_FILE_SRC = /^(licen[cs]e|licen[cs]es|copying|notice|copyright|unlicense)([.-]|$)/i;
export const LICENCE_FILE = LICENCE_FILE_SRC;
/** What the stager removes, and nothing else (a static scan cannot see computed native loads, fs reads of JSON, wasm or
 * markdown templates, or worker paths, so a rule must never delete anything that could be runtime data):
 *   (a) source maps (.map);
 *   (b) markdown files with a known documentation name (DOC_NAMES), at the package root or directly in its top-level docs/;
 *       any other .md (for example templates/prompt.md) is kept;
 *   (c) the test-runner snapshot directories of the audited packages in SNAPSHOT_ALLOWLIST (written and read only by
 *       jest-style runners; their generated file names break the Windows path budget), except licence files in them.
 * Licence and notice files are never removed anywhere. */
const DOC_NAMES = /^(readme|changelog|changes|history|contributing|code[-_]of[-_]conduct|security|authors|upgrading|migration)$/i;
export const SNAPSHOT_AUDITED_VERSION = "1.6.1";
/** @jimp/* packages audited at exactly 1.6.1 (any other version keeps its snapshot dirs): their src/__snapshots__ and src/__image_snapshots__ hold only test fixtures. */
export const SNAPSHOT_ALLOWLIST = new Set(["plugin-flip", "plugin-contain", "plugin-quantize", "plugin-color", "plugin-print", "plugin-blit", "plugin-resize", "diff", "plugin-blur", "plugin-fisheye", "plugin-circle", "plugin-rotate", "plugin-mask", "plugin-crop", "plugin-cover", "plugin-threshold", "js-png"].map(name => `@jimp/${name}`));
const SNAPSHOT_DIRECTORIES = new Set(["__snapshots__", "__image_snapshots__"]);

/** True for a documentation markdown file the stager removes. `directory` is its path relative to the package root. */
export function isPrunableDocFile(name, directory = "") {
  if (LICENCE_FILE_SRC.test(name)) return false;
  if (name.endsWith(".map")) return true;
  const match = /^(.*)\.(md|markdown)$/i.exec(name);
  return Boolean(match && DOC_NAMES.test(match[1]) && (directory === "" || directory === "docs"));
}

/** Copy filter: drops nested node_modules (we flatten instead), the rules above, and nothing else. `source` is the
 * package root being copied. */
export function copyFilter(source) {
  // A package that publishes no licence file may carry its only licence text in a root markdown file
  // (for example @tokenizer/token's README holds the full MIT notice). Keep those; prune them otherwise.
  const entries = readdirSync(source), keepRootDocs = !entries.some((entry) => LICENCE_FILE_SRC.test(entry));
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")); } catch { /* unreadable manifest: no allowlist */ }
  const pruneSnapshots = SNAPSHOT_ALLOWLIST.has(manifest.name) && manifest.version === SNAPSHOT_AUDITED_VERSION;
  const holdsLicence = (dir) => readdirSync(dir, { withFileTypes: true }).some(e => e.isDirectory() ? holdsLicence(join(dir, e.name)) : LICENCE_FILE_SRC.test(e.name));
  return (path) => {
    if (path === source) return true;
    const name = basename(path), directory = relative(source, dirname(path)).split("\\").join("/");
    const isDirectory = statSync(path).isDirectory();
    if (name === "node_modules") return false;
    if (pruneSnapshots && directory === "src" && isDirectory && SNAPSHOT_DIRECTORIES.has(name)) return holdsLicence(path);
    if (pruneSnapshots && /^src\/__(image_)?snapshots__(\/|$)/.test(directory) && !isDirectory) return LICENCE_FILE_SRC.test(name);
    if (isDirectory) return true;
    if (keepRootDocs && directory === "" && name.endsWith(".md") && !/^changelog/i.test(name)) return true;
    return !isPrunableDocFile(name, directory);
  };
}

export function packageRoot(name, from) {
  const require = createRequire(join(from, "package.json"));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name, "package.json");
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === name) return dirname(realpathSync(candidate));
  }
  let file;
  try { file = require.resolve(`${name}/package.json`); } catch { file = require.resolve(name); }
  let dir = dirname(realpathSync(file));
  for (;;) {
    const path = join(dir, "package.json");
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw Error(`package root unavailable: ${name}`);
    dir = parent;
  }
}

const readPackage = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Node's lookup for `name` from `fromDir`, bounded by the staged `modules` root. Returns the package
 * directory that Node would load, or null. */
export function lookupStaged(name, fromDir, modules) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === modules || dirname(dir) === dir) return null;
  }
}

/** Remove every package a previous staging left behind. Refuses anything this stager did not write. */
export function wipeStagedTree(distRoot, within) {
  const modules = join(distRoot, "node_modules");
  if (!existsSync(modules)) return;
  const owned = (dir) => existsSync(join(dir, STAGE_MARKER_FILE));
  const wipe = (dir) => {
    if (!owned(dir)) throw Error(`refusing unowned runtime staging directory: ${relative(distRoot, dir)}`);
    safeWipeSync(dir, { within });
  };
  for (const entry of readdirSync(modules)) {
    const dir = join(modules, entry);
    if (entry.startsWith("@")) {
      for (const child of readdirSync(dir)) wipe(join(dir, child));
      safeWipeSync(dir, { within });
    } else wipe(dir);
  }
}

/** Budgets that keep private-copy placement finite: one name@version is never copied more than this many
 * times, and no staged path (relative to the staged node_modules) grows past this many characters. */
export const MAX_COPIES_PER_PACKAGE = 8;
export const MAX_RELATIVE_PATH = 140;

export function createHoistedStager({ distRoot, excluded = () => false, licenseFor = (pkg) => pkg.license ?? null, maxCopies = MAX_COPIES_PER_PACKAGE, maxPath = MAX_RELATIVE_PATH }) {
  const modules = join(distRoot, "node_modules");
  const records = new Map();
  function record(dest, pkg) {
    if (records.has(dest)) return;
    records.set(dest, { name: pkg.name, version: pkg.version, license: licenseFor(pkg, `${pkg.name}@${pkg.version}`), path: relative(distRoot, dest).split(sep).join("/") });
  }
  /** Stage `name` as resolved from the installed tree at `from`, for the staged package at `requesterDest`
   * (null for a top-level runtime). Returns the staged directory Node will resolve for that requester. */
  const edges = new Map(); // consumer dir -> Map(dependency name -> { dest, source }): what each staged package resolves
  const chainOf = (name, fromDir) => {
    const chain = [];
    for (let dir = fromDir; ; dir = dirname(dir)) {
      chain.push(basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name));
      if (dir === modules || dirname(dir) === dir) return chain;
    }
  };
  const copyPackage = (source, pkg, dest) => {
    cpSync(source, dest, { recursive: true, dereference: true, filter: copyFilter(source) });
    if (dest === join(modules, pkg.name)) writeFileSync(join(dest, STAGE_MARKER_FILE), STAGE_MARKER);
    record(dest, pkg);
  };
  // Placements in progress, as dest -> identity, in order: the chain a budget error names, and the guard that
  // makes a recursive request for a placement already being built reuse it instead of copying it again.
  const placing = new Map();
  const copies = new Map(); // name@version -> number of copies written
  const chainText = (extra) => [...placing].map(([dest, id]) => `${id} at ${relative(modules, dest)}`).concat(extra).join(" -> ");
  /** Copy `source` to `dest` and stage its dependencies for it. */
  function install(source, pkg, dest) {
    const identity = `${pkg.name}@${pkg.version}`;
    if (placing.has(dest)) return;
    const where = relative(modules, dest), count = (copies.get(identity) ?? 0) + 1;
    if (where.length > maxPath) throw Error(`Runtime staging cannot terminate: ${identity} would be placed at a ${where.length} character path (limit ${maxPath}). Placement chain: ${chainText(`${identity} at ${where}`)}`);
    if (count > maxCopies) throw Error(`Runtime staging cannot terminate: ${identity} would be copied ${count} times (limit ${maxCopies}). Placement chain: ${chainText(`${identity} at ${where}`)}`);
    copies.set(identity, count);
    placing.set(dest, identity);
    try { installInto(source, pkg, dest); } finally { placing.delete(dest); }
  }
  function installInto(source, pkg, dest) {
    copyPackage(source, pkg, dest);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (excluded(dependency)) throw Error(`Excluded dependency requested: ${dependency}`);
      try { packageRoot(dependency, source); } catch (error) { if (pkg.optionalDependencies?.[dependency]) continue; throw error; }
      stage(dependency, source, dest);
    }
    // Peer dependencies are resolution edges too: the copy the installed tree gives this package is staged and
    // recorded before the subtree, so later placements cannot shadow it. A peer the installed tree does not
    // provide (or an excluded one) is left alone; the tree check reports required peers that do not resolve.
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      if (pkg.dependencies?.[peer] || pkg.optionalDependencies?.[peer] || excluded(peer)) continue;
      try { packageRoot(peer, source); } catch { continue; }
      stage(peer, source, dest);
    }
  }
  /** Placing `dest` (<base>/node_modules/<name>) would be found before the copy an already staged package
   * resolves for `name`. */
  const shadowsConsumer = (name, dest, consumer, edge) => {
    if (edge.dest === dest) return false;
    const chain = chainOf(name, consumer), atDest = chain.indexOf(dest), atEdge = chain.indexOf(edge.dest);
    return !(atDest < 0 || (atEdge >= 0 && atEdge < atDest));
  };
  const shadowsAny = (name, dest) => [...edges].some(([consumer, deps]) => { const edge = deps.get(name); return edge && shadowsConsumer(name, dest, consumer, edge); });
  /** Give every staged package that `dest` would shadow a private copy first, so its resolution cannot change. */
  function protectConsumers(name, dest) {
    for (const [consumer, deps] of [...edges]) {
      const edge = deps.get(name);
      if (!edge || !shadowsConsumer(name, dest, consumer, edge)) continue;
      const pinned = join(consumer, "node_modules", name);
      if (existsSync(join(pinned, "package.json"))) continue;
      install(edge.source, readPackage(edge.source), pinned);
      deps.set(name, { ...edge, dest: pinned });
    }
  }
  /** `found` (another version) is what `requesterDest` would resolve for `name`. Place the needed version at the
   * highest ancestor level that sits below `found` and shadows no staged package's resolution, falling back to a
   * private copy under the requester. Sharing ancestor levels lets a dependency cycle close instead of nesting
   * a fresh private copy at every turn. */
  function nestedDestination(name, requesterDest, found) {
    const chain = [...new Set(chainOf(name, requesterDest))];
    const below = chain.slice(0, Math.max(1, chain.indexOf(found) < 0 ? chain.length : chain.indexOf(found)));
    const usable = below.filter((candidate, index) => index === 0 || !basename(dirname(candidate.slice(0, candidate.length - name.length - 1))).startsWith("@"));
    for (let index = usable.length - 1; index > 0; index--) if (!shadowsAny(name, usable[index])) return usable[index];
    return usable[0];
  }
  /** Stage `name` as resolved from the installed tree at `from`, for the staged package at `requesterDest`
   * (null for a top-level runtime). Returns the staged directory Node will resolve for that requester. */
  function stage(name, from, requesterDest = null) {
    if (excluded(name)) throw Error(`${name} must not be staged for this runtime`);
    const source = packageRoot(name, from), pkg = readPackage(source);
    const found = lookupStaged(name, requesterDest ?? modules, modules);
    const current = found ? readPackage(found) : null;
    const link = (result) => {
      if (!requesterDest) return;
      if (!edges.has(requesterDest)) edges.set(requesterDest, new Map());
      edges.get(requesterDest).set(name, { dest: result, source });
    };
    if (current && current.name === name && current.version === pkg.version) { record(found, pkg); link(found); return found; }
    if (!requesterDest && found) throw Error(`runtime package ${name}@${pkg.version} collides with staged ${name}@${current.version}`);
    const dest = found ? nestedDestination(name, requesterDest, found) : join(modules, name);
    protectConsumers(name, dest);
    // Record what the requester resolves before its subtree is staged, so placements inside that subtree see it.
    link(dest);
    install(source, pkg, dest);
    return dest;
  }
  return { stage, records: () => [...records.values()], modules };
}
