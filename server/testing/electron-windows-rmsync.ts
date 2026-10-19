// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support: makes fs.rmSync behave as the app's runtime does on Windows
// (Electron 43.7.7, Node 24.21.0), probed on Windows 11 in lane W1 on
// 2026-10-19 with a directory junction:
//   rmSync(link)                       throws ERR_FS_EISDIR "Path is a directory"
//   rmSync(link, { recursive: true })  deletes every file in the folder the link
//                                      points to, then the link
//   rmSync(folder, { recursive: true }) walks into every link inside the same way
// With it a run on any OS proves that a code path never hands a link to
// rmSync, which a plain Node run on Windows CI cannot show (murage#16).
import fs, { type PathLike, type RmOptions } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

function replace(name: "rmSync", value: unknown): void {
  const owner = fs as unknown as Record<string, unknown>;
  const existing = Object.getOwnPropertyDescriptor(owner, name);
  if (existing?.writable) owner[name] = value;
  else Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: existing?.enumerable ?? true });
  syncBuiltinESMExports();
}

const isDirectoryLink = (path: string): boolean =>
  Boolean(fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && fs.statSync(path, { throwIfNoEntry: false })?.isDirectory());

/** remove_all with a link treated as the folder it names. */
function removeFollowingLinks(path: string): void {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() || isDirectoryLink(path)) {
    for (const name of fs.readdirSync(path)) removeFollowingLinks(join(path, name));
    if (stat.isSymbolicLink()) fs.unlinkSync(path);
    else fs.rmdirSync(path);
    return;
  }
  fs.unlinkSync(path);
}

/** Installs the emulation; the returned function restores the previous rmSync. */
export function emulateElectronWindowsRmSync(): () => void {
  const previous = fs.rmSync;
  replace("rmSync", function electronWindowsRmSync(this: unknown, path: PathLike, options?: RmOptions): void {
    const named = String(path);
    if (options?.recursive && fs.lstatSync(named, { throwIfNoEntry: false })) {
      removeFollowingLinks(named);
      return;
    }
    if (isDirectoryLink(named)) {
      throw Object.assign(new Error(`Path is a directory: ${named}`), { code: "ERR_FS_EISDIR" });
    }
    return (previous as (path: PathLike, options?: RmOptions) => void).call(this, path, options);
  });
  return () => replace("rmSync", previous);
}
