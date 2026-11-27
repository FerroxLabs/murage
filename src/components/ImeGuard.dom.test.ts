// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Editor } from "@tiptap/core";
import { SuggestionPluginKey } from "@tiptap/suggestion";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  api: vi.fn(), dispatch: vi.fn(), ask: vi.fn(),
  state: { bots: [] as unknown[], groups: [], instances: [], config: null as unknown },
  session: { phase: "ready", maskedEmail: "o***@example.test", act: "save", resendAt: 0, error: "" },
}));
vi.mock("@/state/store", async importOriginal => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, EmberAvatar: () => null }));
vi.mock("@/components/LayerSurface", () => ({ LayerSurface: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/focus-trap", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/focus-trap")>(), useFocusTrap: () => null,
}));
vi.mock("@/components/CalendarLayer", () => ({ useCalendarLayer: () => null }));
vi.mock("@/components/LayerSlot", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/LayerSlot")>(), useLayerContainer: () => null,
}));
vi.mock("@/components/FirstRunChrome", () => ({ useSetupView: () => ({ view: null, refresh: () => {} }) }));
vi.mock("@/components/today/use-engine-health", () => ({ useEngineReading: () => ({ health: null, flux: "ready" }) }));
vi.mock("@/lib/bot-skill-count", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/bot-skill-count")>(), useSkillCount: () => 0,
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/compose-link", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/compose-link")>(),
  composeIo: { readDraft: () => "", setDraft: fixture.ask, focus: () => {} },
}));
vi.mock("@/lib/owner-code", () => ({
  getOwnerCodeSession: () => fixture.session, subscribeOwnerCode: () => () => {},
  ownerCodeActions: { submit: fixture.ask, cancel: () => {}, resend: () => {} },
}));

import { SidebarNewChatPanel } from "./SidebarNewChatPanel";
import { ChannelDetailsPanel } from "./ChannelDetailsPanel";
import { NewTeamDialogBody } from "./NewTeamDialog";
import { TeamSettingsDialogBody } from "./TeamSettingsDialog";
import { AvatarGenerateSection } from "./BotProfileAvatarCard";
import { avatarGeneratorPlan } from "@/lib/avatar-generation";
import { NewRoutineSheet } from "./routines/NewRoutineSheet";
import { MakeProjectDialog, RenameChannelDialog } from "./GroupView";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { TeamLibraryPanel } from "./TeamLibraryPanel";
import { OwnerCodeDialog } from "./cloud/OwnerCodeDialog";
import { Inbox } from "./Inbox";
import { BotSetupAction } from "./BotIntakeCard";
import { OptionCard } from "./OptionCard";
import { createSlashCommand, SlashMenuPopup, SLASH_ITEMS, type SlashKeyHandle } from "./editor/slashMenu";
import { createMarkdownExtensions } from "@/lib/markdown-fidelity";
import { WidgetBody } from "./widget/WidgetBody";
import { WidgetTimePicker } from "./widget/WidgetTimePicker";
import { WidgetFormProvider, type WidgetForm } from "./widget/WidgetControls";
import { AskAboutScreen } from "./help/HelpAskChief";
import type { Bot, Group, Message } from "@/state/store";

const bot = { id: "bot-a", name: "Aster", color: "green", messages: [], threadId: "thread-a", modelSelection: { instanceId: "engine-a", model: "model-a" } } as unknown as Bot;
const group = { id: "room-a", name: "Planning", bulletin: "", memberIds: [], defaultResponder: { kind: "everyone" } } as unknown as Group;
let root: Root;
let host: HTMLDivElement;
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const input = (selector = "input") => {
  const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(node, selector).not.toBeNull();
  return node!;
};
const type = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
const signals: KeyboardEventInit[] = [{ isComposing: true }, { isComposing: false, keyCode: 229 }];
/** jsdom does not implement implicit Enter submission. Model that browser default only when keydown was not canceled. */
async function enter(node: HTMLElement, signal: KeyboardEventInit = {}, implicitSubmit = false) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...signal });
  await act(async () => {
    node.dispatchEvent(event);
    if (implicitSubmit && !event.defaultPrevented) node.closest("form")!.requestSubmit();
  });
  return event;
}
async function guarded(node: HTMLElement, action: () => number, modifiers: KeyboardEventInit = {}, implicitSubmit = false) {
  const before = action();
  for (const signal of signals) {
    await enter(node, { ...modifiers, ...signal }, implicitSubmit);
    expect(action(), `candidate Enter ${JSON.stringify(signal)}`).toBe(before);
  }
  await enter(node, modifiers, implicitSubmit);
  expect(action(), "ordinary Enter").toBe(before + 1);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.api.mockReset(); fixture.dispatch.mockReset(); fixture.ask.mockReset();
  fixture.state.bots = [bot]; fixture.state.config = null;
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/inbox?")) return { items: [], routines: [], counts: {}, total: 0 };
    if (path === "/api/team-library/catalog") return { teams: [] };
    if (path.includes("/skills")) return { skills: [], hits: [], total: 0, facets: [] };
    return {};
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("candidate confirmation stays in the text field", () => {
  it("SidebarNewChatPanel: only ordinary Enter starts the selected chat", async () => {
    await render(createElement(SidebarNewChatPanel, { bots: [bot], onPick: fixture.ask, onClose: () => {} }));
    await guarded(input(), () => fixture.ask.mock.calls.length);
    // Arrows also belong to the IME while choosing a candidate.
    await enter(input(), { key: "ArrowDown", isComposing: true });
  });
  it("ChannelDetailsPanel: only ordinary modified Enter saves instructions", async () => {
    await render(createElement(ChannelDetailsPanel, { group, onClose: () => {}, triggerRef: { current: null } }));
    await type(input("textarea"), "New instructions");
    await guarded(input("textarea"), () => fixture.dispatch.mock.calls.length, { ctrlKey: true });
  });
  it("NewTeamDialog: only ordinary Enter creates the team", async () => {
    await render(createElement(NewTeamDialogBody, {
      bots: [bot], existing: [], canLead: () => true, draft: { name: "Research", picked: new Set([bot.id]), lead: undefined, instructions: "" }, busy: false, error: null,
      onName: () => {}, onToggle: () => {}, onLead: () => {}, onInstructions: () => {}, onCreate: fixture.ask, onClose: () => {},
    }));
    await guarded(input('[aria-label="Team name"]'), () => fixture.ask.mock.calls.length);
  });
  it("TeamSettingsDialog: only ordinary Enter renames the team", async () => {
    await render(createElement(TeamSettingsDialogBody, {
      team: { name: "Planning", leadId: null, revision: "r".repeat(64), members: [], channels: [], hasInstructions: false }, candidates: [], existing: [], canLead: () => true,
      name: "Research", picked: new Set<string>(), lead: "", confirmingDelete: false, deleteChoice: "keep", busy: false, status: null,
      onName: () => {}, onSaveName: fixture.ask, onToggle: () => {}, onLead: () => {}, onSaveMembers: () => {}, onAskDelete: () => {}, onDeleteChoice: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onClose: () => {},
    }));
    await guarded(input('[aria-label="Team name"]'), () => fixture.ask.mock.calls.length);
  });
  it("BotProfileAvatarCard: only ordinary Enter saves the image credential", async () => {
    await render(createElement(AvatarGenerateSection, {
      plan: avatarGeneratorPlan({ flux: false, openAiImageKey: false, lastAttemptFailed: false }), direction: "", onDirection: () => {}, directionPlaceholder: "", generating: false, uploading: false, onGenerate: () => {},
      imageKey: "fixture value", onImageKey: () => {}, savingKey: false, onSaveKey: fixture.ask, onOpenSettings: () => {},
    }));
    await guarded(input(), () => fixture.ask.mock.calls.length);
  });
  it("NewRoutineSheet: only ordinary Enter moves the sentence to chat", async () => {
    await render(createElement(NewRoutineSheet, { onClose: () => {}, onChange: () => {}, onAskInChat: () => {} }));
    await type(input("textarea"), "Read the weekly notes");
    await guarded(input("textarea"), () => fixture.ask.mock.calls.length);
  });
  it("GroupView: form defaults and the project shortcut ignore candidate Enter", async () => {
    const close = vi.fn();
    await render(createElement(RenameChannelDialog, { group, onClose: close }));
    await type(input(), "Research");
    await guarded(input(), () => fixture.dispatch.mock.calls.length, {}, true);
    expect(close).toHaveBeenCalledTimes(1);
    await render(createElement(MakeProjectDialog, { group, onClose: () => {}, onMade: () => {} }));
    await type(input("textarea"), "Read the weekly notes");
    await guarded(input("textarea"), () => fixture.dispatch.mock.calls.length, { metaKey: true });
  });
  it("ApiKeys: only ordinary Enter saves the credential", async () => {
    await render(createElement(ApiKeyRow, { section: "box" }));
    await type(input(), "fixture value");
    await guarded(input(), () => fixture.api.mock.calls.filter(([, options]) => options?.method === "PUT").length);
  });
  it("VpsConnection: only ordinary Enter saves the SSH alias", async () => {
    await render(createElement(VpsConnection));
    await click("Set up your own server");
    const field = input('[aria-label="Self-hosted VPS SSH config alias"]');
    await type(field, "fixture-server");
    await guarded(field, () => fixture.api.mock.calls.filter(([, options]) => options?.method === "PUT").length);
  });
  it("TeamLibraryPanel: GitHub loading ignores candidate Enter", async () => {
    await render(createElement(TeamLibraryPanel, { onClose: () => {}, onImported: () => {}, returnFocusRef: { current: null }, initialTab: "import" }));
    await type(input('[aria-label="GitHub team URL"]'), "https://github.com/example/fixture");
    await guarded(input('[aria-label="GitHub team URL"]'), () => fixture.api.mock.calls.filter(([path]) => path.includes("/github")).length);
  });
  it("OwnerCodeDialog: only ordinary Enter confirms the filled code", async () => {
    await render(createElement(OwnerCodeDialog));
    await type(input(), "123456");
    await guarded(input(), () => fixture.ask.mock.calls.length);
  });
  it("Inbox: implicit search submission ignores candidate Enter", async () => {
    await render(createElement(Inbox, { onOpen: () => {}, initialView: "results" }));
    await type(input('input[type="search"]'), "Research");
    await guarded(input('input[type="search"]'), () => fixture.api.mock.calls.filter(([path]) => path.startsWith("/api/inbox?")).length, {}, true);
  });
  it("BotIntakeCard: only ordinary Enter looks for a matching profile", async () => {
    await render(createElement(BotSetupAction, { bot })); await click("Set up");
    await type(input(), "Read the weekly notes");
    await guarded(input(), () => fixture.api.mock.calls.length);
  });
  it("OptionCard: only ordinary Enter answers with custom text", async () => {
    const message = { id: "question-a", kind: "options", card: { title: "Choose a task", options: ["Read notes"] } } as unknown as Message;
    await render(createElement(OptionCard, { botId: bot.id, message }));
    await type(input(), "Read the weekly notes");
    await guarded(input(), () => fixture.dispatch.mock.calls.length);
  });
  it("editor/slashMenu: forwarded editor keys ignore both composition signals", async () => {
    const keyHandleRef = { current: null as SlashKeyHandle | null };
    await render(createElement(SlashMenuPopup, { items: SLASH_ITEMS.slice(0, 2), command: fixture.ask, rect: null, keyHandleRef, onClose: () => {} }));
    // Forward keys directly to isolate the popup's guard.
    const editor = document.createElement("div"); editor.contentEditable = "true"; host.append(editor);
    editor.addEventListener("keydown", event => { if (keyHandleRef.current?.onKeyDown(event)) event.preventDefault(); });
    for (const signal of signals) {
      const event = await enter(editor, signal);
      expect(fixture.ask).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
      await enter(editor, { ...signal, key: "ArrowDown" });
      expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("Text");
    }
    await enter(editor); expect(fixture.ask).toHaveBeenCalledExactlyOnceWith(SLASH_ITEMS[0]);
  });
  it.each(signals)("editor/slashMenu: the registered suggestion leaves the menu open on candidate Escape (%j)", async signal => {
    const setSlash = vi.fn();
    const editor = new Editor({
      element: host,
      injectCSS: false,
      extensions: [...createMarkdownExtensions(), createSlashCommand(setSlash, { current: null })],
    });
    try {
      editor.commands.insertContent({ type: "text", text: "/" });
      await vi.waitFor(() => expect(setSlash).toHaveBeenLastCalledWith(expect.objectContaining({ items: [...SLASH_ITEMS] })));
      setSlash.mockClear();

      const plugin = SuggestionPluginKey.get(editor.state)!;
      const escape = (composition: KeyboardEventInit = {}) => plugin.props.handleKeyDown!.call(
        plugin, editor.view, new KeyboardEvent("keydown", { key: "Escape", ...composition }),
      );
      // ProseMirror can filter IME events before they reach the registered handler.
      expect(escape(signal)).toBe(false);
      expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({ active: true });
      expect(setSlash).not.toHaveBeenCalled();
      expect(escape()).toBe(true);
      expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({ active: false });
      expect(setSlash).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      editor.destroy();
    }
  });
  it("WidgetBody: the Other text field does not activate its choice row", async () => {
    const form: WidgetForm = { uid: "widget-a", values: {}, other: { task: "Read notes" }, locked: false, errorId: "error-a", fields: new Map(), actions: new Map(), labelled: new Set(), compact: false, name: "",
      setValue: fixture.ask, chooseOther: fixture.ask, setOther: () => {}, press: fixture.ask };
    await render(createElement(WidgetFormProvider, { value: form }, createElement(WidgetBody, { headed: false, root: {
      id: "list-a", type: "ListView", name: "task", allowOther: true, children: [{ id: "row-a", type: "ListViewItem", value: "notes", children: [{ id: "text-a", type: "Text", value: "Notes" }] }],
    } })));
    for (const signal of [...signals, {}]) { await enter(input(), signal); expect(fixture.ask).not.toHaveBeenCalled(); }
    await enter(host.querySelector<HTMLElement>('[role="radio"]')!);
    expect(fixture.ask).toHaveBeenCalledExactlyOnceWith("task", "notes");
  });
  it("WidgetTimePicker: its Enter handler belongs to a button, with no editable text", async () => {
    const form: WidgetForm = { uid: "widget-a", values: { time: "09:00" }, other: {}, locked: false, errorId: "error-a", fields: new Map(), actions: new Map(), labelled: new Set(), compact: false, name: "",
      setValue: fixture.ask, chooseOther: () => {}, setOther: () => {}, press: () => {} };
    await render(createElement(WidgetFormProvider, { value: form }, createElement(WidgetTimePicker, { node: { id: "time-a", type: "TimePicker", name: "time" }, bare: false })));
    const trigger = host.querySelector<HTMLElement>('[role="combobox"]')!;
    expect(trigger.tagName).toBe("BUTTON"); expect(host.querySelector("input, textarea, [contenteditable] ")).toBeNull();
    await enter(trigger); expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await enter(trigger); expect(fixture.ask).toHaveBeenCalledExactlyOnceWith("time", "09:00");
  });
  it("HelpAskChief: textarea Enter stays a newline; the Ask button still works", async () => {
    await render(createElement(AskAboutScreen, { chiefName: "Aster", onAsk: fixture.ask }));
    await type(input("textarea"), "Where are my notes?");
    for (const signal of [...signals, {}]) {
      const event = await enter(input("textarea"), signal); expect(event.defaultPrevented).toBe(false);
      await act(async () => input("textarea").dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
      expect(fixture.ask).not.toHaveBeenCalled();
    }
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(fixture.ask).toHaveBeenCalledExactlyOnceWith("Where are my notes?");
  });
});
