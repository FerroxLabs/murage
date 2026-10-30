// B3 WP6: every Settings section has a Cloud class, and a page called "home" never reaches for this computer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SETTINGS_CARDS } from "./settings-card-registry";
import { CLOUD_COMPUTER_ONLY_CARDS, CLOUD_SETTINGS_CLASS, ON_YOUR_COMPUTER_ONLY, cloudCardBlocked, cloudCardHidden, cloudSectionBlocked } from "./cloud-settings";
import { SETTINGS_SECTIONS, type AppSettingsSection } from "./settings-sections";
import { SECTION_ALIASES, SECTION_PAGES, type SettingsAlias, type SettingsPage } from "./settings-pages";

const read = (file: string) => readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");

// Bridge members the Cloud window does not have (preload-cloud.cjs exposes only muragecloud).
const LOCAL_BRIDGE = /muragebox\??\.(setCredential|mutateFluxConnection|mutateProviderConnection|modelSignIn|backup\w*|companion\w*|pickFolder|openEngineSetupTerminal|startup|transcription|browser|exportDiagnostics)/;

// The component files each "home" or "mixed" page renders (SettingsModal.tsx), so a new local call there fails here.
const PAGE_FILES: Partial<Record<AppSettingsSection, string[]>> = {
  aboutMe: ["AboutMeSettings.tsx"],
  botDefaults: ["ProjectAutonomySetting.tsx", "RoomTurnTimeoutSettings.tsx", "StarterProfiles.tsx"],
  houseRules: ["HouseRulesSettings.tsx"],
  skills: ["skills/SkillsSettings.tsx"],
  memory: ["MemorySection.tsx"],
  images: ["ImageSettings.tsx"],
  usage: ["UsageSection.tsx"],
  general: ["NotificationSettings.tsx", "cloud/CloudDisconnectComputer.tsx"],
};

describe("Settings in a Cloud window", () => {
  it("classifies every section exactly once", () => {
    expect(Object.keys(CLOUD_SETTINGS_CLASS).sort()).toEqual(SETTINGS_SECTIONS.map((entry) => entry.id).sort());
  });

  it("blocks exactly the computer-only pages, only in a Cloud window", () => {
    const blocked = SETTINGS_SECTIONS.filter((entry) => cloudSectionBlocked(entry.id, true)).map((entry) => entry.id).sort();
    expect(blocked).toEqual(["backups", "channels", "companion", "computer", "engines", "experimental", "models", "storage", "voice", "webSearch"]);
    for (const entry of SETTINGS_SECTIONS) expect(cloudSectionBlocked(entry.id, false)).toBe(false);
  });

  it("keeps every credential, backup, phone and folder page computer-only", () => {
    for (const id of ["models", "webSearch", "voice", "channels", "companion", "backups", "computer", "engines"] as const) {
      expect(CLOUD_SETTINGS_CLASS[id]).toBe("computer-only");
    }
  });

  it("renders no page that calls this computer's bridge as 'home'", () => {
    for (const [id, files] of Object.entries(PAGE_FILES)) {
      for (const file of files!) {
        expect(read(file), `${id} -> ${file}`).not.toMatch(LOCAL_BRIDGE);
      }
    }
  });

  it("SettingsModal routes blocked sections through the classifier and stubs this computer's cards", () => {
    const source = read("SettingsModal.tsx");
    expect(source).toContain("cloudSectionBlocked(requested)");
    // 1.0.3: the 20 ids land on 12 pages (settings-pages.ts); a blocked id lands on none of them.
    expect(source).toContain('const section = (blocked ? "" : resolveSettingsSection(requested).section) as SettingsPage;');
    expect(source).toContain("const pageComputerOnly = !blocked && cloudSectionBlocked(section);");
    expect(source).toContain("ON_YOUR_COMPUTER_ONLY");
    // SETTINGS-UX-1011 S1: a Cloud window renders each of this computer's cards as the "set this on your computer" stub, never nothing.
    expect(source).toContain('{desktop === true && <Anchor id="startup-heading">{cloudCardHidden("startup-heading", cloud) ? <ComputerOnlyStub anchor="startup-heading" /> : <StartupSettings />}</Anchor>}');
    expect(source).toContain('<Anchor id="diagnostics-heading">{cloudCardHidden("diagnostics-heading", cloud) ? <ComputerOnlyStub anchor="diagnostics-heading" /> : <DiagnosticsRow />}</Anchor>');
    expect(source).toContain('{desktop === true && <Anchor id="setup-heading">{cloudCardHidden("setup-heading", cloud) ? <ComputerOnlyStub anchor="setup-heading" /> : <SetupAgainRow />}</Anchor>}');
    expect(source).toContain('{(cloudCardHidden("updates-heading", cloud) || window.muragebox?.updater) && <Anchor id="updates-heading">{cloudCardHidden("updates-heading", cloud) ? <ComputerOnlyStub anchor="updates-heading" /> : <UpdatesRow />}</Anchor>}');
    // 1.0.3 moved the MCP servers button into the Connected apps Advanced; a Cloud window gets the stub in its place.
    expect(source).toMatch(/\{cloudCardHidden\("mcp-servers-heading"\) \? <ComputerOnlyStub anchor="mcp-servers-heading" \/> : \(\s*<Card[\s\S]*?openPanel\("mcp"\)/);
    expect(source).not.toContain("!cloudCardHidden(");
    expect(source.match(/openPanel\("mcp"\)/g)).toHaveLength(1);
    // every page body reads `section`, which is "" for a blocked id, and the nav and redirect read `requested`
    for (const entry of SECTION_PAGES) expect(source, entry.id).toContain(`section === "${entry.id}"`);
    expect(source).not.toMatch(/\bsection === id\b/);
    expect(source).toContain("const navPage = resolveSettingsSection(requested).section;");
    expect(source).toContain('aria-current={navPage === id ? "page" : undefined}');
    expect(ON_YOUR_COMPUTER_ONLY).toBe("On your computer only");
  });

  it("an alias never brings a computer-only card into a page a Cloud window renders", () => {
    const modal = read("SettingsModal.tsx");
    const tools = read("ToolsSettings.tsx");
    for (const [alias, target] of Object.entries(SECTION_ALIASES) as Array<[SettingsAlias, { section: SettingsPage }]>) {
      const aliasOnly = CLOUD_SETTINGS_CLASS[alias] === "computer-only";
      const pageOnly = CLOUD_SETTINGS_CLASS[target.section] === "computer-only";
      if (aliasOnly && !pageOnly) {
        // The page renders in a Cloud window, so the alias's card is the "set this on your computer" stub there.
        expect(alias).toBe("experimental");
        expect(modal).toContain('<Anchor id="skill-recorder-heading">{cloudCardHidden("skill-recorder-heading", cloud) ? <ComputerOnlyStub anchor="skill-recorder-heading" /> : <WorkspaceFeatureRow feature="skillRecorder" />}</Anchor>');
      } else if (!aliasOnly && pageOnly) {
        // The alias may be used but its page may not: only the alias's card renders.
        expect(alias).toBe("images");
        expect(modal).toContain("<ToolsSettings advanced={advancedFor(\"webSearch\")} cloudImagesOnly={pageComputerOnly} />");
        expect(tools).toContain("{!cloudImagesOnly && <Anchor id=\"search-settings-heading\"><SearchSettings /></Anchor>}");
        expect(tools).toMatch(/\{!cloudImagesOnly && \(\s*<Anchor id="voice-settings-heading">/);
      }
    }
  });
});

describe("Settings search in a Cloud window", () => {
  const cards = SETTINGS_CARDS;

  it("lists no card from a page the window blocks, and keeps the Images card", async () => {
    const { searchSettingsCards } = await import("./settings-search");
    const everyWord = [...new Set(cards.flatMap((card) => [...card.words]))];
    const found = new Set(everyWord.flatMap((word) => searchSettingsCards(word, true, cards, undefined, undefined, true)).map((hit) => hit.card.id));
    for (const card of cards) {
      const blocked = cloudCardBlocked(card, true);
      expect(found.has(card.id) && blocked, card.id).toBe(false);
    }
    expect(cards.some((card) => cloudCardBlocked(card, true))).toBe(true);
    const images = cards.find((card) => card.anchor === "image-settings-heading")!;
    expect(cloudCardBlocked(images, true)).toBe(false);
    expect(found.has(images.id)).toBe(true);
    expect(images.section).toBe("webSearch");
  });

  // The modal and search read one list: every card the modal hides on a page a Cloud window renders.
  it("each of this computer's cards on a Cloud-usable page is a registered card, and the modal stubs it by that list", () => {
    const modal = read("SettingsModal.tsx");
    expect([...CLOUD_COMPUTER_ONLY_CARDS].sort()).toEqual(["diagnostics-heading", "mcp-servers-heading", "setup-heading", "skill-recorder-heading", "startup-heading", "updates-heading"]);
    for (const anchor of CLOUD_COMPUTER_ONLY_CARDS) {
      const card = cards.find((entry) => entry.anchor === anchor);
      expect(card, anchor).toBeDefined();
      expect(cloudSectionBlocked(card!.section, true), anchor).toBe(false);
      expect(modal, anchor).toMatch(new RegExp(`cloudCardHidden\\("${anchor}"(, cloud)?\\) \\? <ComputerOnlyStub anchor="${anchor}" />`));
      expect(cloudCardHidden(anchor, true)).toBe(true);
      expect(cloudCardHidden(anchor, false)).toBe(false);
    }
    // No card the modal shows in a Cloud window is gated by a bare cloud check the list does not know about.
    expect(modal).not.toMatch(/!cloud &&|!isCloudOrigin\(\) &&/);
  });

  it("finds none of Startup, Set up again, Updates, Diagnostics, Teach a skill or MCP servers, and keeps their pages' other cards", async () => {
    const { searchSettingsCards } = await import("./settings-search");
    for (const word of ["startup", "set up", "updates", "diagnostics", "teach a skill", "mcp"]) {
      const cloudHits = searchSettingsCards(word, true, cards, undefined, undefined, true).map((hit) => hit.card.anchor);
      for (const anchor of CLOUD_COMPUTER_ONLY_CARDS) expect(cloudHits, word).not.toContain(anchor);
    }
    const desktopHits = new Set(["startup", "setup", "updates", "diagnostics", "teach a skill", "mcp"].flatMap((word) => searchSettingsCards(word, true, cards, undefined, undefined, false)).map((hit) => hit.card.anchor));
    for (const anchor of CLOUD_COMPUTER_ONLY_CARDS) expect(desktopHits.has(anchor), anchor).toBe(true);
    const kept = (word: string, anchor: string) => expect(searchSettingsCards(word, true, cards, undefined, undefined, true).map((hit) => hit.card.anchor), word).toContain(anchor);
    kept("appearance", "appearance-heading");
    kept("shortcuts", "shortcuts-heading");
    kept("connected apps", "connections-heading");
    kept("skills", "skills-settings-title");
  });

  it("changes nothing outside a Cloud window", async () => {
    const { searchSettingsCards } = await import("./settings-search");
    const word = cards.find((card) => cloudCardBlocked(card, true))!.words[0];
    const desktop = searchSettingsCards(word, true, cards, undefined, undefined, false);
    const blockedCard = cards.find((card) => cloudCardBlocked(card, true))!;
    expect(desktop.some((hit) => hit.card.id === blockedCard.id)).toBe(true);
    for (const card of cards) expect(cloudCardBlocked(card, false)).toBe(false);
  });
});
