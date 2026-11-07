// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT (1.0.20, design r4 section 5): the download registry, one per install (bots share the disk).
// Pure: every syscall goes through the injected `FsHooks`, counted by a per-text `TextBudget` (64 lstat/realpath per text,
// shared by Match, registration and 6.2; past it, a hit). Paths are stored and matched lower-cased on every OS, after NFC,
// with `\` as `/` (ruling 5): two names that differ only by case both Match, which only over-marks. Strip-only TypeScript.

import path from "node:path";

/** file: one path. tree: a whole folder outside content placed. window: a folder written during [since, until] (a path
 *  under it Matches by ctime). repo: a git repository a tainted turn changed. span: a filesystem root written during
 *  [since, until] by a process whose destinations Murage cannot name (a path Matches when its own ctime is in the span). */
export type RegistryKind = "file" | "tree" | "window" | "repo" | "span";
export interface RegistryEntry {
  /** the key: lower-cased, NFC, `/` only (registryKey) */
  path: string;
  kind: RegistryKind;
  since: number;
  /** none: open (a window stays open; a span closes at since + 24 h) */
  until?: number;
  /** a clone destination: Matches read `cloned folder` */
  cloned?: boolean;
  /** the turn that will stamp `until` when it ends (stampTurnEnd); none for a background text */
  turn?: string;
}
/** The durable copy (OutsideStore extends it). One call per change: rows to add (or replace by path and kind), rows to drop. */
export interface RegistryRows {
  loadRegistry(): RegistryEntry[];
  writeRegistry(add: RegistryEntry[], drop: RegistryEntry[]): void;
}
export interface FsStat { dir: boolean; ctime: number }
/** lstat / realpath: null on ENOENT (or ENOTDIR), throw on any other failure. */
export interface FsHooks {
  lstat(p: string): FsStat | null;
  realpath(p: string): string | null;
}
export type DlLabel = "downloaded file" | "cloned folder";

export const MAX_ENTRIES = 4096;
export const COMPACT_TO = 2048;
export const MAX_SPANS = 256;
export const TEXT_SYSCALLS = 64;
export const SPAN_OPEN_MS = 24 * 3600 * 1000;
const KIND_RANK: Record<RegistryKind, number> = { file: 0, window: 1, repo: 2, tree: 3, span: 4 };

// ---------------------------------------------------------------------------------------------------------------------
// keys and paths

const DRIVE_ROOT = /^[a-z]:\/$/;
const unquote = (s: string): string => s.replace(/^["']+|["']+$/g, "");

/** The stored form of a path: quotes around it removed, NFC, `\` as `/`, lower case, repeated `/` folded (a leading `//`
 *  share kept), no trailing `/` except on a root. */
export function registryKey(p: string): string {
  let s = unquote(p).normalize("NFC").replace(/\\/g, "/").toLowerCase();
  const share = s.startsWith("//") && !s.startsWith("///");
  s = (share ? "/" : "") + s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/") && !DRIVE_ROOT.test(s) && s !== "//") s = s.slice(0, -1);
  return s;
}

const isWin = (s: string): boolean => /^[a-zA-Z]:[\\/]/.test(s) || /^[a-zA-Z]:$/.test(s) || s.startsWith("\\\\");

/** `resolve(cwd, w)` keeping the original case (the syscalls need it): quotes removed, a leading `~` as `home`, Windows
 *  forms (a drive or a `\\` share in the word or the cwd) resolved as Windows, the rest as POSIX. */
export function resolveWord(cwd: string, word: string, home?: string): string {
  let w = unquote(word);
  if (home && (w === "~" || w.startsWith("~/") || w.startsWith("~\\"))) w = home + w.slice(1);
  if (isWin(w) || isWin(cwd)) return path.win32.resolve(cwd, w).replace(/\\/g, "/");
  return path.posix.resolve(cwd, w);
}

/** The parent key, or null at a root. */
export function parentKey(k: string): string | null {
  if (k === "/" || DRIVE_ROOT.test(k)) return null;
  const at = k.lastIndexOf("/");
  if (at < 0) return null;
  if (at === 0) return "/";
  const head = k.slice(0, at);
  if (/^[a-z]:$/.test(head)) return head + "/";
  if (k.startsWith("//") && head.lastIndexOf("/") <= 1) return null; // `//server/share` is a root
  return head;
}
const isUnder = (k: string, root: string): boolean => k === root || k.startsWith(root.endsWith("/") ? root : root + "/");
const depthOf = (k: string): number => k.split("/").filter(Boolean).length;
const baseOf = (k: string): string => k.slice(k.lastIndexOf("/") + 1);

/** R7 (4): the prefix root of an installer's folder, the folder minus one trailing `bin`, `sbin` or `Scripts` segment. */
export function prefixRoot(folder: string): string {
  const f = folder.replace(/[\\/]+$/, "");
  const m = /^(.*)([\\/])(bin|sbin|scripts)$/i.exec(f);
  if (!m) return f;
  const head = m[1]!;
  return head === "" ? "/" : /^[a-zA-Z]:$/.test(head) ? head + m[2] : head;
}
/** R7 (4): the folders registered for an installer found at the lexical path L and its realpath R: each one's folder and
 *  prefix root, without repeats, in order. */
export function installerFolders(lexical: string, real?: string | null): string[] {
  const out: string[] = [];
  for (const hit of [lexical, real]) {
    if (!hit) continue;
    const folder = resolveWord("/", hit).replace(/\/[^/]*$/, "") || "/";
    for (const f of [folder, prefixRoot(folder)]) if (!out.includes(f)) out.push(f);
  }
  return out;
}

const DEST_OPTIONS = new Set(["--prefix", "--dir", "-c", "--cwd", "--global-folder", "--modules-folder", "--target", "-t", "--root",
  "--install-dir", "-i", "--bindir", "--working-dir", "-d", "--target-dir"]);
const DEST_ASSIGNS = ["npm_config_prefix", "gopath", "gobin", "gomodcache", "pip_target", "cargo_home", "gem_home", "pythonuserbase"];
const GLOBAL_FORMS = new Set(["-g", "--global", "--user", "--system", "--location=global"]);

/** R7 (3): the destinations an install's simple command names (words as the scan gives them, lower-cased): the option values
 *  (`--prefix x`, `--prefix=x`), the environment assignments, and the working folder for a project-local form (no `-g`,
 *  `--global`, `--user`, `--system`). Resolved against `cwd`. */
export function installDestinations(words: readonly string[], cwd: string, home?: string): string[] {
  const out: string[] = [];
  const add = (w: string) => { if (w) { const p = resolveWord(cwd, w, home); if (!out.includes(p)) out.push(p); } };
  let global = false;
  words.forEach((word, index) => {
    const w = word.toLowerCase();
    if (GLOBAL_FORMS.has(w)) global = true;
    const eq = w.indexOf("=");
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (DEST_OPTIONS.has(name)) {
      if (eq > 0) add(word.slice(eq + 1));
      else if (index + 1 < words.length) add(words[index + 1]!);
    } else if (eq > 0 && DEST_ASSIGNS.includes(name)) add(word.slice(eq + 1));
  });
  if (!global) add(".");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// the per-text syscall budget

export type StatResult = FsStat | null | "failed" | "spent";
/** 64 lstat / realpath per text (steps 2, 2b, 2c, 5, registration and 6.2 share it), each path asked once. */
export class TextBudget {
  left: number;
  private readonly fs: FsHooks;
  private readonly stats = new Map<string, StatResult>();
  private readonly reals = new Map<string, string | null | "failed" | "spent">();
  constructor(fs: FsHooks, limit = TEXT_SYSCALLS) { this.fs = fs; this.left = limit; }
  spent(): boolean { return this.left <= 0; }
  lstat(p: string): StatResult {
    const known = this.stats.get(p);
    if (known !== undefined) return known;
    if (this.left <= 0) return "spent";
    this.left--;
    let result: StatResult;
    try { result = this.fs.lstat(p); } catch { result = "failed"; }
    this.stats.set(p, result);
    return result;
  }
  realpath(p: string): string | null | "failed" | "spent" {
    const known = this.reals.get(p);
    if (known !== undefined) return known;
    if (this.left <= 0) return "spent";
    this.left--;
    let result: string | null | "failed";
    try { result = this.fs.realpath(p); } catch { result = "failed"; }
    this.reals.set(p, result);
    return result;
  }
  /** Q: the realpath of P's deepest existing ancestor joined with the rest (original case). "hit" when a syscall failed or the
   *  budget is spent (fail closed). */
  deepestReal(p: string): string | "hit" {
    const rest: string[] = [];
    let at = p;
    for (;;) {
      const real = this.realpath(at);
      if (real === "failed" || real === "spent") return "hit";
      if (real !== null) return rest.length ? [real.replace(/[\\/]+$/, ""), ...rest].join("/") : real;
      if (/^[a-zA-Z]:\/?$/.test(at)) return p;
      const up = path.posix.dirname(at);
      if (up === at) return p;
      rest.unshift(at.slice(up.length).replace(/^[\\/]+/, ""));
      at = up;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the registry

export interface MatchOptions {
  /** the gate's commandCwd, else the bot's working folder */
  cwd: string;
  budget: TextBudget;
  home?: string;
  /** step 2c: the word is a folder searched recursively (a folder operand or the implied cwd of a step-4 form) */
  searched?: boolean;
  /** step 2c: the engine's PATH folders (at most 64, lexical and realpath, known at turn start) */
  pathFolders?: readonly string[];
}

const labelOf = (e: RegistryEntry): DlLabel => (e.cloned || e.kind === "repo" ? "cloned folder" : "downloaded file");
const sameEntry = (a: RegistryEntry, b: RegistryEntry) => a.path === b.path && a.kind === b.kind;
const compareEntry = (a: RegistryEntry, b: RegistryEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : KIND_RANK[a.kind] - KIND_RANK[b.kind]);
const spanEnd = (s: RegistryEntry): number => s.until ?? s.since + SPAN_OPEN_MS;

export class DownloadRegistry {
  /** non-span entries, sorted by path then kind; at most one per (path, kind) */
  private entries: RegistryEntry[] = [];
  /** spans sorted by since, at most MAX_SPANS */
  private spans: RegistryEntry[] = [];
  private readonly basenames = new Map<string, { n: number; cloned: number }>();
  private readonly rows: RegistryRows | null;

  /** Loads what `rows` holds (a load that throws is the caller's to catch: the store is then not ready, 3.5). */
  constructor(rows: RegistryRows | null = null) {
    this.rows = rows;
    if (!rows) return;
    for (const row of rows.loadRegistry()) {
      const entry = { ...row, path: registryKey(row.path) };
      if (entry.kind === "span") this.spans.push(entry);
      else this.entries.push(entry);
    }
    this.entries.sort(compareEntry);
    this.spans.sort((a, b) => a.since - b.since);
    for (const entry of this.entries) this.countBase(entry, 1);
  }

  size(): number { return this.entries.length; }
  spanCount(): number { return this.spans.length; }
  /** A copy, for tests and the store. */
  list(): RegistryEntry[] { return [...this.entries, ...this.spans].map((e) => ({ ...e })); }
  empty(): boolean { return this.entries.length === 0 && this.spans.length === 0; }

  private countBase(entry: RegistryEntry, by: 1 | -1): void {
    const base = baseOf(entry.path);
    if (!base) return;
    const count = this.basenames.get(base) ?? { n: 0, cloned: 0 };
    count.n += by;
    if (labelOf(entry) === "cloned folder") count.cloned += by;
    if (count.n <= 0) this.basenames.delete(base);
    else this.basenames.set(base, count);
  }
  private lowerBound(key: string): number {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.entries[mid]!.path < key) lo = mid + 1; else hi = mid; }
    return lo;
  }
  private at(key: string): RegistryEntry[] {
    const out: RegistryEntry[] = [];
    for (let i = this.lowerBound(key); i < this.entries.length && this.entries[i]!.path === key; i++) out.push(this.entries[i]!);
    return out;
  }
  private write(add: RegistryEntry[], drop: RegistryEntry[]): void {
    if (!this.rows || (!add.length && !drop.length)) return;
    try { this.rows.writeRegistry(add.map((e) => ({ ...e })), drop.map((e) => ({ ...e }))); } catch { /* in memory for this run (over-marks only) */ }
  }

  /** Adds entries (one per (path, kind): a second one widens the first, since = min, until = max or none). The paths are keys
   *  or raw paths; they are stored as keys. Compacts past MAX_ENTRIES, merges spans past MAX_SPANS. */
  add(list: readonly RegistryEntry[]): void {
    const added: RegistryEntry[] = [];
    const dropped: RegistryEntry[] = [];
    const fresh: RegistryEntry[] = [];
    for (const raw of list) {
      const entry: RegistryEntry = { ...raw, path: registryKey(raw.path) };
      if (entry.kind === "span") {
        const same = this.spans.find((s) => s.path === entry.path && s.since === entry.since && s.turn === entry.turn);
        if (same) continue;
        const after = this.spans.findIndex((s) => s.since > entry.since);
        this.spans.splice(after < 0 ? this.spans.length : after, 0, entry);
        added.push(entry);
        continue;
      }
      const existing = this.at(entry.path).find((e) => sameEntry(e, entry)) ?? fresh.find((e) => sameEntry(e, entry));
      if (existing) {
        const before = { ...existing };
        const until = existing.until === undefined || entry.until === undefined ? undefined : Math.max(existing.until, entry.until);
        // an open entry with no turn stays open for good; else the newer turn stamps the end (an older turn's end never narrows it)
        const permanent = until === undefined && ((existing.until === undefined && !existing.turn) || (entry.until === undefined && !entry.turn));
        const turn = until !== undefined || permanent ? undefined : entry.turn ?? existing.turn;
        const widened = existing.since > entry.since || existing.until !== until || existing.turn !== turn || (entry.cloned && !existing.cloned);
        if (!widened) continue;
        existing.since = Math.min(existing.since, entry.since);
        if (until === undefined) delete existing.until; else existing.until = until;
        if (turn === undefined) delete existing.turn; else existing.turn = turn;
        if (entry.cloned && !existing.cloned) {
          const counted = !fresh.includes(existing);
          if (counted) this.countBase(existing, -1);
          existing.cloned = true;
          if (counted) this.countBase(existing, 1);
        }
        if (!fresh.includes(existing)) { dropped.push(before); added.push(existing); }
        continue;
      }
      fresh.push(entry);
    }
    if (fresh.length) {
      // one sorted merge per call (closes Opus M (d)): O(N + k log k)
      fresh.sort(compareEntry);
      const merged: RegistryEntry[] = [];
      let i = 0, j = 0;
      while (i < this.entries.length || j < fresh.length) {
        if (j >= fresh.length || (i < this.entries.length && compareEntry(this.entries[i]!, fresh[j]!) <= 0)) merged.push(this.entries[i++]!);
        else merged.push(fresh[j++]!);
      }
      this.entries = merged;
      for (const entry of fresh) this.countBase(entry, 1);
      added.push(...fresh);
    }
    while (this.spans.length > MAX_SPANS) this.mergeClosestSpans(added, dropped);
    if (this.entries.length > MAX_ENTRIES) this.compact(added, dropped);
    this.write(added.filter((e) => !dropped.includes(e)), dropped);
  }

  /** The two spans closest in time merge into one covering both (only widens). */
  private mergeClosestSpans(added: RegistryEntry[], dropped: RegistryEntry[]): void {
    let best = 0, gap = Infinity;
    for (let i = 0; i + 1 < this.spans.length; i++) {
      const g = this.spans[i + 1]!.since - spanEnd(this.spans[i]!);
      if (g < gap) { gap = g; best = i; }
    }
    const a = this.spans[best]!, b = this.spans[best + 1]!;
    const merged: RegistryEntry = { path: a.path === b.path ? a.path : "/", kind: "span", since: Math.min(a.since, b.since), until: Math.max(spanEnd(a), spanEnd(b)) };
    this.spans.splice(best, 2, merged);
    for (const old of [a, b]) {
      const was = added.indexOf(old);
      if (was >= 0) added.splice(was, 1); else dropped.push(old);
    }
    added.push(merged);
  }

  /** Never silently dropped: the deepest entries become entries for their parents (a `file` becomes a `window` with no end, so
   *  the file it named still Matches by ctime; kinds merge tree > repo > window > file, since = min, until = max or none),
   *  repeated until at most COMPACT_TO remain. */
  private compact(added: RegistryEntry[], dropped: RegistryEntry[]): void {
    const before = new Set(this.entries);
    while (this.entries.length > COMPACT_TO) {
      let deepest = 0;
      for (const entry of this.entries) deepest = Math.max(deepest, depthOf(entry.path));
      if (deepest <= 1) break;
      const byPath = new Map<string, RegistryEntry>();
      for (const entry of this.entries) {
        let next: RegistryEntry = entry;
        if (depthOf(entry.path) === deepest) {
          const parent = parentKey(entry.path) ?? entry.path;
          next = { path: parent, kind: entry.kind === "file" ? "window" : entry.kind, since: entry.since, ...(entry.kind === "file" || entry.until === undefined ? {} : { until: entry.until }), ...(entry.cloned ? { cloned: true } : {}) };
        }
        const have = byPath.get(next.path);
        if (!have) { byPath.set(next.path, next); continue; }
        const kind = KIND_RANK[next.kind] > KIND_RANK[have.kind] ? next.kind : have.kind;
        const openEnded = have.until === undefined || next.until === undefined || have.kind === "file" || next.kind === "file";
        const merged: RegistryEntry = { path: next.path, kind, since: Math.min(have.since, next.since), ...(openEnded ? {} : { until: Math.max(have.until!, next.until!) }), ...(have.cloned || next.cloned ? { cloned: true } : {}) };
        byPath.set(next.path, merged);
      }
      this.entries = [...byPath.values()].sort(compareEntry);
    }
    this.basenames.clear();
    for (const entry of this.entries) this.countBase(entry, 1);
    const after = new Set(this.entries);
    for (const old of before) if (!after.has(old)) {
      const was = added.indexOf(old);
      if (was >= 0) added.splice(was, 1); else dropped.push(old);
    }
    for (const entry of this.entries) if (!before.has(entry)) added.push(entry);
  }

  /** The turn ended (the next turn here began, or it settled): its open entries get `until = at`. */
  stampTurnEnd(turn: string, at: number): void {
    const changed: RegistryEntry[] = [];
    const old: RegistryEntry[] = [];
    for (const entry of [...this.entries, ...this.spans]) {
      if (entry.turn !== turn) continue;
      old.push({ ...entry });
      delete entry.turn;
      if (entry.until === undefined) entry.until = at;
      changed.push(entry);
    }
    this.write(changed, old);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Match (DL)

  /** Steps 1-4 for a word, a tool path, or the implied folder (`searched`). A glob word is read as its literal folder (3). */
  match(word: string, options: MatchOptions): DlLabel | null {
    if (this.empty() || !unquote(word)) return null;
    // 1 basename
    const base = baseOf(registryKey(word));
    const count = base ? this.basenames.get(base) : undefined;
    if (count) return count.cloned ? "cloned folder" : "downloaded file";
    // 3 a glob word: its literal folder
    let w = unquote(word);
    const glob = w.search(/[*?[]/);
    if (glob >= 0) {
      const cut = Math.max(w.lastIndexOf("/", glob), w.lastIndexOf("\\", glob));
      w = cut >= 0 ? w.slice(0, cut) || "/" : ".";
    }
    return this.matchPath(resolveWord(options.cwd, w, options.home), options);
  }

  /** Step 2 (and 2b, 2c) for an absolute path P in its original case. */
  matchPath(p: string, options: MatchOptions): DlLabel | null {
    if (this.empty()) return null;
    const { budget } = options;
    const pKey = registryKey(p);
    const lexical = this.byEntries(pKey);
    if (lexical.label) return lexical.label;
    const q = budget.deepestReal(p);
    if (q === "hit") return "downloaded file";
    const qKey = registryKey(q);
    const real = qKey === pKey ? lexical : this.byEntries(qKey);
    if (real.label) return real.label;
    const window = lexical.window ?? real.window;
    if (window || this.spans.length) {
      const stat = budget.lstat(q);
      if (stat === "failed" || stat === "spent") return window ? labelOf(window) : "downloaded file";
      if (stat) {
        if (window && (stat.dir || (stat.ctime >= window.since && (window.until === undefined || stat.ctime <= window.until)))) return labelOf(window);
        if (this.inSpan(stat.ctime)) return "downloaded file";
      }
    }
    // 2c PATH folders under a searched folder
    if (options.searched && this.spans.length && options.pathFolders) {
      for (const folder of options.pathFolders.slice(0, 64)) {
        const fKey = registryKey(folder);
        if (!isUnder(fKey, pKey) && !isUnder(fKey, qKey)) continue;
        const stat = budget.lstat(folder);
        if (stat === "failed" || stat === "spent") return "downloaded file";
        if (stat && this.inSpan(stat.ctime)) return "downloaded file";
      }
    }
    return null;
  }

  private inSpan(ctime: number): boolean {
    // spans are sorted by since: binary search the last span starting at or before ctime, then look back over the ones
    // still open at ctime (merged spans keep this short)
    let lo = 0, hi = this.spans.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.spans[mid]!.since <= ctime) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i--) if (spanEnd(this.spans[i]!) >= ctime) return true;
    return false;
  }

  /** The entry checks of step 2 with no syscall: a file equal to it, a tree or repo at or above it, a folder holding an entry;
   *  and the window at or above it that needs the lstat. */
  private byEntries(key: string): { label: DlLabel | null; window?: RegistryEntry } {
    let window: RegistryEntry | undefined;
    for (const entry of this.at(key)) {
      if (entry.kind === "file" || entry.kind === "tree" || entry.kind === "repo") return { label: labelOf(entry) };
      if (entry.kind === "window") window = entry;
    }
    const prefix = key.endsWith("/") ? key : key + "/";
    const below = this.entries[this.lowerBound(prefix)];
    if (below && below.path.startsWith(prefix)) return { label: labelOf(below) };
    for (let up = parentKey(key); up !== null; up = parentKey(up)) {
      for (const entry of this.at(up)) {
        if (entry.kind === "tree" || entry.kind === "repo") return { label: labelOf(entry) };
        if (entry.kind === "window" && !window) window = entry;
      }
    }
    return window ? { label: null, window } : { label: null };
  }

  /** Step 5, every text with a `git` part: the repo root (`root` = a `-C` / `--git-dir` / `--work-tree` / `GIT_DIR=` value,
   *  else the first ancestor of cwd holding `.git`, at most 16 levels). Hit when the root is or lies under a tree or repo
   *  entry, or its `.git/description`, else `.git/config`, else the `.git` itself Matches by step 2. */
  matchRepo(options: MatchOptions & { root?: string }): DlLabel | null {
    if (this.empty()) return null;
    const { budget } = options;
    let root: string | null = options.root ? resolveWord(options.cwd, options.root, options.home) : null;
    if (root && /[\\/]\.git$/i.test(root)) root = root.replace(/[\\/]\.git$/i, "") || "/";
    if (!root) {
      let at = resolveWord(options.cwd, ".");
      for (let level = 0; level < 16; level++) {
        const stat = budget.lstat(at === "/" ? "/.git" : `${at}/.git`);
        if (stat === "failed" || stat === "spent") return "downloaded file";
        if (stat) { root = at; break; }
        if (/^[a-zA-Z]:\/?$/.test(at)) break;
        const up = path.posix.dirname(at);
        if (up === at) break;
        at = up;
      }
    }
    if (!root) return null;
    const rootKey = registryKey(root);
    for (let up: string | null = rootKey; up !== null; up = parentKey(up)) {
      const hit = this.at(up).find((e) => e.kind === "tree" || e.kind === "repo");
      if (hit) return labelOf(hit);
    }
    const git = root === "/" ? "/.git" : `${root}/.git`;
    for (const name of ["description", "config"]) {
      const stat = budget.lstat(`${git}/${name}`);
      if (stat === "failed" || stat === "spent") return "downloaded file";
      if (stat) return this.matchPath(`${git}/${name}`, options);
    }
    return this.matchPath(git, options);
  }
}
