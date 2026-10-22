// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-project check and the walk of a search root
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rules 63 and 73a).
//
// A file operation inside the project is card-free only after this check
// passes: the path is placed by its REAL path, resolved segment by segment
// (a symlink is resolved before the next segment is applied, so `link/../x`
// climbs from the link's target), then every given, intermediate and real
// spelling runs through the one sensitive list. A search root is walked
// breadth-first under a bound, and every entry is placed and key-guarded the
// same way.
//
// This module imports only node and the two shared modules that import
// nothing, so the Pi gate can carry the same code inline (Rule 60, T105).

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { GATE_MESSAGE_BYTES, WALK_CACHE_MS, WALK_ENTRIES, WALK_MS } from "./scan-limits.ts";
import { TEMPLATE_BASENAMES, secretShapeIn, sensitivePathRow } from "./sensitive-paths.ts";

export interface PlaceOptions {
  /** The platform whose path rules apply; the running one by default. */
  platform?: NodeJS.Platform;
  /** The owner's home, for a path given as `~/…`. Without it such a path
   * cannot be placed. */
  home?: string;
  /** The folder a relative path is placed from; the root by default. */
  base?: string;
}

export interface RealOptions extends PlaceOptions {
  /** Every part, the last one included, must exist (Rule 75d: `realpath X`
   * and `readlink -f X`). Without it a missing tail is kept as written. */
  mustExist?: boolean;
}

/** A path resolved part by part in order. Only `realPathInOrder` and
 * `realDir` make one. */
export type RealPath = string & { readonly __real: "RealPath" };

export type RealResult = { real: RealPath; intermediates: readonly RealPath[] } | { cannot: string };

export type Placement =
  | { kind: "inside" | "outside"; real: RealPath; intermediates: readonly RealPath[] }
  | { kind: "cannot-place"; why: string };

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Drive-relative (`C:foo`) and current-drive-root (`\foo`) forms, which name
 * a place only relative to state the call does not carry. */
function windowsUnplaceable(path: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(path) || /^[\\/](?![\\/])/.test(path);
}

function realOf(path: string): string {
  return realpathSync.native(path);
}

/** A Windows path without its `\\?\` or `\\.\` device prefix (`\\?\C:\x`,
 * `\\.\C:\x` and `//?/C:/x` are `C:\x`; `\\?\UNC\host\share` is
 * `\\host\share`). The walk needs this: Node reads the root `\\?\C:\` as
 * the drive-relative `C:` and cannot realpath it, so a prefixed path could
 * not be placed at all (SG-WIN-PATHTRICKS.md). Nothing else is changed. */
function win32Unprefixed(path: string): string {
  return path.replace(/^[\\/]{2}[?.][\\/]UNC(?=[\\/])/i, "\\").replace(/^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/, "");
}

function within(root: string, target: string, platform: NodeJS.Platform): boolean {
  const sep = platform === "win32" ? "\\" : "/";
  const a = platform === "win32" ? root.toLowerCase() : root;
  const b = platform === "win32" ? target.toLowerCase() : target;
  if (a === b) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

type Walked = { cur: string; intermediates: string[]; missing: boolean } | { cannot: string };

/** The segment loop: from the real `start`, apply each part in order. A link
 * is resolved before the next part, so `link/..` climbs from the link's
 * target. The first part that does not exist ends resolution: the rest is
 * appended as written (a file about to be written), a `..` in it cannot be
 * placed, and in must-exist mode nothing missing is kept. Any other error
 * (`ELOOP`, `EACCES`, `ENAMETOOLONG`) cannot be placed. */
function walk(start: string, rest: string, platform: NodeJS.Platform, mustExist: boolean): Walked {
  const p = pathFor(platform);
  let cur = start;
  const segments = rest.split(platform === "win32" ? /[\\/]+/ : /\/+/);
  const intermediates: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = p.dirname(cur);
      intermediates.push(cur);
      continue;
    }
    const next = p.join(cur, seg);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { cannot: code ?? "a path that cannot be read" };
      if (mustExist) return { cannot: "missing" };
      const tail = segments.slice(i).filter((part) => part !== "" && part !== ".");
      if (tail.includes("..")) return { cannot: "a climb past a missing folder" };
      return { cur: p.join(cur, ...tail), intermediates, missing: true };
    }
    if (link) {
      try {
        cur = realOf(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { cannot: mustExist && code === "ENOENT" ? "missing" : code ?? "a link that cannot be resolved" };
      }
    } else if (platform === "win32") {
      // the real spelling of a part that is there: an 8.3 short name (C:\Users\RUNNER~1) reads as its long name, as the root does
      try {
        cur = realOf(next);
      } catch (error) {
        return { cannot: (error as NodeJS.ErrnoException).code ?? "a path that cannot be read" };
      }
    } else {
      cur = next;
    }
    intermediates.push(cur);
  }
  return { cur, intermediates, missing: false };
}

/** An absolute path walked from its real drive or root. */
function walkAbsolute(given: string, platform: NodeJS.Platform, mustExist: boolean): Walked {
  const parsed = pathFor(platform).parse(given);
  let root: string;
  try {
    root = realOf(parsed.root);
  } catch {
    return { cannot: "the drive cannot be read" };
  }
  return walk(root, given.slice(parsed.root.length), platform, mustExist);
}

/**
 * Rules 63.2 and 75d: the real path of `path`, resolved part by part in
 * order, with every intermediate real spelling it passed through (the key
 * guard reads them all, so a climb through `~/.ssh/..` is still seen). A
 * relative path is placed from `base`, which is walked the same way first; a
 * base that does not exist yet keeps the path as written beneath it. Nothing
 * is ever collapsed lexically.
 */
export function realPathInOrder(path: string, base: string, opts: RealOptions = {}): RealResult {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  const mustExist = opts.mustExist === true;
  if (typeof path !== "string" || !path) return { cannot: "no path" };
  if (path.includes("\u0000") || (typeof base === "string" && base.includes("\u0000"))) return { cannot: "a NUL byte" };
  if (platform === "win32" && windowsUnplaceable(path)) return { cannot: "a drive-relative path" };
  let given = path;
  if (given === "~" || given.startsWith("~/") || (platform === "win32" && given.startsWith("~\\"))) {
    if (!opts.home) return { cannot: "a home path with no home" };
    // joined as written: `~/link/../x` must climb from where the link points, so nothing is collapsed before the segments resolve
    given = given === "~" ? opts.home : `${opts.home}${p.sep}${given.slice(2)}`;
  } else if (given.startsWith("~")) {
    return { cannot: "another account's home" };
  }
  let walked: Walked;
  if (p.isAbsolute(given)) {
    walked = walkAbsolute(platform === "win32" ? win32Unprefixed(given) : given, platform, mustExist);
  } else {
    if (typeof base !== "string" || !base || !p.isAbsolute(base) || (platform === "win32" && windowsUnplaceable(base))) {
      return { cannot: "a relative path with no folder to place it from" };
    }
    const from = walkAbsolute(base, platform, mustExist);
    if ("cannot" in from) return { cannot: from.cannot === "missing" ? "missing" : "the folder it is placed from cannot be read" };
    if (from.missing) {
      const tail = given.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part !== "" && part !== ".");
      if (tail.includes("..")) return { cannot: "a climb past a missing folder" };
      walked = { cur: tail.length ? p.join(from.cur, ...tail) : from.cur, intermediates: [], missing: true };
    } else {
      walked = walk(from.cur, given, platform, mustExist);
    }
  }
  if ("cannot" in walked) return { cannot: walked.cannot };
  return { real: walked.cur as RealPath, intermediates: walked.intermediates as RealPath[] };
}

/** A folder's real path, every part resolved in order and present, or null
 * when it does not resolve or is not a folder. A relative path is taken from
 * the running process's folder. */
export function realDir(path: string, opts: PlaceOptions = {}): RealPath | null {
  const platform = opts.platform ?? process.platform;
  let here = "";
  if (!pathFor(platform).isAbsolute(path)) {
    try {
      here = realOf(".");
    } catch {
      return null;
    }
  }
  const placed = realPathInOrder(path, here, { platform, mustExist: true });
  if ("cannot" in placed) return null;
  try {
    return statSync(placed.real).isDirectory() ? placed.real : null;
  } catch {
    return null;
  }
}

/** The one way to add names to a real folder: each name is one part (no
 * separator of either platform, not `.` or `..`, no NUL), else it cannot be
 * joined. The result names a place beneath `base`; it is not itself
 * resolved (the last name may be a link the reader follows). */
export function joinReal(base: RealPath, ...names: string[]): { path: string } | { cannot: string } {
  for (const name of names) {
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\u0000]/.test(name)) return { cannot: "a name that is not one part" };
  }
  const p = /^(?:[A-Za-z]:\\|\\\\)/.test(base) ? win32 : posix;
  return { path: p.join(base, ...names) };
}

/**
 * Rule 63 step 2: place `path` by its real path against the real `root`,
 * segment by segment (`realPathInOrder`), from `opts.base` when given, else
 * from the root. Whatever cannot be resolved cannot be placed.
 */
export function placePath(path: string, root: string, opts: PlaceOptions = {}): Placement {
  const platform = opts.platform ?? process.platform;
  if (typeof path !== "string" || !path) return { kind: "cannot-place", why: "no path" };
  if (path.includes("\u0000") || root.includes("\u0000")) return { kind: "cannot-place", why: "a NUL byte" };
  if (platform === "win32" && windowsUnplaceable(path)) return { kind: "cannot-place", why: "a drive-relative path" };
  let realRoot: string;
  try {
    realRoot = realOf(root);
  } catch {
    return { kind: "cannot-place", why: "the project folder cannot be read" };
  }
  const placed = realPathInOrder(path, opts.base ?? realRoot, opts);
  if ("cannot" in placed) return { kind: "cannot-place", why: placed.cannot };
  return { kind: within(realRoot, placed.real, platform) ? "inside" : "outside", real: placed.real, intermediates: placed.intermediates };
}

/**
 * The Win32 half of Rule 34's canonical form, for the key guard: the
 * spelling Win32 reads a path as (lanes/release103/SG-WIN-PATHTRICKS.md).
 * `\\?\X:` and `\\.\X:` lose their prefix and `\\?\UNC\` reads as `\\`; an
 * admin share `\\host\X$\rest` reads as `X:\rest` whatever the host (a
 * loopback cannot be told from a far host without a lookup, so both read as
 * the local drive: a far path that looks like a hook file is held, never
 * passed). In each part after the drive a stream suffix (`hooks.json::$DATA`,
 * `hooks.json:evil`) is cut and trailing dots and spaces are stripped (Win32
 * strips the last part's; stripping every part can only hold more); `.` and
 * `..` keep theirs. Separators and case stay as given: `spellings` adds the
 * `/` form and the rows read case-insensitively. On POSIX the path is
 * returned as given: every one of these is a file name there.
 */
export function win32Canonical(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const unwrapped = win32Unprefixed(path).replace(/^[\\/]{2}[^\\/]+[\\/]([A-Za-z])\$(?=[\\/]|$)/, "$1:");
  const name = (part: string): string => {
    if (part === "." || part === "..") return part;
    const bare = part.replace(/:.*$/, "").replace(/[. ]+$/, "");
    return bare === "" ? part : bare;
  };
  // split with the separators kept, so `\` and `/` land back where they were
  return unwrapped.split(/([\\/])/).map((part, i) => {
    if (i % 2 === 1) return part;
    if (i === 0) {
      const drive = /^([A-Za-z]:)(.*)$/.exec(part);
      if (drive) return drive[1] + (drive[2] === "" ? "" : name(drive[2]!));
    }
    return name(part);
  }).join("");
}

/** The spellings the key guard reads for one path: as given, with
 * backslashes as `/` (the separator part of Rule 34's canonical form), and
 * on Windows the Win32 canonical form of each (`win32Canonical`). */
function spellings(text: string, platform: NodeJS.Platform): string[] {
  const out = [text];
  const add = (spelling: string) => { if (!out.includes(spelling)) out.push(spelling); };
  add(text.replace(/\\/g, "/"));
  const canonical = win32Canonical(text, platform);
  add(canonical);
  add(canonical.replace(/\\/g, "/"));
  return out;
}

/** Rule 63 step 3 over every spelling of every path: the first sensitive
 * row hit, by id. `onTheWay`: the paths are folders passed through. */
function keyGuard(paths: readonly string[], inProject: boolean, platform: NodeJS.Platform, onTheWay = false): string | null {
  for (const path of paths) {
    // Rule 64 reads the name Win32 reads: `.env.example.` is the template on Windows, by every spelling of the path
    const template = inProject && TEMPLATE_BASENAMES.includes(win32Canonical(path, platform).split(platform === "win32" ? /[\\/]/ : "/").pop()?.toLowerCase() ?? "");
    for (const spelling of spellings(path, platform)) {
      const row = sensitivePathRow(spelling, inProject, onTheWay, template);
      if (row) return row;
    }
  }
  return null;
}

export type InProjectResult =
  | { ok: true; real: string }
  | { ok: false; reason: "sensitive"; rule: string }
  | { ok: false; reason: "outside"; real: string }
  | { ok: false; reason: "cannot-place"; why: string }
  | { ok: false; reason: "unread"; why: string };

/**
 * Rule 63 steps 2, 3 and 5 for one path (step 1, the contract, is the
 * caller's: a search tool's absent root is the cwd). Passing means the
 * operation runs with no card. `content`, for an edit or write, must be a
 * string no larger than the gate's message cap, else the call is unread.
 */
export function inProjectCheck(path: string, root: string, content?: unknown, opts: PlaceOptions = {}): InProjectResult {
  const platform = opts.platform ?? process.platform;
  const placed = placePath(path, root, opts);
  const inside = placed.kind === "inside";
  const rule = keyGuard([path], inside, platform) ?? (placed.kind === "cannot-place" ? null : keyGuard(placed.intermediates, inside, platform, true) ?? keyGuard([placed.real], inside, platform));
  if (rule) return { ok: false, reason: "sensitive", rule };
  if (placed.kind === "cannot-place") return { ok: false, reason: "cannot-place", why: placed.why };
  if (placed.kind === "outside") return { ok: false, reason: "outside", real: placed.real };
  if (content !== undefined) {
    if (typeof content !== "string") return { ok: false, reason: "unread", why: "the content is not text" };
    if (Buffer.byteLength(content, "utf8") > GATE_MESSAGE_BYTES) return { ok: false, reason: "unread", why: "the content is too large to read whole" };
    // Rule 64: the body of a write to an in-project template file is read by the secret-shape rules as if it left the project, so a
    // real key pasted into `.env.example` is sensitive (the carve-out covers the name, never the body)
    const baseOf = (text: string) => (platform === "win32" ? win32Canonical(text, platform).split(/[\\/]/) : text.split("/")).pop()?.toLowerCase() ?? "";
    if (TEMPLATE_BASENAMES.includes(baseOf(placed.real)) || TEMPLATE_BASENAMES.includes(baseOf(path))) {
      const shape = secretShapeIn(content);
      if (shape) return { ok: false, reason: "sensitive", rule: shape };
    }
  }
  return { ok: true, real: placed.real };
}

export interface WalkHit {
  /** relative to the search root, `/`-separated */
  path: string;
  /** a sensitive directory is one hit for its whole subtree */
  dir: boolean;
  rule: string;
}

export type WalkResult =
  | { ok: true; hits: readonly WalkHit[]; unwalked: readonly string[] }
  | { ok: false; why: string };

export interface WalkOptions extends PlaceOptions {
  maxEntries?: number;
  maxMs?: number;
  now?: () => number;
}

/**
 * Rule 73a: a breadth-first walk of the real tree under a search root,
 * bounded by WALK_ENTRIES and WALK_MS. Every entry is placed and key-guarded;
 * a sensitive directory is one hit and is not descended. `unwalked` is every
 * directory the bound stopped before it was finished, and every directory
 * the walk could not enter (a folder it cannot read, a link out of the
 * project): a walk that did not reach a place proves nothing about it. A
 * root that cannot be read at all is not ok.
 */
export function walkRoot(root: string, project: string, opts: WalkOptions = {}): WalkResult {
  const platform = opts.platform ?? process.platform;
  const maxEntries = opts.maxEntries ?? WALK_ENTRIES;
  const maxMs = opts.maxMs ?? WALK_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const rootPlaced = placePath(root, project, opts);
  if (rootPlaced.kind === "cannot-place") return { ok: false, why: rootPlaced.why };
  const realProject = realDir(project, { platform });
  if (!realProject) return { ok: false, why: "the project folder cannot be read" };
  const hits: WalkHit[] = [];
  const unwalked: string[] = [];
  const queue: { real: RealPath; rel: string }[] = [{ real: rootPlaced.real, rel: "" }];
  const seen = new Set<string>([rootPlaced.real]);
  let entries = 0;
  let first = true;
  while (queue.length) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(dir.real);
    } catch {
      if (first) return { ok: false, why: "the search root cannot be read" };
      unwalked.push(dir.rel || ".");
      continue;
    }
    first = false;
    names.sort();
    for (let i = 0; i < names.length; i++) {
      if (entries >= maxEntries || now() - started > maxMs) {
        unwalked.push(dir.rel || ".", ...queue.map((left) => left.rel));
        return { ok: true, hits, unwalked };
      }
      entries++;
      const name = names[i]!;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const joined = joinReal(dir.real, name);
      if ("cannot" in joined) continue; // a directory entry is always one name
      const abs = joined.path;
      let isLink = false;
      let isDir = false;
      try {
        const st = lstatSync(abs);
        isLink = st.isSymbolicLink();
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      let real = abs;
      if (isLink) {
        try {
          real = realOf(abs);
          isDir = statSync(real).isDirectory();
        } catch {
          continue; // a dangling link reads nothing
        }
      }
      const inside = within(realProject, real, platform);
      // A repository's `.git` holds its config and hooks rows and the rest of
      // its history: the walk treats it as one sensitive directory (Rule 73a).
      const rule = isDir && name === ".git" ? "project-git" : keyGuard([rel, abs, real], inside, platform, isDir);
      if (rule) {
        hits.push({ path: rel, dir: isDir, rule });
        continue;
      }
      if (!isDir) continue;
      if (!inside) {
        unwalked.push(rel);
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const next = realDir(real, { platform });
      if (!next) {
        unwalked.push(rel);
        continue;
      }
      queue.push({ real: next, rel });
    }
  }
  return { ok: true, hits, unwalked };
}

/** Rule 73a: one walk per (turn, real root) reused for WALK_CACHE_MS, and
 * dropped on any approved write under the root. */
export class WalkCache {
  private readonly entries = new Map<string, { at: number; result: WalkResult; root: string }>();
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(now: () => number = Date.now, ttl = WALK_CACHE_MS) {
    this.now = now;
    this.ttl = ttl;
  }

  get(turn: string, realRoot: string): WalkResult | undefined {
    const key = `${turn}\u0000${realRoot}`;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(turn: string, realRoot: string, result: WalkResult): void {
    this.entries.set(`${turn}\u0000${realRoot}`, { at: this.now(), result, root: realRoot });
  }

  /** An approved write landed at `realPath`: every walk of a root holding it
   * is stale. */
  invalidateWrite(realPath: string, platform: NodeJS.Platform = process.platform): void {
    for (const [key, entry] of this.entries) if (within(entry.root, realPath, platform)) this.entries.delete(key);
  }
}
