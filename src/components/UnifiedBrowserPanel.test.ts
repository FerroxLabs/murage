import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BROWSER_SANDBOX_ENABLE_CODE, BrowserNotRunningNotice, BrowserPanelAlerts, BrowserRestartNotice, BrowserSandboxEnable, browserChoicePatch, MY_CHROME, MyChromeConsent, ProtectedBrowserNotice } from "./UnifiedBrowserPanel";
import { LINUX_SANDBOX_ENABLE_CODE } from "../../server/browser-sandbox";

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
  it("closes the Use my browser consent too when that choice is refused", () => {
    // A failed extension opt-in left the Set up my browser dialog stuck open.
    const source = readFileSync(fileURLToPath(new URL("./UnifiedBrowserPanel.tsx", import.meta.url)), "utf8");
    const choose = source.slice(source.indexOf("const chooseBrowser = "), source.indexOf("const action = "));
    expect(choose.slice(choose.indexOf("catch"))).toContain("setConfirmMyBrowser(false)");
  });
});

// Fix round 1: `connectionError`/`error` used to be set from raw message
// text (`cause.message`), which is exactly what carries the door's own
// `no route: ...`/`browser owner authentication required` strings
// straight into `BrowserPanelAlerts`. Both now go through
// `describeDesktopOnlyRouteError(routeErrorFrom(cause))`, which decides
// from `cause.status` (see src/lib/desktop-only-route-error.test.ts for the
// mapping itself) rather than the text. This pins the wiring, not just the
// mapper in isolation.
describe("a raw route/auth string cannot reach connectionError or error (fix round 1)", () => {
  const source = readFileSync(fileURLToPath(new URL("./UnifiedBrowserPanel.tsx", import.meta.url)), "utf8");

  it("imports the status-aware mapper", () => {
    expect(source).toContain(
      'import { describeDesktopOnlyRouteError, routeErrorFrom } from "@/lib/desktop-only-route-error";',
    );
  });

  it("the poll loop's connectionError is never set from raw cause.message", () => {
    expect(source).toContain(
      'setConnectionError(describeDesktopOnlyRouteError(cause instanceof Error ? routeErrorFrom(cause) : { message: "Browser connection unavailable" }));',
    );
    expect(source).not.toMatch(/setConnectionError\(cause instanceof Error \? cause\.message/);
  });

  it("the action catch's error is never set from raw cause.message", () => {
    expect(source).toContain(
      'setError(describeDesktopOnlyRouteError(cause instanceof Error ? routeErrorFrom(cause) : { message: "Browser action failed" }));',
    );
    expect(source).not.toMatch(/setError\(cause instanceof Error \? cause\.message/);
  });
});

describe("a browser that stopped answering, told to the owner", () => {
  const render = (held: boolean) => renderToStaticMarkup(createElement(BrowserRestartNotice, { botName: "Petra", held, pending: false, onReopen: () => {} }));
  it("offers Reopen blank page once the owner holds the browser, and says to take control first otherwise", () => {
    const held = render(true), free = render(false);
    expect(held).toContain("Reopen a blank page to restart Petra&#x27;s browser.");
    expect(held).toContain("Reopen blank page</button>");
    expect(held).not.toContain('disabled=""');
    expect(free).toContain("Take control, then reopen a blank page to restart Petra&#x27;s browser.");
    expect(free).toContain('disabled=""');
    for (const html of [held, free]) expect(html).not.toMatch(/\u2014|\bsafe|unsafe|safety/i);
  });
});

describe("a browser that is not running, told to the owner", () => {
  it("says the browser is not running and offers Restart browser without taking control, never the page-lock words", () => {
    const html = renderToStaticMarkup(createElement(BrowserNotRunningNotice, { botName: "Petra", pending: false, onRestart: () => {} }));
    expect(html).toContain("Petra&#x27;s browser is not running. Restart it to give Petra its browser back.");
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>.*Restart browser<\/button>/);
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/password|code|card|payment|\u2014|\bsafe|unsafe|safety/i);
  });
  it("shows it on the not-running state, and the page-lock note only on a real lock", () => {
    const source = readFileSync(fileURLToPath(new URL("./UnifiedBrowserPanel.tsx", import.meta.url)), "utf8");
    expect(source).toContain("{status?.notRunning && !bot.useMyChrome && status.owned !== false && <BrowserNotRunningNotice");
    expect(source).toContain('onRestart={() => void action("restart")}');
    expect(source).toContain("{status?.protectedDocument && <ProtectedBrowserNotice");
  });
});

describe("Linux AppImage Enable browser", () => {
  it("offers one button for the administrator prompt and shows what happened after it", () => {
    const html = renderToStaticMarkup(createElement(BrowserSandboxEnable, { pending: false, note: "", onEnable: () => {} }));
    expect(html).toContain(">Enable browser</button>");
    const waiting = renderToStaticMarkup(createElement(BrowserSandboxEnable, { pending: true, note: "The administrator prompt was closed, so nothing changed.", onEnable: () => {} }));
    expect(waiting).toContain("disabled");
    expect(waiting).toContain("Waiting for the administrator prompt");
    expect(waiting).toContain("The administrator prompt was closed, so nothing changed.");
  });
  it("shows the button only for the refusal the server marks as fixable", () => {
    expect(BROWSER_SANDBOX_ENABLE_CODE).toBe(LINUX_SANDBOX_ENABLE_CODE);
    const source = readFileSync(fileURLToPath(new URL("./UnifiedBrowserPanel.tsx", import.meta.url)), "utf8");
    expect(source).toContain("setCanEnable(cause instanceof Error && routeErrorFrom(cause).code === BROWSER_SANDBOX_ENABLE_CODE)");
    expect(source).toContain('api("/api/browser/linux-sandbox/enable", { method: "POST", body: "{}" })');
    // The status poll carries it too, once a command has failed with it; Reopen would only fail again.
    expect(source).toContain("status?.problemCode === BROWSER_SANDBOX_ENABLE_CODE)) && <BrowserSandboxEnable");
    expect(source).toContain("status.problemCode !== BROWSER_SANDBOX_ENABLE_CODE && !status.notRunning");
    // A poll with no page yet must not wipe "the prompt was closed" the moment it appears.
    expect(source).toContain('setConnectionError(""); setCanEnable(false); if (next) setEnableNote("");');
  });
});
