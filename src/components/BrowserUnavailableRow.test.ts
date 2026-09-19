// The note a turn leaves when it ran without its browser: one quiet status
// line with the reason, never a card or an action.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserUnavailableRow } from "./BrowserUnavailableRow";
import { timelineEvents } from "@/lib/taskTimeline";
import { browserUnavailableActivityName, USER_CHROME_UNREACHABLE_REASON } from "../../shared/browser-unavailable";

describe("browser unavailable note", () => {
  it("says what happened in plain words, with the technical reason tucked into details", () => {
    const markup = renderToStaticMarkup(createElement(BrowserUnavailableRow, { reason: "agent-browser command timed out" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("The browser didn&#x27;t start in time, so this turn ran without it. It&#x27;ll try again next turn.");
    expect(markup).not.toContain("Browser unavailable this turn");
    expect(markup).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary>[^]*agent-browser command timed out[^]*<\/details>/);
    expect(markup).not.toContain("<button");
    expect(markup).not.toMatch(/Provider settings|hit a problem|Retry/);
  });

  it("wraps at word boundaries, breaking only a token too long for the line", () => {
    // `break-all` split ordinary words mid-word at 390px ("com / mand").
    const markup = renderToStaticMarkup(createElement(BrowserUnavailableRow, { reason: "agent-browser command timed out" }));
    expect(markup).not.toContain("break-all");
    expect(markup).toContain("[overflow-wrap:anywhere]");
  });

  it("tells a Use my Chrome owner how to reach their Chrome", () => {
    const markup = renderToStaticMarkup(createElement(BrowserUnavailableRow, { reason: USER_CHROME_UNREACHABLE_REASON }));
    expect(markup).toContain("Your Chrome isn&#x27;t reachable, so this turn ran without a browser. Open Chrome and turn on remote debugging at chrome://inspect/#remote-debugging.");
    expect(markup).not.toContain("<details");
  });

  it("reads as an observed note in the task timeline, not a failed tool", () => {
    const [event] = timelineEvents([{ id: "m1", at: 1, kind: "activity", role: "bot", tool: { name: browserUnavailableActivityName("agent-browser command timed out"), ok: true } }]);
    expect(event).toMatchObject({ label: "The browser didn't start in time, so this turn ran without it. It'll try again next turn.", state: "observed" });
  });
});
