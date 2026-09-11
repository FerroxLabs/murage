// Murage's own per-folder trust record (0.1.52 FUIGOTRUST1).
//
// Fuigo 1.0.13 keeps repo-local sources — project instructions (AGENTS.md,
// CLAUDE.md, rules), .mcp.json, project `.fuigo/` and `.claude/` config,
// project skills, hooks, plugins and agents — behind a per-workspace trust
// gate, and resolves "untrusted" on its own whenever it cannot ask (Murage's
// piped `agent stdio` spawn, upstream fuigo-workspace/src/folder_trust.rs
// `decide`). Murage asks the human instead, once per folder, and keeps the
// answer here: server-side, in the installation's own data dir next to
// bots.json, keyed by the same canonical workspace root Fuigo keys on (the
// git worktree root when the folder is inside a repository, else the folder
// itself). The record is the single source for both the `--trust` argv the
// driver passes and the answer it gives to Fuigo's own interactive request.
//
// The scan mirrors upstream `collect_repo_config_kinds` by NAME so the card
// can say what the folder would contribute ("AGENTS.md, .mcp.json, .fuigo/
// skills"). It walks the same cwd → git-root chain the upstream loaders walk.
// Fuigo's scan stays authoritative for the gate itself: if it gates something
// this scan did not name, its request still reaches the driver and the card.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "./atomic.ts";
import { readPersistedJson } from "./persisted-state.ts";
import type { FolderTrustDecision } from "../shared/folder-trust.ts";

export type { FolderTrustDecision } from "../shared/folder-trust.ts";

/** Project instruction files upstream reads (`CompatConfig::agent_filenames`). */
const INSTRUCTION_FILES = ["AGENTS.md", "AGENT.md", "Agents.md", "CLAUDE.md", "Claude.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/CLAUDE.local.md"];
/** Rules directories (`rules_dirs`). */
const RULES_DIRS = [".fuigo/rules", ".claude/rules", ".cursor/rules"];
/** Project skill and command roots (`skill_config_dirs` × SKILL_SUBDIRS + COMMAND_SUBDIR). */
const SKILL_DIRS = [".fuigo", ".agents", ".claude", ".cursor"].flatMap((d) => [`${d}/skills`, `${d}/commands`]);
/** Code-exec and policy sources: MCP, LSP, hooks, plugins, agents, permission rules, env.
 * `.fuigo/config.toml` counts by presence; upstream gates it only when it carries
 * `[mcp_servers]`, `[plugins].paths` or `[permission]` rules, so a config that
 * sets nothing of the kind may see a card the engine would not have raised —
 * an honest question about the folder either way, never a missed one. */
const CONFIG_FILES = [".mcp.json", ".fuigo/config.toml", ".fuigo/lsp.json", ".cursor/mcp.json", ".cursor/hooks.json", ".claude/settings.json", ".claude/settings.local.json", ".envrc"];
const CONFIG_DIRS = [".fuigo/hooks", ".fuigo/plugins", ".claude/plugins", ".fuigo/agents", ".claude/agents", ".fuigo/roles", ".fuigo/personas", ".fuigo/workflows"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The canonical real path, or the resolved path when it does not exist. */
export function canonicalFolder(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The git worktree root containing `folder` (a directory with `.git`, file
 * or dir — a linked worktree keeps a `.git` file), or null outside a repo. */
export function gitRootOf(folder: string): string | null {
  let dir = canonicalFolder(folder);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The user's home, canonicalized once; a repo that IS the home folder (a
 * dotfiles checkout) must never become a trust key covering everything. */
const canonicalHome = () => canonicalFolder(homedir());

/** A key Fuigo refuses to record — and so does Murage: the home folder, a
 * filesystem root, or a relative path. Such a folder is never gated upstream
 * (`is_unsafe_trust_root` → trusted), so no card is ever raised for it. */
export function isUnrecordableTrustRoot(key: string): boolean {
  if (!key || key !== resolve(key)) return true;
  if (parse(key).root === key) return true;
  return canonicalFolder(key) === canonicalHome();
}

/** `[core]` settings of a git directory that decide its working tree, read
 * the way libgit2 does when it opens the directory: `core.bare` and
 * `core.worktree`. Missing or unreadable config = neither set. */
function gitCoreConfig(gitDir: string): { bare: boolean; worktree: string | null } {
  let text: string;
  try {
    text = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    return { bare: false, worktree: null };
  }
  let inCore = false;
  let bare = false;
  let worktree: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "").replace(/\s*[#;].*$/, "");
    if (!line) continue;
    if (line.startsWith("[")) {
      inCore = /^\[\s*core\s*\]$/i.test(line);
      continue;
    }
    if (!inCore) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name === "bare") bare = value.toLowerCase() === "true";
    else if (name === "worktree") worktree = value;
  }
  return { bare, worktree };
}

/** The main checkout's root for a LINKED git worktree root (`<root>/.git`
 * is a file naming a gitdir under the main repository's `worktrees/`), or
 * null when `root` is not one. Mirrors the git-topology branch of upstream
 * `workspace_key` (fuigo-workspace/src/trust.rs, git2): the linked
 * worktree's common gitdir is opened as the main repository, and the
 * collapse fires ONLY for the conventional `<main>/.git` layout — the main
 * repository's inferred working tree must own the common gitdir as its
 * `.git`. A bare repository (no working tree) or a `--separate-git-dir`
 * checkout (the gitdir's parent is not the checkout) fails that guard and
 * the worktree keeps its own root, narrow and never widened. A submodule's
 * `.git` file names a gitdir with no `commondir`/`gitdir` files and is not
 * a worktree either. */
export function linkedWorktreeMainRoot(root: string): string | null {
  const dotGit = join(root, ".git");
  let link: string;
  try {
    if (!statSync(dotGit).isFile()) return null;
    link = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(link);
  if (!named) return null;
  const gitDir = canonicalFolder(resolve(root, named[1]!));
  // libgit2 `repo_is_worktree`: a `gitdir` file inside the gitdir marks a
  // linked worktree; `commondir` names the shared (main) git directory
  let commonRel: string;
  try {
    if (!isFile(join(gitDir, "gitdir"))) return null;
    commonRel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return null;
  }
  if (!commonRel) return null;
  const commonDir = canonicalFolder(resolve(gitDir, commonRel));
  if (commonDir === gitDir || !isDir(commonDir)) return null;
  const core = gitCoreConfig(commonDir);
  // the main repository's working tree as libgit2 infers it: `core.worktree`
  // when set (relative to the gitdir), none for a bare repository, else the
  // gitdir's parent
  const mainWorkdir = core.worktree ? resolve(commonDir, core.worktree) : core.bare ? null : dirname(commonDir);
  if (!mainWorkdir) return null;
  if (canonicalFolder(join(mainWorkdir, ".git")) !== commonDir) return null;
  return canonicalFolder(mainWorkdir);
}

export interface FolderTrustKeyOptions {
  /** The Fuigo home whose `worktrees.db` the engine consults for this turn
   * (`fuigoHomeFromEnv`); null/undefined = no registry — a provider-routed
   * turn runs under a per-turn temporary FUIGO_HOME that has none, so the
   * key is git's alone. */
  fuigoHome?: string | null;
}

/** The trust key for a folder: the canonical git root when the folder sits in
 * a repository whose root is recordable, else the canonical folder itself.
 * A linked git worktree keys on its MAIN checkout's root (FUIGOTRUST3), so
 * every worktree of a repository shares one key with the checkout a
 * standalone `fuigo --trust` was run in. With a Fuigo home, a fuigo-managed
 * worktree (`fuigo -w`, FUIGOTRUST4) keys on its RECORDED source repo's git
 * root first, whatever git says about it. Mirrors upstream `workspace_key`
 * (fuigo-workspace/src/trust.rs): registry, then git topology, then the
 * over-broad-root fallback to the folder itself. */
export function folderTrustKey(folder: string, options: FolderTrustKeyOptions = {}): string {
  const key = gitDerivedTrustKey(folder, options.fuigoHome ?? null);
  if (key && !isUnrecordableTrustRoot(key)) return key;
  return canonicalFolder(folder);
}

/** Upstream `git_derived_workspace_key`: the key before the over-broad
 * check. A managed worktree collapses onto the git root of its recorded
 * source (upstream: `Repository::discover(source).workdir()`, else the
 * recorded path itself when the source is gone); otherwise git decides. */
function gitDerivedTrustKey(folder: string, fuigoHome: string | null): string | null {
  const source = fuigoHome ? managedWorktreeSourceRepo(folder, fuigoHome) : null;
  if (source) return gitRootOf(source) ?? canonicalFolder(source);
  const root = gitRootOf(folder);
  return root ? linkedWorktreeMainRoot(root) ?? root : null;
}

// ── the engine's managed-worktree registry (read-only) ────────────────────
//
// `fuigo -w` creates its worktrees under `<FUIGO_HOME>/worktrees/<repo>/<label>`
// and records each in `<FUIGO_HOME>/worktrees.db` (SQLite, fuigo-fast-worktree
// src/db: table `worktrees`, `path` UNIQUE and `source_repo`, both stored
// canonical by `register_worktree`). Upstream `source_repo_for_cwd`
// (fuigo-workspace/src/worktree/mod.rs) answers only for a cwd under the
// worktrees dir — the prefix test is on the cwd AS GIVEN against the home as
// the engine resolves it (`FUIGO_HOME` verbatim, else the canonical
// `<home>/.fuigo`) — walks the cwd up to the worktrees dir looking each path
// up canonicalized (`WorktreeDb::get`), and returns the first record's
// `source_repo`; a record's status is not consulted. Murage reads the same
// file read-only and never creates it (the engine's own open would); a
// database it cannot open or query is treated as the engine treats one it
// cannot open: logged, and no collapse.

export const UPSTREAM_WORKTREES_DB = "worktrees.db";
const UPSTREAM_WORKTREES_DIR = "worktrees";
const warnedWorktreesDb = new Set<string>();

/** The recorded source repo of the fuigo-managed worktree containing
 * `folder`, or null (no registry I/O for a folder outside the worktrees
 * dir). Mirrors upstream `source_repo_for_cwd`. */
export function managedWorktreeSourceRepo(folder: string, fuigoHome: string): string | null {
  const worktreesDir = join(fuigoHome, UPSTREAM_WORKTREES_DIR);
  if (!pathStartsWith(folder, worktreesDir) || relative(worktreesDir, folder) === "") return null;
  const file = join(fuigoHome, UPSTREAM_WORKTREES_DB);
  if (!isFile(file)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    warnWorktreesDb(file, error);
    return null;
  }
  try {
    const byPath = db.prepare("SELECT source_repo FROM worktrees WHERE path = ?");
    let path = folder;
    while (pathStartsWith(path, worktreesDir) && relative(worktreesDir, path) !== "") {
      // `WorktreeDb::get` treats a string with a `/` as a path (canonicalized
      // before the lookup) and anything else as an id or label — so a
      // backslash-only spelling never matches by path, on the engine's side
      // and on this one
      if (path.includes("/")) {
        const row = byPath.get(canonicalFolder(path)) as { source_repo?: unknown } | undefined;
        if (row && typeof row.source_repo === "string" && row.source_repo) return row.source_repo;
      }
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    return null;
  } catch (error) {
    warnWorktreesDb(file, error);
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function warnWorktreesDb(file: string, error: unknown): void {
  const message = `[folder-trust] could not read the Fuigo worktree registry ${file}: ${error instanceof Error ? error.message : String(error)}`;
  if (warnedWorktreesDb.has(message)) return;
  warnedWorktreesDb.add(message);
  console.warn(message);
}

/** The directories the upstream loaders walk: `folder` up to and including
 * its git root (just `folder` outside a repository). */
function chainDirs(folder: string): string[] {
  const start = canonicalFolder(folder);
  const root = gitRootOf(start);
  const dirs = [start];
  if (!root || root === start) return dirs;
  let dir = start;
  while (dir !== root) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dirs.push(parent);
    dir = parent;
  }
  return dirs;
}

export interface FolderTrustScan {
  key: string;
  folder: string;
  /** Names of the trust-sensitive sources present, deduplicated, in the order
   * a person would recognise them (instructions first). Empty = nothing to
   * gate, so no card. */
  sources: string[];
  /** 0.1.52 FUIGOTRUST2: the user's own Fuigo install already trusts this
   * workspace (`<FUIGO_HOME>/trusted_folders.toml`, the store standalone
   * `fuigo --trust` writes and the engine re-reads per session). Such a
   * folder runs trusted whatever Murage's record says — the engine never
   * asks and cannot be told otherwise — so no card is raised for it and no
   * "untrusted folder" chip is ever shown. Present only when true. */
  upstreamTrusted?: true;
}

export interface FolderTrustScanOptions {
  /** The Fuigo home whose `trusted_folders.toml` the engine will read for
   * this turn (`fuigoHomeFromEnv`); null/undefined = do not consult one —
   * a provider-routed turn runs under a per-turn temporary FUIGO_HOME that
   * has no such file, so only Murage's own record speaks for it. */
  fuigoHome?: string | null;
}

/** What the folder would contribute to a Fuigo turn, by name. Cheap: a
 * bounded set of stat calls along the cwd → git-root chain, no parsing. */
export function scanFolderTrustSources(folder: string, options: FolderTrustScanOptions = {}): FolderTrustScan {
  const start = canonicalFolder(folder);
  // the key the ENGINE will use for this turn: the registry prefix test is
  // on the folder as given, so the folder is passed uncanonicalized
  const key = folderTrustKey(folder, options);
  const sources: string[] = [];
  // deduplicated case-insensitively: on a case-insensitive filesystem (macOS
  // APFS, Windows) "AGENTS.md" and "Agents.md" stat as the same file
  const seen = new Set<string>();
  const hit = (name: string) => {
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    sources.push(name);
  };
  if (isUnrecordableTrustRoot(key)) return { key, folder: start, sources };
  const dirs = chainDirs(start);
  for (const dir of dirs) for (const name of INSTRUCTION_FILES) if (isFile(join(dir, name))) hit(name);
  for (const dir of dirs) for (const name of RULES_DIRS) if (isDir(join(dir, name))) hit(name);
  for (const dir of dirs) for (const name of SKILL_DIRS) if (isDir(join(dir, name))) hit(name);
  for (const dir of dirs) for (const name of CONFIG_FILES) if (isFile(join(dir, name))) hit(name);
  for (const dir of dirs) for (const name of CONFIG_DIRS) if (isDir(join(dir, name))) hit(name);
  const upstream = options.fuigoHome ? upstreamTrustsFolder(readUpstreamTrustedFolders(options.fuigoHome), folder, options) : false;
  return { key, folder: start, sources, ...(upstream ? { upstreamTrusted: true as const } : {}) };
}

// ── the user's own Fuigo trust store (read-only) ─────────────────────────
//
// Fuigo 1.0.13 keeps its grants in `<FUIGO_HOME>/trusted_folders.toml`
// (fuigo-workspace/src/trust.rs), written by standalone `fuigo --trust` and
// by the `--trust` Murage passes on a trusted turn:
//
//     [folders."/abs/repo/root"]
//     trusted = true
//     decided_at = 1780000000
//
// The engine re-reads it per session and its `decide` answers Trusted from
// the store BEFORE anything else — before the interactive request Murage
// answers, before Murage's own record. A native-login turn (the user's real
// FUIGO_HOME) in such a folder therefore runs trusted no matter what the
// person told Murage. Murage reads the same file, read-only, so the card is
// not raised and the "untrusted folder" chip is not shown for a folder the
// engine will trust anyway. Never written here: `--trust` is the only way a
// Murage decision reaches that file, and only on a trusted turn.

/** Fuigo's home for a child env: `FUIGO_HOME` verbatim when non-empty (the
 * engine uses it as-is, uncanonicalized), else `<home>/.fuigo`. Mirrors
 * `fuigoHome` in drivers/acp/fuigo.ts and upstream fuigo-dirs
 * `resolve_fuigo_home_from`. */
export function fuigoHomeFromEnv(env: Record<string, string | undefined>): string {
  if (env.FUIGO_HOME) return env.FUIGO_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".fuigo");
}

export const UPSTREAM_TRUST_FILE = "trusted_folders.toml";

/** A TOML basic (`"…"`, with escapes) or literal (`'…'`) string at the start
 * of `text`; null when it is neither or is unterminated. */
function tomlString(text: string): { value: string; rest: string } | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === quote) return { value, rest: text.slice(i + 1) };
    if (quote === "'" || ch !== "\\") {
      value += ch;
      continue;
    }
    const next = text[i + 1];
    i++;
    switch (next) {
      case "\\": value += "\\"; break;
      case '"': value += '"'; break;
      case "n": value += "\n"; break;
      case "t": value += "\t"; break;
      case "r": value += "\r"; break;
      case "b": value += "\b"; break;
      case "f": value += "\f"; break;
      case "u":
      case "U": {
        const width = next === "u" ? 4 : 8;
        const hex = text.slice(i + 1, i + 1 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) return null;
        value += String.fromCodePoint(parseInt(hex, 16));
        i += width;
        break;
      }
      default:
        return null;
    }
  }
  return null;
}

/** A TOML key: quoted, or bare (`A-Za-z0-9_-`). */
function tomlKey(text: string): { value: string; rest: string } | null {
  const quoted = tomlString(text);
  if (quoted) return quoted;
  const bare = /^[A-Za-z0-9_-]+/.exec(text);
  return bare ? { value: bare[0], rest: text.slice(bare[0].length) } : null;
}

/** Strip a trailing `# comment` (outside quotes) and whitespace. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i).trim();
  }
  return line.trim();
}

/** `trusted = true|false`, or null for any other value. */
function tomlTrusted(value: string): boolean | null {
  const v = value.trim();
  return v === "true" ? true : v === "false" ? false : null;
}

/** Parse the upstream `trusted_folders.toml` document into folder → trusted.
 * Understands exactly what the engine's `toml` serializer writes (one
 * `[folders."<key>"]` table per folder) plus the two hand-edit spellings a
 * TOML reader accepts for the same data (`[folders]` with inline tables or
 * dotted keys). Anything else — any line it does not recognise — makes the
 * whole document unparseable and yields an EMPTY map, the way the engine's
 * own reader treats a document its parser rejects: Murage must never trust
 * a folder the engine would not, or the turn would run untrusted with no
 * card and no chip. Returns null for an unparseable document. */
export function parseUpstreamTrustedFolders(text: string): Map<string, boolean> | null {
  const folders = new Map<string, boolean>();
  // table state: null = root, "folders" = inside [folders], {key} = inside [folders."key"]
  let table: null | "folders" | { key: string } | "other" = null;
  const set = (key: string, trusted: boolean | null) => {
    if (trusted === null) return false;
    folders.set(key, trusted);
    return true;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw);
    if (!line) continue;
    if (line.startsWith("[")) {
      if (line.startsWith("[[") || !line.endsWith("]")) return null;
      const inner = line.slice(1, -1).trim();
      if (inner === "folders") { table = "folders"; continue; }
      if (inner.startsWith("folders.")) {
        const key = tomlKey(inner.slice("folders.".length));
        if (!key || key.rest.trim()) return null;
        table = { key: key.value };
        continue;
      }
      // a table this reader does not know (a future section): skip its body
      table = "other";
      continue;
    }
    const eq = (() => {
      // find the first `=` outside quotes
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          if (ch === "\\" && quote === '"') i++;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "=") return i;
      }
      return -1;
    })();
    if (eq < 0) return null;
    const lhs = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 1).trim();
    if (table === "other") continue;
    if (table === null) return null; // a root-level key the document never has
    if (typeof table === "object") {
      if (lhs === "trusted") { if (!set(table.key, tomlTrusted(rhs))) return null; continue; }
      if (lhs === "decided_at") { if (!/^-?\d+$/.test(rhs)) return null; continue; }
      return null;
    }
    // inside [folders]: `"key" = { trusted = true, decided_at = 1 }` or `"key".trusted = true`
    const key = tomlKey(lhs);
    if (!key) return null;
    const after = key.rest.trim();
    if (after === "" && rhs.startsWith("{") && rhs.endsWith("}")) {
      let trusted: boolean | null = null;
      for (const part of rhs.slice(1, -1).split(",").map((p) => p.trim()).filter(Boolean)) {
        const m = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(part);
        if (!m) return null;
        if (m[1] === "trusted") { trusted = tomlTrusted(m[2]!); if (trusted === null) return null; }
        else if (m[1] === "decided_at") { if (!/^-?\d+$/.test(m[2]!.trim())) return null; }
        else return null;
      }
      if (trusted === null) return null;
      folders.set(key.value, trusted);
      continue;
    }
    if (after === ".trusted") { if (!set(key.value, tomlTrusted(rhs))) return null; continue; }
    if (after === ".decided_at") { if (!/^-?\d+$/.test(rhs)) return null; continue; }
    return null;
  }
  return folders;
}

/** The user's own Fuigo grants: folder → trusted, from
 * `<fuigoHome>/trusted_folders.toml`. Missing, unreadable or unparseable →
 * empty (the engine's own rule). Read fresh every time: the engine re-reads
 * per session, and standalone Fuigo may have written it a moment ago. */
export function readUpstreamTrustedFolders(fuigoHome: string): Map<string, boolean> {
  let text: string;
  try {
    text = readFileSync(join(fuigoHome, UPSTREAM_TRUST_FILE), "utf8");
  } catch {
    return new Map();
  }
  if (!text.trim()) return new Map();
  return parseUpstreamTrustedFolders(text) ?? new Map();
}

/** Component-wise "`path` is `prefix` or below it" (Rust `Path::starts_with`). */
function pathStartsWith(path: string, prefix: string): boolean {
  const rel = relative(prefix, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Whether the engine's own store trusts `folder`, by upstream `is_trusted`
 * (fuigo-workspace/src/trust.rs), which the engine queries with the
 * folder's WORKSPACE KEY (`is_trusted(workspace_key(cwd))`): among recorded
 * folders that are an ancestor-or-self of that key AND share its own
 * workspace key (the same git root — a nested repo is not covered, and a
 * hand-edited record below the root covers nothing), the deepest decides;
 * on a depth tie every tied record must say trusted; over-broad keys (home,
 * a filesystem root, a relative path) are ignored. A linked worktree is
 * queried by its main checkout's root (FUIGOTRUST3), and a fuigo-managed
 * worktree by its recorded source repo's root when `options.fuigoHome`
 * names the registry (FUIGOTRUST4), so a standalone `fuigo --trust` on the
 * source repository covers its worktrees. */
export function upstreamTrustsFolder(records: ReadonlyMap<string, boolean>, folder: string, options: FolderTrustKeyOptions = {}): boolean {
  if (!records.size) return false;
  const query = folderTrustKey(folder, options);
  const queryKey = folderTrustKey(query, options);
  let bestDepth: number | null = null;
  let trusted = false;
  for (const [raw, decision] of records) {
    // a hand-edited `/a/b/` names the same folder as `/a/b` (Rust Path
    // components ignore a trailing separator); the tie rule then applies
    const recorded = raw.length > 1 ? raw.replace(/[\\/]+$/, "") || raw : raw;
    if (isUnrecordableTrustRoot(recorded) || !pathStartsWith(query, recorded)) continue;
    if (folderTrustKey(recorded, options) !== queryKey) continue;
    const depth = recorded.split(/[\\/]+/).filter(Boolean).length;
    if (bestDepth !== null && depth < bestDepth) continue;
    if (bestDepth !== null && depth === bestDepth) trusted &&= decision;
    else {
      bestDepth = depth;
      trusted = decision;
    }
  }
  return trusted;
}

/** Display names for the kinds Fuigo's own request reports (`configKinds`),
 * used when Fuigo gates something Murage's scan did not name. */
export function folderTrustKindNames(kinds: readonly unknown[]): string[] {
  const names: Record<string, string> = {
    instructions: "AGENTS.md / CLAUDE.md",
    skills: "project skills",
    mcp: "MCP servers (.mcp.json)",
    lsp: ".fuigo/lsp.json",
    hooks: "project hooks",
    plugins: "project plugins",
    agents: "project agents",
    permission: "permission rules",
    envrc: ".envrc",
    claude: ".claude settings",
    roles: ".fuigo/roles",
    personas: ".fuigo/personas",
    workflows: ".fuigo/workflows",
  };
  const out: string[] = [];
  for (const kind of kinds) {
    if (typeof kind !== "string") continue;
    const name = names[kind] ?? kind.slice(0, 40);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Who made the record: a folder picker, the trust card, or the one-time
 * upgrade seed (FUIGOTRUST2: a folder a bot, task or room was already
 * working in before 0.1.52 — chosen by the person in Murage back then, so
 * treated as picker-chosen; Forget in the picker asks again). */
export type FolderTrustSource = "picker" | "card" | "upgrade";

export interface FolderTrustRecord {
  decision: FolderTrustDecision;
  decidedAt: number;
  source: FolderTrustSource;
  /** the folder the decision was made on; the record is keyed by its root */
  folder: string;
}

interface PersistedFolderTrust {
  version: 1;
  folders: Record<string, FolderTrustRecord>;
  /** The release whose boot seeded pre-existing working folders (once). */
  seededFrom?: string;
}

const isRecord = (value: unknown): value is FolderTrustRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && ((value as FolderTrustRecord).decision === "trust" || (value as FolderTrustRecord).decision === "reject")
  && typeof (value as FolderTrustRecord).decidedAt === "number"
  && typeof (value as FolderTrustRecord).folder === "string";

/** The durable record, one JSON file in the data dir (`folder-trust.json`).
 * Damaged state is a recovery error like bots.json, never silently reset:
 * a reset would re-ask the human questions they already answered. */
export class FolderTrustStore {
  private folders = new Map<string, FolderTrustRecord>();
  private readonly file: string;
  private seededFrom: string | undefined;

  constructor(file: string) {
    this.file = file;
    const parsed = readPersistedJson(file);
    if (parsed === undefined) return;
    const raw = parsed as Partial<PersistedFolderTrust> | null;
    if (raw && typeof raw === "object" && typeof raw.seededFrom === "string") this.seededFrom = raw.seededFrom;
    const folders = raw && typeof raw === "object" && raw.folders && typeof raw.folders === "object" ? raw.folders : null;
    if (!folders) return;
    for (const [key, record] of Object.entries(folders)) if (isRecord(record)) this.folders.set(key, record);
  }

  /** 0.1.52 FUIGOTRUST2 upgrade seed: folders bots, tasks and rooms were
   * already working in when this record first appeared were chosen by the
   * person in Murage before it existed, so they are recorded as trusted
   * ONCE — on the first boot that finds no `seededFrom` marker — and never
   * again: a later Forget (or a card's Don't trust) is not overridden by the
   * next boot, and a folder that already has a record keeps it. Returns how
   * many folders were recorded; -1 when the seed had already run. The
   * marker is written even when nothing was recorded. */
  seedOnce(folders: Iterable<string>, release: string): number {
    if (this.seededFrom) return -1;
    let count = 0;
    const now = Date.now();
    for (const folder of folders) {
      const key = folderTrustKey(folder);
      if (isUnrecordableTrustRoot(key) || this.folders.has(key)) continue;
      this.folders.set(key, { decision: "trust", decidedAt: now, source: "upgrade", folder: canonicalFolder(folder) });
      count++;
    }
    this.seededFrom = release;
    this.persist();
    return count;
  }

  /** The release the upgrade seed ran for, if it has. */
  get seeded(): string | undefined {
    return this.seededFrom;
  }

  /** The keys a lookup consults, most specific first: the engine's key for
   * the turn (with its registry, FUIGOTRUST4) and the folder's own git key.
   * A picker records the folder by its own key (it knows no turn); a card on
   * a native turn records the engine's. Both must answer the next turn, so a
   * managed worktree is not asked again about a source repo the person
   * already decided on — in either place. */
  private keysFor(folder: string, options: FolderTrustKeyOptions): string[] {
    const own = folderTrustKey(folder);
    const engine = options.fuigoHome ? folderTrustKey(folder, options) : own;
    return engine === own ? [own] : [engine, own];
  }

  /** The recorded decision for the folder's trust key, if any. */
  decision(folder: string, options: FolderTrustKeyOptions = {}): FolderTrustDecision | undefined {
    return this.record(folder, options)?.decision;
  }

  record(folder: string, options: FolderTrustKeyOptions = {}): FolderTrustRecord | undefined {
    for (const key of this.keysFor(folder, options)) {
      const record = this.folders.get(key);
      if (record) return record;
    }
    return undefined;
  }

  /** Remember a decision for the folder's whole workspace (its trust key —
   * the engine's, when the turn's Fuigo home is known). Unrecordable roots
   * (home, a filesystem root) are never written: Fuigo never gates them, so
   * a record would only mislead. Returns the key. */
  remember(folder: string, decision: FolderTrustDecision, source: FolderTrustSource, options: FolderTrustKeyOptions & { key?: string } = {}): string | null {
    // a card answers for the key it asked about (the engine's key for that
    // turn, carried by the question), which may no longer be derivable once
    // the turn's home is gone
    const key = options.key ?? folderTrustKey(folder, options);
    if (isUnrecordableTrustRoot(key)) return null;
    this.folders.set(key, { decision, decidedAt: Date.now(), source, folder: canonicalFolder(folder) });
    this.persist();
    return key;
  }

  /** Forget every record a lookup for the folder would find. */
  forget(folder: string, options: FolderTrustKeyOptions = {}): boolean {
    let removed = false;
    for (const key of this.keysFor(folder, options)) removed = this.folders.delete(key) || removed;
    if (removed) this.persist();
    return removed;
  }

  /** Every record, for the settings surface: key → record. */
  list(): Array<{ key: string } & FolderTrustRecord> {
    return [...this.folders].map(([key, record]) => ({ key, ...record })).sort((a, b) => b.decidedAt - a.decidedAt);
  }

  private persist(): void {
    const data: PersistedFolderTrust = { version: 1, folders: Object.fromEntries(this.folders), ...(this.seededFrom ? { seededFrom: this.seededFrom } : {}) };
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
