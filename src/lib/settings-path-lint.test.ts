// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 L1 lint: no new literal "Settings" + path separator in server/, src/, shared/ or companion/. The files
// that already spell one are listed with their count in settings-path-lint.baseline.json; a count may only go down,
// and a file not listed may have none. Each lane that moves a path onto lib/settings-links.ts lowers its entry.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countSettingsPathLiterals, settingsPathLiteralLines } from "./settings-path-lint";
import baseline from "./settings-path-lint.baseline.json";

const ROOT = path.resolve(__dirname, "../..");
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("Settings path lint (L1)", () => {
  it("catches all four separators, including the one the shipped refusal uses", () => {
    expect(countSettingsPathLiterals("Open Settings > Tools")).toBe(1);
    expect(countSettingsPathLiterals("Open Settings › Tools")).toBe(1);
    expect(countSettingsPathLiterals("enable them in Settings → Connections → Connected apps.")).toBe(1);
    expect(countSettingsPathLiterals("Settings->Tools")).toBe(1);
    expect(countSettingsPathLiterals("Settings \\u2192 Tools")).toBe(1);
    expect(countSettingsPathLiterals("Settings \\u203a Tools")).toBe(1);
    expect(countSettingsPathLiterals("Settings and then Tools, App Settings page")).toBe(0);
    expect(settingsPathLiteralLines("a\nSettings → x\nb\nSettings > y")).toEqual([2, 4]);
  });

  it("no file spells more of them than its baseline, and no new file spells any", () => {
    const allowed = baseline as Record<string, number>;
    const over: string[] = [];
    for (const dir of ["server", "src", "shared", "companion"]) {
      const base = path.join(ROOT, dir);
      if (!fs.existsSync(base)) continue;
      for (const file of sources(base)) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        const found = countSettingsPathLiterals(fs.readFileSync(file, "utf8"));
        if (found > (allowed[rel] ?? 0)) over.push(`${rel}: ${found} > ${allowed[rel] ?? 0}`);
      }
    }
    expect(over).toEqual([]);
  });
});
