// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U44 / journey B-120: "In Japanese, my bot settings usage card reads
// entirely in Japanese." Bot settings is rendered in a stub language where
// every catalog string is a marker, so any English still written into
// SettingsPanel.tsx shows up as a leftover. The child cards are stubbed: each
// owns its own copy and is checked on its own; this file checks the panel's.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { en, localeLoaders } from "@/locales";
import { setLocale } from "@/lib/i18n";
import { effortLabel } from "@/lib/effort-label";
import { botRoleTitle } from "@/lib/bot-role";
import { PEER_CONTACT_LABEL, peerContactHint } from "@/lib/permission-mode";
import { usageDetail } from "@/lib/usage";
import { settingsRoleLabel } from "./bot-settings-sections";
import { SettingsPanel } from "./SettingsPanel";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("@/state/store", async (orig) => ({
  ...(await orig<typeof import("@/state/store")>()),
  useStore: () => ({ state: store.state, dispatch: () => {} }),
}));
vi.mock("@/lib/use-surface", async (orig) => ({ ...(await orig<object>()), useDesktopSurface: () => true }));
vi.mock("@/lib/use-ensure-task", async (orig) => ({
  ...(await orig<object>()),
  useOlderTasks: () => ({ hasMore: true, loading: false, failed: true, loadMore: () => {} }),
}));
vi.mock("@/lib/feature-flags", async (orig) => ({ ...(await orig<object>()), builtInBrowserEnabled: () => false }));
vi.mock("@/lib/mascot", async (orig) => ({ ...(await orig<object>()), stateForBot: () => "idle" }));
vi.mock("@/lib/local-computer", async (orig) => ({
  ...(await orig<object>()),
  instanceSupportsLocalComputer: () => true,
  localComputerSelectable: () => true,
  localComputerDisabledReason: () => null,
}));
// No original here: it reads `window` as it loads.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: "/home/u" } } }),
}));
vi.mock("./bot-settings-drafts", async (orig) => ({
  ...(await orig<object>()),
  useBotSettingsDraft: () => {},
  useBotSettingsNavigation: () => (go: () => void) => go(),
}));
vi.mock("./SettingsPrimitives", async (orig) => {
  const { createElement: h } = await import("react");
  return {
    ...(await orig<object>()),
    Switch: (props: Record<string, unknown>) => h("button", { "aria-label": props["aria-label"], title: props.title }),
  };
});
vi.mock("./ModelPicker", async (orig) => ({ ...(await orig<object>()), ModelPicker: ({ label }: { label?: unknown }) => label ?? null }));
const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock("./CloudBackendPicker", async (orig) => ({ ...(await orig<object>()), CloudBackendPicker: none }));
vi.mock("./ThreadFollowControls", async (orig) => ({ ...(await orig<object>()), BotFollowModelRow: none, LimitBackupRow: none }));
vi.mock("./BotProfileAvatarCard", async (orig) => ({ ...(await orig<object>()), BotProfileAvatarCard: none }));
vi.mock("./BotRoleControl", async (orig) => ({ ...(await orig<object>()), BotRoleControl: none }));
vi.mock("./CanTalkToControl", async (orig) => ({ ...(await orig<object>()), CanTalkToControl: none }));
vi.mock("./BotIntakeCard", async (orig) => ({ ...(await orig<object>()), BotSetupAction: none }));
vi.mock("./BotSkillsPanel", async (orig) => ({ ...(await orig<object>()), BotSkillsPanel: none }));
vi.mock("./BotShapesPanel", async (orig) => ({ ...(await orig<object>()), BotShapesPanel: none }));
vi.mock("./PublishCard", async (orig) => ({ ...(await orig<object>()), PublishedSitesPanel: none }));
vi.mock("./LearningSettings", async (orig) => ({ ...(await orig<object>()), LearningSettings: none }));
vi.mock("./LearningOverviewLine", async (orig) => ({ ...(await orig<object>()), LearningOverviewLine: none }));
vi.mock("./FolderTrustNote", async (orig) => ({ ...(await orig<object>()), FolderTrustNote: none }));
vi.mock("./LocalComputerAutoWarning", async (orig) => ({ ...(await orig<object>()), LocalComputerAutoWarning: none }));
vi.mock("./FullAccessWarning", async (orig) => ({ ...(await orig<object>()), FullAccessWarning: none }));
vi.mock("./BotPermissionDefault", async (orig) => ({ ...(await orig<object>()), BotPermissionDefault: none }));
vi.mock("./BotImageApproval", async (orig) => ({ ...(await orig<object>()), BotImageApproval: none }));
vi.mock("./RememberedApprovals", async (orig) => ({ ...(await orig<object>()), RememberedApprovals: none }));
vi.mock("./VoiceSettings", async (orig) => ({ ...(await orig<object>()), VoiceSettings: none }));
vi.mock("./BotAccessSettings", async (orig) => ({ ...(await orig<object>()), BotAccessSettings: none }));
vi.mock("./MemoryLauncher", async (orig) => ({ ...(await orig<object>()), MemoryLauncher: none }));
vi.mock("./ContinuityBlock", async (orig) => ({ ...(await orig<object>()), ContinuityBlock: none }));

const CREATED = Date.UTC(2026, 9, 20, 9, 30);
const USAGE = { input: 1200, output: 300, costUsd: 0.42, turns: 3 };
const baseBot = {
  id: "b1",
  name: "Vega",
  title: "",
  description: "",
  threadId: "t1",
  notifications: false,
  approvePeerComms: false,
  cloudBackend: "vps",
  modelSelection: { instanceId: "i1" },
  installedPackage: { sourceRole: "leader", sourceTeam: "Growth" },
  tasks: [{ threadId: "t1", title: "Plan the launch", createdAt: CREATED, cwd: "/srv/elsewhere", usage: USAGE }],
  usageTotal: USAGE,
};

function render(bot: Record<string, unknown>, muragebox: Record<string, unknown> | undefined) {
  store.state = {
    instances: [{
      instanceId: "i1",
      driverKind: "claudeAgent",
      snapshot: { billing: "metered" },
      capabilities: { effortLevels: ["low", "high"], approvalReview: false, agentsMcp: false, composioMcp: false, browserMcp: false, computerMcp: false },
    }],
    bots: [bot, { id: "b2", name: "Orion" }],
    config: { composio: { configured: false } },
    routines: [],
    error: null,
    mascotMotion: null,
  };
  vi.stubGlobal("window", { muragebox });
  return renderToStaticMarkup(createElement(SettingsPanel, { bot: bot as never }));
}

const decode = (text: string) =>
  text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every visible string (text and the attributes a reader or screen reader
 * meets) with markers and the given data/other-module strings taken out. */
function leftovers(markup: string, allowed: string[]): string[] {
  const pieces = [
    ...[...markup.matchAll(/\s(?:aria-label|title|placeholder)="([^"]*)"/g)].map((match) => match[1]),
    ...markup.replace(/<[^>]*>/g, "\n").split("\n"),
  ];
  const byLength = [...allowed].sort((a, b) => b.length - a.length);
  return pieces
    .map((piece) => {
      let rest = decode(piece).replace(/⟦[^⟧]*⟧/g, " ");
      for (const value of byLength) rest = rest.split(value).join(" ");
      return rest.trim();
    })
    .filter((rest) => /[A-Za-z]{2,}/.test(rest));
}

/** Copy that other modules own (each is its own lane), and the fixture's own data. */
const allowedFor = (bot: Record<string, unknown>) => [
  "Vega", "Plan the launch", "Growth", "/srv/elsewhere", "memory/",
  new Date(CREATED).toLocaleString(),
  PEER_CONTACT_LABEL, peerContactHint(bot as never), botRoleTitle(bot as never), settingsRoleLabel("leader"),
  effortLabel(undefined), effortLabel("low"), effortLabel("high"),
  usageDetail(USAGE as never),
];

describe("bot settings in another language", () => {
  beforeAll(async () => {
    localeLoaders["zz"] = async () => Object.fromEntries(Object.keys(en).map((key) => [key, `⟦${key}⟧`]));
    expect(await setLocale("zz")).toBe("zz");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    delete localeLoaders["zz"];
    await setLocale("en");
  });

  it("shows no English of its own: usage card, labels, placeholders, titles", () => {
    const bot = { ...baseBot };
    const markup = render(bot, { pickFolder: async () => null });
    expect(leftovers(markup, allowedFor(bot))).toEqual([]);
    for (const key of ["usageCard.title", "usageCard.allBots", "usageCard.colTurns", "usageCard.colTokens", "usageCard.colCost", "usageCard.costLine",
      "settings.bot.header.title", "settings.bot.header.close", "settings.bot.folder.title", "settings.bot.folder.private", "settings.bot.folder.choose",
      "settings.bot.notebook.title", "settings.bot.review.title", "settings.bot.review.notSupported", "settings.bot.computer.vpsTitle",
      "settings.bot.identity.personalityPlaceholder", "settings.bot.overview.importedRole", "settings.bot.history.loadFailed"]) {
      expect(markup, key).toContain(`⟦${key}⟧`);
    }
  });

  it("the empty usage line, the typed folder and the home-folder pin are translated too", () => {
    const bot = { ...baseBot, cwd: "/srv/work", usageTotal: { input: 0, output: 0, costUsd: null, turns: 0 }, tasks: [{ ...baseBot.tasks[0], cwd: null }] };
    const markup = render(bot, undefined);
    expect(leftovers(markup, [...allowedFor(bot), "/srv/work"])).toEqual([]);
    for (const key of ["usageCard.empty", "settings.bot.folder.pathLabel", "settings.bot.folder.pathPlaceholder", "settings.bot.save",
      "settings.bot.folder.pinned", "settings.bot.folder.homeFolder"]) {
      expect(markup, key).toContain(`⟦${key}⟧`);
    }
  });

  it("keeps the English pin sentence whole around the folder", async () => {
    await setLocale("en");
    try {
      const bot = { ...baseBot, cwd: "/srv/work" };
      const markup = decode(render(bot, undefined)).replace(/<[^>]*>/g, "");
      expect(markup).toContain("New tasks start here. This task is pinned to /srv/elsewhere; start a new task to use the new folder.");
    } finally {
      await setLocale("zz");
    }
  });
});
