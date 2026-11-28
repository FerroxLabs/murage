// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixtures for the F5n source readers: a temp <home>, the real filesystem, and a counter of every open, listing and path lookup the
// anchored reader makes (the reader itself is never mocked). Neutral names only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { realImportFs, type ImportFs } from "../claude-code-import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SourceCellStore, type SourcesMap } from "./source-cells.ts";

/** A secret-shaped value built at run time (32+ mixed characters), so no key-like literal is committed. */
export const sentinel = (tag: string) => `Fx${tag}${"q7W".repeat(12)}`;

export interface CountingFs extends ImportFs { calls: string[]; onOpen?: (path: string) => void }
export function countingFs(base: ImportFs = realImportFs): CountingFs {
  const fs: CountingFs = {
    ...base,
    calls: [],
    realpathSync: (path) => { fs.calls.push(`realpath ${path}`); return base.realpathSync(path); },
    readdirSync: (path) => { fs.calls.push(`readdir ${path}`); return base.readdirSync(path); },
    openSync: (path, flags) => { fs.calls.push(`open ${path}`); fs.onOpen?.(path); return base.openSync(path, flags); },
  };
  return fs;
}
/** Opens whose path ends in one of the given names (Linux walks open one part at a time through /proc/self/fd). */
export const opensOf = (fs: CountingFs, ...names: string[]) => fs.calls.filter((call) => call.startsWith("open ") && names.some((name) => call.endsWith(`/${name}`))).length;

export function tempHome(roots: string[]): { home: string; put(relPath: string, content: string | Uint8Array): void } {
  const home = mkdtempSync(join(tmpdir(), "murage-f5n-home-"));
  roots.push(home);
  return {
    home,
    put(relPath, content) { const path = join(home, relPath); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
  };
}
export const cleanRoots = (roots: string[]) => { for (const root of roots.splice(0)) removeTempDirSync(root); };

export function memoryStore(initial: SourcesMap = {}): { store: SourceCellStore; map: () => SourcesMap; writes: number } {
  let map = initial;
  const box = { store: undefined as unknown as SourceCellStore, map: () => map, writes: 0 };
  box.store = new SourceCellStore({ read: () => map, write: (next) => { map = next; box.writes++; } });
  return box;
}
