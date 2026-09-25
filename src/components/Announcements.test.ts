// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The notice components: the body's Markdown subset becomes elements and
// nothing else, each layout draws on both surfaces, a missing picture falls
// back to spotlight, and actions go only where the fixed list says.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AnnouncementView } from "@/lib/announcements";

const opened: string[] = [];
const check = vi.fn();
Object.assign(globalThis, {
  window: Object.assign((globalThis as { window?: object }).window ?? {}, {
    muragebox: { openExternal: async (url: string) => { opened.push(url); return true; }, updater: { check } },
    open: vi.fn(),
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  }),
});
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { AnnouncementBanner, AnnouncementBody, AnnouncementCard, drawnLayout, runAnnouncementAction } = await import("./Announcements");
const { openAnnouncementLink, ANNOUNCEMENT_ACTION_SECTIONS, ANNOUNCEMENT_ACTIONS } = await import("@/lib/announcements");

const item = (extra: Partial<AnnouncementView> = {}): AnnouncementView => ({
  id: "flux-voice", kind: "info", layout: "hero", accent: "orange",
  title: "Voice through Flux", body: "Calls run through **Flux**.\n\nRead [the notes](https://ferroxlabs.com/notes).",
  image: "/api/announcements/image/abc", imageAlt: "A glowing orb", ...extra,
});
const handlers = { onAct: () => {}, onDismiss: () => {} };

describe("the body", () => {
  it("renders paragraphs, bold and https links as elements", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBody, { body: item().body }));
    expect(html).toMatch(/<p[^>]*>Calls run through <strong[^>]*>Flux<\/strong>\.<\/p><p[^>]*>Read <a href="https:\/\/ferroxlabs.com\/notes" target="_blank" rel="noopener noreferrer"[^>]*>the notes<\/a>\.<\/p>/);
  });

  it("never lets markup through", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBody, { body: '<img src=x onerror="alert(1)"> [x](javascript:alert(1)) <script>bad()</script>' }));
    expect(html).not.toMatch(/<img|<script|href="javascript/);
    expect(html).toContain("&lt;img");
  });

  it("opens links only over https, in the system browser", async () => {
    await openAnnouncementLink("https://ferroxlabs.com/notes");
    await openAnnouncementLink("javascript:alert(1)");
    await openAnnouncementLink("http://ferroxlabs.com");
    expect(opened).toEqual(["https://ferroxlabs.com/notes"]);
  });
});

describe("layouts", () => {
  it("draws each layout as a card and as a banner, with the picture", () => {
    for (const layout of ["hero", "split", "spotlight"] as const) {
      const card = renderToStaticMarkup(createElement(AnnouncementCard, { item: item({ kind: "important", layout }), imageUrl: "blob:x", ...handlers }));
      expect(card).toContain(`data-layout="${layout}"`);
      expect(card).toContain("whats-new-display");
      expect(card.includes('src="blob:x"')).toBe(layout !== "spotlight");
      const banner = renderToStaticMarkup(createElement(AnnouncementBanner, { item: item({ layout }), imageUrl: "blob:x", ...handlers }));
      expect(banner).toContain(`data-layout="${layout}"`);
      expect(banner).toContain(`data-accent="orange"`);
    }
  });

  it("falls back to spotlight when the picture is missing or failed", () => {
    expect(drawnLayout({ layout: "hero" }, null)).toBe("spotlight");
    expect(drawnLayout({ layout: "split" }, undefined)).toBe("spotlight");
    const html = renderToStaticMarkup(createElement(AnnouncementCard, { item: item({ kind: "security", layout: "hero" }), imageUrl: null, ...handlers }));
    expect(html).toContain('data-layout="spotlight"');
    expect(html).not.toContain("<img");
    expect(html).toContain("SECURITY");
  });

  it("offers the notice's own button and a way out, in plain words", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementCard, { item: item({ kind: "important", action: { label: "Check now", target: "check-for-updates" } }), imageUrl: "blob:x", ...handlers }));
    expect(html).toContain(">Check now<");
    expect(html).toContain(">Got it<");
    expect(html).toContain('aria-label="Close"');
    const source = readFileSync(new URL("./Announcements.tsx", import.meta.url), "utf8") + readFileSync(new URL("./AnnouncementsSettings.tsx", import.meta.url), "utf8");
    const copy = [...source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((match) => match[1]).join(" ") + [...source.matchAll(/"([A-Z][^"]{8,})"/g)].map((match) => match[1]).join(" ");
    expect(copy).not.toMatch(/—|\bsafe\b|composio/i);
  });
});

describe("actions", () => {
  it("covers every action in the fixed list, and nothing else", () => {
    const dispatched: unknown[] = [];
    for (const target of ANNOUNCEMENT_ACTIONS) runAnnouncementAction(target, (action) => dispatched.push(action));
    expect(dispatched).toEqual([
      ...Object.values(ANNOUNCEMENT_ACTION_SECTIONS).map((section) => ({ type: "toggleAppSettings", open: true, section })),
      { type: "toggleAppSettings", open: true, section: "general" },
    ]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
