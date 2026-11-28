// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: SettingsPanel.tsx is split into one file per bot page and the old file only re-exports.
// Two witnesses: (1) the old file holds no JSX and no hooks, only re-exports; (2) the rendered controls
// (section order and every data-setting row, in document order) are exactly what the unsplit panel drew.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "../SettingsPanel";

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
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: "/home/u" } } }),
}));
vi.mock("../bot-settings-drafts", async (orig) => ({
  ...(await orig<object>()),
  useBotSettingsDraft: () => {},
  useBotSettingsNavigation: () => (go: () => void) => go(),
}));
vi.mock("../SettingsPrimitives", async (orig) => {
  const { createElement: h } = await import("react");
  return {
    ...(await orig<object>()),
    Switch: (props: Record<string, unknown>) => h("button", { "aria-label": props["aria-label"], title: props.title }),
  };
});
vi.mock("../ModelPicker", async (orig) => ({ ...(await orig<object>()), ModelPicker: ({ label }: { label?: unknown }) => label ?? null }));
const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock("../CloudBackendPicker", async (orig) => ({ ...(await orig<object>()), CloudBackendPicker: none }));
vi.mock("../ThreadFollowControls", async (orig) => ({ ...(await orig<object>()), BotFollowModelRow: none, LimitBackupRow: none }));
vi.mock("../BotProfileAvatarCard", async (orig) => ({ ...(await orig<object>()), BotProfileAvatarCard: none }));
vi.mock("../BotRoleControl", async (orig) => ({ ...(await orig<object>()), BotRoleControl: none }));
vi.mock("../CanTalkToControl", async (orig) => ({ ...(await orig<object>()), CanTalkToControl: none }));
vi.mock("../BotIntakeCard", async (orig) => ({ ...(await orig<object>()), BotSetupAction: none }));
vi.mock("../BotSkillsPanel", async (orig) => ({ ...(await orig<object>()), BotSkillsPanel: none }));
vi.mock("../BotShapesPanel", async (orig) => ({ ...(await orig<object>()), BotShapesPanel: none }));
vi.mock("../PublishCard", async (orig) => ({ ...(await orig<object>()), PublishedSitesPanel: none }));
vi.mock("../LearningSettings", async (orig) => ({ ...(await orig<object>()), LearningSettings: none }));
vi.mock("../LearningOverviewLine", async (orig) => ({ ...(await orig<object>()), LearningOverviewLine: none }));
vi.mock("../FolderTrustNote", async (orig) => ({ ...(await orig<object>()), FolderTrustNote: none }));
vi.mock("../LocalComputerAutoWarning", async (orig) => ({ ...(await orig<object>()), LocalComputerAutoWarning: none }));
vi.mock("../FullAccessWarning", async (orig) => ({ ...(await orig<object>()), FullAccessWarning: none }));
vi.mock("../BotPermissionDefault", async (orig) => ({ ...(await orig<object>()), BotPermissionDefault: none }));
vi.mock("../approval/use-level-change", () => ({ useLevelChange: () => ({ pick: () => {} }) }));
vi.mock("../BotImageApproval", async (orig) => ({ ...(await orig<object>()), BotImageApproval: none }));
vi.mock("../RememberedApprovals", async (orig) => ({ ...(await orig<object>()), RememberedApprovals: none }));
vi.mock("../VoiceSettings", async (orig) => ({ ...(await orig<object>()), VoiceSettings: none }));
vi.mock("../BotAccessSettings", async (orig) => ({ ...(await orig<object>()), BotAccessSettings: none }));
vi.mock("../MemoryLauncher", async (orig) => ({ ...(await orig<object>()), MemoryLauncher: none }));
vi.mock("../ContinuityBlock", async (orig) => ({ ...(await orig<object>()), ContinuityBlock: none }));
const store2 = store;
const bot = {
  id: "b1", name: "Vega", title: "", description: "", threadId: "t1", notifications: false, approvePeerComms: false,
  cloudBackend: "vps", modelSelection: { instanceId: "i1" }, tasks: [], usageTotal: { input: 0, output: 0, costUsd: null, turns: 0 },
};

function renderAll() {
  store2.state = {
    instances: [{ instanceId: "i1", driverKind: "claudeAgent", snapshot: { billing: "metered" }, capabilities: { effortLevels: ["low", "high"], approvalReview: false, agentsMcp: false, composioMcp: false, browserMcp: false, computerMcp: false } }],
    bots: [bot, { id: "b2", name: "Orion" }],
    config: { composio: { configured: false } },
    routines: [],
    error: null,
    mascotMotion: null,
  };
  vi.stubGlobal("window", { muragebox: undefined });
  return renderToStaticMarkup(createElement(SettingsPanel, { bot: bot as never }));
}

/** Document order of every section and every row id the panel draws. */
function controlOrder(markup: string): string[] {
  return [...markup.matchAll(/data-settings-section="([^"]+)"|data-setting="([^"]+)"/g)].map((m) => (m[1] ? `section:${m[1]}` : m[2]));
}

const EXPECTED: string[] = [
  "section:overview",
  "bot.overview.setup",
  "section:identity",
  "bot.identity.avatar",
  "bot.identity.name",
  "bot.identity.title",
  "bot.identity.instructions",
  "bot.identity.personality",
  "bot.identity.archive",
  "section:overview",
  "bot.overview.role",
  "section:permissions",
  "bot.permissions.can-talk",
  "bot.permissions.peers",
  "section:access",
  "bot.access.apps",
  "bot.access.app-access",
  "bot.access.phone",
  "bot.access.phone-for-bots",
  "bot.access.browser",
  "bot.access.browser-choice",
  "section:model",
  "bot.model.model",
  "bot.model.backup",
  "bot.model.effort",
  "section:access",
  "bot.access.computer",
  "section:usage",
  "bot.usage.usage",
  "section:access",
  "bot.access.folder",
  "bot.access.sites",
  "section:email",
  "bot.email.email",
  "section:memory",
  "bot.memory.memory",
  "bot.memory.notebook",
  "section:shapes",
  "bot.shapes.shapes",
  "section:skills",
  "bot.skills.skills",
  "section:learning",
  "bot.learning.learning",
  "section:permissions",
  "bot.permissions.level",
  "bot.permissions.images",
  "bot.permissions.always-allowed",
  "bot.permissions.review",
  "section:voice",
  "bot.voice.voice",
  "bot.voice.notifications",
  "bot.voice.calls",
  "section:routines",
  "bot.routines.routines",
  "section:teams",
  "bot.teams.teams",
  "section:history",
  "bot.history.history",
];

describe("B0 bot page split", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("draws the same sections and rows in the same order as the unsplit panel", () => {
    const order = controlOrder(renderAll());
    if (process.env.B0_PRINT) console.log("B0_ORDER " + JSON.stringify(order));
    expect(order).toEqual(EXPECTED);
  });

  it("the old file only re-exports: no JSX, no hooks, no component bodies", () => {
    const old = readFileSync(fileURLToPath(new URL("../SettingsPanel.tsx", import.meta.url)), "utf8");
    const code = old.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line) && line.trim() !== "");
    expect(code.every((line) => /^export (type )?\{[^}]*\} from "[^"]+";?$|^export \* from "[^"]+";?$/.test(line)), code.join("\n")).toBe(true);
    expect(old.length).toBeLessThan(1500);
  });
});
