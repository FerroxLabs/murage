// Whether to invite someone to install, and on which platform it is even
// possible. The decision is pure so it can be tested against every browser
// state that matters without pretending to be a browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { installInvite, isAppleMobile, type InstallFacts } from "./install-prompt";

const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({
  standalone: false,
  secure: true,
  captured: false,
  ios: false,
  dismissed: false,
  ...over,
});

describe("who gets invited to install", () => {
  it("says NOTHING over plain HTTP, on either platform", () => {
    // The state the door is in until remote access is turned on. No browser
    // installs a site outside a secure context, whatever the manifest says —
    // so an iOS hint here would be instructions for something that cannot
    // happen, followed carefully, producing nothing.
    expect(installInvite(facts({ secure: false, ios: true }))).toBe("hidden");
    expect(installInvite(facts({ secure: false, captured: true }))).toBe("hidden");
  });

  it("offers a real button once Chromium says the site is installable", () => {
    expect(installInvite(facts({ captured: true }))).toBe("prompt");
  });

  it("falls back to instructions on iOS, which fires no event and never will", () => {
    expect(installInvite(facts({ ios: true }))).toBe("manual");
  });

  it("stays silent on a desktop browser that never offered anything", () => {
    // Not iOS, no captured event: there is nothing to offer and no Share
    // sheet to point at.
    expect(installInvite(facts())).toBe("hidden");
  });

  it("does not invite an app that is already installed", () => {
    expect(installInvite(facts({ standalone: true, captured: true }))).toBe("hidden");
    expect(installInvite(facts({ standalone: true, ios: true }))).toBe("hidden");
  });

  it("takes no for an answer", () => {
    expect(installInvite(facts({ dismissed: true, captured: true }))).toBe("hidden");
  });
});

describe("recognising the platform that cannot be prompted", () => {
  it("knows an iPhone", () => {
    expect(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe(true);
  });

  it("knows the iPad that claims to be a Mac", () => {
    // Since iPadOS 13 a tablet sends a desktop Safari user agent. Touch
    // points are what separate it from a real Mac, whose trackpad reports 0.
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
  });

  it("does not mistake a real Mac for one", () => {
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
  });

  it("does not mistake Android for one", () => {
    expect(isAppleMobile("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe(false);
  });
});

describe("where the invitation is allowed to appear", () => {
  it("renders on a confirmed remote surface and nowhere else", () => {
    // The same rule the welcome gate follows in the other direction: the
    // desktop app is already an app, and `undefined` renders nothing.
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain("{desktop === false && <InstallPrompt />}");
  });

  it("suppresses Chromium's own banner so the button is the only offer", () => {
    const hook = readFileSync(fileURLToPath(new URL("./use-install-prompt.ts", import.meta.url)), "utf8");
    expect(hook).toContain("event.preventDefault()");
    // Single-use: replaying a spent prompt throws, so it is dropped either way.
    expect(hook).toContain("finally(() => setCaptured(null))");
  });

  it("survives a browser that refuses localStorage", () => {
    // A private window, or site data blocked. Not remembering a dismissal is
    // a smaller failure than throwing during render.
    const hook = readFileSync(fileURLToPath(new URL("./use-install-prompt.ts", import.meta.url)), "utf8");
    expect(hook).toMatch(/try \{\s*return localStorage\.getItem/);
  });
});
