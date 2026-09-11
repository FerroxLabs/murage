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
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

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
/** Code-exec and policy sources: MCP, LSP, hooks, plugins, agents, permission rules, env. */
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

/** The trust key for a folder: the canonical git root when the folder sits in
 * a repository whose root is recordable, else the canonical folder itself.
 * Mirrors upstream `workspace_key` (fuigo-workspace/src/trust.rs) minus its
 * managed-worktree source-repo collapse. */
export function folderTrustKey(folder: string): string {
  const root = gitRootOf(folder);
  if (root && !isUnrecordableTrustRoot(root)) return root;
  return canonicalFolder(folder);
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
}

/** What the folder would contribute to a Fuigo turn, by name. Cheap: a
 * bounded set of stat calls along the cwd → git-root chain, no parsing. */
export function scanFolderTrustSources(folder: string): FolderTrustScan {
  const start = canonicalFolder(folder);
  const key = folderTrustKey(start);
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
  return { key, folder: start, sources };
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

export type FolderTrustSource = "picker" | "card";

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

  constructor(file: string) {
    this.file = file;
    const parsed = readPersistedJson(file);
    if (parsed === undefined) return;
    const raw = parsed as Partial<PersistedFolderTrust> | null;
    const folders = raw && typeof raw === "object" && raw.folders && typeof raw.folders === "object" ? raw.folders : null;
    if (!folders) return;
    for (const [key, record] of Object.entries(folders)) if (isRecord(record)) this.folders.set(key, record);
  }

  /** The recorded decision for the folder's trust key, if any. */
  decision(folder: string): FolderTrustDecision | undefined {
    return this.folders.get(folderTrustKey(folder))?.decision;
  }

  record(folder: string): FolderTrustRecord | undefined {
    return this.folders.get(folderTrustKey(folder));
  }

  /** Remember a decision for the folder's whole workspace (its trust key).
   * Unrecordable roots (home, a filesystem root) are never written: Fuigo
   * never gates them, so a record would only mislead. Returns the key. */
  remember(folder: string, decision: FolderTrustDecision, source: FolderTrustSource): string | null {
    const key = folderTrustKey(folder);
    if (isUnrecordableTrustRoot(key)) return null;
    this.folders.set(key, { decision, decidedAt: Date.now(), source, folder: canonicalFolder(folder) });
    this.persist();
    return key;
  }

  forget(folder: string): boolean {
    const removed = this.folders.delete(folderTrustKey(folder));
    if (removed) this.persist();
    return removed;
  }

  /** Every record, for the settings surface: key → record. */
  list(): Array<{ key: string } & FolderTrustRecord> {
    return [...this.folders].map(([key, record]) => ({ key, ...record })).sort((a, b) => b.decidedAt - a.decidedAt);
  }

  private persist(): void {
    const data: PersistedFolderTrust = { version: 1, folders: Object.fromEntries(this.folders) };
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
