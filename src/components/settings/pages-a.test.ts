// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 Settings pages 1 to 7 (SETPAGES-A): each page lists every card the registry gives it, once, with the registry's
// anchor; Simple flags come from one list; the legacy block of each moved page is gone; the shell edge (a link to an
// Advanced-only card from Simple turns Advanced on) is one rule over data.
import { readFileSync, readdirSync } from "node:fs";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageCardProblems } from "@/lib/settings-page-contract";
import { SETTINGS_CARDS } from "@/lib/settings-card-registry";
import { cardForAnchor } from "@/lib/settings-cards";
import { isAdvancedOnlyCard, isSimpleCard } from "@/lib/settings-simple-cards";
import { SETTINGS_PAGE_LOADERS } from "./page-registry";
import { botDefaultsCards } from "./pages/BotDefaultsPage";
import { callsCards } from "./pages/CallsPage";
import { generalCards } from "./pages/GeneralPage";
import { memoryCards } from "./pages/MemoryPage";
import { modelsCards } from "./pages/ModelsPage";
import { webSearchCards } from "./pages/SearchImagesDictationPage";
import { skillsCards } from "./pages/SkillsPage";
import { InAdvanced, Part, PartSlot, PartsHost } from "../SettingsPrimitives";
import { VoiceNotesStatus } from "../TranscriptionSettings";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** Section 2.4 of the split with SETPAGES-B: connections.phone-calls renders on Calls. The registry line is B's; until the
 *  branches meet, the registry here still says connections, so this view applies the move. */
const registry = SETTINGS_CARDS.map((entry) => (entry.id === "connections.phone-calls" ? { ...entry, section: "calls" as const } : entry));
const on = { desktop: true as const, cloud: false };
/** memory.limit (the monthly learning limit) is SETPAGES-B's: it moves to Usage there. Until the branches meet, the registry
 *  here still lists it on Memory, so pages 5 to 7 are checked against the registry without it. */
// The browser is a nested search destination within the existing people card, not another page-level slot.
const registryA = registry.filter((entry) => entry.id !== "memory.limit" && entry.id !== "memory.browser");

it("reports the configured voice-note route without claiming service health or guessing a missing route", () => {
  const voice = (route?: string | null) => renderToStaticMarkup(createElement(VoiceNotesStatus, { route }));
  for (const [route, service] of [["flux", "Flux"], ["groq", "Groq"], ["openai", "OpenAI"]]) {
    expect(voice(route)).toContain(`Configured to transcribe voice notes with ${service}.`);
    expect(voice(route)).toContain("Service availability is checked when you transcribe.");
  }
  expect(voice(null)).toContain("Add a Flux, Groq or OpenAI connection");
  for (const route of [undefined, "unrecognized"]) expect(voice(route)).toContain("status is unavailable");
  expect(voice("groq")).toContain("Chat attachments and phone recordings also need a Flux key.");
});

describe("pages 1 to 4 list every registered card once", () => {
  it.each([
    ["general", generalCards(on)],
    ["calls", callsCards(on)],
    ["botDefaults", botDefaultsCards(on)],
    ["skills", skillsCards(on)],
    ["memory", memoryCards(on)],
    ["models", modelsCards(on)],
    ["webSearch", webSearchCards(on)],
  ] as const)("%s", (page, cards) => {
    expect(pageCardProblems(page, cards, registryA)).toEqual([]);
  });

  it("each page has a loader and no legacy block left in the modal", () => {
    const modal = read("../SettingsModal.tsx");
    for (const page of ["general", "calls", "botDefaults", "skills", "memory", "models", "webSearch"] as const) {
      expect(SETTINGS_PAGE_LOADERS[page], page).toBeTypeOf("function");
      expect(modal, page).not.toContain(`section === "${page}"`);
    }
  });
});

describe("Simple and Advanced on General", () => {
  it("Simple keeps the mode switch, About you, Appearance, Notifications and sounds and Start at login", () => {
    expect(generalCards(on).filter((card) => card.simple).map((card) => card.id)).toEqual([
      "general.mode", "general.profile", "general.about-me", "general.appearance", "general.sidebar-density", "general.notifications", "general.startup",
    ]);
  });
  it("Calls, How every bot behaves, Skills, Memory and Search, images and dictation have no Simple card (their pages are Advanced)", () => {
    for (const cards of [callsCards(on), botDefaultsCards(on), skillsCards(on), memoryCards(on), webSearchCards(on)]) expect(cards.some((card) => card.simple)).toBe(false);
  });
  it("a card a person can reach from Simple is exactly the ones the list names", () => {
    expect(isSimpleCard("general.profile")).toBe(true);
    expect(isSimpleCard("general.sidebar-density")).toBe(true);
    expect(isSimpleCard("general.language")).toBe(false);
  });
});

describe("a link to a card Simple leaves out turns Advanced on (shell edge, item a)", () => {
  it("is decided from data, before any page file has loaded", () => {
    expect(isAdvancedOnlyCard("general", "general.language")).toBe(true);
    expect(isAdvancedOnlyCard("general", "general.profile")).toBe(false);
    expect(isAdvancedOnlyCard("skills", "skills.library")).toBe(true);
    expect(isAdvancedOnlyCard("connections", "channels.slack")).toBe(false); // Messaging retains its Simple card within Apps
  });
  it("the modal's landing effect applies it to the card the anchor names, for both page families", () => {
    const modal = read("../SettingsModal.tsx");
    expect(modal).toMatch(/if \(card && mode === "simple" && isAdvancedOnlyCard\(card.section, card.id\)\) \{\s*setSettingsMode\("advanced"\);\s*return;/);
    const card = cardForAnchor(SETTINGS_CARDS, "language-heading");
    expect(card && isAdvancedOnlyCard(card.section, card.id)).toBe(true);
  });
});

describe("Set in Advanced keeps keyboard focus (shell edge, item b)", () => {
  it("moves focus to the first revealed card, or the mode footer for the sidebar line, after the line has gone", () => {
    const source = read("./PageCards.tsx");
    expect(source).toContain("focusSoon(focusTarget)");
    expect(source).toContain("firstHidden");
    expect(source).toContain("[data-settings-mode-footer]");
  });
});

describe("a page that owns no anchor twice", () => {
  it("the components moved onto pages no longer carry the card's anchor on a second element", () => {
    for (const [file, id] of [["../AboutMeSettings.tsx", "about-me-heading"], ["../CallsSettings.tsx", "calls-settings-title"], ["../HouseRulesSettings.tsx", "house-rules-heading"], ["../skills/SkillsSettings.tsx", "skills-settings-title"], ["../RoomRoutingSettings.tsx", "room-routing-label"]] as const) {
      expect(read(file), file).not.toContain(` id="${id}"`);
    }
  });
});

describe("Models & engines in Simple and Advanced", () => {
  it("Simple keeps Engines, the model connections, Paste keys and the existing keys, in page order", () => {
    expect(modelsCards(on).filter((card) => card.simple).map((card) => card.id)).toEqual(["models.engines", "models.providers", "models.paste-keys", "models.existing-keys"]);
  });
  it("lists the new-bot effort here under its old id, and How every bot behaves no longer lists it", () => {
    expect(modelsCards(on).map((card) => card.id)).toContain("botDefaults.new-bot-effort");
    expect(botDefaultsCards(on).map((card) => card.id)).not.toContain("botDefaults.new-bot-effort");
    expect(SETTINGS_CARDS.find((card) => card.id === "botDefaults.new-bot-effort")).toMatchObject({ section: "models", anchor: "new-bot-effort-heading" });
  });
  it("draws every engine through S1's EngineRow, read from routeState, and the picker and a bot's Model card use the same row", () => {
    const engines = read("../EnginesSettings.tsx");
    expect(engines).toContain("const route = routeState(null, instance, null, creditFromHealth(useEngineHealthAnswer()));");
    expect(engines).toContain("<EngineRow name={instance.displayName} state={route} onFix={onFix}");
    expect(read("../ModelPickerDialog.tsx")).toContain("<ModelRouteRow engine={engine} manage={manage}");
    expect(read("../SettingsPanel.tsx")).toContain("<ModelRouteRow engine={engine}");
    expect(read("../ModelRouteRow.tsx")).toContain("if (!route.fix) return null;");
  });
});

describe("the AssemblyAI key has one home, on Skills", () => {
  it("is a Skills card with its old id, next to Teach a skill, and the Search page has no key card", () => {
    expect(skillsCards(on).map((card) => card.id)).toEqual(["skills.recorder", "webSearch.voice-key", "skills.library", "skills.scan-rules"]);
    expect(webSearchCards(on).map((card) => card.id)).not.toContain("webSearch.voice-key");
    expect(SETTINGS_CARDS.find((card) => card.id === "webSearch.voice-key")).toMatchObject({ section: "skills", anchor: "voice-key-heading" });
  });
  it("mounts the key field once and marks one control for it", () => {
    const pages = readdirSync(new URL("./pages", import.meta.url)).map((file) => read(`./pages/${file}`)).join("\n");
    expect(pages.match(/<TranscriptionKey \/>/g)).toHaveLength(1);
    expect(read("../TranscriptionSettings.tsx").match(/data-setting-control="voice-key-heading"/g)).toHaveLength(1);
    expect(read("./pages/SearchImagesDictationPage.tsx")).not.toContain("TranscriptionKey");
  });
});

describe("cards made of pieces of one component (pages 5 to 7)", () => {
  /** Every <PartSlot id> a page's cards render. */
  function slotIds(node: ReactNode, out: string[] = []): string[] {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as { id?: string; children?: ReactNode };
      if (child.type === PartSlot) out.push(props.id as string);
      slotIds(props.children, out);
    });
    return out;
  }
  const slots = new Set([...memoryCards(on), ...modelsCards(on), ...webSearchCards(on)].flatMap((card) => slotIds(card.render())));
  const hosted = ["MemorySection", "MemorySettings", "ModelsSettings", "EnginesSettings", "SearchSettings", "ImageSettings"].map((name) => read(`../${name}.tsx`)).join("\n");
  const pieces = new Set([...hosted.matchAll(/(?:<Part id|part)="([\w.-]+)"/g)].map((match) => match[1]));

  it("sends every piece to a card slot, so no control disappears behind a missing card", () => {
    // The monthly limit now has its own component and a single card on Usage.
    for (const piece of pieces) expect(slots.has(piece), piece).toBe(true);
    expect(pieces.has("memory.limit")).toBe(false);
    expect(read("./pages/UsagePage.tsx")).toContain('id: "memory.limit", anchor: "memory-limit-heading", simple: false, render: () => <LearningLimitCard />');
    expect(slots.has("memory.limit")).toBe(false);
  });
  it("a piece in a host with no slot renders nowhere, and outside a host renders in place", () => {
    const html = (node: ReactNode) => renderToStaticMarkup(node as never);
    expect(html(createElement(Part, { id: "x", children: "hello" }))).toBe("hello");
    expect(html(createElement(PartsHost, null, createElement(Part, { id: "x", children: "hello" })))).toBe("");
    expect(html(createElement(PartsHost, null, createElement(InAdvanced, { part: "x", children: "hello" })))).toBe("");
    // An Advanced piece with no card is named by this test, never shown loose inside a hosting page.
    expect(html(createElement(PartsHost, null, createElement(InAdvanced, { children: "loose" })))).toBe("");
    expect(html(createElement(InAdvanced, { children: "loose" }))).toBe("loose");
  });
  it("a slot with nothing in it draws nothing, and a surface only where the piece has none of its own", () => {
    const out = renderToStaticMarkup(createElement(PartsHost, null, createElement(PartSlot, { id: "a" }), createElement(PartSlot, { id: "b", card: true })));
    expect(out).toContain("empty:hidden");
    expect(out.match(/bg-card/g)).toHaveLength(1);
  });
  it("the components no longer carry a card's anchor on a second element", () => {
    for (const [file, id] of [
      ["MemorySection", "memory-how-heading"], ["MemorySection", "memory-bots-heading"], ["MemorySection", "memory-learned-heading"], ["MemorySection", "memory-mode-heading"], ["MemorySection", "memory-connection-heading"],
      ["MemorySettings", "memory-people-heading"], ["MemorySettings", "memory-import-heading"], ["MemorySettings", "memory-audience-heading"], ["MemorySettings", "memory-reindex-heading"],
      ["ProcedureEvaluationAdmissions", "memory-procedures-heading"], ["MemoryLearningControls", "memory-health-heading"],
      ["ModelsSettings", "models-heading"], ["ModelsSettings", "model-catalogs-heading"], ["ModelsSettings", "existing-keys-heading"], ["EnginesSettings", "engine-command-lines-heading"],
      ["LocalModelsSettings", "local-models-heading"], ["ClaudeAccountsSettings", "claude-accounts-heading"],
      ["SearchSettings", "search-keys-heading"], ["ImageSettings", "image-settings-heading"], ["ImageSettings", "image-daily-check-heading"], ["TranscriptionSettings", "voice-key-heading"],
    ] as const) expect(read(`../${file}.tsx`), `${file} ${id}`).not.toContain(` id="${id}"`);
  });
  it("Memory lists its upkeep section after the seven cards, with no monthly limit card", () => {
    const ids = memoryCards(on).map((card) => card.id);
    expect(ids).toEqual(["memory.overview", "memory.how-it-learns", "memory.bots", "memory.learned", "memory.mode", "memory.people", "memory.import", "memory.connection", "memory.audience", "memory.procedures", "memory.reindex", "memory.health"]);
    expect(read("./pages/MemoryPage.tsx")).toContain('t("settings.l2.upkeep")');
  });
  it("keeps the browser destination inside the existing people slot", () => {
    const people = memoryCards(on).find(card => card.id === "memory.people")!;
    const browser = cardForAnchor(SETTINGS_CARDS, "memory-browser-heading")!;
    expect(browser.id).toBe("memory.browser");
    expect(isAdvancedOnlyCard(browser.section, browser.id)).toBe(true);
    expect(people.anchor).toBe("memory-people-heading");
    expect(slotIds(people.render())).toEqual(["memory.people"]);
    expect(read("./pages/MemoryPage.tsx")).toContain('<MemoryBrowserSlot><PartSlot id="memory.people" card /></MemoryBrowserSlot>');
    expect(read("../MemorySettings.tsx")).toContain('id="memory-browser-heading"');
  });
  it("Search, images and dictation lists Web search, Images and Dictation in that order", () => {
    expect(webSearchCards(on).map((card) => card.id)).toEqual(["webSearch.search", "webSearch.provider-keys", "webSearch.images", "webSearch.daily-check", "webSearch.voice"]);
  });
});
