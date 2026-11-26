// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { localeLoaders } from "@/locales";
import { beginEdit, editDraftStore, editFailed } from "@/lib/edit-drafts";
import { sendNoticeFromBody, sendNoticeText } from "@/lib/send-notice";
import type { Bot, Message } from "@/state/store";
import { SEND_NOTICE_ENGLISH, sendNoticeActivityName } from "../../shared/send-notice";
import { ChatView } from "./ChatView";
import { QueuedComposerMessages } from "./ComposerQueuedMessages";

vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (subscribe: any, snapshot: any, server: any) => actual.useSyncExternalStore(subscribe, snapshot, server ?? snapshot) };
});
vi.mock("@/state/store", async original => {
  const actual = await original<typeof import("@/state/store")>();
  const state = { ...actual.initialState, showToolCalls: false };
  return {
    ...actual,
    useStore: () => ({ state, dispatch: vi.fn() }),
    useStoreActions: () => ({ dispatch: vi.fn() }),
    useStoreSelector: (select: (state: unknown) => unknown) => select(state),
    useStoreSnapshot: () => () => state,
  };
});
vi.mock("./use-reply-pop", () => ({ useReplyPop: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {}, ready: true }) }));
vi.mock("./CallControls", () => ({
  CallBarStrip: () => null, CallOverlaySlot: () => null, GroupCallOverlay: () => null, CallOverlay: () => null,
  GroupCallButton: () => null, CallButton: () => null, ActiveCallBar: () => null, CallStatus: () => null,
}));
vi.mock("./Composer", () => ({ Composer: () => null }));

afterEach(() => {
  delete localeLoaders["zz-command"];
  delete localeLoaders["zz-command-edit"];
  return setLocale("en");
});

function chatBot(id: string, messages: Message[]): Bot {
  return { id, threadId: "chat", name: "Moss", title: "", description: "", notifications: false, unread: false,
    color: "blue", messages, tasks: [], activity: "idle", modelSelection: { instanceId: "fixture", model: "fixture" } };
}

it.each(["compactNeedsSession", "commandNeedsSession", "commandModelChanged"] as const)(
  "V shows %s as a localized standalone notice across a transcript reload",
  async code => {
    await setLocale("en");
    const tool = { name: sendNoticeActivityName(code), ok: false, notice: true };
    const row = { id: "notice", at: 1, role: "bot", kind: "activity", tool } satisfies Message;
    for (const record of [row, JSON.parse(JSON.stringify(row)) as Message]) {
      const user = { id: "command", at: 1, role: "user", kind: "text", text: "/compact" } satisfies Message;
      const bot = chatBot("owner", [user, record]);
      const html = renderToStaticMarkup(<ChatView bot={bot} />);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const rows = doc.querySelectorAll("[data-testid=send-notice-row]");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toBe(SEND_NOTICE_ENGLISH[code]);
      expect(doc.querySelectorAll("[data-testid=refused-send]")).toHaveLength(0);
      expect(doc.body.textContent).toContain("/compact");
      expect(doc.body.textContent).not.toMatch(/Picked up this conversation|Send again/);
    }
  },
);

it("renders the refused send chip and localizes the edit error from its wire code", async () => {
  const localized = "Localized fixture notice";
  localeLoaders["zz-command"] = async () => ({ "sendNotice.compactNeedsSession": localized });
  await setLocale("zz-command");
  const code = "compactNeedsSession";
  const body = { noticeCode: code, error: "Raw server fallback" };
  expect(sendNoticeFromBody(body)).toBe(localized);
  const html = renderToStaticMarkup(<QueuedComposerMessages items={[{ queueId: "held", text: "/compact", refused: { notice: code } }]}
    onCancel={() => {}} onResend={() => {}} />);
  const root = new DOMParser().parseFromString(html, "text/html");
  expect(root.querySelectorAll("[data-testid=refused-send]")).toHaveLength(1);
  expect(root.querySelector("[data-testid=refused-send]")?.textContent).toBe("Not sent" + sendNoticeText(code) + "Send againDismiss");
});

it("reopens the refused edit with the draft and localized notice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
  const localized = "Localized edit refusal";
  localeLoaders["zz-command-edit"] = async () => ({ "sendNotice.compactNeedsSession": localized });
  await setLocale("zz-command-edit");
  const message = { id: "before-edit", at: 1, role: "user", kind: "text", text: "Original text" } satisfies Message;
  const bot = chatBot("editor", [message]);
  const draft = beginEdit({}, message.id, "/compact", "edit-attempt")!;
  const notice = sendNoticeFromBody({ noticeCode: "compactNeedsSession", error: "Raw server fallback" });
  editDraftStore.update(bot.id, () => editFailed(draft, message.id, "edit-attempt", notice));
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(() => root.render(<ChatView bot={bot} />));
    const editor = node.querySelector("textarea");
    expect(editor?.value).toBe("/compact");
    expect(editor?.readOnly).toBe(false);
    expect(node.querySelector("[role=alert]")?.textContent).toBe(localized);
    expect(node.textContent).not.toContain("Raw server fallback");
  } finally {
    await act(() => root.unmount());
    node.remove();
    editDraftStore.update(bot.id, () => ({}));
    if (scrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    vi.unstubAllGlobals();
  }
});
