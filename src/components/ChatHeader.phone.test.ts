// The phone chat header: a back circle, the bot's name pill and one round
// "..." menu. The model, the bot's computer and the bot's profile move into
// that menu with everything the row would otherwise fold; the tablet and
// desktop headers are the ones they always were. Same shape as
// ChatHeader.test.ts: node, markup through renderToStaticMarkup, with the
// menu's props captured so the entries can be read.
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));

const fixture = vi.hoisted(() => ({
  phone: false,
  dispatch: vi.fn(),
  menu: null as null | { items: Array<{ id: string; label: string; checked?: boolean; onSelect: () => void }>; variant?: string; label: string; menuLabel: string },
  model: null as null | Record<string, unknown>,
  state: {
    config: { features: { browser: true } },
    instances: [{ instanceId: "engine", capabilities: { browserMcp: true }, snapshot: {} }],
    computerOpen: false,
    inspectorOpen: false,
  },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("@/lib/media-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-query")>()),
  useNarrowViewport: () => fixture.phone,
}));
// The real relocation order, with a layout that relocates nothing: on a phone
// the menu must hold every slot whatever the measured layout says.
vi.mock("@/lib/chat-header-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-header-layout")>()),
  useChatHeaderLayout: () => ({ layout: { twoRow: false, chips: "full" }, slots: new Set() }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./CallControls", () => ({ CallButton: () => createElement("span", { "data-call-button": "" }) }));
vi.mock("./Files", () => ({ openFiles: vi.fn() }));
vi.mock("./MemoryLauncher", () => ({ MemoryLauncher: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: Record<string, unknown>) => { fixture.model = props; return null; } }));
vi.mock("./RenameTitle", () => ({ RenameTitle: (props: { onActivate?: () => void }) => createElement("span", { "data-rename": props.onActivate ? "link" : "plain" }) }));
vi.mock("./RoleBadge", () => ({ RoleBadge: () => null }));
vi.mock("./TaskPicker", () => ({ TaskPicker: () => createElement("span", { "data-task-picker": "" }) }));
vi.mock("./ChatHeaderMenu", () => ({ ChatHeaderMenu: (props: NonNullable<typeof fixture.menu>) => { fixture.menu = props; return createElement("button", { "data-menu-stub": props.variant ?? "header" }); } }));

const { ChatHeader } = await import("./ChatHeader");
const { BotListDrawerProvider } = await import("./OpenBotListButton");

beforeEach(() => {
  fixture.phone = false;
  fixture.menu = null;
  fixture.model = null;
  fixture.dispatch.mockClear();
  fixture.state.computerOpen = false;
});

function renderHeader(overrides: Partial<Bot> = {}) {
  const bot = {
    id: "bot", name: "Ember", threadId: "thread", busy: false, computer: "browser",
    modelSelection: { instanceId: "engine", model: "model-x" }, messages: [], createdAt: 1, ...overrides,
  } as Bot;
  const control = { expanded: false, open: () => {}, buttonRef: createRef<HTMLButtonElement>(), takeFocusReturn: () => false };
  return renderToStaticMarkup(createElement(BotListDrawerProvider, {
    value: control,
    children: createElement(ChatHeader, { bot, messages: [], mascotMotion: null, findOpen: false, onToggleFind: () => {} }),
  }));
}

describe("the phone chat header", () => {
  it("is a back circle, a name pill and the round ... menu", () => {
    fixture.phone = true;
    const html = renderHeader();
    expect(html).toContain("data-chat-header-phone");
    expect(html).toContain("data-chat-header-pill");
    // the drawer button, drawn as the circle (same button, same focus return)
    expect(html).toContain('aria-label="Open bot list"');
    expect(html).toContain("data-bot-list-circle");
    expect(html).toContain('data-menu-stub="phone-more"');
    expect(fixture.menu?.label).toBe("More actions");
    expect(fixture.menu?.menuLabel).toBe("More header actions");
  });

  it("moves the profile, the model and the bot's computer into the menu, with the folded controls", () => {
    fixture.phone = true;
    renderHeader();
    const ids = fixture.menu?.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["profile", "model", "computer", "find", "inspector", "memory"]));
    expect(ids?.slice(0, 2)).toEqual(["profile", "model"]);
    const entry = (id: string) => fixture.menu!.items.find((item) => item.id === id)!;
    entry("profile").onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true });
    entry("computer").onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleComputer" });
  });

  it("opens the model list from its menu entry, with the chip hidden and focus returning to the ... button", () => {
    fixture.phone = true;
    const heard = vi.fn();
    (globalThis as { window: Window }).window.dispatchEvent = ((event: Event) => { heard(event.type); return true; }) as never;
    renderHeader();
    expect(fixture.model).toMatchObject({ hideTrigger: true });
    expect(fixture.model?.returnFocusRef).toBeDefined();
    fixture.menu!.items.find((item) => item.id === "model")!.onSelect();
    expect(heard).toHaveBeenCalledWith("murage:open-model-picker");
  });

  it("drops the model chip, the profile click targets and the bot's computer button from the row", () => {
    fixture.phone = true;
    const html = renderHeader();
    expect(html).not.toContain('data-header-labelled="model"');
    expect(html).not.toContain('title="Bot settings"');
    expect(html).toContain('data-rename="plain"');
    expect(html).not.toContain("Bot&#x27;s computer");
    expect(html).not.toContain('aria-label="Find in conversation"');
  });

  it("keeps the chat picker, New chat, the call button and Stop on the row", () => {
    fixture.phone = true;
    const html = renderHeader({ busy: true });
    expect(html).toContain("data-task-picker");
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain("data-call-button");
    expect(html).toContain('aria-label="Stop this turn"');
  });
});

describe("the desktop and tablet chat header", () => {
  it("is unchanged: model chip in the row, profile button, no phone markers, the plain menu variant", () => {
    fixture.phone = false;
    const html = renderHeader();
    expect(html).not.toContain("data-chat-header-phone");
    expect(html).not.toContain("data-chat-header-pill");
    expect(html).not.toContain("data-bot-list-circle");
    expect(html).toContain('data-header-labelled="model"');
    expect(html).toContain('title="Bot settings"');
    expect(html).toContain('data-rename="link"');
    expect(html).toContain('aria-label="Find in conversation"');
    expect(fixture.model?.hideTrigger).toBeFalsy();
    // nothing relocated by the layout, so no menu is drawn at all
    expect(html).not.toContain("data-menu-stub");
  });
});

describe("the header menu's keyboard contract", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatHeaderMenu.tsx", import.meta.url)), "utf8");

  it("is a labelled menu button whose Escape and Tab close it and return focus to the trigger", () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain("aria-label={label}");
    expect(source).toContain('role="menu"');
    expect(source).toContain("aria-label={menuLabel}");
    expect(source).toMatch(/event\.key === "Escape" \|\| event\.key === "Tab"\) close\(true\)/);
    expect(source).toMatch(/if \(restore\) triggerRef\.current\?\.focus\(\)/);
    // choosing an entry also hands focus back to the trigger before the action runs
    expect(source).toMatch(/close\(true\);[\s\S]{0,200}item\.onSelect\(\)/);
  });

  it("gives the phone ... and the composer + their own looks without touching the header's", () => {
    expect(source).toMatch(/"phone-more"/);
    expect(source).toMatch(/"composer-plus"/);
    expect(source).toContain('trigger: "size-[30px] rounded-md text-ink-secondary hover:bg-raised hover:text-ink"');
    expect(source).toContain('menu: "bottom-full left-0 mb-2"');
  });

  it("returns focus for the phone model picker to the ... button, not the hidden chip", () => {
    const picker = readFileSync(fileURLToPath(new URL("./ModelPicker.tsx", import.meta.url)), "utf8");
    expect(picker).toContain("(returnFocus.current?.current??trigger.current)?.focus()");
    expect(picker).toContain("returnFocus.current=returnFocusRef;");
    expect(picker).toContain("hideTrigger&&'sr-only'");
  });

  it("keeps one model picker across the phone and wide layouts, so an open picker survives a rotation", () => {
    const header = readFileSync(fileURLToPath(new URL("./ChatHeader.tsx", import.meta.url)), "utf8");
    expect(header).not.toContain("model-phone-");
    expect(header.match(/<ModelPicker\b/g)).toHaveLength(1);
    expect(header).toContain("hideTrigger={phone}");
  });
});
