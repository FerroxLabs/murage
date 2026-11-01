// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE: the Mac folder prompt's line shows with Tool calls on or off, in a chat and in a project, offers nothing to
// press, and draws nothing once the wait ends.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FolderPromptRow } from "./FolderPromptRow";
import { groupActivityRuns } from "../lib/activity-runs";
import { timelineEvents } from "../lib/taskTimeline";
import type { Message } from "../state/store";
import { macFolderPromptLine } from "../../shared/mac-folder-prompt";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const line = macFolderPromptLine("Desktop");
const tool = (id: string, name: string): Message => ({ id, at: 1, role: "bot", kind: "activity", tool: { name, ok: true } });
const row = (done?: boolean): Message => ({ ...tool("n", line), folderPrompt: { folder: "Desktop", ...(done ? { done } : {}) } });

describe("the folder prompt row", () => {
  it("is a status line with nothing to press", () => {
    const markup = renderToStaticMarkup(createElement(FolderPromptRow, { text: line }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Your Mac is asking whether Murage can open your Desktop folder.");
    expect(markup).not.toMatch(/<button|<a /);
  });

  it.each([
    ["ChatView", read("./ChatView.tsx"), 'case "activity"', "<ActivityChip"],
    ["GroupView", read("./GroupView.tsx"), 'm.kind === "activity" && m.folderPrompt', "<RoomToolChip"],
  ])("%s draws it before the chip Tool calls hides, and nothing once done", (_name, source, branch, chip) => {
    const activity = source.indexOf(branch);
    const routed = source.indexOf("folderPromptShowing(m, Date.now())", activity);
    expect(activity).toBeGreaterThan(-1);
    expect(routed).toBeGreaterThan(-1);
    expect(routed).toBeLessThan(source.indexOf(chip, activity));
    expect(source.slice(routed, routed + 110)).toContain("<FolderPromptRow text={m.tool.name} /> : null");
  });

  it.each([[false], [true]])("is never folded into a run (done %s)", (done) => {
    const items = groupActivityRuns([tool("a", "Edit"), tool("b", "Bash"), row(done)]);
    expect(items.map((item) => item.kind)).toEqual(["run", "message"]);
  });

  it("is not a step of the task timeline", () => {
    expect(timelineEvents([row()]).map((event) => event.label)).not.toContain(line);
  });
});
