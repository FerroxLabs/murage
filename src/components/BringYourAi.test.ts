// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { generalCards } from "./settings/pages/GeneralPage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { en } from "@/locales";
import { initialState, reducer, type Action } from "@/state/store";
import { searchSettingsCards } from "@/lib/settings-search";
import { LAM_PROVIDERS } from "../../shared/learn-about-me/parse";
import { LAM_PROVIDER_NAMES, ownerNoteId, rememberedOrigin } from "../../shared/learn-about-me/origin";
import { BringYourAi, BringYourAiRow, openBringYourAi } from "./BringYourAi";

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: vi.fn() }),
}));

const KEYS = ["bringYourAi.title", "bringYourAi.lead", "bringYourAi.firstRunLine", "bringYourAi.grok", "bringYourAi.learn", "settings.l1.card.general.bring-your-ai"] as const;

describe("Bring what you already use", () => {
  it("offers both existing flows in Settings and in the first-run row", () => {
    const settings = renderToStaticMarkup(createElement(BringYourAi));
    expect(settings).toContain(en["bringYourAi.title"]);
    expect(settings).toContain(en["bringYourAi.grok"]);
    expect(settings).toContain(en["bringYourAi.learn"]);
    // Render the production card so a missing, duplicated or non-focusable
    // landing mark still fails after the General page moved out of the modal.
    const cards = generalCards({ desktop: true, cloud: false }).filter(card => card.id === "general.bring-your-ai");
    expect(cards).toHaveLength(1);
    expect(cards[0].anchor).toBe("bring-your-ai-heading");
    const landing = renderToStaticMarkup(cards[0].render());
    expect(landing).toContain(en["bringYourAi.grok"]);
    expect(landing).toContain(en["bringYourAi.learn"]);
    expect(readFileSync(new URL("./settings/page-registry.tsx", import.meta.url), "utf8")).toContain('general: () => import("./pages/GeneralPage")');
    expect(landing.match(/data-setting-control="bring-your-ai-heading"/g)).toHaveLength(1);
    expect(landing).toMatch(/<div\b(?=[^>]*data-setting-control="bring-your-ai-heading")(?=[^>]*tabindex="-1")[^>]*>/);
    const row = renderToStaticMarkup(createElement(BringYourAiRow));
    expect(row).toContain('data-testid="bring-your-ai-row"');
    expect(row).toContain(en["bringYourAi.grok"]);
    expect(row).toContain(en["bringYourAi.learn"]);
  });

  it("opens the existing Grok import tab and closes Settings, changing nothing else", () => {
    let state = { ...initialState, appSettingsOpen: true };
    openBringYourAi("grok", action => { state = reducer(state, action); });
    expect(state.appSettingsOpen).toBe(false);
    expect(state.teamLibrary).toMatchObject({ open: true, view: "bots", tab: "import" });
    expect(state.bots).toBe(initialState.bots);
    expect(state.selectedId).toBe(initialState.selectedId);
  });

  it("keeps Settings open when the owner keeps unsaved About me words", () => {
    const actions: Action[] = [];
    openBringYourAi("grok", action => actions.push(action), () => false);
    expect(actions).toEqual([]);
  });

  it("opens Learn about me at its Memory anchor without keeping anything", () => {
    const actions: Action[] = [];
    openBringYourAi("learn", action => actions.push(action));
    expect(actions).toEqual([{ type: "toggleAppSettings", open: true, section: "memory", anchor: "learn-about-me-heading" }]);
    const state = actions.reduce(reducer, initialState);
    expect(state).toMatchObject({ appSettingsOpen: true, appSettingsSection: "memory", appSettingsAnchor: "learn-about-me-heading" });
    expect(state.bots).toBe(initialState.bots);
  });

  it("is found in General by provider name, on the desktop", () => {
    for (const name of ["Grok Bot", "ChatGPT", "Claude", "dots", "Duet"]) {
      expect(searchSettingsCards(name, true).map(hit => hit.card.id)).toContain("general.bring-your-ai");
      expect(searchSettingsCards(name, false).map(hit => hit.card.id)).not.toContain("general.bring-your-ai");
    }
  });

  it("takes dots and Duet exports, and reads their kept lines back", () => {
    expect(LAM_PROVIDERS).toEqual(["chatgpt", "claude", "gemini", "grok", "copilot", "dots", "duet", "other"]);
    expect(LAM_PROVIDER_NAMES.dots).toBe("dots");
    expect(LAM_PROVIDER_NAMES.duet).toBe("Duet");
    const id = ownerNoteId("duet", "u", "0123456789abcdef0123456789abcdef");
    expect(rememberedOrigin(id)).toEqual({ provider: "duet", precision: "u" });
  });

  it("follows the copy rules", () => {
    for (const key of KEYS) {
      const text = en[key];
      expect(text, key).toBeTruthy();
      expect(text, key).not.toMatch(/[–—]|\b(safe|safely|safety|unsafe|free|price|pricing|cheap|cheaper|cost)\b/i);
    }
  });
});
