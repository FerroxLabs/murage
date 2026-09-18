// The note a turn leaves when it ran without its browser: one quiet status
// line with the reason, never a card or an action.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserUnavailableRow } from "./BrowserUnavailableRow";
import { timelineEvents } from "@/lib/taskTimeline";
import { browserUnavailableActivityName } from "../../shared/browser-unavailable";

describe("browser unavailable note", () => {
  it("renders the reason as a neutral status line with no actions", () => {
    const markup = renderToStaticMarkup(createElement(BrowserUnavailableRow, { reason: "agent-browser command timed out" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Browser unavailable this turn — agent-browser command timed out");
    expect(markup).not.toContain("<button");
    expect(markup).not.toMatch(/Provider settings|hit a problem|Retry/);
  });

  it("reads as an observed note in the task timeline, not a failed tool", () => {
    const [event] = timelineEvents([{ id: "m1", at: 1, kind: "activity", role: "bot", tool: { name: browserUnavailableActivityName("agent-browser command timed out"), ok: true } }]);
    expect(event).toMatchObject({ label: "Browser unavailable this turn — agent-browser command timed out", state: "observed" });
  });
});
