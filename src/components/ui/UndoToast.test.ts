// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Undo toast's markup (handoffs/UNDO-HOST-DESIGN.md sections 4 and 8): a
// polite status region, Undo as a real button with a 44 px target, a labelled
// Dismiss, the detail line, and the disabled Undoing state.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createUndoHost, type UndoToastView } from "@/lib/undo";
import { UndoToast, UndoToastHost } from "./UndoToast";

const noop = () => undefined;
const view = (over: Partial<UndoToastView> = {}): UndoToastView => ({ id: 1, message: "Tip hidden.", canUndo: true, undoing: false, action: null, detail: null, extra: [], ...over });
const card = (v: UndoToastView) => renderToStaticMarkup(createElement(UndoToast, { view: v, onUndo: noop, onAction: noop, onDismiss: noop }));

describe("UndoToast", () => {
  it("mounts a polite status region that holds the open offer, bottom-left", () => {
    const host = createUndoHost();
    host.offerUndo({ kind: "local", key: "tip:x", message: "Tip hidden.", undo: vi.fn() });
    const markup = renderToStaticMarkup(createElement(UndoToastHost, { host }));
    expect(markup).toMatch(/^<div role="status" aria-live="polite">/);
    expect(markup).toContain("Tip hidden.");
    expect(markup).toMatch(/<button type="button"[^>]*>Undo<\/button>/);
    expect(markup).toContain("fixed bottom-4 left-4");
  });

  it("keeps the region in the page with nothing in it when there is no offer", () => {
    const markup = renderToStaticMarkup(createElement(UndoToastHost, { host: createUndoHost() }));
    expect(markup).toBe('<div role="status" aria-live="polite"></div>');
  });

  it("gives Undo and Dismiss 44 px targets and Dismiss a name", () => {
    const markup = card(view());
    expect(markup).toContain('aria-label="Dismiss"');
    expect(markup.match(/min-h-11 min-w-11/g)).toHaveLength(1);
    expect(markup).toContain("size-11");
  });

  it("shows the detail line and the stacked lines under the headline", () => {
    const markup = card(view({ canUndo: false, detail: "Could not undo: gone", extra: [{ id: 0, text: "Could not undo: older" }] }));
    expect(markup).not.toContain(">Undo<");
    expect(markup).toContain("Could not undo: gone");
    expect(markup).toContain("Could not undo: older");
  });

  it("disables Undo and names it Undoing while an undo runs", () => {
    const markup = card(view({ canUndo: false, undoing: true }));
    expect(markup).toMatch(/<button type="button" disabled="" aria-disabled="true"[^>]*>Undoing<\/button>/);
  });

  it("shows the optional action as a second button", () => {
    const markup = card(view({ action: { label: "Open tips", run: noop } }));
    expect(markup).toMatch(/>Undo<\/button><button type="button"[^>]*>Open tips<\/button>/);
  });
});
