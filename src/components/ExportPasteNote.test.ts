// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The chat line under an export paste memory left out (PASTE-CAPTURE-FIX 3.3, B3, B4).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { en } from "@/locales";
import { ExportPasteNoteView, offersReview } from "./ExportPasteNote";

const noted = { memoryNote: "export-paste" as const, origin: "desktop" as const, text: "IDENTITY\nundated I live in Austin" };
const view = (message: Parameters<typeof ExportPasteNoteView>[0]["message"], offered: boolean) =>
  renderToStaticMarkup(createElement(ExportPasteNoteView, { message, offered, onReview: () => undefined }));

describe("the export paste line", () => {
  it("says the paste was left out of memory and offers Review and keep on the desktop", () => {
    const html = view(noted, true);
    expect(html).toContain(en["memory.exportPaste.line"]);
    expect(html).toContain(">Review and keep<");
  });
  it("shows the line alone in a room, on a phone and for a message from a channel or the phone", () => {
    expect(offersReview(noted, true, false)).toBe(true);
    expect(offersReview(noted, true, true)).toBe(false);
    expect(offersReview(noted, false, false)).toBe(false);
    expect(offersReview(noted, undefined, false)).toBe(false);
    expect(offersReview({ ...noted, origin: "companion" }, true, false)).toBe(false);
    expect(offersReview({ ...noted, origin: undefined }, true, false)).toBe(false);
    const html = view(noted, false);
    expect(html).toContain(en["memory.exportPaste.line"]);
    expect(html).not.toContain("Review and keep");
  });
  it("renders nothing for a message without the mark", () => {
    expect(view({ ...noted, memoryNote: undefined }, true)).toBe("");
  });
  it("keeps the copy rules", () => {
    for (const key of ["memory.exportPaste.line", "memory.exportPaste.button", "learnAboutMe.flag.maskedIdentifier"] as const) {
      expect(en[key]).not.toMatch(/[–—]|\bsafe|\bunsafe|\bsafety|composio/i);
    }
  });
});
