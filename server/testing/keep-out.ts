// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Makes a file or folder unusable to the deletion the way each system really can. macOS and Linux: its permissions are taken away
// (chmod). Windows, where a folder's mode bits change nothing: every file under it is held open with no sharing by the native addon,
// which is what another program that keeps the files open does there. Returns the undo.
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadExclusionAddon } from "../engine-exclusion.ts";
import { exclOps } from "../engine-fs.ts";
import type { HeldFile } from "../engine-plan-core.ts";

export function keepOut(path: string, mode: number): () => void {
  if (process.platform !== "win32") {
    const folder = lstatSync(path).isDirectory();
    chmodSync(path, mode);
    return () => chmodSync(path, folder ? 0o755 : 0o644);
  }
  if (!loadExclusionAddon()?.openFile) throw new Error("the native addon is needed to keep a file in use on Windows");
  const held: HeldFile[] = [];
  const visit = (at: string): void => {
    if (lstatSync(at).isDirectory()) { for (const name of readdirSync(at)) visit(join(at, name)); return; }
    const handle = exclOps.openFile(at, "exclusive");
    if (!handle) throw new Error(`${at} is already in use`);
    held.push(handle);
  };
  visit(path);
  return () => { for (const handle of held.splice(0)) handle.close(); };
}
