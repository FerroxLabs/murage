// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 slice B, the shell's parts as they render (SETTINGS-SHELL-CONTRACT-1019.md). The whole modal is driven in
// e2e/settings-shell.human.spec.ts; here each part is read as markup, so a wording or structure slip fails fast.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import "@/lib/settings-copy";
import type { SettingsPageCard } from "@/lib/settings-page-contract";
import { AdvancedModeCard } from "./AdvancedModeCard";
import { BrowseBotsPage, filterBotRows } from "./BrowseBotsPage";
import { PageCards, SetInAdvancedLine } from "./PageCards";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replaceAll("&#x27;", "'");

describe("the Advanced mode card", () => {
  it("is one switch, Off in Simple, named by the card's own title, with the locked note", () => {
    const out = html(createElement(AdvancedModeCard));
    expect(out).toContain("Advanced mode");
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('aria-labelledby="advanced-mode-title"');
    expect(out).toContain("Nothing is deleted either way.");
    expect(out).toContain("border-accent/40");
  });
});

describe("the page cards", () => {
  const card = (id: string, simple: boolean): SettingsPageCard => ({ id: `x.${id}`, anchor: `${id}-heading`, simple, render: () => createElement("p", null, `card ${id}`) });
  const cards = [card("one", true), card("two", false), card("three", true)];

  it("in Simple lists the Simple cards in anchors and one Set in Advanced line", () => {
    const out = html(createElement(PageCards, { cards, mode: "simple" }));
    expect(out).toContain('id="one-heading"');
    expect(out).toContain("card three");
    expect(out).not.toContain("card two");
    expect(out).toContain('data-set-in-advanced="1"');
    expect(out).toContain("More settings are in Advanced mode.");
    expect(out).toContain("Set in Advanced");
  });

  it("in Advanced lists every card and no line", () => {
    const out = html(createElement(PageCards, { cards, mode: "advanced" }));
    expect(out).toContain("card two");
    expect(out).not.toContain("data-set-in-advanced");
  });

  it("makes the line a button with a phone-sized hit area", () => {
    const out = html(createElement(SetInAdvancedLine, { count: 7 }));
    expect(out).toMatch(/<button[^>]*max-md:min-h-11/);
  });
});

describe("the breadcrumb", () => {
  it("reads Settings > group > page in a labelled nav, the last one current, with the one Copy link", () => {
    const out = html(createElement(SettingsBreadcrumb, { crumbs: [{ label: "All bots" }, { label: "Memory" }], link: "murage://settings/app/memory" }));
    expect(out).toContain('aria-label="Where you are"');
    expect(out).toContain("Settings");
    expect(out.indexOf("Settings")).toBeLessThan(out.indexOf("All bots"));
    expect(out.indexOf("All bots")).toBeLessThan(out.indexOf("Memory"));
    expect(out).toMatch(/aria-current="page"[^>]*>Memory/);
    expect(out).toContain("Copy link to this page");
    expect(out.match(/data-settings-copy-link/g)).toHaveLength(1);
    expect(out).toContain('aria-live="polite"');
  });

  it("makes only the bot segment a button, and shows no Copy link when there is no address", () => {
    const out = html(createElement(SettingsBreadcrumb, { crumbs: [{ label: "Each bot" }, { label: "Nova", onClick: () => {} }], link: null }));
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toMatch(/<button[^>]*>Nova<\/button>/);
    expect(out).not.toContain("data-settings-copy-link");
  });
});

describe("Browse bots", () => {
  const bots = [
    { id: "n", name: "Nova", chiefOfStaff: true, chiefScope: "workspace" as const },
    { id: "p", name: "Pepper Potts" },
    { id: "s", name: "Sable", individual: true },
  ];
  it("lists one row per bot with its role and an Open button named for the bot", () => {
    const out = html(createElement(BrowseBotsPage, { bots, openId: null, onOpen: () => {} }));
    expect(out.match(/data-settings-browse-row=/g)).toHaveLength(3);
    expect(out).toContain("Chief of Staff");
    expect(out).toContain('aria-label="Open Nova"');
    expect(out).toContain("Find a bot");
    expect(out.indexOf("Nova")).toBeLessThan(out.indexOf("Pepper Potts"));
  });

  it("filters by every word typed, in any order", () => {
    expect(filterBotRows(bots, "potts pep").map((bot) => bot.id)).toEqual(["p"]);
    expect(filterBotRows(bots, "").map((bot) => bot.id)).toEqual(["n", "p", "s"]);
    expect(filterBotRows(bots, "zzz")).toEqual([]);
  });

  it("says plainly when there are no bots", () => {
    const out = html(createElement(BrowseBotsPage, { bots: [], openId: null, onOpen: () => {} }));
    expect(out).toContain("No bots yet. Your Chief arrives when setup finishes.");
  });
});
