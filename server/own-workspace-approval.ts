// 0.1.57 D57 — a bot writing inside its OWN managed directories is
// bookkeeping, not an action taken on the person's behalf.
//
// The bug (0.1.56 Mac customer test, M2): one question to Business Planner in
// Ask mode raised three approval cards — a tool call, then "Edit
// …/workspaces/<id>/MEMORY.md", then "Edit …/threads/<id>/…". Worse, a
// routine's "Run now" sat at "Waiting for you…" with a pending approval until
// two file edits to the bot's OWN thread files and MEMORY.md were allowed. An
// 8 am routine would have waited for the owner to wake up.
//
// Murage creates those folders, tells the bot exactly where they are (the
// memory block in server/workspace.ts quotes the absolute MEMORY.md path into
// every system prompt) and shows them back in Memory and Files. Asking the
// owner to authorize a write there is asking them to authorize the product's
// own filing. A write ANYWHERE else is unchanged and still asks.
//
// This IS a permission boundary, so it is decided like one:
//   - the paths come from the engine's STRUCTURED tool input, never from the
//     card's display text — that text is composed from model output, and a
//     boundary that can be talked into opening is not a boundary;
//   - the tools are an allow-list of the engine's own file tools, so a tool
//     that takes a `path` AND does something else with it (a shell, a
//     fetcher, an MCP upload named `write`) can never reach this;
//   - `..` and `.` refuse outright instead of being resolved;
//   - both sides are canonicalized with `artifactWorkspaceIdentity`, the same
//     realpath-based identity artifacts.ts and workspace-files.ts authorize
//     workspace roots with, so a symlink out of the managed area is seen;
//   - the comparison is by path SEGMENT, never a string prefix, so
//     `…/workspaces/abc-evil` is not inside `…/workspaces/abc`;
//   - segments compare exactly. Folding case could only ever widen this, and
//     nothing needs it: the bot is handed the exact path it should use.
// Every unreadable, unusual or unrecognized shape answers false, and false
// means the card is raised exactly as it is today.
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { artifactWorkspaceIdentity } from "./artifacts.ts";
import { botWorkspacePath, taskWorkspacePath } from "./workspace.ts";

/** Argument names an engine uses for "the file this call acts on", read only
 * at the top level of the tool's input. Nothing nested is read: an
 * `old_string`, a `content` or a shell `command` is text the model wrote. */
const FILE_PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"] as const;

/** The file paths a permission request names, from the engine's structured
 * tool input. `undefined` means "this request names no file path this can
 * read", which every caller must treat as "ask", never as "allow". */
export function toolFilePaths(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of FILE_PATH_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    // A key that is there but is not a plain non-empty string — an array of
    // paths, a nested object, null — is a shape this does not understand, and
    // the path it could not read is precisely the one that would escape.
    if (typeof value !== "string" || !value) return undefined;
    paths.push(value);
  }
  return paths.length ? paths : undefined;
}

/** Tools whose entire job is one named file. An exemption keyed on a path
 * argument must not be reachable by a tool that also does something ELSE with
 * that path, so this is an allow-list of the engine's own file tools rather
 * than "any tool with a `path`". */
const OWN_FILE_TOOLS = new Set([
  "read", "write", "edit", "multiedit", "notebookedit",
  "read_file", "write_file", "edit_file", "create_file", "read_text_file", "write_text_file",
]);

/** An engine's own file tools are bare names. Anything namespaced — `mcp__…`,
 * `fs/write_text_file`, `functions.write` — belongs to a server that may call
 * its upload `write`, and is never one of these. */
export function isOwnWorkspaceFileTool(tool: unknown): boolean {
  if (typeof tool !== "string") return false;
  const name = tool.trim().toLowerCase();
  if (!/^[a-z_]+$/.test(name)) return false;
  return OWN_FILE_TOOLS.has(name);
}

/** Inside the bot's own folder, but not bookkeeping: the material that
 * decides what the bot IS and what it can reach. `memory/` and `MEMORY.md`
 * are exactly the bookkeeping this exists for, so they are deliberately not
 * here. The vocabulary is artifacts.ts's private workspace names. */
const NOT_BOOKKEEPING = /^(credentials|skills|SOUL\.md|AGENTS\.md|CLAUDE\.md)$/i;

/** Split on BOTH separators. A Windows spelling reaching a POSIX process (or
 * the reverse) must not hide a `..` from the scan below simply because
 * `node:path` picked one separator for this platform. */
const SEPARATOR = /[\\/]/;
const segmentsOf = (path: string): string[] => path.split(SEPARATOR);

function identityOf(path: string): string | undefined {
  try { return artifactWorkspaceIdentity(path); } catch { return undefined; }
}

/** Is `candidate` a file strictly inside `rootPath`? */
function within(rootPath: string, candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate || !isAbsolute(candidate)) return false;
  // `..` and `.` refuse outright rather than being resolved. Every resolver
  // available here collapses them LEXICALLY, before any symlink in the chain
  // is followed, so `threads/<id>/../../x` can name a folder outside the
  // managed area while still looking as though it is inside it. Nothing
  // Murage asks a bot to write has a `..` in it: refusing costs nothing.
  if (segmentsOf(candidate).some(part => part === ".." || part === ".")) return false;
  const root = identityOf(rootPath), target = identityOf(candidate);
  if (root === undefined || target === undefined) return false;
  const rootParts = segmentsOf(root), targetParts = segmentsOf(target);
  // Strictly inside: the folder itself is not a file anything writes, and a
  // sibling whose name merely STARTS with the root's is a different folder —
  // which is why this compares segments and never a string prefix.
  if (targetParts.length <= rootParts.length) return false;
  if (!rootParts.every((part, index) => part === targetParts[index])) return false;
  return !targetParts.slice(rootParts.length).some(part => NOT_BOOKKEEPING.test(part));
}

/** A symlink BELOW a root is caught by the comparison above: the real path
 * lands outside and the segments stop matching. A symlink AT or ABOVE a root
 * cancels out, because both sides resolve through it — `workspaces/<bot>`
 * pointing at `/` would make every path on the disk "the bot's own folder".
 * Those components are checked directly, the same way server/memory/import.ts
 * refuses an import through a linked workspace. */
function managedPathIsLinked(dataDir: string, botId: string): boolean {
  let components: string[];
  try { components = [dataDir, join(dataDir, "workspaces"), botWorkspacePath(dataDir, botId)]; }
  catch { return true; }
  for (const path of components) {
    try { if (lstatSync(path).isSymbolicLink()) return true; }
    catch { /* a component that is not there cannot be a link */ }
  }
  return false;
}

export interface OwnWorkspaceScope {
  dataDir: string;
  botId: string;
  threadId: string;
}

/** The directories Murage manages FOR THIS BOT: its own workspace folder and,
 * inside it, this conversation's own thread folder. Both come from
 * server/workspace.ts — the single derivation dispatch, Files and workspace
 * discovery already use, including its gate on the ids. Empty when either id
 * is not one this installation could have created a folder for.
 *
 * The thread folder is a child of the workspace folder, so the first root
 * already decides. It is named anyway: it is half of what this covers, and a
 * later change that narrows the first must not silently drop the second. */
export function ownWorkspaceRoots(scope: OwnWorkspaceScope): string[] {
  try {
    return [botWorkspacePath(scope.dataDir, scope.botId), taskWorkspacePath(scope.dataDir, scope.botId, scope.threadId)];
  } catch { return []; }
}

export interface OwnWorkspaceRequest extends OwnWorkspaceScope {
  /** The tool as the ENGINE named it — never model prose. */
  tool: unknown;
  /** Absolute paths from the engine's structured tool input (`toolFilePaths`). */
  paths?: readonly string[] | undefined;
}

/** Is this permission request nothing but the bot's own bookkeeping?
 *
 * True only when the tool is one of the engine's own file tools, the request
 * names at least one file path, and EVERY path it names resolves strictly
 * inside the directories Murage manages for this bot. Anything else — a path
 * it could not read, one path of two outside, another bot's folder, a link
 * out, a `..`, a different spelling — is false, and false means the approval
 * card is raised exactly as it is today. */
export function isOwnWorkspaceBookkeeping(request: OwnWorkspaceRequest): boolean {
  if (!isOwnWorkspaceFileTool(request.tool)) return false;
  const paths = request.paths;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  const roots = ownWorkspaceRoots(request);
  if (!roots.length) return false;
  if (managedPathIsLinked(request.dataDir, request.botId)) return false;
  return paths.every(path => roots.some(root => within(root, path)));
}
