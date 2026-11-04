// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4C Tip: timing, roles, one line and the edge flip (Phase 2 spec 3).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { placeTip, Tip, TIP_HOVER_MS, TIP_MAX_CHARS, tipLine, type TipProps } from "./Tip";

const button = (props: Record<string, unknown> = {}) => createElement("button", { type: "button", ...props }, "x") as TipProps["children"];

describe("Tip", () => {
  it("waits 300 ms on hover", () => {
    expect(TIP_HOVER_MS).toBe(300);
  });

  it("is a tooltip linked to its control, and its words are the control's name", () => {
    const html = renderToStaticMarkup(createElement(Tip, { text: "Close help", keys: "Esc", initialOpen: true, children: button() }));
    expect(html).toContain('role="tooltip"');
    const id = /role="tooltip"[^>]*?id="([^"]+)"|id="([^"]+)"[^>]*?role="tooltip"/.exec(html);
    const tipId = id?.[1] ?? id?.[2];
    expect(tipId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${tipId}"`);
    expect(html).toContain('aria-label="Close help"');
    expect(html).toContain("<kbd");
    expect(html).toContain("Esc");
  });

  it("draws nothing until shown, and keeps a name the control already has", () => {
    const html = renderToStaticMarkup(createElement(Tip, { text: "Close help", children: button({ "aria-label": "Close" }) }));
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('aria-label="Close"');
  });

  it("is one line of at most 80 characters", () => {
    expect(tipLine("  two\n lines  ")).toBe("two lines");
    const long = tipLine("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(TIP_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("goes above the control, below it at the top edge, and stays inside the window", () => {
    expect(placeTip({ top: 200, bottom: 232, left: 100, width: 40 }, { width: 120, height: 24 }, 1280).side).toBe("above");
    expect(placeTip({ top: 4, bottom: 36, left: 100, width: 40 }, { width: 120, height: 24 }, 1280).side).toBe("below");
    expect(placeTip({ top: 200, bottom: 232, left: 0, width: 20 }, { width: 120, height: 24 }, 1280).left).toBe(8);
    expect(placeTip({ top: 200, bottom: 232, left: 1270, width: 10 }, { width: 120, height: 24 }, 1280).left).toBe(1280 - 120 - 8);
  });
});
