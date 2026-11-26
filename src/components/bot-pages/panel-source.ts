// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: SettingsPanel.tsx only re-exports now, so source-reading tests (copy, wiring) read the whole panel
// here: the re-export file, BotPanel.tsx, then the other bot-pages files in NAME order. That is not render order:
// a test that slices between two sections or compares positions must read the one page file it means instead.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function settingsPanelSource(): string {
  const files = readdirSync(HERE).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name) && name !== "panel-source.ts" && name !== "index.ts").sort();
  // BotPanel first (the shell: header, order of parts), then the pages.
  files.sort((a, b) => (a === "BotPanel.tsx" ? -1 : b === "BotPanel.tsx" ? 1 : 0));
  return [join(HERE, "..", "SettingsPanel.tsx"), ...files.map((name) => join(HERE, name))].map((file) => readFileSync(file, "utf8")).join("\n");
}
