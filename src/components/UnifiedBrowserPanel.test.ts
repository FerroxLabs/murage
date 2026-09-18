import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { browserChoicePatch, MY_CHROME, MyChromeConsent } from "./UnifiedBrowserPanel";

describe("Use my Chrome choice", () => {
  it("asks before attaching, and changes nothing until confirmed", () => {
    expect(browserChoicePatch({}, MY_CHROME)).toBeNull();
    expect(browserChoicePatch({ useMyChrome: true }, MY_CHROME)).toEqual({});
  });
  it("switching away from my Chrome turns the opt-in off along with the new profile", () => {
    expect(browserChoicePatch({ useMyChrome: true }, "")).toEqual({ useMyChrome: false, browserProfile: null });
    expect(browserChoicePatch({ useMyChrome: true }, "guest")).toEqual({ useMyChrome: false, browserProfile: "guest" });
    expect(browserChoicePatch({}, "work")).toEqual({ browserProfile: "work" });
  });
  it("says what it means and what to do, in plain words, at the moment of choosing", () => {
    const html = renderToStaticMarkup(createElement(MyChromeConsent, { botName: "Moss", pending: false, onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("Moss will act inside your own Chrome, signed in as you, and can see your open tabs.");
    expect(html).toContain("chrome://inspect/#remote-debugging");
    expect(html).toContain("Chrome does not restart and your windows stay open");
    expect(html).toContain("Only one bot can use your Chrome at a time");
    expect(html).toContain(">Use my Chrome</button>");
    expect(html).toContain(">Cancel</button>");
  });
});
