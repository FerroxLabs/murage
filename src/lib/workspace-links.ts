// A bot names a file it wrote relative to its working folder:
// "[the weekly report](reports/weekly.md)". The browser resolves such an href
// against the app's own origin, so as an anchor it opened a dead tab of the
// chat UI. These helpers decide what such a link is, and where it points once
// the conversation's folder is known, so the chat can offer it exactly like an
// absolute file link (Save a copy, or a player for media).
//
// Purely textual: nothing here grants access. The save bridge and the media
// resolver re-check every path they are handed.
import { isWorkspaceRelativePath } from "../../shared/workspace-files";

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** For an href with no scheme, no leading slash, no drive and no fragment or
 * query of its own: the workspace-relative path it names, "" when it names
 * something that must never be opened (climbing out with "..", a hidden file,
 * undecodable text), or null when it is not a relative link at all. */
export function relativeFileLink(href: string | undefined | null): string | null {
  if (!href || SCHEME.test(href) || /^[\\/#?]/.test(href)) return null;
  let path: string;
  try { path = decodeURIComponent(href.replace(/[?#].*$/, "")); } catch { return ""; }
  path = path.replace(/^(?:\.\/)+/, "");
  return isWorkspaceRelativePath(path) ? path : "";
}

/** `relativePath` inside `root`, spelled with the root's own separators, or
 * null when either half cannot make a path. */
export function workspaceFilePath(root: string, relativePath: string): string | null {
  if (!root || !isWorkspaceRelativePath(relativePath)) return null;
  const windows = /^[a-zA-Z]:[\\/]/.test(root) && root.includes("\\");
  const separator = windows ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return `${base}${separator}${windows ? relativePath.replace(/\//g, "\\") : relativePath}`;
}
