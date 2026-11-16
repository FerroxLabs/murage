// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import { initialState, reducer, type Action } from "@/state/store";
import { resetSettingsModeForTest, setSettingsMode, settingsMode } from "@/lib/settings-mode";
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import type { AnchorWait } from "@/lib/anchor-wait";
import { LazyOverlay } from "../LazyOverlay";
import { SettingsModal } from "../SettingsModal";

const fixture = vi.hoisted(() => ({
  state: {} as typeof initialState,
  dispatch: vi.fn<(action: Action) => void>(),
  waits: [] as Array<{ mode: string; anchor: string | null }>,
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("No network in the Settings navigation fixture"); }),
}));
vi.mock("@/lib/use-surface", () => ({
  useSurfaceState: () => ({ desktop: true, confirmed: true }),
  useDesktopSurface: () => true,
}));
// The real shell and search use isolated card bodies: no account or service effects.
vi.mock("./page-registry", async () => {
  const { MERGED_CARD_ANCHORS, SETTINGS_CARDS } = await import("@/lib/settings-card-registry");
  const { isSimpleCard } = await import("@/lib/settings-simple-cards");
  const { PageCards } = await import("./PageCards");
  return {
    hasPageFile: () => true,
    SettingsPageMount: ({ page, mode }: SettingsPageProps) => h(PageCards, {
      mode,
      cards: SETTINGS_CARDS.filter((card) => card.section === page).map((card) => ({
        id: card.id, anchor: card.anchor, simple: isSimpleCard(card.id),
        render: () => h("div", null,
          h("button", { "data-setting-control": card.anchor }, card.id),
          ...Object.entries(MERGED_CARD_ANCHORS).filter(([, parent]) => parent === card.anchor)
            .map(([anchor]) => h("button", { key: anchor, id: anchor }, anchor))),
      })),
    }),
  };
});
vi.mock("@/lib/anchor-wait", () => ({
  waitForAnchor: (wait: AnchorWait<HTMLElement>) => {
    fixture.waits.push({ mode: settingsMode(), anchor: wait.find()?.id ?? null });
    return () => {};
  },
}));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  resetSettingsModeForTest();
  setSettingsMode("simple");
  fixture.waits = [];
  fixture.state = { ...initialState, appSettingsOpen: true, appSettingsSection: "connections", appSettingsAnchor: null };
  fixture.dispatch.mockImplementation((action) => { fixture.state = reducer(fixture.state, action); });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetSettingsModeForTest();
});

const settingsWindow = () => h(LazyOverlay, { name: "settings", kind: "window", covers: "always", onDismiss: vi.fn(), onRetry: vi.fn() }, h(SettingsModal));

describe("Settings target navigation", () => {
  it.each([
    ["connections", "claude-code-import-heading"],
    ["usage", "usage-learning-heading"],
    ["usage", "memory-limit-heading"],
  ] as const)("deep link to %s/%s enables Advanced before waiting", async (section, anchor) => {
    fixture.state = reducer(fixture.state, { type: "toggleAppSettings", open: true, section, anchor });
    mount(settingsWindow());
    await settle();
    expect(settingsMode()).toBe("advanced");
    expect(fixture.waits.length).toBeGreaterThan(0);
    expect(fixture.waits.every((wait) => wait.mode === "advanced" && wait.anchor === anchor)).toBe(true);
  });

  it.each([
    ["Claude Code", "connections.claude-code", "claude-code-import-heading"],
    ["learning limit", "memory.limit", "memory-limit-heading"],
  ])("search opens %s in Advanced before waiting", async (query, id, anchor) => {
    const app = mount(settingsWindow());
    const search = document.querySelector<HTMLInputElement>("#settings-search")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(settingsMode()).toBe("simple");
    const result = document.querySelector<HTMLButtonElement>(`[data-settings-result="${id}"]`)!;
    expect(result).not.toBeNull();
    act(() => result.click());
    app.rerender(settingsWindow());
    await settle();
    expect(settingsMode()).toBe("advanced");
    expect(fixture.waits).toContainEqual({ mode: "advanced", anchor });
    expect(fixture.waits.every((wait) => wait.mode === "advanced")).toBe(true);
  });

  it.each([
    ["about.updates", "updates-heading", "simple"],
    ["about.previous-version", "previous-version-heading", "simple"],
    ["about.announcements", "announcements-heading", "advanced"],
    ["announcements-heading", "announcements-heading", "advanced"],
  ] as const)("merged target %s waits for %s in %s mode", async (target, anchor, mode) => {
    fixture.state = reducer(fixture.state, { type: "toggleAppSettings", open: true, section: "about", anchor: target });
    mount(settingsWindow());
    await settle();
    expect(settingsMode()).toBe(mode);
    expect(fixture.waits).toContainEqual({ mode, anchor });
    expect(fixture.waits.every((wait) => wait.mode === mode && wait.anchor === anchor)).toBe(true);
  });

  it("ordinary Apps navigation and Simple card links keep Simple", async () => {
    const app = mount(settingsWindow());
    expect(settingsMode()).toBe("simple");
    expect(fixture.waits).toEqual([]);
    fixture.state = reducer(fixture.state, { type: "toggleAppSettings", open: true, section: "connections", anchor: "mcp-servers-heading" });
    app.rerender(settingsWindow());
    await settle();
    expect(settingsMode()).toBe("simple");
    expect(fixture.waits).toContainEqual({ mode: "simple", anchor: "mcp-servers-heading" });
  });
});
