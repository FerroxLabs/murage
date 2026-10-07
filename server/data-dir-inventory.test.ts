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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_EXTENSION_FILES, classifyDataDirEntry, DATA_DIR_ENTRIES, DATA_DIR_PATTERNS, DATA_DIR_RESTORABLE } from "./data-dir-inventory.ts";
import { scanDataDirWrites, unclassifiedStaticWrites } from "./testing/data-dir-guard.ts";

const ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// 1. Static scan
// ---------------------------------------------------------------------------

/** A scan hit that is not the Murage data folder: file -> joined name -> why. */
const NOT_THE_DATA_FOLDER: Record<string, Record<string, string>> = {
  "server/user-chrome.ts": { DevToolsActivePort: "Chrome's own user-data folder, read only" },
  "server/env-path.ts": { shims: "mise's own data folder (MISE_DATA_DIR), read for PATH only" },
  "server/engine-history-deletion.ts": {
    projects: "another engine's history folder (Qwen, Cursor)",
    storage: "another engine's history folder",
    "<<name>>": "another engine's history folder",
  },
  "server/memory/settings.ts": { "<<part>>": "path parts inside DATA_DIR/memory-model, checked by memoryModelPath" },
  "server/procedure-bundles.ts": { "<<part>>": "path parts inside DATA_DIR/skill-state/<bot>" },
  "server/index.ts": { "<<relative>>": "relative paths inside DATA_DIR/workspaces" },
  "electron/memory-upgrade-status.mjs": { "<<name>>": "deletes only memory-upgrade-status.json and its memory-upgrade-status.json.<pid>.tmp (both classified), matched by name before removal" },
  "server/database.ts": { "<<MEMORY_PRE_V2_SNAPSHOT>>": "messages.pre-memory-v2.db, from memory/schema.ts", "<<MEMORY_PRE_V4_SNAPSHOT>>": "messages.pre-memory-v4.db, from memory/schema.ts", "<<MEMORY_PRE_V3_SNAPSHOT>>": "messages.pre-memory-v3.db, from memory/schema.ts" },
};

describe("every top-level name Murage writes is classified for backup", () => {
  it("static scan: every name joined under the data folder in source", () => {
    const stale: string[] = [];
    const hits = scanDataDirWrites();
    const unknown = unclassifiedStaticWrites(hits, NOT_THE_DATA_FOLDER);
    for (const [file, names] of Object.entries(NOT_THE_DATA_FOLDER)) for (const name of Object.keys(names)) {
      if (!hits.some(hit => hit.file === file && hit.name === name)) stale.push(`${file}: ${name}`);
    }
    // Add each new name to server/data-dir-inventory.ts with its backup kind.
    expect(unknown).toEqual([]);
    expect(stale).toEqual([]);
    // The scan must keep finding the writers it was built against.
    for (const name of ["about-me.md", "decisions.ndjson", "whats-new.json", "house-rules.md", "skill-collection", "stop-line", "telegram", "whatsapp", "browser-engine-key", "queued-messages.json", "setup.json", "engine-commands.json", "announcements.json", "restored-connections.json", "connected-apps-catalog.json", "image-reference-packs"]) {
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

  it("keeps the connected-apps catalog cache out of every backup (0.1.61, plan 4.3)", () => {
    // Public app names and logo links, fetched again when stale: never
    // backed up, never restored, and it must not stop a backup either.
    expect(classifyDataDirEntry("connected-apps-catalog.json")).toMatchObject({ backup: "excluded" });
    expect(classifyDataDirEntry("connected-apps-catalog.json")?.why).toMatch(/not restored/);
    expect(DATA_DIR_RESTORABLE).not.toContain("connected-apps-catalog.json");
  });

  it("reference-pack images are owner work the restorable stage copies", () => {
    expect(scanDataDirWrites([join(ROOT, "server", "image-library.ts")])).toContainEqual({ file: "server/image-library.ts", name: "image-reference-packs" });
    expect(classifyDataDirEntry("image-reference-packs")).toMatchObject({ backup: "owner-folder" });
    expect(DATA_DIR_RESTORABLE).toContain("image-reference-packs");
  });

  it("excludes reflection scratch while preserving its durable database", () => {
    expect(classifyDataDirEntry("pip-tmp")).toMatchObject({ backup: "excluded" });
    expect(DATA_DIR_RESTORABLE).not.toContain("pip-tmp");
    expect(classifyDataDirEntry("messages.db")).toMatchObject({ backup: "database" });
  });

  it("the scan sees a name held in a constant under a DATA_DIR default parameter", () => {
    const hits = scanDataDirWrites([join(ROOT, "server", "about-me.ts")]);
    expect(hits).toContainEqual({ file: "server/about-me.ts", name: "about-me.md" });
  });

  // Murage for Chrome writes several files in one folder (plan 4.3). The
  // folder is excluded as a credential; each name inside it is listed with
  // its reason so a new extension file is looked at, not swept in unseen.
  it("every file Murage for Chrome writes in its folder is listed and left out of a backup", () => {
    expect(classifyDataDirEntry("browser-extension")).toMatchObject({ backup: "excluded", why: expect.stringContaining("Credential") });
    const found = new Set<string>();
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    for (const match of index.matchAll(/join\(\s*DATA_DIR\s*,\s*"browser-extension"\s*,\s*"([^"]+)"/g)) found.add(match[1]);
    const integration = readFileSync(join(ROOT, "server", "browser-extension-integration.ts"), "utf8");
    expect(integration).toMatch(/const directory = join\(this\.options\.dataDir, "browser-extension"\)/);
    for (const match of integration.matchAll(/join\(\s*directory\s*,\s*"([^"]+)"/g)) found.add(match[1]);
    for (const match of integration.matchAll(/join\(\s*this\.options\.dataDir\s*,\s*"browser-extension"\s*,\s*"([^"]+)"/g)) found.add(match[1]);
    expect([...found].sort()).toEqual(Object.keys(BROWSER_EXTENSION_FILES).sort());
    for (const why of Object.values(BROWSER_EXTENSION_FILES)) expect(why.length).toBeGreaterThan(20);
  });

  it("each pattern's example is a real instance of it", () => {
    for (const { pattern, example } of DATA_DIR_PATTERNS) expect(pattern.test(example), example).toBe(true);
    for (const name of Object.keys(DATA_DIR_ENTRIES)) expect(DATA_DIR_PATTERNS.some(item => item.pattern.test(name)), name).toBe(false);
  });

  it("a quarantined handoff-budget file is classified and excluded, so backups keep working", () => {
    expect(classifyDataDirEntry("coordination-roots.json.invalid-1790000000000")).toMatchObject({ backup: "excluded" });
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

it("keeps what a bot learned from prospects on this computer: learning-local is never in a backup",()=>{
 expect(classifyDataDirEntry("learning-local")).toMatchObject({backup:"excluded"});
 expect(DATA_DIR_RESTORABLE).not.toContain("learning-local");
 expect(DATA_DIR_ENTRIES["learning-local"]?.why).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio/i);
});

it("excludes the pre-v4 memory snapshot from archives",()=>{
 expect(classifyDataDirEntry("messages.pre-memory-v4.db")).toMatchObject({backup:"excluded"});
});

it("leaves the memory upgrade's note and unfinished copies out of archives",()=>{
 for(const name of["memory-upgrade-status.json","messages.pre-memory-v3.db.partial","messages.pre-memory-v4.db.partial","memory-upgrade-status.json.4242.tmp","messages.pre-memory-v3.db.partial-journal","messages.pre-memory-v3.db.partial-wal"])expect(classifyDataDirEntry(name)).toMatchObject({backup:"excluded"});
});
