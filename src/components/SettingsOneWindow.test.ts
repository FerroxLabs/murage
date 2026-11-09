// One Settings window (SETTINGS-UX-1011 S7, UX-L3B): a bot's settings are a page of the Settings window under its Bots
// group; BotSettingsDialog is a thin opener; drafts, the unsaved-edit check and murage:open-memory still work; the bot
// header chips open their section with the row marked; the app search carries the anchor for its hint (L4C).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, createRef, type MutableRefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { sidebarBots } from "@/lib/settings-shell-bots";

const fixture = vi.hoisted(() => ({
  bots: [{ id: "nova", name: "Nova" }, { id: "pepper", name: "Pepper" }] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: null, bots: fixture.bots, botSettingsIntent: null }, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("no network in this test"); }),
}));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<typeof import("@/lib/use-surface")>()), useDesktopSurface: () => true }));
vi.mock("@/lib/bot-email", async (original) => ({ ...(await original<typeof import("@/lib/bot-email")>()), useEmailStatus: () => ({ kind: "off" }) }));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("@/lib/learning-counts", async (original) => ({ ...(await original<typeof import("@/lib/learning-counts")>()), useLearningBadge: () => 0 }));

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const { reducer, initialState } = await import("@/state/store");
const { BotSettingsPane, BOT_HEADER_CHIPS } = await import("./BotSettingsPane");
type Leave = import("./BotSettingsPane").BotSettingsLeave;

describe("one Settings window", () => {
  it("the bot opener is thin: it shows the Settings window with the bot selected, not a window of its own", () => {
    const opener = read("./BotSettingsDialog.tsx");
    expect(opener).not.toContain("<dialog");
    expect(opener).toContain("<Window bot={bot} onBotClose={onClose} />");
    expect(opener).toContain('import("./SettingsModal")');
    // The opener and the window stay off the first paint; preloading brings the window and the bot page in together.
    expect(read("../lib/preload-bot-settings.ts")).toContain("await module.loadBotSettingsWindow()");
    expect(read("../App.tsx")).not.toMatch(/^import .*(SettingsModal|BotSettingsPane)/m);
  });

  it("lists the bots under a closed Bots group, leaves archived ones out except the open bot, and shows the chosen bot's page in the window", () => {
    const modal = read("./SettingsModal.tsx");
    // 1.0.19 shell: Each bot lists up to five rows (no closed toggle); archived bots stay out except the open one.
    expect(modal).toContain("const botRows = sidebarBots(state.bots, bot?.id);");
    expect(modal).toContain('const rows = group === "bots" ? botRows.rows : [];');
    const some = [{ id: "a", name: "Ann" }, { id: "b", name: "Bea", hidden: true }, { id: "c", name: "Cy", hidden: true }];
    expect(sidebarBots(some, "c").rows.map((each) => each.id)).toEqual(["a", "c"]);
    expect(modal).toContain("data-settings-bot={each.id}");
    expect(modal).toContain('<Pane bot={bot} onClose={closeBot} leaveRef={botLeave} />');
    expect(modal).toContain('dispatch({ type: "toggleSettings", open: true, botId: id })');
  });

  it("every way out of a bot's page asks that page first", () => {
    const modal = read("./SettingsModal.tsx");
    expect(modal).toContain("if (bot) { leaveBotPage(operation); return; }");
    expect(modal).toContain("registerBotPageLeave(() => botLeave.current)");
    expect(modal).toContain("const closeSettings = useCallback(() => leave(bot ? closeBot");
    expect(modal).toContain("if (bot) leave(() => dispatch({ type: \"toggleAppSettings\", open: true, section: id }))");
  });

  it("opening a bot from the Bots group keeps the chat behind it; closing forgets the bot", () => {
    const open = reducer(initialState, { type: "toggleSettings", open: true, botId: "pepper" });
    expect(open.settingsOpen).toBe(true);
    expect(open.settingsBotId).toBe("pepper");
    expect(open.selectedId).toBe(initialState.selectedId);
    expect(reducer(open, { type: "toggleSettings", open: false }).settingsBotId).toBeNull();
    expect(reducer(initialState, { type: "toggleSettings", open: true }).settingsBotId).toBeNull();
    // An Edit link inside the window names only a section: it stays on the bot the window shows.
    expect(reducer(open, { type: "toggleSettings", open: true, intent: { section: "identity" } }).settingsBotId).toBe("pepper");
    // Moving to an app page closes the bot page.
    expect(reducer(open, { type: "toggleAppSettings", open: true, section: "general" }).settingsOpen).toBe(false);
    expect(read("../App.tsx")).toContain("state.bots.find((b) => b.id === state.settingsBotId)");
  });

  it("the bot page renders inside the window: sections, chips and footer, and no frame or Close of its own", () => {
    const leaveRef = createRef<Leave | null>() as MutableRefObject<Leave | null>;
    const html = renderToStaticMarkup(createElement(BotSettingsPane, { bot: fixture.bots[0] as never, onClose: () => {}, leaveRef }));
    expect(html).toContain('data-bot-settings-pane="nova"');
    expect(html).toContain('aria-label="Bot settings sections"');
    expect(html).toContain("Most changes save immediately.");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("Close bot settings");
    for (const chip of BOT_HEADER_CHIPS) expect(html).toContain(`data-bot-header-chip="${chip.id}"`);
    expect(html).toContain("Email (Off)");
    // With nothing unsaved the page lets the window go at once.
    const operation = vi.fn();
    leaveRef.current?.(operation);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("each header chip opens a section and a row that exist", () => {
    const panel = read("./SettingsPanel.tsx");
    expect(BOT_HEADER_CHIPS.map((chip) => chip.id)).toEqual(["level", "engine", "apps", "folder", "email"]);
    for (const chip of BOT_HEADER_CHIPS) {
      const at = panel.indexOf(`id="${chip.anchor}"`);
      expect(at, chip.anchor).toBeGreaterThan(-1);
      const before = panel.slice(0, at);
      expect(before.slice(before.lastIndexOf("<SettingsSection id=")), chip.anchor).toContain(`<SettingsSection id="${chip.section}"`);
    }
    const pane = read("./BotSettingsPane.tsx");
    expect(pane).toContain("chooseSection(chip.section); setPendingAnchor(chip.anchor);");
  });

  it("drafts, the unsaved-edit check and murage:open-memory still live on the bot page", () => {
    const pane = read("./BotSettingsPane.tsx");
    expect(pane).toContain('window.confirm("Discard unsaved changes and close bot settings?")');
    expect(pane).toContain('window.addEventListener("murage:open-memory", opened)');
    expect(pane).toContain("<BotSettingsDraftContext.Provider value={updateDraft}>");
    expect(pane).toContain("if (leaveRef) leaveRef.current = navigate;");
  });

  it("Escape over an editor opened above the window is that editor's, and a failed load can be tried again", () => {
    const modal = read("./SettingsModal.tsx");
    expect(modal).toContain('useLayerContainer(dialogRef, { onEscape: closeSettings, initialFocus: null, holdFocus: false })');
    const engine = read("../lib/focus-trap.ts");
    expect(engine).toContain("entry.modalRoot === root");
    expect(engine).toContain("event.defaultPrevented || event.isComposing");
    expect(engine).toContain("guarded(doc, event.target");
    expect(read("../lib/preload-bot-settings.ts")).toContain("}).catch((error) => { loading = null; throw error; });");
  });

  it("the app search carries the anchor its hint points at (L4C)", () => {
    const modal = read("./SettingsModal.tsx");
    expect(modal).toContain('id="settings-search"');
    expect(modal).toContain('data-coach-anchor="settings-search"');
  });

  it("keeps to the copy rules", () => {
    for (const file of ["./BotSettingsPane.tsx", "./BotSettingsDialog.tsx"]) expect(read(file)).not.toMatch(/—|\b(safe|safely|free|forge)\b/i);
  });
});
