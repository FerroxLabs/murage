// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fails when Murage writes a top-level data-folder name the backup does not
// classify. On the packaged 0.1.60 final draft, saving Settings > About me
// wrote DATA_DIR/about-me.md, which no backup list knew, and from then on
// every backup stopped with BACKUP_UNCLASSIFIED_COMPONENT and paused itself
// (Mac customer re-test 2, 2026-09-26). The same had already happened with
// setup.json, queued-messages.json, What's New and House Rules, one release
// at a time, because the lists were kept by hand.
//
// Two nets, because neither alone catches everything:
//  1. A static scan of every server, electron and shared source file for a
//     path joined directly under the data folder, including names held in a
//     constant and folders reached through a parameter that defaults to
//     DATA_DIR. It sees code paths no test runs.
//  2. A real server on a throwaway data folder, driven through the owner's
//     features, with every file it creates at the root recorded as it
//     happens (so a temp file that is renamed away still counts), then a
//     real backup inventory of that folder. It sees names built at runtime.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyDataDirEntry, DATA_DIR_ENTRIES, DATA_DIR_PATTERNS, DATA_DIR_RESTORABLE } from "./data-dir-inventory.ts";

const ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// 1. Static scan
// ---------------------------------------------------------------------------

/** Identifiers that name Murage's data folder itself. */
const DATA_ROOTS = new Set(["DATA_DIR", "dataDir", "this.dataDir", "deps.dataDir", "options.dataDir", "opts.dataDir", "config.dataDir", "this.options.dataDir", "input.dataDir", "args.dataDir", "desktopDataDir"]);

/** A scan hit that is not the Murage data folder: file -> joined name -> why. */
const NOT_THE_DATA_FOLDER: Record<string, Record<string, string>> = {
  "server/user-chrome.ts": { DevToolsActivePort: "Chrome's own user-data folder, read only" },
  "server/engine-history-deletion.ts": {
    projects: "another engine's history folder (Qwen, Cursor)",
    storage: "another engine's history folder",
    "<<name>>": "another engine's history folder",
  },
  "server/memory/settings.ts": { "<<part>>": "path parts inside DATA_DIR/memory-model, checked by memoryModelPath" },
  "server/procedure-bundles.ts": { "<<part>>": "path parts inside DATA_DIR/skill-state/<bot>" },
  "server/index.ts": { "<<relative>>": "relative paths inside DATA_DIR/workspaces" },
  "server/database.ts": { "<<MEMORY_PRE_V2_SNAPSHOT>>": "messages.pre-memory-v2.db, from memory/schema.ts" },
};

type Hit = { file: string; name: string };
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "vendor" || name === "testing" || name.startsWith("dist")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts|mjs|cjs|js)$/.test(name) && !/\.(?:test|node-test|spec|fixture)\.|\.d\.m?ts$/.test(name)) files.push(path);
    }
  };
  // companion/ keeps its own folder (~/.murage-companion, companion/src/state.ts).
  for (const dir of ["server", "electron", "shared"]) walk(join(ROOT, dir));
  return files;
}

/** Top-level names joined under the data folder, as written in the source. */
export function scanDataDirWrites(files = sourceFiles()): Hit[] {
  const hits: Hit[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const file = relative(ROOT, path).split("\\").join("/");
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*(["'`])([^"'`\n]*)\2/g)) constants.set(match[1], match[3]);
    const roots = new Set(DATA_ROOTS);
    // A parameter or field that defaults to the data folder is the data folder.
    for (const match of source.matchAll(/([A-Za-z_$][\w$.]*)\s*(?::\s*string)?\s*(?:=|\?\?=?)\s*DATA_DIR\b/g)) roots.add(match[1]);
    for (const match of source.matchAll(/([A-Za-z_$][\w$.]*)\s*\?\?\s*DATA_DIR\b/g)) roots.add(match[1]);
    if (/\bDATA_DIR\b/.test(source)) { roots.add("this.dir"); roots.add("this.root"); }
    for (const match of source.matchAll(/\b(?:join|resolve)\(\s*([\w$.]+)\s*,\s*(?:(["'`])([^"'`\n]*)\2|([A-Za-z_$][\w$]*)\s*[,)])/g)) {
      if (!roots.has(match[1])) continue;
      const literal = match[3] ?? constants.get(match[4]) ?? `<<${match[4]}>>`;
      hits.push({ file, name: literal.split("/")[0] });
    }
  }
  return hits;
}

/** A concrete name for a hit whose source has a variable part. */
function sample(name: string): string {
  if (name.endsWith("-") && name.startsWith(".")) return `${name}a1B2c3`; // mkdtemp prefix
  return name.replace(/\$\{[^}]*\}/g, "x1");
}

describe("every top-level name Murage writes is classified for backup", () => {
  it("static scan: every name joined under the data folder in source", () => {
    const unknown: string[] = [];
    const stale: string[] = [];
    const hits = scanDataDirWrites();
    for (const { file, name } of hits) {
      if (NOT_THE_DATA_FOLDER[file]?.[name]) continue;
      if (name.startsWith("<<")) { unknown.push(`${file}: a name built from ${name.slice(2, -2)}; classify it or explain it in NOT_THE_DATA_FOLDER`); continue; }
      if (!classifyDataDirEntry(sample(name))) unknown.push(`${file}: ${name}`);
    }
    for (const [file, names] of Object.entries(NOT_THE_DATA_FOLDER)) for (const name of Object.keys(names)) {
      if (!hits.some(hit => hit.file === file && hit.name === name)) stale.push(`${file}: ${name}`);
    }
    // Add each new name to server/data-dir-inventory.ts with its backup kind.
    expect(unknown).toEqual([]);
    expect(stale).toEqual([]);
    // The scan must keep finding the writers it was built against.
    for (const name of ["about-me.md", "decisions.ndjson", "whats-new.json", "house-rules.md", "skill-collection", "stop-line", "telegram", "browser-engine-key", "queued-messages.json", "setup.json", "engine-commands.json", "announcements.json", "restored-connections.json"]) {
      expect(hits.map(hit => hit.name)).toContain(name);
    }
  });

  // 0.1.60 audit A-07: the desktop writes `${file}.${process.pid}.tmp` and
  // renames it; the static scan above cannot see a name built from a
  // variable. Every such temp name in electron/ is listed here with the file
  // it stands for, so a new one fails this test until it is classified.
  it("every desktop temp-and-rename leftover in the data folder is classified", () => {
    const DESKTOP_TEMP_FILES: Record<string, string | null> = {
      configPath: "config.json", preferenceFile: "startup-background.json",
      // In Electron's userData, not the data folder.
      file: null, CREDENTIALS_FILE: null,
    };
    const found = new Set<string>();
    for (const name of readdirSync(join(ROOT, "electron"))) {
      if (!/\.(?:mjs|cjs|js)$/.test(name) || /node-test|\.test\./.test(name)) continue;
      const source = readFileSync(join(ROOT, "electron", name), "utf8");
      for (const match of source.matchAll(/`\$\{([\w$.]+)\}\.\$\{process\.pid\}\.tmp`/g)) found.add(match[1]);
    }
    expect([...found].filter(variable => !Object.hasOwn(DESKTOP_TEMP_FILES, variable))).toEqual([]);
    for (const [variable, file] of Object.entries(DESKTOP_TEMP_FILES)) {
      expect(found.has(variable), `${variable} is no longer written; remove it here`).toBe(true);
      if (file) expect(classifyDataDirEntry(`${file}.48213.tmp`), `${file}.<pid>.tmp`).toMatchObject({ backup: "excluded" });
    }
  });

  it("the scan sees a name held in a constant under a DATA_DIR default parameter", () => {
    const hits = scanDataDirWrites([join(ROOT, "server", "about-me.ts")]);
    expect(hits).toContainEqual({ file: "server/about-me.ts", name: "about-me.md" });
  });

  it("each pattern's example is a real instance of it", () => {
    for (const { pattern, example } of DATA_DIR_PATTERNS) expect(pattern.test(example), example).toBe(true);
    for (const name of Object.keys(DATA_DIR_ENTRIES)) expect(DATA_DIR_PATTERNS.some(item => item.pattern.test(name)), name).toBe(false);
  });

  it("a refused name carries its stop code", () => {
    for (const [name, entry] of Object.entries(DATA_DIR_ENTRIES)) if (entry.backup === "refused") expect(entry.code, name).toMatch(/^[A-Z_]+$/);
  });

  it("the Windows recovery capture copies every restorable name", () => {
    const cpp = readFileSync(join(ROOT, "native", "recovery-snapshot", "capture.cpp"), "utf8");
    const list = cpp.match(/bool selected\(const std::wstring& name\) \{\s*static const std::array names = \{([^}]*)\}/)?.[1];
    expect(list).toBeDefined();
    const names = [...list!.matchAll(/L"([^"]+)"/g)].map(match => match[1]);
    expect(DATA_DIR_RESTORABLE.filter(name => !names.includes(name))).toEqual([]);
  });
});
