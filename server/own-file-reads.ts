// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot READING its own files never needs the person, at any level.
//
// The bug (upstream 267fa44f9): an unattended routine run stopped to ask for
// approval to `cat` the bot's own SOUL.md and its own skill files; nobody
// answered, so the run waited and failed. Here the same ask came from two
// gaps: own-workspace-approval.ts refuses SOUL.md, AGENTS.md, CLAUDE.md and
// skills/ for every file tool, reads included (its job is writes, where those
// names are what the bot IS), and a shell `cat` of the bot's own folder was
// never covered at all.
//
// This IS a permission boundary, so it is decided like the two it sits next
// to (own-workspace-approval.ts, own-tool-results.ts):
//   - the folders are the bot's own, from server/workspace.ts through
//     ownWorkspaceRoots (its workspace folder and this conversation's folder;
//     a partitioned bot's audience roots), never from the request;
//   - a file tool counts only when it is a read tool by the engine's own bare
//     name (an ACP `kind` is the agent's own word and is not enough), and
//     EVERY path it names counts: the driver's filePaths and every path
//     field of its structured input, any unreadable shape asking;
//   - a shell command counts only where a POSIX shell runs it (never
//     PowerShell, never on Windows), and must pass shared/readonly-shell.ts in full (no
//     chaining, substitution, globs, `~` or redirection) AND be made of
//     cat/head/tail/wc/grep/jq alone: never `python -c`, which imports from
//     the folder it runs in (a `sitecustomize.py` or `json.py` the bot wrote
//     into its own folder without a card would run with the read);
//   - every path the command names is checked. A relative path is placed
//     against the REAL path of the folder the engine says the command runs
//     in, which must itself be inside the bot's own folders; a word or folder
//     with a `..` or `.` segment, a drive-relative `C:name`, or a word starting
//     with `=` (zsh expands `=name` to a program's path) asks;
//   - every path must be strictly inside one of those folders by real path
//     and by segment (within), never below `credentials/`, be a plain file
//     with one name or a folder (a hard link to a file elsewhere asks), pass
//     the shared in-project check (a `.env` or a key file still asks), and no
//     root or folder above it up to the data folder may be a link;
//   - the caller passes this only for a turn the workspace owner is behind
//     (the owner at the desktop, the owner's own channel message, or one of
//     the owner's routine runs): a guest's turn, a webhook or anyone else's
//     message still asks, because the folder holds the owner's memory.
// Known limit: the paths are checked before the engine opens them; a link
// swapped in between needs a write to the folder first, which asks for
// anything outside the bookkeeping files.
// False means the approval card is raised exactly as before.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { inProjectCheck } from "../shared/in-project.ts";
import { parseReadOnlyCommand } from "../shared/readonly-shell.ts";
import { managedPathIsLinked, NOT_OWN_READ, ownWorkspaceRoots, within } from "./own-workspace-approval.ts";

/** Read-only file tools, by the engine's own bare name (Claude's Read and
 * NotebookRead, an ACP engine's read_file and friends). */
const READ_TOOLS = new Set(["read", "notebookread", "read_file", "read_text_file", "view", "view_file"]);

/** An engine's own shell tools whose command a POSIX shell runs, by their exact bare names (auto-approve.ts COMMAND_TOOLS
 * without PowerShell and the remote computer's runner). */
const POSIX_SHELL_TOOLS = new Set(["Bash", "bash", "shell", "execute", "exec_command", "run_command", "terminal"]);

/** The pipeline programs that only read the files they name. python is not one here (see above). */
const SHELL_READERS = new Set(["cat", "head", "tail", "wc", "grep", "jq"]);

export interface OwnFileReadRequest {
  dataDir: string;
  botId: string;
  threadId: string;
  /** The tool as the ENGINE named it (Bash, shell, Read, read_file). */
  tool: unknown;
  /** The shell command, from the engine's structured tool input. */
  command?: string;
  /** The folder the command runs in: the one the engine named, else the turn's. */
  cwd?: string;
  /** File paths from the engine's structured tool input. */
  filePaths?: readonly string[];
  /** The engine's structured tool input: every path field in it must pass too. */
  input?: unknown;
  /** "pwsh" when the engine runs this command under PowerShell. */
  commandShell?: unknown;
  /** For tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
}

/** Field names an engine's tool names a path under (auto-approve.ts PATH_FIELDS, plus the notebook spelling). */
const INPUT_PATH_FIELDS = ["path", "file_path", "filePath", "notebook_path", "notebookPath", "paths", "file", "files", "target", "directory", "dir"];

/** Every path a read tool's ask names: the driver's `filePaths` and every path field of its input. Undefined when a path field
 * is there but is not a plain non-empty string (or a list of them): a shape this cannot read is the one that would escape. */
function readToolPaths(request: OwnFileReadRequest): string[] | undefined {
  const paths: string[] = [];
  if (request.filePaths !== undefined) {
    if (!Array.isArray(request.filePaths)) return undefined;
    paths.push(...request.filePaths);
  }
  const input = request.input;
  if (input !== undefined && input !== null) {
    if (typeof input !== "object" || Array.isArray(input)) return undefined;
    const fields = input as Record<string, unknown>;
    for (const key of INPUT_PATH_FIELDS) {
      if (!(key in fields)) continue;
      const value = fields[key];
      const items = Array.isArray(value) ? value : [value];
      if (!items.length || items.some((item) => typeof item !== "string" || !item)) return undefined;
      paths.push(...(items as string[]));
    }
  }
  return paths.length ? paths : undefined;
}

/** A word the shell or a resolver could turn into another path. */
function unplaceable(path: string): boolean {
  return path.startsWith("=") || /^[A-Za-z]:(?![\\/])/.test(path) || path.split(/[\\/]/).some((part) => part === ".." || part === ".");
}

/** A root, or a folder above it up to the data folder, that is a link would make the real-path comparison cancel out. */
function rootLinked(root: string, dataDir: string): boolean {
  const stop = resolve(dataDir);
  let current = resolve(root);
  for (let depth = 0; depth < 8; depth++) {
    try { if (lstatSync(current).isSymbolicLink()) return true; } catch { /* a component that is not there cannot be a link */ }
    if (current === stop) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return true;
}

/** A plain file with one name, or a folder. A hard link to a file elsewhere has more than one name. */
function plainEntry(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || (stat.isFile() && stat.nlink === 1);
  } catch { return false; }
}

function ownRoots(request: OwnFileReadRequest): string[] {
  const roots = ownWorkspaceRoots(request);
  if (!roots.length || managedPathIsLinked(request.dataDir, request.botId)) return [];
  return roots.some((root) => rootLinked(root, request.dataDir)) ? [] : roots;
}

/** Every path is strictly inside one of the bot's own folders, not under credentials/, not a key file, not a hard link. */
function ownReadable(roots: readonly string[], paths: readonly string[]): boolean {
  if (!paths.length || !roots.length) return false;
  return paths.every((path) => typeof path === "string" && path !== "" && isAbsolute(path) && !unplaceable(path)
    && roots.some((root) => within(root, path, NOT_OWN_READ) && inProjectCheck(path, root).ok)
    && plainEntry(path));
}

/** The real folder a command runs in, when it is one of the bot's own folders (or one of them itself). */
function ownCwd(roots: readonly string[], cwd: string | undefined): string | undefined {
  if (!cwd || !isAbsolute(cwd) || unplaceable(cwd)) return undefined;
  let real: string;
  try { real = realpathSync.native(cwd); } catch { return undefined; }
  const inside = roots.some((root) => {
    let realRoot: string;
    try { realRoot = realpathSync.native(root); } catch { return false; }
    return real === realRoot || within(root, real, NOT_OWN_READ);
  });
  return inside ? real : undefined;
}

/** Is this permission request nothing but the bot reading its own files? */
export function isOwnFileRead(request: OwnFileReadRequest): boolean {
  if (typeof request.tool !== "string") return false;
  if (typeof request.command === "string") {
    // The parser reads POSIX shell words. PowerShell reads `\` as a separator and `a,b` as two paths, so a command it runs
    // (pwsh, or any command tool on Windows, where Codex and ACP engines use it) is never placed by them: it asks.
    // Allow-listed, never deny-listed: only an engine's own bare POSIX shell tool counts. A namespaced or dotted name
    // (mcp__x__powershell, functions.powershell), PowerShell under any name, and the remote computer's runner all ask.
    if ((request.platform ?? process.platform) === "win32" || request.commandShell === "pwsh" || !POSIX_SHELL_TOOLS.has(request.tool)) return false;
    const parsed = parseReadOnlyCommand(request.command);
    if (!parsed?.paths.length || !parsed.programs.every((program) => SHELL_READERS.has(program))) return false;
    if (parsed.paths.some((path) => unplaceable(path))) return false;
    const roots = ownRoots(request);
    const relative = parsed.paths.some((path) => !isAbsolute(path));
    const cwd = relative ? ownCwd(roots, request.cwd) : undefined;
    if (relative && !cwd) return false;
    return ownReadable(roots, parsed.paths.map((path) => (isAbsolute(path) ? path : resolve(cwd!, path))));
  }
  if (!READ_TOOLS.has(request.tool.trim().toLowerCase())) return false;
  const paths = readToolPaths(request);
  return paths !== undefined && ownReadable(ownRoots(request), paths);
}
