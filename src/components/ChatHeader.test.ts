// The header's folder chip names the folder a person would recognise. A
// Murage-made task folder is named by an id ("84b0ad57-0be6-…"), which told
// the person nothing, so the chip says Files and keeps the full location in
// its title and accessible name.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const header = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    config: { features: { browser: true } },
    instances: [{ instanceId: "engine", capabilities: { browserMcp: true }, snapshot: {} }],
    computerOpen: false,
    inspectorOpen: false,
  },
}));
vi.mock("@/state/store", () => ({ useStore: () => header }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => false }));
vi.mock("@/lib/chat-header-layout", () => ({
  HEADER_RELOCATION_ORDER: [],
  useChatHeaderLayout: () => ({ layout: { twoRow: false, chips: "full" }, slots: new Set() }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./CallControls", () => ({ CallButton: () => null }));
vi.mock("./Files", () => ({ openFiles: vi.fn() }));
vi.mock("./MemoryLauncher", () => ({ MemoryLauncher: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./RenameTitle", () => ({ RenameTitle: () => null }));
vi.mock("./RoleBadge", () => ({ RoleBadge: () => null }));
vi.mock("./TaskPicker", () => ({ TaskPicker: () => null }));
const { ChatHeader, workspaceChipLabel } = await import("./ChatHeader");

beforeEach(() => {
  header.dispatch.mockClear();
  header.state.config.features.browser = true;
  header.state.instances[0].capabilities.browserMcp = true;
  header.state.computerOpen = false;
});

function renderHeader(overrides: Partial<Bot> = {}) {
  const bot = {
    id: "bot", name: "Browser bot", threadId: "thread", busy: true, browserMounted: true,
    computer: "browser", browser: true, modelSelection: { instanceId: "engine", model: "model" },
    messages: [], createdAt: 1, ...overrides,
  } as Bot;
  return renderToStaticMarkup(createElement(ChatHeader, {
    bot, messages: [], mascotMotion: null, findOpen: false, onToggleFind: () => {},
  }));
}

it("offers New chat beside the chat picker with its keyboard hint", () => {
  const html = renderHeader();
  expect(html).toContain('aria-label="New chat"');
  expect(html).toMatch(/title="New chat \((?:Ctrl\+Shift\+N|⌘⇧N)\)"/);
});

it.each(["off", "browser"] as const)("marks a busy browser conversation in %s mode", computer => {
  const markup = renderHeader({ computer });
  expect(markup).toContain('data-testid="computer-button-live"');
  expect(markup).toContain('aria-label="Bot&#x27;s computer, in use now"');
  expect(markup).toMatch(/aria-label="Bot&#x27;s computer, in use now" aria-pressed="false"/);
  expect(markup).toContain("motion-reduce:animate-none");
  expect(markup).toMatch(/data-testid="computer-button-live" aria-hidden="true" class="[^"]*\babsolute\b/);
  expect(header.dispatch).not.toHaveBeenCalled();
  expect(header.state.computerOpen).toBe(false);
});

it.each([
  { busy: false }, { browserMounted: false }, { browserMounted: undefined }, { computer: "local" }, { computer: "vm" }, { computer: "cloud" },
  { computer: undefined }, { browser: false },
] satisfies Partial<Bot>[])("omits the live dot when the browser is not the busy place: %j", overrides => {
  const markup = renderHeader(overrides);
  expect(markup).not.toContain('data-testid="computer-button-live"');
  expect(markup).toContain('aria-label="Bot&#x27;s computer"');
  expect(markup).not.toContain("in use now");
});

it("omits the dot when browser tools are unavailable", () => {
  header.state.instances[0].capabilities.browserMcp = false;
  expect(renderHeader()).not.toContain('data-testid="computer-button-live"');
  header.state.instances[0].capabilities.browserMcp = true;
  header.state.config.features.browser = false;
  expect(renderHeader()).not.toContain('data-testid="computer-button-live"');
});

it("never shows a raw id as the folder's name", () => {
  expect(workspaceChipLabel({ path: "/Users/me/.murage/workspaces/b1/84b0ad57-0be6-4853-9c1e-5a3f0e7d2b11", origin: "task" })).toBe("Files");
  expect(workspaceChipLabel({ path: "C:\\Users\\Maus\\.murage\\workspaces\\84B0AD57-0BE6-4853-9C1E-5A3F0E7D2B11\\", origin: "bot" })).toBe("Files");
});

it("keeps a folder the person chose under its own name", () => {
  expect(workspaceChipLabel({ path: "/Users/me/projects/site/", origin: "task" })).toBe("site");
  expect(workspaceChipLabel({ path: "D:\\Work\\Q3 report", origin: "bot" })).toBe("Q3 report");
  expect(workspaceChipLabel({ origin: "default" })).toBe("Files");
});
