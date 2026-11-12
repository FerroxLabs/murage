// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHONE-UI-1019 unit pins. The layout itself is pinned by
// src/e2e/phone-ui-1019.human.spec.ts; these cover what runs without a browser:
// the whole stylesheet parsed into rules (the styled scroll bars live only in
// the fine-pointer, no-coarse-pointer media block), the Help launcher's markup
// on and off a modal, and where focus goes when help closes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { canTakeFocus, helpReturnTarget, HelpLauncher, openerToRecord } from "./help/HelpHost";

interface Rule { media: string; text: string }
/** Every block of the stylesheet with the @media conditions around it (comments removed). */
function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const walk = (from: number, to: number, media: string) => {
    let i = from;
    while (i < to) {
      const open = src.indexOf("{", i);
      if (open < 0 || open >= to) return;
      let depth = 1, j = open + 1;
      while (j < to && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const head = src.slice(i, open).trim();
      if (head.startsWith("@media")) walk(open + 1, j - 1, `${media} ${head.slice(6).trim()}`.trim());
      else out.push({ media, text: `${head} {${src.slice(open + 1, j - 1)}}` });
      i = j;
    }
  };
  walk(0, src.length, "");
  return out;
}
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const rules = parseRules(css);
/** Evaluates a rule's media condition for a device: its PRIMARY pointer/hover, plus whether any other pointer is coarse. */
function appliesTo(media: string, device: { primary: "fine" | "coarse"; hover: boolean; anyCoarse: boolean }): boolean {
  const feature = (name: string, value: string) => new RegExp(`(?<!any-)${name}:\\s*${value}`).test(media);
  if (/any-pointer|any-hover/.test(media)) return false; // a rule that looks at a secondary pointer is not a primary-pointer rule
  if (feature("hover", "hover") && !device.hover) return false;
  if (feature("pointer", "fine") && device.primary !== "fine") return false;
  if (feature("pointer", "coarse") && device.primary !== "coarse") return false;
  return true;
}
const touchLaptop = { primary: "fine", hover: true, anyCoarse: true } as const;
const phone = { primary: "coarse", hover: false, anyCoarse: true } as const;
const mouseDesktop = { primary: "fine", hover: true, anyCoarse: false } as const;

describe("styled scroll bars are for a mouse only", () => {
  const styled = rules.filter((r) => /scrollbar-width:\s*thin|::-webkit-scrollbar/.test(r.text) && !/no-scrollbar/.test(r.text));
  it("exist, and every one sits in the hover + fine PRIMARY pointer media block, with no any-pointer clause", () => {
    expect(styled.length).toBeGreaterThanOrEqual(5);
    for (const rule of styled) {
      expect(rule.media, rule.text.slice(0, 60)).toMatch(/hover:\s*hover/);
      expect(rule.media, rule.text.slice(0, 60)).toMatch(/pointer:\s*fine/);
      expect(rule.media, rule.text.slice(0, 60)).not.toMatch(/any-pointer|any-hover/);
    }
  });
  it("fine primary + coarse secondary (a touch laptop) => styled; coarse primary (phone, tablet) => not", () => {
    for (const rule of styled) {
      expect(appliesTo(rule.media, mouseDesktop)).toBe(true);
      expect(appliesTo(rule.media, touchLaptop), "touch laptop").toBe(true);
      expect(appliesTo(rule.media, phone), "phone").toBe(false);
    }
  });
  it("the chip rows' bar is hidden at phone widths only", () => {
    const hidden = rules.filter((r) => r.text.includes(".no-scrollbar-phone"));
    expect(hidden.length).toBe(2);
    for (const rule of hidden) expect(rule.media).toMatch(/max-width:\s*767\.98px/);
  });
});

describe("HelpLauncher", () => {
  const html = (inModal: boolean) => renderToStaticMarkup(createElement(HelpLauncher, { onOpen: () => undefined, inModal }));
  it("outside a modal is the floating tab, hidden below md, and nothing else", () => {
    const out = html(false);
    expect(out).toContain("data-help-launcher");
    expect(out).toMatch(/class="[^"]*max-md:hidden/);
    expect(out).not.toContain("data-help-modal-button");
  });
  it("inside a modal adds a labelled, non-floating Help button that only phones see", () => {
    const out = html(true);
    const button = out.slice(out.indexOf("<button", out.indexOf("data-help-modal-button") - 60));
    expect(button).toContain("Help");
    expect(button).toContain("md:hidden");
    expect(button).not.toContain("fixed");
  });
});

describe("where focus goes when help closes", () => {
  const el = (over: Record<string, unknown> = {}) => ({ isConnected: true, closest: () => null, checkVisibility: () => true, ...over }) as unknown as HTMLElement;
  const rootWith = (found: Record<string, HTMLElement>) => ({ querySelector: (selector: string) => found[selector] ?? null }) as unknown as ParentNode;
  it("a hidden or inert trigger is not a target", () => {
    expect(canTakeFocus(el())).toBe(true);
    expect(canTakeFocus(el({ checkVisibility: () => false }))).toBe(false);
    expect(canTakeFocus(el({ closest: () => ({}) }))).toBe(false);
    expect(canTakeFocus(el({ isConnected: false }))).toBe(false);
  });
  it("prefers the opener, then the tab, then the modal button, then the phone's bot-list toggle", () => {
    const opener = el(), tab = el(), modal = el(), toggle = el();
    const all = { "[data-help-launcher]": tab, "[data-help-modal-button]": modal, "[data-open-bot-list]": toggle };
    expect(helpReturnTarget(opener, rootWith(all))).toBe(opener);
    expect(helpReturnTarget(el({ checkVisibility: () => false }), rootWith(all))).toBe(tab);
    const hiddenTab = el({ checkVisibility: () => false });
    expect(helpReturnTarget(null, rootWith({ ...all, "[data-help-launcher]": hiddenTab }))).toBe(modal);
    expect(helpReturnTarget(el({ closest: () => ({}) }), rootWith({ "[data-open-bot-list]": toggle }))).toBe(toggle);
    expect(helpReturnTarget(null, rootWith({}))).toBeNull();
  });
  it("never records <body> as the opener, so the fallbacks still run", () => {
    const body = {} as Element;
    class FakeEl {}
    vi.stubGlobal("HTMLElement", FakeEl);
    try {
      const button = new FakeEl() as unknown as Element;
      expect(openerToRecord(body, body)).toBeNull();
      expect(openerToRecord(null, body)).toBeNull();
      expect(openerToRecord(button, body)).toBe(button);
      const bodyEl = new FakeEl() as unknown as Element;
      expect(openerToRecord(bodyEl, bodyEl), "body is an element too").toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});
