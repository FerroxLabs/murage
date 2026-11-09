// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ENGINE-CHECK-FOLDER-1018 decision 3: Claude's isolation excludes every instruction file above the set-up check folder, and only there.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ENGINE_CHECK_CLAUDE_MD_EXCLUDES, engineCheckFolder, engineCheckHost } from "../engine-reply-check.ts";
import { claudeIsolationSettings } from "./claude.ts";

const FIVE = ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/AGENTS.md", "**/.claude/rules/**"];
const excludes = (settings: Record<string, unknown>) => settings.claudeMdExcludes as string[];
const posixOnly = process.platform === "win32" ? it.skip : it;
const scratches: string[] = [];
// The check folder lives in a temp system root here, never in the machine's real /tmp; the predicate sees the same root.
beforeEach(() => {
  const systemRoot = mkdtempSync(join(tmpdir(), "claude-check-root-"));
  scratches.push(systemRoot);
  vi.spyOn(engineCheckHost, "systemRoot").mockReturnValue(systemRoot);
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of scratches.splice(0)) removeTempDirSync(dir); });

describe("Claude isolation in the set-up check folder", () => {
  it("names the five globs", () => { expect([...ENGINE_CHECK_CLAUDE_MD_EXCLUDES]).toEqual(FIVE); });

  posixOnly("carries the five globs for the check folder, and not for any other folder", () => {
    const config = mkdtempSync(join(tmpdir(), "claude-engchk-"));
    scratches.push(config);
    const run = engineCheckFolder();
    const forCheck = excludes(claudeIsolationSettings({ CLAUDE_CONFIG_DIR: config }, run, "linux"));
    expect(forCheck).toEqual(expect.arrayContaining(FIVE));
    expect(forCheck).toEqual(expect.arrayContaining([join(config, "CLAUDE.md"), join(config, "rules", "**")]));
    const forPicked = excludes(claudeIsolationSettings({ CLAUDE_CONFIG_DIR: config }, join(tmpdir(), "a-picked-project"), "linux"));
    for (const glob of FIVE) expect(forPicked).not.toContain(glob);
    expect(forPicked).toContain(join(config, "CLAUDE.md"));
  });

  it("on win32 adds both slash spellings, for the check folder only", () => {
    vi.spyOn(engineCheckHost, "windowsUser").mockReturnValue({ name: "PC\\owner", sid: "S-1-5-21-9" });
    vi.spyOn(engineCheckHost, "systemRoot").mockReturnValue(undefined); // the Windows default root, not the temp one
    const config = mkdtempSync(join(tmpdir(), "claude-engchk-"));
    scratches.push(config);
    const run = "C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-9\\run";
    const forCheck = excludes(claudeIsolationSettings({ CLAUDE_CONFIG_DIR: config }, run, "win32"));
    for (const glob of FIVE) { expect(forCheck).toContain(glob); expect(forCheck).toContain(glob.replace(/\//g, "\\")); }
    const forPicked = excludes(claudeIsolationSettings({ CLAUDE_CONFIG_DIR: config }, "C:\\Users\\o\\project", "win32"));
    for (const glob of FIVE) { expect(forPicked).not.toContain(glob); expect(forPicked).not.toContain(glob.replace(/\//g, "\\")); }
  });
});
