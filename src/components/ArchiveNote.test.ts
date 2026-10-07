// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G4: archiving a bot is one click (no confirm), the row flies into the +
// menu that holds Archived bots, and a note with Restore stays until it is
// dismissed. The first archive explains what archiving keeps.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { archiveFlightKeyframes } from "@/lib/archive-flight";

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false, optAction: () => "none" as const, setAnalyticsEnabled: () => {}, initAnalytics: () => {},
  track: () => {}, identifyEmail: () => {}, emailGateDone: () => false, setEmailGateDone: () => {},
}));
(globalThis as unknown as { window?: unknown }).window ??= {};
const { TeamFeedbackToast, archiveFeedback, feedbackStays } = await import("./Sidebar");
const source = readFileSync(fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)), "utf8");

describe("archive a bot (G4)", () => {
  it("offers Restore, not Undo, and a way to dismiss the note", () => {
    const markup = renderToStaticMarkup(createElement(TeamFeedbackToast, {
      feedback: archiveFeedback({ id: "b1", name: "Dax" }, false), onUndoTeam: () => {}, onUndoBot: () => {}, onDismiss: () => {},
    }));
    expect(markup).toContain(">Restore<");
    expect(markup).not.toContain(">Undo<");
    expect(markup).toContain('aria-label="Dismiss"');
  });

  it("stays until dismissed; ordinary notes still time out", () => {
    expect(feedbackStays(archiveFeedback({ id: "b1", name: "Dax" }, false))).toBe(true);
    expect(feedbackStays({ error: false, text: "Dax restored" })).toBe(false);
  });

  it("says more the first time, and where to find the bot after that", () => {
    const first = archiveFeedback({ id: "b1", name: "Dax" }, true);
    expect(first.text).toBe("Dax archived");
    expect(first.detail).toBe("Archiving keeps Dax's conversations, files and memory. Dax leaves the sidebar and waits in Archived bots, under + at the top of the sidebar. Restore brings Dax back.");
    expect(archiveFeedback({ id: "b1", name: "Dax" }, false).detail).toBe("Find Dax in Archived bots, under +.");
    for (const note of [first.detail, archiveFeedback({ id: "b1", name: "Dax" }, false).detail]) expect(note).not.toMatch(/—|safe/i);
  });

  it("never asks for confirmation", () => {
    const body = source.slice(source.indexOf("const archiveBot = async"), source.indexOf("const toggleSidebarHidden"));
    expect(body).not.toMatch(/confirm\(|setConfirm|ConfirmDialog/);
  });

  it("flies the row to the + button and shrinks away", () => {
    const [start, end] = archiveFlightKeyframes({ left: 0, top: 300, width: 200, height: 40 }, { left: 10, top: 10, width: 40, height: 40 });
    expect(start).toMatchObject({ opacity: 1 });
    expect(end).toMatchObject({ opacity: 0, transform: "translate(-70px, -290px) scale(0.2)" });
  });
});
