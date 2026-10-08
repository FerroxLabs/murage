// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { createPrivateWindowsDirectory, writePrivateWindowsData } from "../../electron/browser-extension-windows.mjs";

/** A private folder for browser state, made the way the product makes its own on each platform.
 * macOS and Linux: a fresh folder at mode 0700. Windows: the native helper creates the folder with
 * its owner-only ACL (the product refuses a folder it did not make private, and a plain mkdtemp
 * inherits the temp folder's ACL). `root` is what a test removes afterwards. */
export function privateTestDirectorySync(prefix: string): { root: string; directory: string } {
  const root = fs.mkdtempSync(prefix);
  if (process.platform !== "win32") { fs.chmodSync(root, 0o700); return { root, directory: root }; }
  const directory = path.join(root, "private");
  createPrivateWindowsDirectory(directory);
  return { root, directory };
}

export async function privateTestDirectory(prefix: string): Promise<{ root: string; directory: string }> {
  return privateTestDirectorySync(prefix);
}

/** Write a file into a private folder as the product's own writer would leave it: mode 0600, or on
 * Windows through the native helper, which gives the file its owner-only ACL. */
export function writePrivateTestFile(file: string, data: string | Buffer): void {
  if (process.platform === "win32") writePrivateWindowsData(file, data);
  else fs.writeFileSync(file, data, { mode: 0o600 });
}

/** A private folder inside another, as the product's own private folders are made. */
export function makePrivateTestSubdirectory(directory: string): void {
  if (process.platform === "win32") createPrivateWindowsDirectory(directory);
  else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
