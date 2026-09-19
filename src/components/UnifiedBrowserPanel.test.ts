import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserPanelAlerts, browserChoicePatch, MY_CHROME, MyChromeConsent } from "./UnifiedBrowserPanel";

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

describe("a refused browser choice", () => {
  it("is shown on its own, and a connection problem cannot hide it", () => {
    const refusal = "Moss is already using your Chrome. Only one bot can use it at a time; switch Moss back to its own browser first.";
    const html = renderToStaticMarkup(createElement(BrowserPanelAlerts, { refusal, problem: "agent-browser command timed out" }));
    const alerts = [...html.matchAll(/<div role="alert"[^>]*>([^<]*)<\/div>/g)].map((match) => match[1]);
    expect(alerts).toEqual([refusal, "agent-browser command timed out"]);
    expect(renderToStaticMarkup(createElement(BrowserPanelAlerts, { refusal: "", problem: "" }))).toBe("");
  });

  it("closes the Use my Chrome confirmation when the choice is refused", () => {
    // The consent box stayed open over the refusal, still offering the button
    // that had just been refused.
    const source = readFileSync(fileURLToPath(new URL("./UnifiedBrowserPanel.tsx", import.meta.url)), "utf8");
    const choose = source.slice(source.indexOf("const chooseBrowser = "), source.indexOf("const action = "));
    const refused = choose.slice(choose.indexOf("catch"));
    expect(refused).toContain("setConfirmMyChrome(false)");
    expect(refused).toContain("setRefusal(");
  });
});
