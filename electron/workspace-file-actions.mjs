// Native open/reveal for one workspace file (0.1.52 F4-T5).
//
// The renderer never names a path on disk. It names the conversation scope
// and a relative path; the owned main process adds the desktop proof, asks
// the server to authorize that exact file (`/api/workspace-files/native`,
// same root resolution, link, hard-link and private-file policy as a read),
// and only then hands a path to the operating system.
//
// What this module adds on top of the server's answer:
//
//  1. An extension allowlist for `open`. `reveal` only selects the file in
//     the file manager and runs nothing, so it is not filtered — the same
//     split the saved-artifact action already uses.
//  2. A last-moment revalidation that closes the window between the server's
//     answer and `shell.openPath`: the path is rebuilt from the canonical
//     root (never taken from the response), every ancestor is `lstat`-ed and
//     refused if it is a link or not a directory, the file is opened
//     `O_NOFOLLOW | O_NONBLOCK`, and the identity observed through that
//     descriptor must still equal the one the server authorized.
//
// Nothing here imports Electron: main.mjs injects the window, origin, fetch,
// dialog and shell, so the node tests exercise the exact refusal order the
// app runs.
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";

import { isOwnedMainSender } from "./main-trust.mjs";

/**
 * Extensions Murage will hand to the OS "open" verb. Documents, data and
 * images only: no executable, script, shortcut, archive or installer type,
 * and nothing whose handler is chosen by the file rather than by the user.
 * Media types are here because the OS player opens them passively.
 */
export const WORKSPACE_NATIVE_OPEN_EXTENSIONS = Object.freeze([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log", ".rtf",
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".avif",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".mp4", ".webm", ".mov",
  ".html", ".htm",
]);

/** Opened by a browser, which may run scripts or reach the network. SVG
 * belongs here: it is markup, and the default handler is usually a browser. */
export const WORKSPACE_NATIVE_BROWSER_EXTENSIONS = Object.freeze([".html", ".htm", ".svg"]);

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const PATH_MAX_LENGTH = 2048;
const SEGMENT_MAX_LENGTH = 255;
const BACKSLASH = 0x5c, COLON = 0x3a, DEL = 0x7f, FIRST_PRINTABLE = 0x20;
/** Backslash, colon and control characters, exactly as
 * shared/workspace-files.ts refuses them. Written as character codes so no
 * escape can be lost to an edit. */
function hasForbiddenPathCharacter(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE || code === DEL || code === BACKSLASH || code === COLON) return true;
  }
  return false;
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Same syntax rules as `isWorkspaceRelativePath` in shared/workspace-files.ts,
 * restated here because main.mjs cannot import TypeScript. A path that fails
 * this never reaches the server, so a traversal attempt costs no request.
 */
export function isWorkspaceRelativeFilePath(value) {
  if (typeof value !== "string" || value === "" || value.length > PATH_MAX_LENGTH) return false;
  if (value.startsWith("/") || hasForbiddenPathCharacter(value)) return false;
  return value.split("/").every(part => part.length > 0 && part.length <= SEGMENT_MAX_LENGTH && !part.startsWith("."));
}

export const workspaceFileExtension = (relativePath) => path.posix.extname(relativePath).toLowerCase();

/** True when the OS "open" verb may be used on this name. */
export function isNativeOpenableWorkspaceFile(relativePath) {
  return isWorkspaceRelativeFilePath(relativePath) && WORKSPACE_NATIVE_OPEN_EXTENSIONS.includes(workspaceFileExtension(relativePath));
}

/** True when opening this name means handing it to a browser. */
export function opensInBrowser(relativePath) {
  return WORKSPACE_NATIVE_BROWSER_EXTENSIONS.includes(workspaceFileExtension(relativePath));
}

/** The server's observed-file identity, recomputed from a local stat.
 * Must stay identical to `fingerprint` in server/artifacts.ts. */
const identityOf = (stat) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);

const MOVED = "That file moved or changed. Refresh the workspace and try again.";

/**
 * Rebuild and revalidate the authorized workspace file, then return the path
 * the OS may act on.
 *
 * `record` is the `WorkspaceNativeFile` the server answered with. Its `path`
 * is deliberately never used: the path is derived from the canonical root and
 * the relative path the caller asked for, so a tampered or confused answer
 * cannot redirect the action.
 *
 * @param {unknown} record
 * @param {{ relativePath: string, scope: { botId: string, threadId: string } }} request
 * @returns {string} absolute path
 */
export function verifiedWorkspaceNativePath(record, { relativePath, scope }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw refusal("WORKSPACE_NATIVE_UNVERIFIED", MOVED);
  const { root, identity } = record;
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof identity !== "string" || !identity) {
    throw refusal("WORKSPACE_NATIVE_UNVERIFIED", MOVED);
  }
  // The answer must be about the file that was asked for, in this scope.
  if (record.relativePath !== relativePath || record.scope?.botId !== scope.botId || record.scope?.threadId !== scope.threadId) {
    throw refusal("WORKSPACE_NATIVE_UNVERIFIED", MOVED);
  }
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(root); } catch { throw refusal("WORKSPACE_NATIVE_ROOT", "This conversation's workspace is unavailable."); }
  if (canonicalRoot !== root) throw refusal("WORKSPACE_NATIVE_ROOT", "This conversation's workspace changed. Refresh the workspace and try again.");
  let rootStat;
  try { rootStat = lstatSync(root); } catch { throw refusal("WORKSPACE_NATIVE_ROOT", "This conversation's workspace is unavailable."); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw refusal("WORKSPACE_NATIVE_ROOT", "This conversation's workspace is unavailable.");

  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { throw refusal("WORKSPACE_NATIVE_MOVED", MOVED); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refusal("WORKSPACE_NATIVE_LINKED", "Files inside linked folders are not opened.");
  }
  const file = path.join(current, parts.at(-1));
  let before;
  try { before = lstatSync(file); } catch { throw refusal("WORKSPACE_NATIVE_MOVED", MOVED); }
  if (before.isSymbolicLink()) throw refusal("WORKSPACE_NATIVE_LINKED", "Linked files are not opened.");
  if (!before.isFile()) throw refusal("WORKSPACE_NATIVE_NOT_FILE", "Only ordinary files can be opened here.");
  if (before.nlink !== 1) throw refusal("WORKSPACE_NATIVE_LINKED", "Hard-linked files are not opened.");
  if (identityOf(before) !== identity) throw refusal("WORKSPACE_NATIVE_MOVED", MOVED);

  let fd;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw refusal("WORKSPACE_NATIVE_MOVED", MOVED); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || identityOf(stat) !== identity) throw refusal("WORKSPACE_NATIVE_MOVED", MOVED);
  } finally { closeSync(fd); }
  return file;
}

function assertOwnedSender(event, { window, origin }) {
  if (!isOwnedMainSender(event, { window: window(), origin: origin() })) {
    throw refusal("NATIVE_SENDER_UNTRUSTED", "Workspace files can only be opened from the Murage window.");
  }
}

/**
 * `desktop:workspace-file-action`.
 *
 * Refusal order, deliberately: sender, then request shape, then the
 * allowlist, then the server's authorization, then the browser warning, then
 * the on-disk revalidation immediately before the OS call. A refused request
 * never reaches the server and never shows a dialog.
 *
 * `open` on a cancelled browser warning resolves without acting; that is a
 * decision, not a failure.
 *
 * @param {{ window: () => unknown, origin: () => string | null | undefined,
 *   authorize: (input: {scope: {botId: string, threadId: string}, relativePath: string}) => Promise<unknown>,
 *   confirmBrowserOpen: (input: {event: unknown, relativePath: string}) => Promise<boolean>,
 *   openPath: (path: string) => Promise<string>, revealPath: (path: string) => void }} deps
 */
export function createWorkspaceFileActionHandler({ window, origin, authorize, confirmBrowserOpen, openPath, revealPath }) {
  return async (event, scope, relativePath, action) => {
    assertOwnedSender(event, { window, origin });
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length !== 2
      || typeof scope.botId !== "string" || !ID.test(scope.botId) || typeof scope.threadId !== "string" || !ID.test(scope.threadId)
      || !isWorkspaceRelativeFilePath(relativePath) || (action !== "open" && action !== "reveal")) {
      throw refusal("WORKSPACE_NATIVE_REQUEST", "This file cannot be opened from here.");
    }
    if (action === "open" && !isNativeOpenableWorkspaceFile(relativePath)) {
      throw refusal("WORKSPACE_NATIVE_TYPE", "Murage does not open this kind of file directly. Reveal it and open it yourself.");
    }
    const record = await authorize({ scope: { botId: scope.botId, threadId: scope.threadId }, relativePath });
    if (action === "open" && opensInBrowser(relativePath) && !(await confirmBrowserOpen({ event, relativePath }))) return;
    const file = verifiedWorkspaceNativePath(record, { relativePath, scope });
    if (action === "reveal") { revealPath(file); return; }
    const error = await openPath(file);
    if (error) throw refusal("WORKSPACE_NATIVE_OS", "The operating system could not open this file. Reveal it and open it yourself.");
  };
}
