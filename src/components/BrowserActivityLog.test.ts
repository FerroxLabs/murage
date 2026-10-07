// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { BrowserActivityLogView } from "./BrowserActivityLog";

const line = (over: Record<string, unknown> = {}) => ({ at: Date.UTC(2026, 9, 2, 14, 5), botId: "b", bindingId: "x", taskId: "t", site: "example.com", action: "click", target: "Save", fromPage: false, level: 2, decision: "allowed for this task", decidedBy: "grant", outcome: "done", ...over });
const render = (lines: any[]) => renderToStaticMarkup(createElement(BrowserActivityLogView, { botName: "Mira", lines, timeZone: "UTC" }));

describe("activity log", () => {
  it("shows time, site, action and decision", () => {
    const html = render([line()]); expect(html).toContain("Activity"); expect(html).toContain("14:05"); expect(html).toContain("example.com"); expect(html).toContain("click"); expect(html).toContain("allowed for this task");
  });
  it("shows the length of typed text, never the text", () => {
    const html = render([line({ action: "type", textLength: 12, text: "hunter2-secret", value: "hunter2-secret" })]);
    expect(html).toContain("typed 12 characters"); expect(html).not.toContain("hunter2");
  });
  it("marks a name that came from the page", () => {
    expect(render([line({ fromPage: true })])).toContain("name from the page"); expect(render([line({ fromPage: false })])).not.toContain("name from the page");
  });
  it("gives the intent card decision owner words, not the raw code", () => {
    const html = render([line({ decision: "intent card" })]); expect(html).toContain("asked you to check"); expect(html).not.toContain("intent card");
  });
  it("maps every decision to owner words and shows an empty note", () => {
    const html = render([line({ decision: "free" }), line({ decision: "you denied" }), line({ decision: "Full permissive" })]);
    expect(html).toContain("no approval needed"); expect(html).toContain("you denied"); expect(html).toContain("Full access");
    expect(render([])).toContain("Each step Mira takes in your browser appears here.");
  });
});
