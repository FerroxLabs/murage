import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { transitionComputerControlLease } from "../lib/computer-control";

// ComputerPanel's import graph reads `window` at module scope
// (DesktopCapabilities asks the desktop shell what it is running on), and
// this suite runs in node. A bare object is the honest answer: no shell.
(globalThis as unknown as { window?: unknown }).window ??= {};
const {
  planComputerDestinationChange,
  computerPanelHeaderMode,
  phoneComputerNoticeText,
  phoneComputerNoticeSentences,
  PhoneComputerPanelBody,
} = await import("./ComputerPanel");
const { initialState, reducer } = await import("../state/store");

it("opening settings from Computer closes the panel and preserves the selected bot", () => {
  const selected = { ...initialState, selectedId: "computer-bot", computerOpen: true };
  const settings = reducer(selected, { type: "toggleSettings", open: true });
  expect(settings).toMatchObject({ selectedId: "computer-bot", settingsOpen: true, computerOpen: false });
  const closed = reducer(settings, { type: "toggleSettings", open: false });
  const reopened = reducer(closed, { type: "toggleComputer", open: true });
  expect(reopened).toMatchObject({ selectedId: "computer-bot", settingsOpen: false, computerOpen: true });
});

const snap = (held: boolean) => ({ held, helpReason: null });

describe("computer/browser control transition ordering", () => {
  it("gates Electron before taking the server lease", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    expect(calls).toEqual(["native:true", "server:take"]);
  });

  it("releases the server before clearing Electron", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(false); },
    });
    expect(calls).toEqual(["server:release", "native:false"]);
  });

  it("never clears the private gate when the server did not release", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await expect(transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });

  it("does not contact the server if the private take gate fails", async () => {
    const requestControl = vi.fn(async () => snap(true));
    await expect(transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async () => false,
      requestControl,
    })).rejects.toThrow(/pause.*browser/i);
    expect(requestControl).not.toHaveBeenCalled();
  });

  it("leaves BrowserPanel to perform its own native choreography", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: false,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    });
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });
});

// AUTOOP2 verifier follow-up: the "Runs on" grid used to decide the local-Auto
// warning with `!isLinux && localSelectable`, so on a Mac whose provider lacks
// local-computer capability (localSelectable false) an Auto-on bot moved to
// the Auto destination fired PATCH {computer:null} with no acknowledgement
// and got a bare 400 from the server rule, which does not consult provider
// support. The grid now decides with the shared rule, which takes no
// provider-support input at all: every case below holds whether or not
// "This computer" is clickable.
describe("ComputerPanel destination change on an Auto-on bot", () => {
  const capabilities = (platform: "darwin" | "linux" | "win32" | "other") => ({ host: { platform, label: "", homeDir: "" } } as never);
  it("opens the warning on a Mac even when the provider cannot use this computer", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "off",
      next: "local",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "local" });
  });
  it("patches straight through where Auto mounts nothing, and never re-warns an already granted desktop", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("linux"),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "local",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "browser",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: "browser", browser: true } });
  });
  it("is a no-op for the current destination and never warns a bot in Ask", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: undefined,
      next: "auto",
      autoApprove: true,
    })).toBeNull();
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "local",
      autoApprove: false,
    })).toEqual({ kind: "patch", patch: { computer: "local" } });
  });
  it("reads the Mac through the browser door the way the settings switch does", () => {
    // host.platform "other" (a plain browser) on a Mac UA is still this Mac
    // while the harness has not announced itself
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
  });
  // FOLLOW5: the harness's own platform (announced on /api/config) decides,
  // not the browser's UA — a Linux tab through the browser door on a Mac
  // harness must get the dialog, and a Mac tab on a Linux harness must not.
  it("decides on the platform the harness announced, not the browser UA", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      harness: { platform: "darwin" },
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      harness: { platform: "linux" },
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    // an explicit "local" on a Linux harness still mounts it there
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      harness: { platform: "linux" },
      current: "cloud",
      next: "local",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "local" });
  });
});

const source = readFileSync(fileURLToPath(new URL("./ComputerPanel.tsx", import.meta.url)), "utf8");

describe("the preview poll on a phone (spec §6)", () => {
  it("halves both preview polls on a phone and leaves the desktop's rate alone", () => {
    expect(source).toContain("setInterval(shoot, phonePollMs(bot.busy ? 4000 : 30_000, phone))");
    expect(source).toContain("window.setInterval(() => void shoot(), phonePollMs(bot.busy ? 3000 : 30_000, phone))");
    expect(source).toMatch(/const phone = isPhoneClient\(\);/);
  });
});

// E1 device acceptance (2026-09-28): a phone's Computer tab showed
// "Couldn't reach the computer" plus a raw `no route: GET
// /api/bots/<id>/computer`, and the full "Runs on" grid; the Browser tab
// showed "Browser unavailable", "Take control", a Profile picker and a raw
// `browser owner authentication required`. Both routes are desktop-only by
// design (0.1.62 route policy) — a phone must get one explanation instead
// of either dead surface.
describe("the Computer/Browser panel on a phone (spec §6)", () => {
  it("always gives a phone the plain title, never the Computer/Android/Browser tab switcher", () => {
    expect(computerPanelHeaderMode({ phone: true, androidConnected: false, browserEnabled: false })).toBe("title");
    expect(computerPanelHeaderMode({ phone: true, androidConnected: true, browserEnabled: true })).toBe("title");
  });

  it("keeps the desktop's tab switcher exactly as it decides today", () => {
    expect(computerPanelHeaderMode({ phone: false, androidConnected: false, browserEnabled: false })).toBe("title");
    expect(computerPanelHeaderMode({ phone: false, androidConnected: true, browserEnabled: false })).toBe("tabs");
    expect(computerPanelHeaderMode({ phone: false, androidConnected: false, browserEnabled: true })).toBe("tabs");
  });

  it("says the explanation in plain words, naming the bot on both sides", () => {
    const text = phoneComputerNoticeText("Kessler");
    expect(text).toBe(
      "Watching or taking over Kessler's computer and browser happens on your Mac. Kessler can still use them when you ask from here.",
    );
  });

  // Polish (Sean, 2026-09-29 E1): the panel body used to hardcode `'s`, which
  // reads wrong for a name that is already plural/possessive-shaped. The app's
  // one possessive rule (src/lib/possessive.ts) now decides both this text and
  // every other "<bot>'s" label.
  it("uses the app's possessive helper, so a name ending in s takes a bare apostrophe", () => {
    const text = phoneComputerNoticeText("James");
    expect(text).toBe(
      "Watching or taking over James' computer and browser happens on your Mac. James can still use them when you ask from here.",
    );
  });

  it("still reads correctly for a name ending in a closing paren", () => {
    const text = phoneComputerNoticeText("Dax (Closer)");
    expect(text).toBe(
      "Watching or taking over Dax (Closer)'s computer and browser happens on your Mac. Dax (Closer) can still use them when you ask from here.",
    );
  });

  it("splits into exactly the two sentences the brief asks for, joined by the text function", () => {
    const sentences = phoneComputerNoticeSentences("Kessler");
    expect(sentences).toEqual([
      "Watching or taking over Kessler's computer and browser happens on your Mac.",
      "Kessler can still use them when you ask from here.",
    ]);
    expect(sentences.join(" ")).toBe(phoneComputerNoticeText("Kessler"));
  });

  it("never uses an em dash, the word safe, or price talk in the phone copy", () => {
    const text = phoneComputerNoticeText("Kessler");
    expect(text).not.toMatch(/—/);
    expect(text.toLowerCase()).not.toContain("safe");
    expect(text).not.toMatch(/\$|\bfree\b|\bprice\b|\bcost\b/i);
  });

  // A minimal fixture shaped like BotAvatar's `bot` prop (name + color is all
  // the mascot fallback needs) — `as never` matches the cast this file
  // already uses for other partial fixtures (see `capabilities()` above).
  const phoneBot = { id: "computer-bot", name: "Kessler", color: "orange" } as never;

  it("renders the empty-state illustration, heading and both sentences — no Runs on grid, Take control, Profile picker, URL bar, or raw route error", () => {
    const markup = renderToStaticMarkup(createElement(PhoneComputerPanelBody, { bot: phoneBot }));
    const [first, second] = phoneComputerNoticeSentences("Kessler");
    expect(markup).toContain(first.replace(/'/g, "&#x27;"));
    expect(markup).toContain(second.replace(/'/g, "&#x27;"));
    // The panel's own "Computer" title is a styled <span>, not a heading
    // (ComputerPanel.tsx's header), so this empty state's heading is the
    // only one in the panel's subtree — h1 fits, not a nested h2.
    expect(markup).toMatch(/<h1[^>]*>On your Mac<\/h1>/);
    for (const deadEnd of [
      "Runs on",
      "Take control",
      "Browser profile",
      "Web address",
      "no route:",
      "browser owner authentication required",
      "Couldn&#x27;t reach the computer",
      "Browser unavailable",
    ]) {
      expect(markup).not.toContain(deadEnd);
    }
  });

  it("draws the laptop illustration as a decorative, aria-hidden inline SVG with the bot's own avatar on its screen", () => {
    const markup = renderToStaticMarkup(createElement(PhoneComputerPanelBody, { bot: phoneBot }));
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
    // No new image files or dependencies: the laptop is drawn, not sourced.
    expect(markup).not.toContain("<img");
    // The mascot fallback renders the bot's name as its accessible label —
    // proof the same avatar the header uses is the one sitting on the screen.
    expect(markup).toContain("Kessler");
  });

  it("gates the panel body on `phone`, ahead of the Browser/Android/Computer branches, and keeps the close control reachable", () => {
    // isPhoneClient() is asked once and cached; a full render harness would
    // need the real StoreProvider and DesktopCapabilities context, which
    // this suite (node, no jsdom) does not stand up for ComputerPanel. The
    // gate itself is proven above; this proves it sits first in the JSX so
    // no phone build can fall through to a browser/android/computer branch,
    // and that the close button survives the phone branch untouched.
    expect(source).toMatch(/\{phone \? \(\s*<PhoneComputerPanelBody bot=\{bot\} \/>\s*\) : panelView === "browser"/);
    expect(source).toMatch(/onClick=\{\(\) => dispatch\(\{ type: "toggleComputer", open: false \}\)\}[^]*?<X size=\{18\} \/>/);
  });
});

// Fix round 1: `setError` used to take `e.message` straight from the
// computer-status fetch's catch, which is exactly what carries the door's
// raw `no route: ...` text. Both catches now decide from `e.status` via
// `describeDesktopOnlyRouteError(routeErrorFrom(e))` (see
// src/lib/desktop-only-route-error.test.ts for the mapping itself and the
// pin against server/index.ts's literal strings). This pins the wiring.
describe("the computer-status catches never set a raw error string (fix round 1)", () => {
  it("imports the status-aware mapper", () => {
    expect(source).toContain(
      'import { describeDesktopOnlyRouteError, routeErrorFrom } from "@/lib/desktop-only-route-error";',
    );
  });

  it("both /api/bots/:id/computer catches route through it, not e.message directly", () => {
    // Scoped to the resolve-on-open effect, which is what fetches
    // `/api/bots/:id/computer` and is what the brief's field report traced
    // the raw `no route: ...` string to. The VM status catch and the
    // sleep/provision action catches are separate endpoints
    // (`/api/bots/:id/local-computer`, user-initiated actions, not the
    // desktop-only status route) and are unchanged, out of scope here.
    // Starts after the Local VM branch (its own status catch, against
    // /api/bots/:id/local-computer, is untouched and out of scope here).
    const effectStart = source.indexOf('if (bot.computer === "cloud" && !cloudSupported)');
    const effectEnd = source.indexOf("// cloud preview: SSE frames win");
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effect = source.slice(effectStart, effectEnd);
    const calls = [...effect.matchAll(/setError\(describeDesktopOnlyRouteError\(routeErrorFrom\(e\)\)\);/g)];
    expect(calls).toHaveLength(2);
    expect(effect).not.toMatch(/setError\(e\.message\)/);
  });
});
