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
const line = "This reply went ahead without remembered context after memory changed.";
const note = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", memoryNote: "without-memory", tool: { name: line, ok: true } } as Message);
const step = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "Read file", ok: true } } as Message);

describe("the without-memory note", () => {
  it("renders the server's line as a quiet status row", () => {
    const markup = renderToStaticMarkup(createElement(WithoutMemoryNoteRow, { text: line }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-testid="without-memory-note"');
    expect(markup).toContain(line);
    expect(markup).not.toContain("break-all");
    expect(line).not.toMatch(/[–—]|\bsafe/);
  });

  it("shows the same copy for an older stored notice", () => {
    const legacy = "Memory changed while Claude was starting, so this reply ran without remembered context.";
    const markup = renderToStaticMarkup(createElement(WithoutMemoryNoteRow, { text: legacy }));
    expect(markup).toContain(line);
    expect(markup).not.toContain("Claude");
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

  // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION-1025 F20 + F21): this asserted the two server sites that wrote the marked row (the
  // last-rebuild refusal note and the revoke-fence notice release). Both are deleted: a memory note is a log line now, and the server
  // writes the mark in ONE place only, the boot repair of a released message-only note a build through 1.0.23 left behind. The row
  // component above stays for the rows already stored. (Behaviour: server/memory-notes-log-only-1024.test.ts and the B3 rows of
  // server/fence-pending-turn-api.test.ts; this is the source inventory.)
  it("the server writes the mark only in the boot repair of a legacy message-only note", () => {
    const index = read("../../server/index.ts");
    for (const gone of ["function releaseFenceNotice(", "function prepareFenceNotice(", "function noteHeldRecall(", "function writeFenceNotice(", "fenceNote(providerTurnId)", "roomFenceNote"]) expect(index, gone).not.toContain(gone);
    expect(index.split('memoryNote: "without-memory"')).toHaveLength(2);
    const repair = index.slice(index.indexOf("const fenceNoticeBoot = setInterval("), index.indexOf("fenceNoticeBoot.unref();"));
    expect(repair).toContain('memoryNote: "without-memory"');
    expect(repair).toContain("(notice.line === MESSAGE_ONLY_NOTE || notice.line === NO_HUMAN_NOTE)");
    expect(index).toContain('if (kind === "without-memory") { console.info(`[memory] reply ran without remembered context');
  });
});
