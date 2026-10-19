// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionButton, ActionStatus, progressLine } from "./ActionButton";
import type { UseAction } from "@/lib/use-action";

const idle: UseAction<never[], unknown> = {
  phase: "idle", pending: false, slow: false, label: "Save", progress: null, message: null, fading: false, error: null,
  run: vi.fn(async () => undefined), retry: vi.fn(async () => undefined), setProgress: vi.fn(), dismiss: vi.fn(),
};
const html = (action: Partial<UseAction<never[], unknown>>, children = "Save") => renderToStaticMarkup(createElement(ActionButton, { action: { ...idle, ...action }, children }));

describe("ActionButton", () => {
  it("is a plain enabled button when idle, with a live region ready for the result", () => {
    const out = html({});
    expect(out).toContain('aria-busy="false"');
    expect(out).not.toContain("disabled");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain(">Save<");
  });

  it("disables and swaps its label while pending, and marks itself busy", () => {
    const out = html({ pending: true, phase: "pending", label: "Saving…" });
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("disabled");
    expect(out).toContain("Saving…");
    expect(out).not.toContain(">Save<");
  });

  it("can be blocked by the caller without pending", () => {
    expect(renderToStaticMarkup(createElement(ActionButton, { action: idle, blocked: true }, "Save"))).toContain("disabled");
  });

  it("shows the slow hint after a while, and progress in place of it", () => {
    expect(html({ pending: true, slow: true })).toContain("Still working. This can take a moment.");
    const out = html({ pending: true, slow: true, progress: { percent: 40, text: "Downloading" } });
    expect(out).toContain("Downloading 40%");
    expect(out).not.toContain("Still working");
  });

  it("shows the success line, and fades it on request", () => {
    expect(html({ message: "Saved" })).toContain('data-action-success="true"');
    expect(html({ message: "Saved", fading: true })).toContain("opacity-0");
  });

  it("shows the failure as an alert with the reason and a Retry button", () => {
    const out = html({ error: "Could not reach the server." });
    expect(out).toContain('role="alert"');
    expect(out).toContain("Could not reach the server.");
    expect(out).toContain(">Retry<");
  });
});

describe("ActionStatus", () => {
  it("stands alone for a control that is not a button", () => {
    const out = renderToStaticMarkup(createElement(ActionStatus, { action: { ...idle, error: "No." } }));
    expect(out).toContain('role="alert"');
  });
  it("clamps progress", () => {
    expect(progressLine({ percent: 250 })).toBe("100%");
    expect(progressLine({ text: "Working" })).toBe("Working");
    expect(progressLine(null)).toBe("");
  });
});
