// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What may leave this computer as a public site. The owner approves the exact
// list this module produces, and the zip is built from the same list, so what
// they read is what goes up. Anything private is left out by name, a symlink
// stops the whole publish (it could point at a private file), and the size and
// count caps stop a folder that is not a small site.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PublishError } from "./errors.ts";

/** `data` is the snapshot: the owner approves these bytes and these bytes are uploaded. */
export interface SiteFile { rel: string; size: number; path: string; data: Buffer }
export interface SiteListing { files: SiteFile[]; skipped: string[]; bytes: number }
export interface SiteLimits { maxFiles: number; maxBytes: number; maxFileBytes: number }
export const SITE_LIMITS: SiteLimits = { maxFiles: 500, maxBytes: 50 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 };

/** Names that never go public, checked on each path segment. */
const DENY_SEGMENT = [
  /^\./,                                  // dotfiles and dot folders: .env, .git, .DS_Store, .ssh
  /^node_modules$/i,
  /^(?:memory|MEMORY)\.md$/i,             // a bot's memory
  /\.(?:env|pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^(?:secrets?|credentials?)(?:\.[a-z0-9]+)?$/i,
];
export const isPrivateName = (segment: string): boolean => DENY_SEGMENT.some(pattern => pattern.test(segment));

const mb = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The site folder inside the bot's workspace, or a refusal. The folder must be a
 * relative path that stays inside the workspace after symlinks are resolved. */
export function resolveSiteFolder(workspace: string, folder: string): string {
  const outside = () => new PublishError("outside", "The site folder has to be a folder inside this bot's own files. Put the site in a folder such as \"site\" and try again.");
  if (typeof folder !== "string" || !folder.trim() || folder.includes("\0") || folder.includes("\\") || isAbsolute(folder) || /^[A-Za-z]:/.test(folder)) throw outside();
  const base = realpathSync(workspace);
  const target = resolve(base, folder.trim());
  if (target !== base && !target.startsWith(base + sep)) throw outside();
  if (target === base) throw outside();
  // The deny list covers the folders on the way in too: ".private/site" or "node_modules/x" is not a public site.
  if (target.slice(base.length + 1).split(sep).some(isPrivateName)) throw new PublishError("outside", "That folder is private (its path has a hidden or protected name), so it cannot be published. Put the site in a plain folder such as \"site\".");
  let real: string;
  try { real = realpathSync(target); } catch { return target; }  // a missing folder is reported by listSite
  if (!real.startsWith(base + sep)) throw outside();
  return target;
}

/** Read one regular file through its own handle: no symlink at the end, not hard-linked
 * to anything else, and still inside the site folder once its real path is resolved. */
function snapshot(path: string, rel: string, root: string): Buffer {
  const changed = () => new PublishError("changed", `"${rel}" changed while I was getting it ready. Nothing was published; try again.`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw changed(); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw changed();
    if (info.nlink > 1) throw new PublishError("symlink", `"${rel}" is linked to another file on this computer, and that file could be private. Make a plain copy of it and try again.`);
    let real: string;
    try { real = realpathSync(path); } catch { throw changed(); }
    if (!real.startsWith(root + sep)) throw new PublishError("symlink", `"${rel}" leads outside the site folder. Replace it with the real file and try again.`);
    const data = readFileSync(fd);
    if (data.length !== info.size) throw changed();
    return data;
  } finally { closeSync(fd); }
}

export function listSite(dir: string, limits: SiteLimits = SITE_LIMITS): SiteListing {
  let root;
  try { root = lstatSync(dir); } catch { throw new PublishError("no-folder", "I could not find the site folder. Make the site first, then publish it."); }
  if (root.isSymbolicLink()) throw new PublishError("symlink", "The site folder is a shortcut (symlink). Put the real files in a normal folder.");
  if (!root.isDirectory()) throw new PublishError("no-folder", "The site folder is not a folder.");
  const realRoot = realpathSync(dir);
  const found: { rel: string; size: number; path: string }[] = [], skipped: string[] = [];
  // Pass 1: names, kinds and sizes only. Caps are enforced here, before any file is read.
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), rel = prefix ? `${prefix}/${name}` : name;
      if (isPrivateName(name)) { skipped.push(rel); continue; }
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new PublishError("symlink", `"${rel}" is a shortcut (symlink), and a shortcut could point at a private file. Replace it with the real file and try again.`);
      if (info.isDirectory()) { walk(path, rel); continue; }
      if (!info.isFile()) throw new PublishError("not-a-file", `"${rel}" is not a regular file. Remove it and try again.`);
      found.push({ rel, size: info.size, path });
      if (found.length > limits.maxFiles) throw new PublishError("too-many-files", `This folder has more than ${limits.maxFiles} files, which is more than a small site needs. Trim it to ${limits.maxFiles} or fewer.`);
    }
  };
  walk(dir, "");
  if (!found.some(file => file.rel === "index.html")) throw new PublishError("no-index", "The site needs an index.html at the top of its folder. That is the page people see first.");
  const bytes = found.reduce((sum, file) => sum + file.size, 0);
  const biggest = [...found].sort((a, b) => b.size - a.size || a.rel.localeCompare(b.rel)).slice(0, 5);
  const list = biggest.map(file => `${file.rel} (${mb(file.size)})`).join(", ");
  if (biggest[0] && biggest[0].size > limits.maxFileBytes) throw new PublishError("too-large", `"${biggest[0].rel}" is ${mb(biggest[0].size)}, over the ${mb(limits.maxFileBytes)} limit for one file. The biggest files are: ${list}. Make them smaller or remove them.`);
  if (bytes > limits.maxBytes) throw new PublishError("too-large", `The site is ${mb(bytes)}, over the ${mb(limits.maxBytes)} limit. The biggest files are: ${list}. Make them smaller or remove them.`);
  // Pass 2: the snapshot. The owner approves these bytes and these bytes are uploaded.
  const files: SiteFile[] = found.map(file => ({ ...file, data: snapshot(file.path, file.rel, realRoot) }));
  return { files, skipped, bytes };
}
