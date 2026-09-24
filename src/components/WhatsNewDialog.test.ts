// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const frames: FrameRequestCallback[] = [];
Object.assign(globalThis, {
  window: Object.assign((globalThis as { window?: object }).window ?? {}, { dispatchEvent: vi.fn(), addEventListener: () => {}, removeEventListener: () => {} }),
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
  document: { getElementById: () => null },
});
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { WhatsNewCard, WHATS_NEW_CARD_COUNT } = await import("./WhatsNewDialog");
const { runWhatsNewAction } = await import("./WhatsNewHost");
const { takeCallRequest } = await import("@/lib/call");

const source = readFileSync(new URL("./WhatsNewDialog.tsx", import.meta.url), "utf8");
const render = (index: number) => renderToStaticMarkup(createElement(WhatsNewCard, {
  index, releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.59",
  onNext: () => {}, onClose: () => {}, onAction: () => {},
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("what's new cards", () => {
  it("renders the four approved cards in order", () => {
    expect(WHATS_NEW_CARD_COUNT).toBe(4);
    expect(text(render(0))).toContain("Just talk to your bots");
    expect(text(render(1))).toContain("One goal. The right bots. Their own space.");
    expect(text(render(2))).toContain("Smarter, sharper, more yours");
    expect(text(render(3))).toContain("Plus a long list of small wins");
  });

  it("carries each card's buttons, as in the mockups", () => {
    const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => text(inner).trim());
    expect(buttons(render(0))).toEqual(["", "Call a bot", "Next"]);
    expect(buttons(render(1))).toEqual(["", "Start a project", "Next"]);
    const highlights = buttons(render(2));
    expect(highlights.slice(-2)).toEqual(["Next", "Got it"]);
    expect(highlights.length).toBe(8);
    expect(buttons(render(3))).toEqual(["Let's go"]);
    expect(render(3)).toMatch(/<a href="https:\/\/github.com\/FerroxLabs\/murage-releases\/releases\/tag\/v0.1.59" target="_blank" rel="noopener noreferrer"[^>]*>Read the full release notes<\/a>/);
  });

  it("names every card, labels the close and the pager, and gives every image text", () => {
    for (let index = 0; index < 4; index += 1) {
      const html = render(index);
      expect(html).toContain(`aria-labelledby="whats-new-title-${index + 1}"`);
      expect(html).toContain(`id="whats-new-title-${index + 1}"`);
      expect(html).toContain(`aria-label="Card ${index + 1} of 4"`);
      for (const [, alt] of html.matchAll(/<img[^>]*?alt="([^"]*)"/g)) expect(alt.length).toBeGreaterThan(10);
      expect(html.match(/<img/g)?.length ?? 0).toBe(index === 2 ? 6 : index === 3 ? 0 : 1);
    }
    expect(render(0)).toContain('aria-label="Close"');
    expect(render(1)).toContain('aria-label="Close"');
  });

  it("keeps every target at least 44px", () => {
    for (let index = 0; index < 4; index += 1) {
      const html = render(index);
      for (const [tag] of html.matchAll(/<(button|a)\b[^>]*>/g)) {
        const tile = tag.includes("data-whats-new-tile");
        expect(tile || /min-h-11|size-11/.test(tag), tag).toBe(true);
      }
    }
  });

  it("shows the six highlights as buttons that go somewhere", () => {
    const html = render(2);
    for (const action of ["search", "skills", "houseRules", "fullAccess", "commands", "shapes"]) expect(html).toContain(`data-whats-new-tile="${action}"`);
    expect(text(html)).toContain("Click any card to try it");
  });

  it("follows the house copy rules and loads no fonts from the network", () => {
    const copy = [0, 1, 2, 3].map((index) => text(render(index))).join(" ");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/composio|price|\$\d/i);
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
  const state = {
    bots: [{ id: "chief", name: "Chief", chiefOfStaff: true, chiefScope: "workspace" }, { id: "ada", name: "Ada" }],
    groups: [{ id: "room", name: "Room" }],
    selectedId: "room",
  } as never;
  const run = (action: Parameters<typeof runWhatsNewAction>[0], current = state) => {
    const dispatch = vi.fn(), project = vi.fn();
    runWhatsNewAction(action, current, dispatch, project);
    return { dispatch, project };
  };

  it("opens Settings at Search, Skills and House rules", () => {
    expect(run("search").dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "connections" });
    expect(run("skills").dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "skills" });
    expect(run("houseRules").dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "houseRules" });
  });

  it("opens the Chief's Permissions and What shapes when no bot chat is open", () => {
    for (const [action, section] of [["fullAccess", "permissions"], ["shapes", "shapes"]] as const) {
      const { dispatch } = run(action);
      expect(dispatch.mock.calls).toEqual([[{ type: "select", id: "chief" }], [{ type: "toggleSettings", open: true, intent: { section } }]]);
    }
    const onAda = { ...(state as object), selectedId: "ada" } as never;
    expect(run("shapes", onAda).dispatch.mock.calls).toEqual([[{ type: "toggleSettings", open: true, intent: { section: "shapes" } }]]);
  });

  it("calls the Chief through its own call button, and opens the New Project panel", () => {
    const { dispatch } = run("call");
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "chief" });
    expect(takeCallRequest("chief")).toBe(true);
    expect(takeCallRequest("chief")).toBe(false);
    const { dispatch: none, project } = run("project");
    expect(project).toHaveBeenCalledTimes(1);
    expect(none).not.toHaveBeenCalled();
  });

  it("focuses the open chat's composer with the / menu", () => {
    frames.length = 0;
    const { dispatch } = run("commands");
    expect(dispatch).not.toHaveBeenCalled();
    while (frames.length) frames.shift()!(0);
    const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe("murage:focus-composer");
    expect(event.detail).toEqual({ slash: true });
  });
});
