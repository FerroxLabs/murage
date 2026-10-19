// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The disk-fact callback (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md
// Rule 75d): the only thing the grant side gives the shell walker. The walker
// calls it for a `$(…)` or backtick whose inner text is exactly one simple
// command with literal words, inside its own ordered resolution, with that
// point's working directory and environment. An answer enters the walk as a
// literal; `undefined` keeps the word Unknown. The walker never touches disk
// itself; this is the one place a real-tree fact enters.

import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { joinReal, realDir, realPathInOrder, type RealPath } from "./in-project.ts";
import { GIT_CONFIG_BYTES } from "./scan-limits.ts";

/** One name's state as the walker reports it for a command (Rule 75c). */
export type EnvEntry =
  | { kind: "literal"; value: string }
  | { kind: "inherited" }
  | { kind: "absent" }
  | { kind: "unknown"; why: string }
  | { kind: "unset" };

export type EnvStateLike = ReadonlyMap<string, EnvEntry>;

export interface DiskFacts {
  substitution(cmd: { name: string; args: string[] }, cwd: string, env: EnvStateLike): string | undefined;
}

/** Names whose presence in any state but `unset` takes `git rev-parse
 * --show-toplevel` out of the plain state. */
export const GIT_ENV_NAMES: readonly string[] = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "XDG_CONFIG_HOME",
];

export interface DiskFactOptions {
  platform?: NodeJS.Platform;
  /** `/etc/gitconfig` by default; a test points it at a fixture. */
  systemConfig?: string;
}

/** A git configuration file read in this precedence slot: what it assigns
 * to `core.bare` and the last value of each asked key (`section.name`,
 * lowercase; a key with no `=` is `true`), or why the chain is unresolved. */
type ConfigRead = { ok: true; bare: boolean | "bad" | undefined; values?: Record<string, string | true> } | { ok: false };

const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0", ""]);

/** Strict git-config reader: sections, keys, quoted values with git's
 * escapes, comments. A line it does not understand, a continuation line, an
 * include, or a `core.worktree` makes the file unresolved; the last
 * `core.bare` assignment is returned, read with git's boolean spellings, and
 * with `keys` (`core.sshcommand`, `commit.gpgsign`, `tag.gpgsign`,
 * `tag.forcesignannotated`, lowercase) the last value of each. */
export function readGitConfigText(text: string, keys?: readonly string[]): ConfigRead {
  let section = "";
  let bare: boolean | "bad" | undefined;
  const wanted = keys ? new Set(keys.map((key) => key.toLowerCase())) : undefined;
  const values: Record<string, string | true> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:[#;].*)?$/.exec(line);
      if (!header) return { ok: false };
      const name = header[1]!.toLowerCase();
      if (name === "include" || name === "includeif" || name.startsWith("include.") || name.startsWith("includeif.")) return { ok: false };
      section = header[2] !== undefined ? `${name}\u0000${header[2]}` : name;
      continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!key) return { ok: false };
    const value = key[2] === undefined ? undefined : parseValue(key[2]);
    if (value === null) return { ok: false };
    const name = key[1]!.toLowerCase();
    if (section === "core" && name === "worktree") return { ok: false };
    if (wanted?.has(`${section}.${name}`)) values[`${section}.${name}`] = value === undefined ? true : value;
    if (section === "core" && name === "bare") {
      if (value === undefined) bare = true;
      else {
        const word = value.toLowerCase();
        bare = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : "bad";
      }
    }
  }
  return wanted ? { ok: true, bare, values } : { ok: true, bare };
}

/** A value with git's quoting and escapes; null for a continuation line or
 * an escape git would reject. Unquoted `#` and `;` start a comment. */
function parseValue(raw: string): string | null {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) return null; // a continuation line
      const mapped = next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next === "\\" || next === "\"" ? next : undefined;
      if (mapped === undefined) return null;
      out += mapped;
      i++;
      continue;
    }
    if (ch === "\"") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === "#" || ch === ";")) break;
    out += ch;
  }
  if (quoted) return null;
  return out.trim();
}

function readConfigFile(path: string | undefined, keys?: readonly string[]): ConfigRead | "missing" {
  // a configuration file that cannot be placed is unresolved, never missing
  if (path === undefined) return { ok: false };
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false };
    size = st.size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : { ok: false };
  }
  if (size > GIT_CONFIG_BYTES) return { ok: false };
  try {
    return readGitConfigText(readFileSync(path, "utf8"), keys);
  } catch {
    return { ok: false };
  }
}

function present(env: EnvStateLike, name: string): boolean {
  const entry = env.get(name);
  return entry !== undefined && entry.kind !== "unset";
}

/** The candidate repository for `cwd`: the working directory holding the
 * `.git` entry and the git directory it names. Undefined when the walk up
 * crosses a device, meets a bare repository, or finds a `.git` it cannot
 * read or place. Every path is placed in order (shared/in-project.ts), so a
 * `gitdir: link/../g` climbs from where the link points. */
function findRepository(cwd: string, platform: NodeJS.Platform): { top: RealPath; gitDir: RealPath } | undefined {
  let dir = realDir(cwd, { platform });
  if (!dir) return undefined;
  let device: number;
  try {
    device = statSync(dir).dev;
  } catch {
    return undefined;
  }
  const exists = (name: string) => {
    const at = joinReal(dir!, name);
    if ("cannot" in at) return false;
    try {
      statSync(at.path);
      return true;
    } catch {
      return false;
    }
  };
  for (;;) {
    let st;
    try {
      st = statSync(dir);
    } catch {
      return undefined;
    }
    if (st.dev !== device) return undefined;
    if (["HEAD", "objects", "refs"].every(exists)) return undefined; // a bare repository on the path
    const dotGit = joinReal(dir, ".git");
    if ("cannot" in dotGit) return undefined;
    let entry;
    try {
      entry = statSync(dotGit.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      entry = undefined;
    }
    if (entry?.isDirectory()) {
      const gitDir = realDir(dotGit.path, { platform });
      return gitDir ? { top: dir, gitDir } : undefined;
    }
    if (entry?.isFile()) {
      let first: string;
      try {
        if (entry.size > GIT_CONFIG_BYTES) return undefined;
        first = readFileSync(dotGit.path, "utf8").split(/\r?\n/)[0] ?? "";
      } catch {
        return undefined;
      }
      const m = /^gitdir: (.+)$/.exec(first);
      if (!m) return undefined;
      const gitDir = realPathInOrder(m[1]!.trim(), dir, { platform });
      return "cannot" in gitDir ? undefined : { top: dir, gitDir: gitDir.real };
    }
    if (entry) return undefined;
    const parent = realDir(pathFor(platform).dirname(dir), { platform });
    if (!parent || parent === dir) return undefined;
    dir = parent;
  }
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** A configuration FILE placed in order: a missing tail is kept as written,
 * so an absent file is read as missing (ENOENT); undefined when it cannot be
 * placed. */
function configFile(path: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (path === undefined) return undefined;
  const placed = realPathInOrder(path, "", { platform });
  return "cannot" in placed ? undefined : placed.real;
}

function under(base: RealPath, platform: NodeJS.Platform, ...names: string[]): string | undefined {
  const at = joinReal(base, ...names);
  return "cannot" in at ? undefined : configFile(at.path, platform);
}

/** The configuration chain of the repository at `cwd` in git's precedence, lowest first (system, the two global files, the
 * common config, the worktree config), every path placed in order; undefined when HOME does not resolve whole, no repository
 * is found, or its commondir cannot be read. */
function configChain(cwd: string, homeValue: string, opts: DiskFactOptions): { top: RealPath; files: (string | undefined)[] } | undefined {
  const platform = opts.platform ?? process.platform;
  // a HOME that does not resolve, in order and whole, leaves the chain unknown
  const realHome = realDir(homeValue, { platform });
  if (!realHome) return undefined;
  // the walk up
  const repo = findRepository(cwd, platform);
  if (!repo) return undefined;
  let commonDir: RealPath = repo.gitDir;
  const commondirFile = joinReal(repo.gitDir, "commondir");
  if ("cannot" in commondirFile) return undefined;
  try {
    const st = statSync(commondirFile.path);
    if (st.isFile()) {
      if (st.size > GIT_CONFIG_BYTES) return undefined;
      const named = (readFileSync(commondirFile.path, "utf8").split(/\r?\n/)[0] ?? "").trim();
      if (!named) return undefined;
      const placed = realPathInOrder(named, repo.gitDir, { platform });
      if ("cannot" in placed) return undefined;
      commonDir = placed.real;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  // git's own default system file; on Windows the same name on the running drive, as git and the old read both saw it
  const systemDefault = platform === "win32" ? `${win32.parse(process.cwd()).root}etc\\gitconfig` : "/etc/gitconfig";
  return {
    top: repo.top,
    files: [
      configFile(opts.systemConfig ?? systemDefault, platform),
      under(realHome, platform, ".config", "git", "config"),
      under(realHome, platform, ".gitconfig"),
      under(commonDir, platform, "config"),
      under(repo.gitDir, platform, "config.worktree"),
    ],
  };
}

/** The per-repository row data (APP-GRANT-FIXPLAN-r6 (e)+(h) (b)): the last value of each asked key over the repository's
 * strict chain at `cwd` (`home` is the HOME the command sees), or `{ ok: false }` when the chain is unresolved. */
export function repoConfigValues(cwd: string, home: string, keys: readonly string[], opts: DiskFactOptions = {}): { ok: true; values: Record<string, string | true> } | { ok: false } {
  const chain = configChain(cwd, home, opts);
  if (!chain) return { ok: false };
  const values: Record<string, string | true> = {};
  for (const file of chain.files) {
    const read = readConfigFile(file, keys);
    if (read === "missing") continue;
    if (!read.ok) return { ok: false };
    Object.assign(values, read.values);
  }
  return { ok: true, values };
}

/** `git rev-parse --show-toplevel` in the PLAIN STATE only (Rule 75d). */
function showToplevel(cwd: string, env: EnvStateLike, handed: ReadonlyMap<string, string>, opts: DiskFactOptions): string | undefined {
  // (1) nothing in the environment redirects git's discovery or config
  if (GIT_ENV_NAMES.some((name) => present(env, name))) return undefined;
  const home = env.get("HOME");
  const homeValue = home?.kind === "literal" ? home.value : home?.kind === "inherited" ? handed.get("HOME") : undefined;
  if (!homeValue) return undefined;
  // (2) the walk up and (3) the configuration chain in git's precedence, lowest first
  const chain = configChain(cwd, homeValue, opts);
  if (!chain) return undefined;
  let bare: boolean | "bad" | undefined;
  for (const file of chain.files) {
    const read = readConfigFile(file);
    if (read === "missing") continue;
    if (!read.ok) return undefined;
    if (read.bare !== undefined) bare = read.bare;
  }
  // a repository found through a `.git` entry in a working directory is not
  // bare by default; an effective true or a spelling git rejects is refused
  if (bare === true || bare === "bad") return undefined;
  // (4) the real path of the candidate, resolved in order by the walk
  return chain.top;
}

/** One literal operand, or undefined. */
function only(args: readonly string[]): string | undefined {
  return args.length === 1 && args[0] !== "" && !args[0]!.startsWith("-") ? args[0] : undefined;
}

/**
 * The grant side's disk-fact table, built over F12's handed map (`handed`)
 * so an `inherited` name has its value. `pwd` is the cwd; `realpath x` and
 * `readlink -f x` the real path of x from the cwd; `dirname x` and `basename
 * x` the path functions; `git rev-parse --show-toplevel` the plain-state
 * answer. Anything else, any other option, any argument that is not one
 * literal: undefined.
 */
export function diskFacts(handed: ReadonlyMap<string, string>, opts: DiskFactOptions = {}): DiskFacts {
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  return {
    substitution(cmd, cwd, env) {
      const { name, args } = cmd;
      if (name === "pwd") return args.length === 0 ? cwd : undefined;
      if (name === "realpath" || (name === "readlink" && args[0] === "-f")) {
        const target = only(name === "readlink" ? args.slice(1) : args);
        if (target === undefined) return undefined;
        // Rule 75d: placed in order with every part present, so `link/..` climbs from where the link points and a missing part
        // (the leaf or an ancestor) is undefined, as realpath itself fails there
        const placed = realPathInOrder(target, cwd, { platform, mustExist: true });
        return "cannot" in placed ? undefined : placed.real;
      }
      if (name === "dirname") {
        const target = only(args);
        return target === undefined ? undefined : p.dirname(target);
      }
      if (name === "basename") {
        const target = only(args);
        return target === undefined ? undefined : p.basename(target);
      }
      if (name === "git" && args.length === 2 && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return showToplevel(cwd, env, handed, opts);
      }
      return undefined;
    },
  };
}
