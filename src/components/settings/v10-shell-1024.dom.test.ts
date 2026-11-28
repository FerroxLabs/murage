// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// Settings v10 ships whole (DESIGN-sv10done W1-W3): the shipped SettingsModal, driven as an owner drives it. The rail is the 17
// pages that have content; old ids land on the page and card that hold their controls; the one search box finds skills.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import { initialState, reducer, type Action } from "@/state/store";
import { resetSettingsModeForTest, setSettingsMode } from "@/lib/settings-mode";
import { settingsPageLabel } from "@/lib/settings-sections";
import { SECTION_ALIASES, type SettingsPage } from "@/lib/settings-pages";
import { signalSettingsEnabled } from "@/lib/settings-card-registry";
import { LazyOverlay } from "../LazyOverlay";
import { SettingsModal } from "../SettingsModal";

const fixture = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn<(action: Action) => void>(), desktop: true, cloud: false }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  useStoreSelector: <T,>(select: (state: typeof initialState) => T) => select(fixture.state),
  api: vi.fn(async () => { throw new Error("No network in the v10 shell fixture"); }),
}));
vi.mock("@/lib/use-surface", () => ({ useSurfaceState: () => ({ desktop: fixture.desktop, confirmed: true }), useDesktopSurface: () => fixture.desktop }));
// A Cloud home window (W5): the shell reads the page's origin, the fixture answers it.
vi.mock("@/lib/cloud-workspace", async (original) => ({ ...await original<typeof import("@/lib/cloud-workspace")>(), isCloudOrigin: () => fixture.cloud }));
// The skills source answers one library skill; the sheet itself is a stand-in that names the ref and the bot it was asked to open on.
const SKILL = { ref: "library:weekly-report", name: "Weekly report", description: "Summarise the week", kind: "library", verdict: "clean", source: "Library", usedBy: [{ botId: "fixture-nova", botName: "Nova", enabled: true }], category: "Writing", isNew: false };
vi.mock("@/lib/skills-api", async (original) => ({
  ...await original<typeof import("@/lib/skills-api")>(),
  querySkills: vi.fn(async () => ({ rows: [SKILL], yours: [], total: 1, facets: [], next: null })),
  listSkills: vi.fn(async () => []),
}));
// W1: five cards draw nothing until their status answer arrives (this fixture has no network). Their REAL component is
// mounted inside a pass-through mark, so a row proves that card's own component is on its v10 page, not just its slot.
const marked = (name: string, real: (props: never) => unknown) => (props: never) => h("div", { "data-card-mounted": name }, h(real as never, props));
vi.mock("../SpendLimitCard", async (original) => { const real = await original<typeof import("../SpendLimitCard")>(); return { ...real, SpendLimitCard: marked("SpendLimitCard", real.SpendLimitCard as never) }; });
vi.mock("../StorageSettings", async (original) => { const real = await original<typeof import("../StorageSettings")>(); return { ...real, StorageSettings: marked("StorageSettings", real.StorageSettings as never) }; });
vi.mock("../ProjectAutonomySetting", async (original) => { const real = await original<typeof import("../ProjectAutonomySetting")>(); return { ...real, ProjectAutonomySetting: marked("ProjectAutonomySetting", real.ProjectAutonomySetting as never) }; });
vi.mock("../TranscriptionSettings", async (original) => { const real = await original<typeof import("../TranscriptionSettings")>(); return { ...real, OwnTranscriptionKeyCard: marked("OwnTranscriptionKeyCard", real.OwnTranscriptionKeyCard as never) }; });
vi.mock("../PhoneCallsSettings", async (original) => { const real = await original<typeof import("../PhoneCallsSettings")>(); return { ...real, default: marked("PhoneCallsSettings", real.default as never) }; });
vi.mock("../skills/SkillReader", () => ({ SkillReader: ({ skillRef, mode }: { skillRef: string; mode: { kind: string; botId?: string } }) => h("div", { "data-skill-sheet": skillRef, "data-skill-sheet-bot": mode.kind === "bot" ? mode.botId : "" }) }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  resetSettingsModeForTest();
  setSettingsMode("advanced");
  fixture.desktop = true;
  fixture.cloud = false;
  fixture.state = { ...initialState, bots: [{ id: "fixture-nova", name: "Nova" }] as never, appSettingsOpen: true };
  fixture.dispatch.mockImplementation((action) => { fixture.state = reducer(fixture.state, action); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); resetSettingsModeForTest(); });

const shell = () => h(LazyOverlay, { name: "settings", kind: "window", covers: "always", onDismiss: vi.fn(), onRetry: vi.fn() }, h(SettingsModal));
const railEntry = (id: string) => document.querySelector<HTMLButtonElement>(`[data-settings-section="${id}"]`);
const current = () => document.querySelector<HTMLElement>('[data-settings-section][aria-current="page"]')?.dataset.settingsSection;
// The store is a fixture (a reducer behind a mocked useStore), so what an opener dispatched shows once the window is drawn again.
const redraw = async () => { cleanup(); mount(shell()); await settle(); };
async function open(section: string) {
  await act(async () => { fixture.dispatch({ type: "toggleAppSettings", open: true, section: section as never }); });
  await redraw();
}

describe("W1 the rail is the 17 pages, none of 1.0.23's controls lost", () => {
  // The first card each page draws (its anchor is the card's heading id): present only when the page mounted with its content.
  const FIRST_CARD: Partial<Record<SettingsPage, string>> = {
    calls: "calls-settings-title", webSearch: "image-settings-heading", messaging: "telegram-settings-title", rules: "house-rules-heading",
    connections: "connections-heading", models: "models-heading", general: "advanced-mode-heading", skills: "skill-recorder-heading",
  };
  // Written out, not read from the registry: the rail is the promise (id and the name the owner sees).
  const RAIL: ReadonlyArray<readonly [SettingsPage, string]> = [
    ["overview", "Overview"], ["models", "Models & engines"], ["webSearch", "Search, images and dictation"], ["usage", "Usage"], ["tools", "Tools"],
    ["connections", "Connected apps"], ["computer", "Computer & browser"], ["messaging", "Messaging apps"], ["calls", "Calls"],
    ["companion", "Phone and other devices"], ["bots", "Bots"], ["rules", "How every bot behaves"], ["skills", "Skills"], ["memory", "Memory"],
    ["general", "General"], ["backups", "Backups"], ["about", "About & help"],
  ];
  it.each(RAIL)("%s has a rail entry named %s, and opening it mounts its page", async (id, name) => {
    mount(shell());
    await settle();
    const entry = railEntry(id);
    expect(entry, `rail entry for ${id}`).not.toBeNull();
    expect(entry!.textContent).toBe(name);
    expect(settingsPageLabel(id)).toBe(name);
    await act(async () => { entry!.click(); });
    expect(fixture.state.appSettingsSection).toBe(id);
    await redraw();
    expect(current()).toBe(id);
    const card = FIRST_CARD[id];
    if (card) await vi.waitFor(() => expect(document.getElementById(card), `${id} first card`).not.toBeNull(), { timeout: 3000 });
  });
  // One row per card the 1.0.23 shell renders (dev/1024 src/lib/settings-card-registry.ts, written out): [card id, 1.0.23 page, anchor].
  // Its v10 page is the 1.0.23 page, except Bot defaults (now "rules") and the messaging apps (now their own page).
  const CARDS_1023: ReadonlyArray<readonly [string, string, string]> = [
    ["general.mode", "general", "advanced-mode-heading"], ["general.profile", "general", "profile-heading"],
    ["general.appearance", "general", "appearance-heading"], ["general.sidebar-density", "general", "sidebar-density-heading"],
    ["general.language", "general", "language-heading"], ["general.time-zone", "general", "time-zone-heading"],
    ["general.send-key", "general", "send-key-heading"], ["general.notifications", "general", "notifications-heading"],
    ["general.startup", "general", "startup-heading"], ["general.about-me", "general", "about-me-heading"],
    ["general.bring-your-ai", "general", "bring-your-ai-heading"], ["calls.calls", "calls", "calls-settings-title"],
    ["connections.phone-calls", "calls", "phone-calls-heading"], ["botDefaults.tool-calls", "botDefaults", "tool-calls-heading"],
    ["botDefaults.project-autonomy", "botDefaults", "project-autonomy-heading"],
    ["botDefaults.channel-turns", "botDefaults", "room-turn-timeout"], ["botDefaults.room-routing", "botDefaults", "room-routing-label"],
    ["botDefaults.starter-profiles", "botDefaults", "starter-profiles-heading"],
    ["botDefaults.house-rules", "botDefaults", "house-rules-heading"], ["skills.recorder", "skills", "skill-recorder-heading"],
    ["skills.library", "skills", "skills-settings-title"], ["skills.scan-rules", "skills", "skill-scan-rules-heading"],
    ["memory.overview", "memory", "memory-heading"], ["memory.browser", "memory", "memory-browser-heading"],
    ["memory.how-it-learns", "memory", "memory-how-heading"], ["memory.bots", "memory", "memory-bots-heading"],
    ["memory.learned", "memory", "memory-learned-heading"], ["memory.people", "memory", "memory-people-heading"],
    ["memory.import", "memory", "memory-import-heading"], ["memory.mode", "memory", "memory-mode-heading"],
    ["memory.connection", "memory", "memory-connection-heading"], ["memory.audience", "memory", "memory-audience-heading"],
    ["memory.procedures", "memory", "memory-procedures-heading"], ["memory.reindex", "memory", "memory-reindex-heading"],
    ["memory.health", "memory", "memory-health-heading"], ["models.providers", "models", "models-heading"],
    ["models.engines", "models", "engines-heading"], ["models.paste-keys", "models", "paste-any-keys"],
    ["models.existing-keys", "models", "existing-keys-heading"], ["models.catalogs", "models", "model-catalogs-heading"],
    ["models.local-servers", "models", "local-models-heading"], ["models.claude-accounts", "models", "claude-accounts-heading"],
    ["botDefaults.new-bot-effort", "models", "new-bot-effort-heading"], ["models.command-lines", "models", "engine-command-lines-heading"],
    ["webSearch.search", "webSearch", "search-settings-heading"], ["webSearch.images", "webSearch", "image-settings-heading"],
    ["webSearch.voice", "webSearch", "voice-settings-heading"], ["webSearch.provider-keys", "webSearch", "search-keys-heading"],
    ["webSearch.daily-check", "webSearch", "image-daily-check-heading"], ["webSearch.voice-key", "webSearch", "voice-key-heading"],
    ["connections.apps", "connections", "connections-heading"], ["connections.bot-email", "connections", "bot-email-heading"],
    ["connections.mcp", "connections", "mcp-servers-heading"], ["connections.claude-code", "connections", "claude-code-import-heading"],
    ["channels.telegram", "connections", "telegram-settings-title"], ["channels.slack", "connections", "slack-settings-title"],
    ["channels.discord", "connections", "discord-settings-title"], ["channels.whatsapp", "connections", "whatsapp-settings-title"],
    ["channels.signal", "connections", "signal-settings-title"], ["channels.slack-setup", "connections", "slack-app-setup-heading"],
    ["channels.discord-setup", "connections", "discord-app-setup-heading"],
    ["channels.allow-lists", "connections", "whatsapp-allow-heading"],
    ["channels.whatsapp-groups", "connections", "whatsapp-groups-heading"], ["companion.browser", "computer", "browser-settings-heading"],
    ["companion.pairing", "companion", "companion-heading"], ["companion.script-access", "computer", "script-access-heading"],
    ["companion.vps", "computer", "vps-heading"], ["companion.computer", "computer", "computer-settings-heading"],
    ["backups.backups", "backups", "backups-heading"], ["backups.storage", "backups", "storage-heading"],
    ["usage.by-bot", "usage", "usage-heading"], ["usage.learning", "usage", "usage-learning-heading"],
    ["memory.limit", "usage", "memory-limit-heading"], ["usage.spend-limit", "usage", "spend-limit-heading"],
    ["usage.by-routine", "usage", "usage-by-routine-heading"], ["usage.account", "usage", "plan-usage-heading"],
    ["about.version", "about", "about-version-heading"], ["about.whats-new", "about", "whats-new-heading"],
    ["about.diagnostics", "about", "diagnostics-heading"], ["about.setup", "about", "setup-heading"],
    ["about.shortcuts", "about", "shortcuts-heading"], ["about.news", "about", "news-heading"],
    ["about.health", "about", "health-heading"],
  ];
  // Cards whose body waits on a status answer: the row asserts their real component's mark (see `marked` above).
  const AFTER_NETWORK: Readonly<Record<string, string>> = {
    "connections.phone-calls": "PhoneCallsSettings", "botDefaults.project-autonomy": "ProjectAutonomySetting", "webSearch.voice-key": "OwnTranscriptionKeyCard",
    "backups.storage": "StorageSettings", "usage.spend-limit": "SpendLimitCard",
  };
  const NEEDS_APP_BRIDGE = new Set(["about.version", "about.diagnostics"]);
  const v10PageOf = (id: string, page: string): SettingsPage => (id.startsWith("channels.") ? "messaging" : page === "botDefaults" ? "rules" : page) as SettingsPage;
  it.each(CARDS_1023.filter(([id]) => signalSettingsEnabled || id !== "channels.signal"))("card %s (1.0.23 page %s) renders on its v10 page", async (id, page, anchor) => {
    mount(shell());
    await settle();
    const target = v10PageOf(id, page);
    const entry = railEntry(target);
    expect(entry, `rail entry ${target} for ${id}`).not.toBeNull();
    await act(async () => { entry!.click(); });
    await redraw();
    await vi.waitFor(() => expect(document.getElementById(anchor), `${id} card ${anchor} on ${target}`).not.toBeNull(), { timeout: 10_000 });
    const mark = AFTER_NETWORK[id];
    if (mark) await vi.waitFor(() => expect(document.getElementById(anchor)!.querySelector(`[data-card-mounted="${mark}"]`), `${id} card ${anchor} mounts ${mark}`).not.toBeNull(), { timeout: 10_000 });
    else await vi.waitFor(() => expect(document.getElementById(anchor)!.childElementCount, `${id} card ${anchor} draws`).toBeGreaterThan(0), { timeout: 10_000 });
    // This window is this computer (desktop, not Cloud): no card may stand in as the on-your-computer stub, except the two whose
    // controls come from the desktop app's own bridge (about-rows.tsx:51 exportDiagnostics, :215 updater), absent in any browser window.
    if (!NEEDS_APP_BRIDGE.has(id)) expect(document.getElementById(anchor)!.querySelector('[data-settings-stub="other-surface"]'), `${id} is a stub on this computer`).toBeNull();
  }, 30_000);
  it("the rail has exactly those 17 entries", async () => {
    mount(shell());
    await settle();
    expect([...document.querySelectorAll<HTMLElement>("[data-settings-section]")].map((el) => el.dataset.settingsSection).sort()).toEqual(RAIL.map(([id]) => id).sort());
  });
});

describe("W2 every old id lands on the page and card that hold its controls", () => {
  // Written out, not read from SECTION_ALIASES: the table is the promise (the first five rows changed in v10, the rest are controls).
  const PAGE_OF: Record<string, [SettingsPage, string | null]> = {
    providers: ["models", "models-heading"], engines: ["models", "engines-heading"], botDefaults: ["rules", null],
    houseRules: ["rules", "house-rules-heading"], channels: ["messaging", "telegram-settings-title"],
    aboutMe: ["general", "about-me-heading"], images: ["webSearch", "image-settings-heading"], voice: ["webSearch", "voice-settings-heading"],
    experimental: ["skills", "skill-recorder-heading"], storage: ["backups", "storage-heading"],
  };
  it("names every alias the shell has, once", () => { expect(Object.keys(PAGE_OF).sort()).toEqual(Object.keys(SECTION_ALIASES).sort()); });
  it.each(Object.entries(PAGE_OF))("%s", async (alias, [page, anchor]) => {
    await open(alias);
    expect(current(), alias).toBe(page);
    // storage-heading is a card that draws only once its disk-space answer arrives, which this fixture has no network for
    if (anchor && alias !== "storage") {
      await vi.waitFor(() => expect(document.getElementById(anchor), `${alias} card ${anchor}`).not.toBeNull());
      await vi.waitFor(() => expect(document.getElementById(anchor)!.contains(document.activeElement), `${alias} focus on ${anchor}, focus is on ${document.activeElement?.tagName}#${document.activeElement?.id || ""} anchor-state=${String(fixture.state.appSettingsAnchor)}`).toBe(true), { timeout: 8000 }); // past ANCHOR_WAIT_MS (5 s): a loaded run still lands
    }
  }, 20_000);
  // Every 1.0.23 page id that keeps its name stays a page id (an old link or phone opens that page, not an alias or the default).
  const KEPT = ["general", "calls", "skills", "memory", "models", "webSearch", "connections", "computer", "companion", "backups", "usage", "about"] as const;
  it.each(KEPT)("the 1.0.23 page id %s opens that page", async (page) => {
    await open(page);
    expect(current(), page).toBe(page);
  });
  it.each([["providers", "models", "models-heading"], ["engines", "models", "engines-heading"], ["botDefaults", "rules", null], ["houseRules", "rules", "house-rules-heading"], ["channels", "messaging", "telegram-settings-title"]] as const)("the changed row %s is %s", (alias, page, anchor) => {
    expect(SECTION_ALIASES[alias as keyof typeof SECTION_ALIASES]).toEqual({ section: page, anchor });
  });
});

describe("W3 the one search box finds a skill after the settings rows, and its row opens that skill's sheet", () => {
  it("shows a skill row, and clicking it opens the Skills page on that skill", async () => {
    mount(shell());
    await settle();
    const input = document.querySelector<HTMLInputElement>("#settings-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "weekly");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => expect(document.querySelector("[data-settings-result-skill]")).not.toBeNull(), { timeout: 3000 });
    const row = document.querySelector<HTMLElement>("[data-settings-result-skill]")!;
    expect(row.dataset.settingsResultSkill).toBe(SKILL.ref);
    const settingRows = [...document.querySelectorAll("[data-settings-result]")];
    for (const each of settingRows) expect(each.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { row.click(); });
    expect(fixture.state.appSettingsSection).toBe("skills");
    await vi.waitFor(() => expect(document.querySelector(`[data-skill-sheet="${SKILL.ref}"]`)).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector<HTMLElement>(`[data-skill-sheet="${SKILL.ref}"]`)!.dataset.skillSheetBot, "the bot the result names").toBe("fixture-nova");
  });
  it("on a phone (Skills is a desktop-only page) the box shows no skill row it could not open", async () => {
    fixture.desktop = false;
    mount(shell());
    await settle();
    const input = document.querySelector<HTMLInputElement>("#settings-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "weekly");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    expect(document.querySelector("[data-settings-result-skill]"), "phone skill row").toBeNull();
  });
});

describe("W5 a Cloud home window draws Messaging apps as on-your-computer stubs", () => {
  const APPS = ["telegram-settings-title", "slack-settings-title", "discord-settings-title", "whatsapp-settings-title"];
  it.each([["Cloud home", true], ["this computer", false]] as const)("%s", async (_where, cloud) => {
    fixture.cloud = cloud;
    await open("messaging");
    expect(current()).toBe("messaging");
    for (const anchor of APPS) {
      await vi.waitFor(() => expect(document.getElementById(anchor)).not.toBeNull());
      expect(Boolean(document.querySelector(`[data-testid="settings-stub-${anchor}"]`)), `${anchor} stub (cloud=${cloud})`).toBe(cloud);
    }
    expect(Boolean(document.querySelector('input[data-setting-control="telegram-settings-title"]')), `live Telegram token box (cloud=${cloud})`).toBe(!cloud);
  });
});
