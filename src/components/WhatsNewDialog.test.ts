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
// Only an HTMLElement setting is scrolled to and focused.
class FakeElement {
  focused = false; scrolled: unknown = null;
  scrollIntoView(options: unknown) { this.scrolled = options; }
  focus() { this.focused = true; }
}
Object.assign(globalThis, { HTMLElement: FakeElement });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { WhatsNewCard, WHATS_NEW_CARD_COUNT, WHATS_NEW_TILES, WHATS_NEW_MORE, whatsNewArrowStep } = await import("./WhatsNewDialog");
const { runWhatsNewAction } = await import("./WhatsNewHost");

const source = readFileSync(new URL("./WhatsNewDialog.tsx", import.meta.url), "utf8");
const render = (index: number) => renderToStaticMarkup(createElement(WhatsNewCard, {
  index, releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.61",
  onNext: () => {}, onClose: () => {}, onAction: () => {},
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("what's new cards", () => {
  it("renders the three approved cards in order", () => {
    expect(WHATS_NEW_CARD_COUNT).toBe(3);
    const hero = text(render(0));
    expect(hero).toContain("NEW IN MURAGE");
    expect(hero).toContain("Your team, in step.");
    expect(hero).toContain("Every bot in a room sees what its teammates said, on every engine. Images get saved looks and reference packs, and long work runs until it is done.");
    expect(render(0)).toContain('alt="A constellation of orange orbs of light, each joined to every other by fine threads"');
    expect(text(render(1))).toContain("AND THERE'S MORE");
    expect(text(render(1))).toContain("Made for bigger work");
    expect(text(render(2))).toContain("AND A LOT MORE");
    expect(text(render(2))).toContain("Plus a long list of small wins");
  });

  it("carries the six approved tiles, in order, with their bodies, dots and pictures", () => {
    expect(WHATS_NEW_TILES.map((tile) => [tile.action, tile.dot, tile.title, tile.body, tile.alt])).toEqual([
      ["rooms", "bg-[var(--wn-accent)]", "Rooms that work as one", "Every bot in a room sees what its teammates said, and bots on Fuigo can ask and hand off to teammates again.", "Three glowing orange glass pebbles sharing one pool of light"],
      ["blocks", "bg-[var(--wn-dot-gold)]", "Saved prompt blocks", "Save a character or a brand look as a named block, and every change keeps its own version.", "A stack of gold glass slabs with one slid forward"],
      ["packs", "bg-[var(--wn-dot-violet)]", "Reference packs", "Keep up to 16 reference images as a named pack and use them again whenever you need them.", "A fan of blank violet glass panes"],
      ["shapes", "bg-[var(--wn-dot-blue)]", "Any shape, any size", "Portrait, landscape or exact pixels, several at once, PNG, JPEG or WebP, a seed or a clear background, where the model allows.", "Four blue frames of light in different proportions"],
      ["gemini", "bg-[var(--wn-dot-mint)]", "Gemini for chat and images", "Add your Google Gemini key once and bots can chat on Gemini and make images with it.", "Two mint spheres joined by a looping ribbon of light"],
      ["longwork", "bg-[var(--wn-ink)]", "Work runs to the end", "No fixed clocks: a working turn or a long command stops only when it goes quiet or you press Stop.", "One unbroken line of white light crossing a dark plain"],
    ]);
    const html = text(render(1));
    for (const tile of WHATS_NEW_TILES) { expect(html).toContain(tile.title); expect(html).toContain(tile.body); }
    for (const name of ["team-hero", "tile-rooms", "tile-blocks", "tile-packs", "tile-shapes", "tile-gemini", "tile-longwork"]) expect(source).toContain(`@/assets/whats-new/${name}.webp`);
  });

  it("lists the small wins", () => {
    expect(WHATS_NEW_MORE).toEqual([
      "Your recovery key stays out of cloud-synced folders",
      "A one-time Move for a recovery key that already syncs",
      "Translations load when you pick them, so Murage opens faster",
      "The first 10 images in a message go through, with a note for the rest",
      "Withheld replies stay withheld, in memory and handoffs too",
      "Each teammate gets its turn right after its own reply",
      "Room replies stop only after 20 quiet minutes",
      "Long image renders are followed to the end",
      "See each image model's limits and when it last worked",
      "Every saved image-capable key shows in Image generation",
      "Slow models on MiniMax, xAI and OpenAI-compatible engines get time to answer",
      "Tool names match the engine each bot runs on",
    ]);
    const html = text(render(2));
    for (const line of WHATS_NEW_MORE) expect(html).toContain(line);
  });

  it("carries each card's buttons, as in the mockups", () => {
    // Pager dots are buttons too (three, no text), and come last.
    const buttons = (html: string) => [...html.matchAll(/<button(?![^>]*data-whats-new-dot)[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => text(inner).trim());
    expect(buttons(render(0))).toEqual(["", "Open Teams", "Next"]);
    const highlights = buttons(render(1));
    expect(highlights.slice(-3)).toEqual(["Back", "Next", "Got it"]);
    expect(highlights.length).toBe(9);
    expect(buttons(render(2))).toEqual(["Back", "Let's go"]);
    expect(render(2)).toMatch(/<a href="https:\/\/github.com\/FerroxLabs\/murage-releases\/releases\/tag\/v0.1.61" target="_blank" rel="noopener noreferrer"[^>]*>Read the full release notes<\/a>/);
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
    for (const action of ["rooms", "blocks", "packs", "shapes", "gemini", "longwork"]) expect(html).toContain(`data-whats-new-tile="${action}"`);
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
  const run = (action: Parameters<typeof runWhatsNewAction>[0]) => {
    const dispatch = vi.fn();
    const went = runWhatsNewAction(action, dispatch);
    return { dispatch, went };
  };

  it("opens the Team map for Open Teams and Rooms that work as one", () => {
    for (const action of ["teams", "rooms"] as const) {
      const { dispatch, went } = run(action);
      expect(went, action).toBe(true);
      expect(dispatch.mock.calls, action).toEqual([[{ type: "showTeamMap" }]]);
    }
  });

  it("opens Image generation, in view, for blocks, packs and shapes", () => {
    for (const action of ["blocks", "packs", "shapes"] as const) {
      frames.length = 0;
      elements.clear();
      const { dispatch, went } = run(action);
      expect(went, action).toBe(true);
      expect(dispatch.mock.calls, action).toEqual([[{ type: "toggleAppSettings", open: true, section: "connections" }]]);
      // not rendered yet: it waits a frame
      const heading = new FakeElement();
      elements.set("image-settings-heading", heading);
      while (frames.length) frames.shift()!(0);
      expect(heading.scrolled, action).toEqual({ block: "start" });
    }
  });

  it("opens Settings at Models for Gemini", () => {
    expect(run("gemini").dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "models" }]]);
  });

  it("opens General at the no activity limit, in view and focused, for Work runs to the end", () => {
    frames.length = 0;
    elements.clear();
    const { dispatch, went } = run("longwork");
    expect(went).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "general" }]]);
    const field = new FakeElement();
    elements.set("room-turn-timeout", field);
    while (frames.length) frames.shift()!(0);
    expect(field.scrolled).toEqual({ block: "start" });
    expect(field.focused).toBe(true);
  });

  it("gives up quietly when the setting never renders", () => {
    frames.length = 0;
    elements.clear();
    expect(run("longwork").went).toBe(true);
    let spins = 0;
    while (frames.length && spins < 100) { frames.shift()!(0); spins += 1; }
    expect(frames.length).toBe(0);
    expect(spins).toBe(60);
  });

  it("goes to the targets the settings really render", () => {
    expect(readFileSync(new URL("./ImageSettings.tsx", import.meta.url), "utf8")).toContain('id="image-settings-heading"');
    expect(readFileSync(new URL("./RoomTurnTimeoutSettings.tsx", import.meta.url), "utf8")).toContain('id="room-turn-timeout"');
    const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/section === "connections"[\s\S]*?<ImageSettings \/>/);
    expect(settings).toMatch(/section === "general"[\s\S]*?<RoomTurnTimeoutSettings \/>/);
  });

  it("loads the dialog, art included, only when the page opens", () => {
    const host = readFileSync(new URL("./WhatsNewHost.tsx", import.meta.url), "utf8");
    expect(host).toContain('retryableLazy(() => import("./WhatsNewDialog")');
    expect(host).toContain('import type { WhatsNewAction } from "./WhatsNewDialog";');
    expect(host).not.toMatch(/^import \{[^}]*\} from "\.\/WhatsNewDialog";/m);
    expect(host).toContain("if (!page || !whatsNew.open) return null;");
  });

  it("can go back from every card after the first, and every dot goes to its card (D11)", () => {
    // Card 3 had no way back: its dots were a picture and the arrow keys did nothing.
    const calls: string[] = [];
    const card = (index: number) => WhatsNewCard({
      index, releaseNotesUrl: "https://example.invalid", onNext: () => calls.push("next"), onClose: () => calls.push("close"), onAction: () => {},
      onBack: () => calls.push("back"), onGo: (target: number) => calls.push(`go ${target}`),
    });
    const find = (node: unknown, match: (props: Record<string, unknown>) => boolean, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
      if (Array.isArray(node)) { for (const child of node) find(child, match, found); return found; }
      if (!node || typeof node !== "object") return found;
      const element = node as { type?: unknown; props?: Record<string, unknown> };
      if (typeof element.type === "function") return find((element.type as (props: unknown) => unknown)(element.props), match, found);
      if (element.props) { if (match(element.props)) found.push(element.props); find(element.props.children, match, found); }
      return found;
    };
    for (let index = 0; index < 3; index += 1) {
      const dots = find(card(index), (props) => props["data-whats-new-dot"] !== undefined);
      expect(dots.map((dot) => dot["aria-label"])).toEqual(["Card 1", "Card 2", "Card 3"]);
      expect(dots.map((dot) => dot["aria-current"])).toEqual([0, 1, 2].map((dot) => (dot === index ? "step" : undefined)));
      calls.length = 0;
      for (const dot of dots) (dot.onClick as () => void)();
      expect(calls).toEqual(["go 0", "go 1", "go 2"]);
      const back = find(card(index), (props) => props.children === "Back");
      expect(back.length, `card ${index + 1}`).toBe(index === 0 ? 0 : 1);
      if (back[0]) { calls.length = 0; (back[0].onClick as () => void)(); expect(calls).toEqual(["back"]); }
    }
  });

  it("pages with the arrow keys on every card", () => {
    expect(whatsNewArrowStep("ArrowRight")).toBe(1);
    expect(whatsNewArrowStep("ArrowLeft")).toBe(-1);
    expect(whatsNewArrowStep("Tab")).toBe(0);
    // The dialog applies the step with a clamp, the same on every card.
    expect(source).toMatch(/const step = whatsNewArrowStep\(event\.key\);\s*if \(step !== 0\) \{ event\.preventDefault\(\); go\(index \+ step\); return; \}/);
    expect(source).toContain("setIndex(Math.max(0, Math.min(target, WHATS_NEW_CARD_COUNT - 1)))");
  });
});

