// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DELEGATION-HOLD F5 (T6): "ran without remembered context" is an activity row, and both transcripts hid activity rows with
// Settings > Tool calls off, so the sidebar preview showed the line and the chat did not. It is now a quiet note in a direct chat and a room
// with Tool calls on or off.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { groupActivityRuns } from "@/lib/activity-runs";
import { isWithoutMemoryNote, WithoutMemoryNoteRow } from "./WithoutMemoryNote";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
// memory/dispatch.ts turnRefusedLine("Claude", "without-memory"), checked against its source below
const line = "Memory changed while Claude was starting, so this reply ran without remembered context.";
const note = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", memoryNote: "without-memory", tool: { name: line, ok: true } } as Message);
const step = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "Read file", ok: true } } as Message);

describe("the without-memory note", () => {
  it("renders the server's line as a quiet status row", () => {
    const markup = renderToStaticMarkup(createElement(WithoutMemoryNoteRow, { text: line }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-testid="without-memory-note"');
    expect(markup).toContain("ran without remembered context");
    expect(markup).not.toContain("break-all");
    expect(line).not.toMatch(/[–—]|\bsafe/);
  });

  it("is told by its mark, never by a tool row's name", () => {
    expect(isWithoutMemoryNote(note("n", 1))).toBe(true);
    expect(isWithoutMemoryNote({ ...note("n", 1), memoryNote: undefined })).toBe(false);
    expect(isWithoutMemoryNote({ ...note("n", 1), kind: "text" } as Message)).toBe(false);
  });

  it("is never folded into a run of tool steps (a run is hidden whole with Tool calls off)", () => {
    const items = groupActivityRuns([step("a", 1), step("b", 2), note("n", 3), step("c", 4), step("d", 5)]);
    const own = items.find(item => item.kind === "message" && item.message.id === "n");
    expect(own).toBeTruthy();
    for (const item of items) if (item.kind === "run") expect(item.messages.map(m => m.id)).not.toContain("n");
  });

  it.each([
    ["ChatView", read("./ChatView.tsx"), 'case "activity"', "if (!showToolCalls && !m.comm && !hasDoneWhenLine(m.tool?.doneWhen)) return null;"],
    ["GroupView", read("./GroupView.tsx"), 'm.kind === "activity" && m.tool', "|| showToolCalls || hasDoneWhenLine(m.tool.doneWhen) ? ("],
  ])("%s routes it to its own row before the Tool calls gate", (_name, source, branch, gate) => {
    const activity = source.indexOf(branch);
    const routed = source.indexOf("isWithoutMemoryNote(m)", activity);
    const hidden = source.indexOf(gate, activity);
    expect(activity).toBeGreaterThan(-1);
    expect(routed, "the note is not routed to its own row").toBeGreaterThan(activity);
    expect(hidden).toBeGreaterThan(routed);
    expect(source.indexOf("<WithoutMemoryNoteRow", routed)).toBeLessThan(hidden);
  });

  it("both server rows carry the mark", () => {
    expect(read("../../server/memory/dispatch.ts")).toContain("`Memory changed while ${engine} was starting, so this reply ran without remembered context.`");
    const index = read("../../server/index.ts");
    expect(index).toMatch(/\{ name: line, ok: true \}, \.\.\.\(kind === "without-memory" \? \{ memoryNote: "without-memory" as const \} : \{\}\)/);
    expect(index).toMatch(/roomLastResort && turnSucceeded\(e\)\) store\.appendMessage\(threadId, murageLine\(\{[^\n]*memoryNote: "without-memory"/);
  });
});
