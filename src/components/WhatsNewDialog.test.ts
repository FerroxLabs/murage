// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
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
  focused = false; scrolled: unknown = null; clicked = 0;
  scrollIntoView(options: unknown) { this.scrolled = options; }
  focus() { this.focused = true; }
  click() { this.clicked += 1; }
}
Object.assign(globalThis, { HTMLElement: FakeElement });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { WhatsNewCard, WHATS_NEW_CARD_COUNT, WHATS_NEW_TILES, WHATS_NEW_MORE, WHATS_NEW_TILES_102, WHATS_NEW_MORE_102, WHATS_NEW_TILES_106, WHATS_NEW_MORE_106, whatsNewContentFor, whatsNewArrowStep } = await import("./WhatsNewDialog");
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

  it("opens Settings > Images, in view, for shapes", () => {
    frames.length = 0;
    elements.clear();
    const { dispatch, went } = run("shapes");
    expect(went).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "images" }]]);
    // not rendered yet: it waits a frame
    const heading = new FakeElement();
    elements.set("image-settings-heading", heading);
    while (frames.length) frames.shift()!(0);
    expect(heading.scrolled).toEqual({ block: "start" });
  });

  it("opens the Images Library tab for saved blocks and reference packs", () => {
    for (const action of ["blocks", "packs"] as const) {
      frames.length = 0;
      elements.clear();
      const { dispatch, went } = run(action);
      expect(went, action).toBe(true);
      expect(dispatch.mock.calls, action).toEqual([[{ type: "toggleAppSettings", open: true, section: "images" }]]);
      const tab = new FakeElement();
      elements.set("images-tab-library", tab);
      while (frames.length) frames.shift()!(0);
      expect(tab.clicked, action).toBe(1);
      expect(tab.focused, action).toBe(true);
    }
  });

  it("opens Settings at Models for Gemini", () => {
    expect(run("gemini").dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "models" }]]);
  });

  it("opens Bot defaults at the no activity limit for Work runs to the end, by anchor so the page's Advanced opens first", () => {
    const { dispatch, went } = run("longwork");
    expect(went).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "botDefaults", anchor: "room-turn-timeout" }]]);
  });

  it("gives up quietly when the setting never renders", () => {
    frames.length = 0;
    elements.clear();
    expect(run("shapes").went).toBe(true);
    let spins = 0;
    while (frames.length && spins < 100) { frames.shift()!(0); spins += 1; }
    expect(frames.length).toBe(0);
    expect(spins).toBe(60);
  });

  it("goes to the targets the settings really render", () => {
    expect(readFileSync(new URL("./ImageSettings.tsx", import.meta.url), "utf8")).toContain('id="image-settings-heading"');
    expect(readFileSync(new URL("./RoomTurnTimeoutSettings.tsx", import.meta.url), "utf8")).toContain('id="room-turn-timeout"');
    const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
    const tools = readFileSync(new URL("./ToolsSettings.tsx", import.meta.url), "utf8");
    expect(tools).toContain("id={`images-tab-${id}`}");
    expect(settings).toMatch(/section === "webSearch"[\s\S]*?<ToolsSettings/);
    expect(tools).toMatch(/<ImagesSettings \/>/);
    expect(tools).toMatch(/function ImagesSettings\(\)[\s\S]*?<ImageSettings showLibrary=\{false\} \/>/);
    expect(settings).toMatch(/section === "botDefaults"[\s\S]*?<BotsSettings/);
    expect(readFileSync(new URL("./BotsSettings.tsx", import.meta.url), "utf8")).toMatch(/<RoomTurnTimeoutSettings \/>/);
  });

  it("loads the dialog, art included, only when the page opens", () => {
    const host = readFileSync(new URL("./WhatsNewHost.tsx", import.meta.url), "utf8");
    expect(host).toContain('retryableLazy(() => import("./WhatsNewDialog")');
    expect(host).toContain('import type { WhatsNewAction } from "./WhatsNewDialog";');
    expect(host).not.toMatch(/^import \{[^}]*\} from "\.\/WhatsNewDialog";/m);
    expect(host).toContain('if (target.kind !== "page" || !whatsNew.open) return null;');
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


describe("the 1.0.2 page", () => {
  const render102 = (index: number) => renderToStaticMarkup(createElement(WhatsNewCard, {
    index, version: "1.0.2", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v1.0.2",
    onNext: () => {}, onClose: () => {}, onAction: () => {},
  }));

  it("has its own hero, six tiles and list, and leaves 0.1.61's alone", () => {
    expect(text(render102(0))).toContain("Bots that remember what matters");
    expect(text(render102(0))).toContain("Open Memory");
    expect(text(render102(0))).not.toContain("Your team, in step.");
    expect(WHATS_NEW_TILES_102.map((tile) => tile.action)).toEqual(["routing", "library", "engines", "chrome", "speed", "desktops"]);
    const html = text(render102(1));
    for (const tile of WHATS_NEW_TILES_102) { expect(html).toContain(tile.title); expect(html).toContain(tile.body); }
    expect(render102(1).match(/<img/g)?.length).toBe(6);
    const more = text(render102(2));
    for (const line of WHATS_NEW_MORE_102) expect(more).toContain(line);
    // the 0.1.61 page is what every call without 1.0.2 shows
    expect(text(render(0))).toContain("Your team, in step.");
    expect(text(render(1))).toContain("Rooms that work as one");
    expect(whatsNewContentFor("0.1.61")).toBe("0.1.61");
    expect(whatsNewContentFor("1.0.2")).toBe("1.0.2");
  });

  it("follows the house copy rules and makes no speed claim beyond the changelog", () => {
    const copy = [0, 1, 2].map((index) => text(render102(index))).join(" ");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\bsaf(e|ely|ety)\b/i);
    expect(copy).not.toMatch(/composio|price|pricing|cost|cheap|free\b|\$\d/i);
    expect(copy).not.toMatch(/\d+x\b|\bmilliseconds?\b|\bfaster than\b|\binstant/i);
    expect(copy).not.toMatch(/\b(broke|broken|used to|no longer|fixed|bug)\b/i);
  });

  it("keeps every 1.0.2 tile and button a 44px target", () => {
    for (let index = 0; index < 3; index += 1) {
      for (const [tag] of render102(index).matchAll(/<(button|a)\b[^>]*>/g)) expect(tag.includes("data-whats-new-tile") || /min-h-11|size-11/.test(tag), tag).toBe(true);
    }
  });

  it("sends every shortcut somewhere in the app", () => {
    const go = (action: Parameters<typeof runWhatsNewAction>[0]) => { const dispatch = vi.fn(); frames.length = 0; elements.clear(); return { went: runWhatsNewAction(action, dispatch), calls: dispatch.mock.calls }; };
    expect(go("memory")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "memory" }]] });
    expect(go("speed")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "memory" }]] });
    expect(go("engines")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "engines" }]] });
    // Murage for Chrome: its Chrome Web Store page, outside the app, where it is added.
    const opened: string[] = [];
    const store = vi.fn();
    expect(runWhatsNewAction("chrome", store, (url) => opened.push(url))).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(opened).toEqual(["https://chromewebstore.google.com/detail/gpilijlcanhphjaoogelbghhbhhminol"]);
    const desktops = go("desktops");
    expect(desktops.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "computer" }]]);
    const limit = new FakeElement();
    elements.set("local-vm-max-instances", limit);
    while (frames.length) frames.shift()!(0);
    expect(limit.scrolled).toEqual({ block: "start" });
    expect(go("library")).toEqual({ went: true, calls: [[{ type: "showTeamLibrary", view: "teams" }]] });
    const routing = go("routing");
    expect(routing.calls).toEqual([[{ type: "toggleAppSettings", open: true, section: "botDefaults", anchor: "room-routing-label" }]]);
  });
});


describe("the 1.0.6 page", () => {
  const render106 = (index: number) => renderToStaticMarkup(createElement(WhatsNewCard, {
    index, version: "1.0.6", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v1.0.6",
    onNext: () => {}, onClose: () => {}, onAction: () => {},
  }));
  const buttons = (html: string) => [...html.matchAll(/<button(?![^>]*data-whats-new-dot)[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => text(inner).trim());

  it("leads with Murage for Chrome in the Chrome Web Store", () => {
    const hero = text(render106(0));
    expect(hero).toContain("NEW IN MURAGE");
    expect(hero).toContain("Murage for Chrome is here");
    expect(hero).toContain("Add it from the Chrome Web Store and your bot works beside you in your own browser, on the sites you choose.");
    expect(buttons(render106(0))).toEqual(["", "Open Chrome Web Store", "Next"]);
    expect(render106(0)).toContain('alt="Two matching gold glass rings, one set inside the other"');
    expect(render106(0)).toMatch(/<img[^>]*class="block h-full w-full object-contain object-right"/);
    expect(whatsNewContentFor("1.0.6")).toBe("1.0.6");
  });

  it("has six tiles from the 1.0.6 changelog, each on art already in the app", () => {
    expect(WHATS_NEW_TILES_106.map((tile) => [tile.action, tile.title, tile.body])).toEqual([
      ["allChats", "Every chat in one list", "Find any conversation in one searchable list, opened from a wider chat pop-up."],
      ["draftOnly", "Bots that draft, you send", "A draft-only bot prepares replies for you to review and send, on every engine and channel. Ticket Triage in the library works this way."],
      ["venues", "Bots know where they belong", "Each bot knows which projects and groups it is part of."],
      ["ownWords", "Memories in your own words", "What your bots learn from you is anchored to what you said, and Forget clears it the moment you click."],
      ["fuigo", "Fuigo starts fast on Windows", "Fuigo starts quickly and steadily on Windows, however Murage was installed."],
      ["backups", "Backups that cover it all", "Every backup includes every folder Murage keeps."],
    ]);
    const html = render106(1);
    for (const tile of WHATS_NEW_TILES_106) { expect(text(html)).toContain(tile.title); expect(text(html)).toContain(tile.body); expect(html).toContain(`data-whats-new-tile="${tile.action}"`); }
    expect(html.match(/<img/g)?.length).toBe(6);
    // the same pictures as the earlier pages, each with the words that describe it there
    const earlier = new Map([...WHATS_NEW_TILES, ...WHATS_NEW_TILES_102].map((tile) => [tile.img, tile.alt]));
    for (const tile of WHATS_NEW_TILES_106) expect(earlier.get(tile.img), tile.action).toBe(tile.alt);
    expect(readdirSync(new URL("../assets/whats-new/", import.meta.url)).sort()).toEqual([
      "memory-hero.webp", "team-hero.webp", "tile-blocks.webp", "tile-chrome.webp", "tile-desktops.webp", "tile-engines.webp", "tile-gemini.webp",
      "tile-labs.webp", "tile-longwork.webp", "tile-packs.webp", "tile-rooms.webp", "tile-routing.webp", "tile-shapes.webp", "tile-speed.webp",
    ]);
  });

  it("lists the small wins and links its own release notes", () => {
    expect(WHATS_NEW_MORE_106).toHaveLength(12);
    const more = text(render106(2));
    for (const line of WHATS_NEW_MORE_106) expect(more).toContain(line);
    expect(render106(2)).toMatch(/<a href="https:\/\/github.com\/FerroxLabs\/murage-releases\/releases\/tag\/v1.0.6" target="_blank" rel="noopener noreferrer"[^>]*>Read the full release notes<\/a>/);
  });

  it("follows the house copy rules", () => {
    const copy = [0, 1, 2].map((index) => text(render106(index))).join(" ");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\b(un)?saf(e|ely|ety)\b/i);
    expect(copy).not.toMatch(/composio|price|pricing|cost|cheap|free\b|\$\d/i);
    expect(copy).not.toMatch(/\d+x\b|\bmilliseconds?\b|\bfaster than\b|\binstant/i);
    expect(copy).not.toMatch(/\b(broke|broken|used to|no longer|fixed|bug|crash)/i);
  });

  it("keeps every 1.0.6 tile and button a 44px target", () => {
    for (let index = 0; index < 3; index += 1) {
      for (const [tag] of render106(index).matchAll(/<(button|a)\b[^>]*>/g)) expect(tag.includes("data-whats-new-tile") || /min-h-11|size-11/.test(tag), tag).toBe(true);
    }
  });

  it("sends every shortcut somewhere real", () => {
    const go = (action: Parameters<typeof runWhatsNewAction>[0]) => { const dispatch = vi.fn(); const opened: string[] = []; return { went: runWhatsNewAction(action, dispatch, (url) => opened.push(url)), calls: dispatch.mock.calls, opened }; };
    expect(go("allChats")).toEqual({ went: true, calls: [[{ type: "showAllChats" }]], opened: [] });
    expect(go("draftOnly")).toEqual({ went: true, calls: [[{ type: "showTeamLibrary", view: "bots" }]], opened: [] });
    expect(go("venues")).toEqual({ went: true, calls: [[{ type: "showTeamMap" }]], opened: [] });
    expect(go("ownWords")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "memory" }]], opened: [] });
    expect(go("fuigo")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "engines" }]], opened: [] });
    expect(go("backups")).toEqual({ went: true, calls: [[{ type: "toggleAppSettings", open: true, section: "backups" }]], opened: [] });
    expect(go("chrome")).toEqual({ went: false, calls: [], opened: ["https://chromewebstore.google.com/detail/gpilijlcanhphjaoogelbghhbhhminol"] });
    // Ticket Triage is the draft-only bot the tile names, and a one-bot package shows on the Bots view
    const triage = JSON.parse(readFileSync(new URL("../../bot-library/builtins/ticket-triage.json", import.meta.url), "utf8")) as { package: { name: string; agents: Array<{ outbound?: string }> } };
    expect(triage.package.name).toBe("Ticket Triage");
    expect(triage.package.agents.map((agent) => agent.outbound)).toEqual(["draft-only"]);
  });

  it("leaves the 1.0.2 and 0.1.61 pages as they were", () => {
    expect(text(render(0))).toContain("Your team, in step.");
    expect(whatsNewContentFor("1.0.5")).toBe("0.1.61");
    expect(WHATS_NEW_TILES_102.map((tile) => tile.action)).toEqual(["routing", "library", "engines", "chrome", "speed", "desktops"]);
  });
});
