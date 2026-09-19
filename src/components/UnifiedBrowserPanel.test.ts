import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { browserChoicePatch, MY_CHROME, MyChromeConsent, ProtectedBrowserNotice } from "./UnifiedBrowserPanel";

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

describe("a locked browser page, told to the owner", () => {
  const render = (reason: "owner-input" | "sensitive-page" | null | undefined, held = false) =>
    renderToStaticMarkup(createElement(ProtectedBrowserNotice, { botName: "Petra", reason, held, pending: false, onReopen: () => {} }));
  it("says the owner's typing locked it and how to give the bot its browser back", () => {
    const html = render("owner-input");
    expect(html).toContain("Petra can&#x27;t use this page because you typed or clicked in it.");
    expect(html).toContain("Take control, then reopen a blank page to give Petra its browser back.");
    expect(html).not.toContain("protected interaction");
  });
  it("names the sensitive page as the cause and that the bot can leave it itself", () => {
    const html = render("sensitive-page");
    expect(html).toContain("Petra can&#x27;t use this page because it has a password, code or card field, an embedded frame, or content Murage can&#x27;t check.");
    expect(html).toContain("Petra can open a different page itself");
  });
  it("reads a lock with no recorded cause as the owner's", () => {
    expect(render(undefined)).toContain("because you typed or clicked in it");
  });
  it("offers Reopen blank page only once the owner holds control", () => {
    expect(render("owner-input", false)).toMatch(/<button disabled=""[^>]*>.*Reopen blank page<\/button>/);
    expect(render("owner-input", true)).not.toMatch(/<button disabled=""/);
  });
});

