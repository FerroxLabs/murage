// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { ProjectLifecycleBanner } from "./ProjectLifecycleBanner";
import { ProjectTabs } from "./ProjectTabs";

afterEach(() => setLocale("en"));

const banner = (props: Partial<Parameters<typeof ProjectLifecycleBanner>[0]> = {}) =>
  renderToStaticMarkup(createElement(ProjectLifecycleBanner, { closing: false, closed: true, reopening: false, onReopen: () => {}, ...props }));
const tabs = () => renderToStaticMarkup(createElement(ProjectTabs, { isProject: true, value: "chat", onChange: () => {}, onSettings: () => {} }));

describe("project screens follow the chosen language", () => {
  it("renders English through the catalogue, word for word", () => {
    expect(banner()).toContain("This project is closed. Routines stay paused until you resume each one.");
    expect(banner()).toContain(">Reopen<");
    expect(tabs()).toContain('aria-label="Project views"');
    expect(tabs()).toContain(">Board<");
  });

  it("renders German when the locale is de", async () => {
    await setLocale("de");
    expect(banner()).toContain("Dieses Projekt ist geschlossen.");
    expect(banner()).toContain(">Wieder öffnen<");
    expect(banner()).not.toContain("This project is closed");
    const html = tabs();
    expect(html).toContain('aria-label="Projektansichten"');
    expect(html).toContain(">Überblick<");
    expect(html).toContain('aria-label="Projekteinstellungen"');
    expect(html).not.toContain("Project views");
  });

  it("interpolates placeholders in a translated string", async () => {
    await setLocale("fr");
    expect(banner({ closed: false, closing: true, leadName: "Ada" })).toContain("Clôture en cours : en attente du résumé de Ada");
  });
});

describe("projects.* catalogue", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("projects."));

  it("has every key in every pack, without em dashes or banned words", async () => {
    expect(keys.length).toBeGreaterThan(300);
    const packs = await allLocalePacks();
    for (const [code, pack] of Object.entries(packs)) {
      for (const key of keys) {
        const value = (pack as Record<string, string | undefined>)[key];
        expect(value, `${code} ${key}`).toBeTruthy();
        expect(value, `${code} ${key}`).not.toMatch(/—|composio/i);
      }
    }
    for (const key of keys) expect(en[key as keyof typeof en], key).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
  });
});
