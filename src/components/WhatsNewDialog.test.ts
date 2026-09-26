// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const frames: FrameRequestCallback[] = [];
const elements = new Map<string, unknown>();
Object.assign(globalThis, {
  window: Object.assign((globalThis as { window?: object }).window ?? {}, { dispatchEvent: vi.fn(), addEventListener: () => {}, removeEventListener: () => {} }),
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
  document: { getElementById: (id: string) => elements.get(id) ?? null },
});
// Only an HTMLElement toggle is opened and focused.
class FakeElement {
  expanded = "false"; clicks = 0; focused = false; scrolled: unknown = null;
  getAttribute(name: string) { return name === "aria-expanded" ? this.expanded : null; }
  click() { this.clicks += 1; this.expanded = "true"; }
  scrollIntoView(options: unknown) { this.scrolled = options; }
  focus() { this.focused = true; }
}
Object.assign(globalThis, { HTMLElement: FakeElement });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { WhatsNewCard, WHATS_NEW_CARD_COUNT, WHATS_NEW_TILES, WHATS_NEW_MORE } = await import("./WhatsNewDialog");
const { runWhatsNewAction } = await import("./WhatsNewHost");

const source = readFileSync(new URL("./WhatsNewDialog.tsx", import.meta.url), "utf8");
const render = (index: number) => renderToStaticMarkup(createElement(WhatsNewCard, {
  index, releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.60",
  onNext: () => {}, onClose: () => {}, onAction: () => {},
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("what's new cards", () => {
  it("renders the three approved cards in order", () => {
    expect(WHATS_NEW_CARD_COUNT).toBe(3);
    const hero = text(render(0));
    expect(hero).toContain("Your work, kept.");
    expect(hero).toContain("Backups that run themselves, a copy somewhere else, and routines that get on with it.");
    expect(text(render(1))).toContain("Built to be relied on");
    expect(text(render(2))).toContain("Plus a long list of small wins");
  });

  it("carries the six approved tiles, in order", () => {
    expect(WHATS_NEW_TILES.map((tile) => [tile.action, tile.title])).toEqual([
      ["backups", "Backups, start to finish"],
      ["offsite", "Off-site, your way"],
      ["routines", "Routines that keep going"],
      ["delete", "Delete means gone"],
      ["help", "Help, built in"],
      ["aboutMe", "About me"],
    ]);
    const html = text(render(1));
    for (const tile of WHATS_NEW_TILES) expect(html).toContain(tile.body);
  });

  it("lists the small wins", () => {
    expect(WHATS_NEW_MORE).toEqual([
      "Snooze conversations",
      "Manage teams (rename, members, lead, delete)",
      "Always allow this exact command",
      "Every voice has a play button",
      "Plain names for connected-app tools",
      "Connected apps stay connected",
      "Photo uploads from the web app in your phone's browser work again",
    ]);
    const html = text(render(2));
    for (const line of WHATS_NEW_MORE) expect(html).toContain(line);
  });

  // Reading keys, and spending on images, still ask on No limits, so the
  // routines tile may not promise it never asks.
  it("does not promise a routine never asks", () => {
    const routines = WHATS_NEW_TILES.find((tile) => tile.action === "routines")!;
    expect(routines.body).not.toMatch(/\bnever\b/i);
  });

  it("carries each card's buttons, as in the mockups", () => {
    const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => text(inner).trim());
    expect(buttons(render(0))).toEqual(["", "Open Backups", "Next"]);
    const highlights = buttons(render(1));
    expect(highlights.slice(-2)).toEqual(["Next", "Got it"]);
    expect(highlights.length).toBe(8);
    expect(buttons(render(2))).toEqual(["Let's go"]);
    expect(render(2)).toMatch(/<a href="https:\/\/github.com\/FerroxLabs\/murage-releases\/releases\/tag\/v0.1.60" target="_blank" rel="noopener noreferrer"[^>]*>Read the full release notes<\/a>/);
  });

  it("names every card, labels the close and the pager, and gives every image text", () => {
    for (let index = 0; index < 3; index += 1) {
      const html = render(index);
      expect(html).toContain(`aria-labelledby="whats-new-title-${index + 1}"`);
      expect(html).toContain(`id="whats-new-title-${index + 1}"`);
      expect(html).toContain(`aria-label="Card ${index + 1} of 3"`);
      for (const [, alt] of html.matchAll(/<img[^>]*?alt="([^"]*)"/g)) expect(alt.length).toBeGreaterThan(10);
      expect(html.match(/<img/g)?.length ?? 0).toBe(index === 1 ? 6 : index === 2 ? 0 : 1);
    }
    expect(render(0)).toContain('aria-label="Close"');
  });

  it("keeps every target at least 44px", () => {
    for (let index = 0; index < 3; index += 1) {
      const html = render(index);
      for (const [tag] of html.matchAll(/<(button|a)\b[^>]*>/g)) {
        const tile = tag.includes("data-whats-new-tile");
        expect(tile || /min-h-11|size-11/.test(tag), tag).toBe(true);
      }
    }
  });

  it("shows the six highlights as buttons", () => {
    const html = render(1);
    for (const action of ["backups", "offsite", "routines", "delete", "help", "aboutMe"]) expect(html).toContain(`data-whats-new-tile="${action}"`);
    expect(text(html)).toContain("Click any card to try it");
  });

  it("follows the house copy rules and loads no fonts from the network", () => {
    const copy = [0, 1, 2].map((index) => text(render(index))).join(" ");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\bsaf(e|ely|ety)\b/i);
    expect(copy).not.toMatch(/composio|price|pricing|cost|cheap|free\b|\$\d/i);
    expect(source).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(readFileSync(new URL("../styles.css", import.meta.url), "utf8")).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it("closes on Escape through the dialog's cancel, and respects reduced motion", () => {
    expect(source).toContain("onCancel={(event) => { event.preventDefault(); onClose(); }}");
    expect(source).toContain("element.showModal()");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.whats-new-card \{ animation: none; \}/);
  });
});

describe("where the shortcuts go", () => {
  const run = (action: Parameters<typeof runWhatsNewAction>[0], bots: Parameters<typeof runWhatsNewAction>[2] = []) => {
    const dispatch = vi.fn();
    const went = runWhatsNewAction(action, dispatch, bots);
    return { dispatch, went };
  };

  it("opens Settings at Backups and About me", () => {
    expect(run("backups").dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "backups" }]]);
    expect(run("aboutMe").dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "aboutMe" }]]);
  });

  it("opens Backups at the off-site copy, expanded, in view and focused", () => {
    frames.length = 0;
    elements.clear();
    const { dispatch, went } = run("offsite");
    expect(went).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "backups" }]]);
    // not rendered yet: it waits a frame
    const toggle = new FakeElement();
    elements.set("backup-offsite-toggle", toggle);
    while (frames.length) frames.shift()!(0);
    expect(toggle.clicks).toBe(1);
    expect(toggle.scrolled).toEqual({ block: "start" });
    expect(toggle.focused).toBe(true);
    // already open: not closed again
    const open = new FakeElement();
    open.expanded = "true";
    elements.set("backup-offsite-toggle", open);
    run("offsite");
    expect(open.clicks).toBe(0);
    expect(open.focused).toBe(true);
  });

  it("opens Routines", () => {
    expect(run("routines").dispatch.mock.calls).toEqual([[{ type: "showRoutines" }]]);
  });

  it("opens the Chief of Staff's conversation for Help, built in, and focuses its composer", () => {
    const bots = [{ id: "hid", name: "Hid", hidden: true }, { id: "ada", name: "Ada" }, { id: "chief", name: "Chief", chiefOfStaff: true, chiefScope: "workspace" }] as never;
    frames.length = 0;
    const { dispatch, went } = run("help", bots);
    expect(went).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "select", id: "chief" }]]);
    while (frames.length) frames.shift()!(0);
    const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe("murage:focus-composer");
    expect(event.detail).toEqual({ botId: "chief" });
  });

  it("falls back to the first bot without a Chief, and only closes with no bots", () => {
    const noChief = [{ id: "hid", name: "Hid", hidden: true }, { id: "ada", name: "Ada" }, { id: "lead", name: "Lead", chiefOfStaff: true }] as never;
    expect(run("help", noChief).dispatch.mock.calls).toEqual([[{ type: "select", id: "ada" }]]);
    const none = run("help", []);
    expect(none.went).toBe(false);
    expect(none.dispatch).not.toHaveBeenCalled();
  });

  // murage_help is mounted only on engines with the agents tools (Claude
  // Code, Codex, Pi, the ACP engines, Antigravity on full auto), so the tile
  // may not promise that every bot answers from the help pages.
  it("does not promise every bot reads the help pages", () => {
    const help = WHATS_NEW_TILES.find((tile) => tile.action === "help")!;
    expect(help.body).not.toMatch(/\b(any|every) bot\b/i);
    expect(WHATS_NEW_MORE.join(" ")).not.toMatch(/\b(any|every) bot\b/i);
  });

  it("only closes the page for Delete means gone", () => {
    const { dispatch, went } = run("delete");
    expect(went).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
