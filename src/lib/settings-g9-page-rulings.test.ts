// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 Krug review, the four pages it failed (Calls, Models in Simple, Connected apps in light, Phone in Simple). Each row
// here is the ruling as behaviour: what a person reads, in which mode, in which theme.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOT_CALL_WORDS } from "./bot-calls";
import * as Companion from "../components/CompanionSection";
import * as Paste from "../components/PasteKeys";
import * as Models from "../components/settings/pages/ModelsPage";

// Namespace reads, so each row fails on its own line where a ruling is not built yet (never one import error for all).
type Surfaces = typeof import("../components/ConnectedAppsSurfaces");
const surfacesPath = "../components/ConnectedAppsSurfaces";
const surfaces: Partial<Surfaces> = await import(/* @vite-ignore */ surfacesPath).catch(() => ({}));
const ON_CARD: Record<string, string> = surfaces.ON_CARD ?? {};
const ConnectedAccountLine = surfaces.ConnectedAccountLine ?? (() => null);
const { PasteKeysBody } = Paste;
const HELP_SIMPLE = (Paste as { HELP_SIMPLE?: string }).HELP_SIMPLE ?? "";
const HELP = (Paste as { HELP?: string }).HELP ?? "";
const checkAgainLabel = (Companion as { checkAgainLabel?: (mode?: "simple" | "advanced") => string }).checkAgainLabel ?? (() => "");
type Desktop = { desktop: boolean | undefined };
const modelsCardsFor = (Models as { modelsCardsFor?: (mode: "simple" | "advanced", input: Desktop) => ReturnType<typeof Models.modelsCards> }).modelsCardsFor
  ?? ((_mode: "simple" | "advanced", input: Desktop) => Models.modelsCards(input));

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const phoneDir = fileURLToPath(new URL("../locales/lazy/phone-calls/", import.meta.url));
const phonePack = (name: string) => JSON.parse(readFileSync(phoneDir + name, "utf8")) as Record<string, string>;
const phoneLocales = readdirSync(phoneDir).filter((name) => name.endsWith(".json") && name !== "source-hashes.json");

describe("Calls: two lists, each named for whose calls it holds", () => {
  it("names the list of calls to you, and its empty line says who has not called", () => {
    expect(BOT_CALL_WORDS.history).toBe("Calls to you");
    expect(BOT_CALL_WORDS.historyEmpty).toBe("No bot has called you yet.");
  });
  it("names the list of phone calls bots placed differently, in all eight languages", () => {
    expect(phoneLocales).toHaveLength(8);
    const en = phonePack("en.json");
    expect(en["phoneCalls.calls.title"]).toBe("Phone calls your bots placed");
    expect(en["phoneCalls.calls.none"]).toBe("No phone calls placed yet.");
    expect(en["phoneCalls.calls.title"]).not.toBe(BOT_CALL_WORDS.history);
    expect(en["phoneCalls.calls.none"]).not.toBe(BOT_CALL_WORDS.historyEmpty);
    const old: Record<string, string> = { de: "Letzte Anrufe", es: "Llamadas recientes", fr: "Appels récents", hi: "हाल की कॉल", ja: "最近の通話", "pt-br": "Ligações recentes", zh: "最近的通话", en: "Recent calls" };
    for (const name of phoneLocales) {
      const pack = phonePack(name);
      expect(pack["phoneCalls.calls.title"], name).toBeTruthy();
      expect(pack["phoneCalls.calls.title"], name).not.toBe(old[name.replace(".json", "")]);
    }
  });
  it("keeps the saved-settings counter off the page", () => {
    for (const name of phoneLocales) expect(Object.keys(phonePack(name)), name).not.toContain("phoneCalls.form.inUse");
    expect(read("../components/PhoneCallsSettings.tsx")).not.toContain("form.inUse");
  });
});

describe("Models in Simple: the weekly job first, in plain words", () => {
  it("puts Add a key first in Simple and leaves Advanced in its built order", () => {
    const simple = modelsCardsFor("simple", { desktop: true }).map((card) => card.id);
    const advanced = modelsCardsFor("advanced", { desktop: true }).map((card) => card.id);
    expect(simple[0]).toBe("models.paste-keys");
    expect(advanced[0]).toBe("models.engines");
    expect([...simple].sort()).toEqual([...advanced].sort());
    expect(simple.filter((id) => id !== "models.paste-keys")).toEqual(advanced.filter((id) => id !== "models.paste-keys"));
  });
  const body = (simple: boolean) => renderToStaticMarkup(createElement(PasteKeysBody, {
    rows: [], scanned: false, onScan: () => {}, onChoose: () => {}, onAccept: () => {}, onDismiss: () => {}, configured: null, simple,
  }));
  it("shows one short helper in Simple with no file names or product plumbing", () => {
    const html = body(true);
    expect(HELP_SIMPLE).not.toBe("");
    expect(html).toContain(HELP_SIMPLE);
    expect(html).not.toContain(".env");
    expect(html).not.toContain("Service keys");
    expect(html).not.toContain("single editor");
    expect(HELP_SIMPLE.length).toBeLessThan(HELP.length / 2);
    expect(HELP_SIMPLE).toContain("on this computer");
    expect(HELP_SIMPLE).toContain("saves nothing");
  });
  it("keeps the full helper in Advanced", () => {
    expect(body(false)).toContain(".env");
  });
});

describe("Connected apps: the same surfaces in light and in dark", () => {
  const css = read("../styles.css");
  const themes = [...css.matchAll(/\{[^{}]*--color-card:[^{}]*\}/g)].map((block) => Object.fromEntries([...block[0].matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1]!, m[2]!.toLowerCase()])));
  const token = (surface: string) => /^bg-([a-z-]+)/.exec(surface)![1]!;
  it("reads a light and a dark theme from the stylesheet", () => {
    expect(themes.some((theme) => theme.card === "#ffffff")).toBe(true);
    expect(themes.some((theme) => theme.card !== "#ffffff")).toBe(true);
  });
  it("covers the five surfaces and the button's hover", () => {
    // buttonHover added by fix review M9 (the five resting surfaces are unchanged).
    expect(Object.keys(ON_CARD).sort()).toEqual(["accountRow", "button", "buttonHover", "search", "tabs", "tile"]);
  });
  it.each(["button", "tile", "accountRow", "search", "tabs"].map((name) => [name, ON_CARD[name] ?? "bg-missing"] as const))("%s has a surface that differs from the card in every theme", (_name, surface) => {
    for (const theme of themes) {
      expect(theme[token(surface)], JSON.stringify(theme.card)).toBeTruthy();
      expect(theme[token(surface)]).not.toBe(theme.card);
    }
  });
  it("draws the panel's button, tile, account row, search box and tab strip from those surfaces", () => {
    const panel = read("../components/PluginsPanel.tsx");
    for (const name of ["button", "tile", "accountRow", "search", "tabs"]) expect(panel, name).toContain("${ON_CARD." + name + "}");
    expect(panel).not.toMatch(/bg-raised(?!-hover)/);
  });
  // Fix review M9: in light, control (#d4d4d4) hovered to raised-hover (#e5e5e5), so Add account got lighter on hover.
  const luma = (hex: string) => { const n = parseInt(hex.slice(1, 7), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
  it("hovers each button to a tone that differs from its resting surface, and darker in light", () => {
    const hover = /^hover:bg-([a-z-]+)$/.exec(ON_CARD.buttonHover ?? "")?.[1] ?? "missing";
    for (const theme of themes) {
      expect(theme[hover], `${hover} in ${theme.card}`).toBeTruthy();
      expect(theme[hover]).not.toBe(theme[token(ON_CARD.button ?? "bg-missing")]);
      if (theme.card === "#ffffff") expect(luma(theme[hover]!)).toBeLessThan(luma(theme[token(ON_CARD.button ?? "bg-missing")]!));
    }
  });
  it("gives every panel button that rests on the button surface that hover, never raised-hover", () => {
    const panel = read("../components/PluginsPanel.tsx");
    expect(panel).not.toContain("hover:bg-raised-hover");
    expect(panel).not.toMatch(/"[^"]*\bbg-control px-3 py-2/);
    expect(panel.split("${ON_CARD.button}").length - 1).toBe(panel.split("${ON_CARD.buttonHover}").length - 1);
  });
  it("never cuts the account's status word: only the id may shorten", () => {
    const html = renderToStaticMarkup(createElement(ConnectedAccountLine, { id: "gmail-work", status: "active" }));
    const host = new DOMParserLike(html);
    expect(host.classOf("data-account-status")).toContain("shrink-0");
    expect(host.classOf("data-account-status")).not.toContain("truncate");
    expect(host.classOf("data-account-id")).toContain("truncate");
    expect(html).toContain("· active");
    expect(html.indexOf("gmail-work")).toBeLessThan(html.indexOf("active"));
  });
  it("shows the status alone when the account has no label", () => {
    const html = renderToStaticMarkup(createElement(ConnectedAccountLine, { id: "", status: "needs reconnecting" }));
    expect(html).not.toContain("data-account-id");
    expect(html).not.toContain("·");
    expect(html).toContain("needs reconnecting");
  });
});

describe("Phone in Simple: the re-check link says what it does", () => {
  it("has no product name in Simple and keeps it in Advanced", () => {
    expect(checkAgainLabel("simple")).toBe("Check the connection again");
    expect(checkAgainLabel("advanced")).toBe("Check Tailscale again");
    expect(checkAgainLabel()).toBe("Check Tailscale again");
  });
  it("is the label the Status card renders", () => {
    const view = read("../components/CompanionSection.tsx");
    expect(view).toContain("{checkAgainLabel(mode)}");
    expect(view).not.toMatch(/\/>\s*Check Tailscale again/);
  });
});

/** The class attribute of the one element carrying `marker`, from static markup. */
class DOMParserLike {
  constructor(private readonly html: string) {}
  classOf(marker: string): string {
    const tag = new RegExp(`<[a-z]+[^>]*${marker}[^>]*>`).exec(this.html)?.[0] ?? "";
    return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
  }
}
