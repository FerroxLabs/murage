// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Bot Settings' "Images" setting: how this bot asks before it makes an image,
// and the optional "ask again after N images" guard. Pins what the owner sees,
// which request each choice makes, and that it follows the chosen language.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { BotImageApproval, imageAskAfterPatch } from "./BotImageApproval";
import { filterBotSettingsSections } from "./bot-settings-sections";

afterEach(() => setLocale("en"));
type Shown = Parameters<typeof BotImageApproval>[0]["bot"];
const render = (bot: Shown = {}, desktop?: boolean) =>
  renderToStaticMarkup(createElement(BotImageApproval, { bot, desktop, onChoose: () => {}, onAskAfter: () => {} }));
const pressed = (markup: string) => [...markup.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)</g)].map(match => match[1]);
const radio = (markup: string, label: string) => {
  const end = markup.indexOf(`>${label}<`);
  expect(end, `no "${label}" radio`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<button", end), end + 1);
};

describe("the Images setting", () => {
  it("offers the three choices, Follow permission level pressed by default", () => {
    const markup = render();
    for (const label of ["Follow permission level", "Ask before each image", "Make images without asking"]) expect(markup).toContain(`>${label}<`);
    expect(pressed(markup)).toEqual(["Follow permission level"]);
    expect(pressed(render({ imageApproval: "ask" }))).toEqual(["Ask before each image"]);
    expect(pressed(render({ imageApproval: "allow" }))).toEqual(["Make images without asking"]);
  });

  it("gives each choice a one-line tooltip, and says what the pressed one means", () => {
    const markup = render({ imageApproval: "allow" });
    expect(radio(markup, "Follow permission level")).toContain('title="Full access and No limits make images without asking; Ask and Auto ask first."');
    expect(radio(markup, "Ask before each image")).toContain('title="Every image waits for your answer, whatever the permission level."');
    expect(radio(markup, "Make images without asking")).toContain('title="');
    expect(markup).toContain("Contacts and anyone else still get the card.");
  });

  it("has no Always allow button", () => {
    expect(render({ imageApproval: "allow" })).not.toMatch(/always allow/i);
  });

  it("shows the guard, blank for the default, with its value when set", () => {
    expect(render()).toContain("Ask again after this many images in one turn");
    expect(render()).toMatch(/<input[^>]*type="number"[^>]*value=""/);
    expect(render({ imageAskAfter: 4 })).toMatch(/<input[^>]*value="4"/);
    expect(render()).toContain("Leave blank to use the default of 50.");
  });

  it("is not offered where the server would refuse it, and says so", () => {
    const remote = render({}, false);
    expect(radio(remote, "Make images without asking")).toContain(' disabled=""');
    expect(remote).toMatch(/<input[^>]*disabled/);
    expect(remote).toContain("can only be changed in the Murage desktop app");
    expect(render({}, true)).not.toContain("can only be changed in the Murage desktop app");
    expect(radio(render({}, true), "Make images without asking")).not.toContain(' disabled=""');
  });

  it("turns what is typed into the request: blank clears, a whole number from 1 to 50 saves, anything else is refused", () => {
    expect(imageAskAfterPatch("")).toEqual({ ok: true, value: null });
    expect(imageAskAfterPatch("  ")).toEqual({ ok: true, value: null });
    expect(imageAskAfterPatch("3")).toEqual({ ok: true, value: 3 });
    expect(imageAskAfterPatch("50")).toEqual({ ok: true, value: 50 });
    for (const bad of ["0", "51", "-2", "1.5", "abc", "1e1"]) expect(imageAskAfterPatch(bad)).toEqual({ ok: false });
  });
});

describe("finding the Images setting", () => {
  it("is found by searching Bot settings for images", () => {
    expect(filterBotSettingsSections("images").map(section => section.id)).toContain("permissions");
  });
});

describe("the Images setting follows the chosen language", () => {
  it("every pack translates every new string", async () => {
    const keys = Object.keys(en).filter(key => key.startsWith("botImages."));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const [code, pack] of Object.entries(await allLocalePacks())) for (const key of keys) expect(pack[key as keyof typeof pack], `${code} ${key}`).toBeTruthy();
  });
  it("German addresses the reader as du, like the rest of the pack", async () => {
    const de = (await allLocalePacks())["de"]!;
    const text = Object.entries(de).filter(([key]) => key.startsWith("botImages.")).map(([, value]) => value).join(" ");
    expect(text).not.toMatch(/\b(Sie|Ihnen|Ihr\w*)\b/);
    expect(text).toMatch(/\b(du|dich|dir|dein\w*)\b/i);
  });
  it("renders German", async () => {
    await setLocale("de");
    const markup = render();
    expect(markup).not.toContain("Follow permission level");
    expect(markup).toContain(">Bilder<");
  });
});
