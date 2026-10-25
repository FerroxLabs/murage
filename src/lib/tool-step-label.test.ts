// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { toolStepKey, toolStepLabel } from "./tool-step-label";

describe("toolStepKey: one meaning across engines", () => {
  const table: Array<[string, string | null]> = [
    ["Bash", "runCommand"], ["shell", "runCommand"], ["run_command", "runCommand"], ["execute", "runCommand"], ["terminal", "runCommand"],
    ["Read", "readFile"], ["read_file", "readFile"],
    ["Edit", "editFile"], ["Write", "editFile"], ["MultiEdit", "editFile"], ["apply_patch", "editFile"], ["delete", "deleteFiles"], ["move", "moveFiles"],
    ["Grep", "searchFiles"], ["Glob", "searchFiles"], ["search", "search"], ["mcp__docs__search", "search"], ["search_file_content", "searchFiles"],
    ["run_shell_command", "runCommand"], ["google_web_search", "searchWeb"],
    ["WebSearch", "searchWeb"], ["WebFetch", "openWebPage"], ["fetch", "openWebPage"],
    ["screenshot", "lookAtScreen"], ["computer", "useComputer"], ["browser", "useBrowser"],
    ["TodoWrite", "updatePlan"], ["update_plan", "updatePlan"],
    ["mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "useConnectedApps"],
    ["murage_connectors__APPS_SEARCH_TOOLS", "useConnectedApps"],
    ["mcp__files__read_file", "readFile"],
    ["frobnicate", null],
    ["", null],
  ];
  for (const [name, key] of table) it(`${JSON.stringify(name)} -> ${key}`, () => expect(toolStepKey(name)).toBe(key));

  it("falls back to the raw name when the table does not know it", () => {
    expect(toolStepLabel("frobnicate")).toBe("frobnicate");
    expect(toolStepLabel("Bash")).toBe("ran commands");
    expect(toolStepLabel("search")).toBe("ran a search");
    expect(toolStepLabel("delete")).toBe("deleted files");
    expect(toolStepLabel("move")).toBe("moved files");
  });
});
