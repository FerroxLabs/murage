import { describe, expect, it } from "vitest";

import { openSignInTab, releaseSignInTab, reserveSignInTab } from "./signin-tab";

const fakeTab = () => { const tab = { closed: false, opener: {} as unknown, location: { href: "about:blank" }, document: { title: "", body: { textContent: "" } }, close() { tab.closed = true; } }; return tab; };

describe("the tab the click opens for the vendor's page", () => {
  it("the click reserves a tab and the link, when it arrives, goes into that tab (no second pop-up)", () => {
    const tab = fakeTab(); const calls: string[] = [];
    expect(reserveSignInTab((url) => { calls.push(url); return tab as never; })).toBe(true);
    expect(openSignInTab("https://accounts.x.ai/oauth2/device?user_code=67SE-48EK", (url) => { calls.push(url); return null; })).toBe(true);
    expect(tab.location.href).toBe("https://accounts.x.ai/oauth2/device?user_code=67SE-48EK");
    expect(calls).toEqual(["about:blank"]);
    expect(tab.opener).toBeNull();
  });
  it("a blocked tab is reported, never accepted silently", () => {
    releaseSignInTab();
    expect(reserveSignInTab(() => null)).toBe(false);
    expect(openSignInTab("https://auth.openai.com/codex/device", () => null)).toBe(false);
  });
  it("with no reserved tab a link opens in a new one; a cancelled sign-in closes the empty one", () => {
    const fresh = fakeTab();
    expect(openSignInTab("https://auth.openai.com/codex/device", () => fresh as never)).toBe(true);
    const tab = fakeTab();
    reserveSignInTab(() => tab as never);
    releaseSignInTab();
    expect(tab.closed).toBe(true);
  });
});
