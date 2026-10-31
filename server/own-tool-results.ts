// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot reading back its OWN saved tool result is not an action to approve.
//
// The bug (1.0.1, seen on camera): an engine that cuts a large tool result
// saves the whole result to a file in its session folder and tells the model
// to query it. Fuigo writes `<FUIGO_HOME>/sessions/<folder key>/<session>/mcp/
// call_00_<id>.json` and says "use `jq` or `python` on the saved file"; Claude
// Code writes `<config>/projects/<folder key>/<session>/tool-results/`. The
// model then runs `cat …/call_00_….json | python3 -c …`, and in Ask mode that
// raised an approval card showing the raw shell line. Nobody can decide
// anything useful on that card: the bot is reading what it was just given.
//
// This IS a permission boundary, so it is decided like one:
//   - the folders come from the DRIVER (the engine home it started and the
//     session id the engine gave it), never from the model's text, and name
//     only this turn's own session: another conversation's results, another
//     bot's, or any other folder of the engine still ask;
//   - a shell command counts only where a POSIX shell runs it: an engine's
//     own bare POSIX shell tool, never on Windows, never PowerShell (its `\`
//     and `,` would name other paths than the ones parsed here);
//   - it must pass shared/readonly-shell.ts in full (allow-listed options, no
//     chaining, substitution, globs or redirection bar `2>/dev/null`) AND be
//     made of cat/head/tail/wc/grep/jq alone. Never `python -c`, however
//     safe its script: CPython puts the folder it runs in first on sys.path,
//     and the bot can write a `json.py` there without a card, so the module
//     that runs is not the script that was checked (1.0.11 OWN-TOOL-RESULTS,
//     GrokBuild). A python read raises the card;
//   - EVERY path the command reads is a literal word of cat/head/tail/wc/
//     grep/jq and must be strictly inside one of those folders, compared the
//     way own-workspace-approval.ts compares a bot's own folders (real paths,
//     by segment, `..` refused, links seen);
//   - a file tool counts only when it is a read tool by the engine's own name
//     or ACP kind, with every path it names inside those folders.
// False means the approval card is raised exactly as before.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseReadOnlyCommand } from "../shared/readonly-shell.ts";
import { claudeProjectKey, fuigoSessionKey } from "./engine-keys.ts";
import { within } from "./own-workspace-approval.ts";

/** A session id an engine could have made a folder for: no separators, no dots-only names. */
function plainSegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/** The folder a session was started in, as given and as its real path: an
 * engine may key its session folder by either. */
export function sessionFolders(cwd: string | undefined): string[] {
  if (!cwd) return [];
  let real: string | undefined;
  try { real = realpathSync.native(cwd); } catch { real = undefined; }
  return [...new Set([cwd, ...(real ? [real] : [])])];
}

/** Fuigo and Grok: `<home>/sessions/<folder key>/<session id>/mcp`, the
 * folder `truncate_mcp_text` saves a cut MCP result into
 * (fuigo-tools util/mcp_truncate.rs, session_dir in fuigo-shared). Both the
 * folder as given and its real path are named, because the engine keys the
 * session by the folder it was started in. */
export function fuigoToolResultDirs(home: string | undefined, cwds: readonly string[], sessionId: unknown): string[] {
  if (!home || !plainSegment(sessionId)) return [];
  const keys = [...new Set(cwds.filter(Boolean).map((cwd) => fuigoSessionKey(cwd)))];
  return keys.map((key) => join(home, "sessions", key, sessionId, "mcp"));
}

/** Claude Code: `<config dir>/projects/<folder key>/<session id>/tool-results`.
 * Only the exact key: past 200 characters Claude cuts the key and adds a hash
 * this cannot recompute, and such a folder simply keeps asking. */
export function claudeToolResultDirs(configDir: string | undefined, cwds: readonly string[], sessionId: unknown): string[] {
  if (!configDir || !plainSegment(sessionId)) return [];
  const keys = [...new Set(cwds.filter(Boolean).flatMap((cwd) => {
    const key = claudeProjectKey(cwd);
    return "exact" in key ? [key.exact] : [];
  }))];
  return keys.map((key) => join(configDir, "projects", key, sessionId, "tool-results"));
}

/** An engine's own shell tools whose command a POSIX shell runs, by their exact bare names (auto-approve.ts COMMAND_TOOLS
 * without PowerShell and the remote computer's runner; the same list as own-file-reads.ts). */
const POSIX_SHELL_TOOLS = new Set(["Bash", "bash", "shell", "execute", "exec_command", "run_command", "terminal"]);

/** The pipeline programs that only read the files they name. python is not one (see above). */
const SHELL_READERS = new Set(["cat", "head", "tail", "wc", "grep", "jq"]);

/** Read-only file tools, by the engine's own bare name or ACP kind. */
const READ_TOOLS = new Set(["read", "read_file", "read_text_file", "view", "view_file"]);

export interface OwnToolResultRequest {
  /** The tool as the ENGINE named it (Bash, shell, Read, read). */
  tool: unknown;
  /** The command, from the engine's structured tool input. */
  command?: string;
  /** File paths from the engine's structured tool input. */
  filePaths?: readonly string[];
  /** This turn's own result folders, from the driver. */
  dirs?: readonly string[];
  /** "pwsh" when the engine runs this command under PowerShell. */
  commandShell?: unknown;
  /** For tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
}

/** A link at or above a result folder cancels out of the real-path
 * comparison (both sides resolve through it), so `mcp -> /` would make every
 * file on the disk "inside". The folder and the three above it (session,
 * folder key, `sessions`/`projects`) must be real folders. */
function linked(dir: string): boolean {
  let current = dir;
  for (let depth = 0; depth < 4; depth++) {
    try { if (lstatSync(current).isSymbolicLink()) return true; }
    catch { /* a component that is not there cannot be a link */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function insideOwn(dirs: readonly string[], path: string): boolean {
  return dirs.some((dir) => !linked(dir) && within(dir, path, false));
}

/** Is this permission request nothing but the bot reading its own saved tool results? */
export function isOwnToolResultRead(request: OwnToolResultRequest): boolean {
  const dirs = Array.isArray(request.dirs) ? request.dirs.filter((dir) => typeof dir === "string" && dir) : [];
  if (!dirs.length || typeof request.tool !== "string") return false;
  const tool = request.tool.trim();
  if (typeof request.command === "string") {
    // Allow-listed, never deny-listed: only an engine's own bare POSIX shell tool off Windows. A namespaced or dotted
    // name, PowerShell under any name or marker, and any command tool on Windows ask.
    if ((request.platform ?? process.platform) === "win32" || request.commandShell === "pwsh" || !POSIX_SHELL_TOOLS.has(request.tool)) return false;
    const parsed = parseReadOnlyCommand(request.command);
    if (!parsed?.paths.length || !parsed.programs.every((program) => SHELL_READERS.has(program))) return false;
    return parsed.paths.every((path) => insideOwn(dirs, path));
  }
  if (!READ_TOOLS.has(tool.toLowerCase())) return false;
  const paths = request.filePaths;
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && insideOwn(dirs, path));
}
