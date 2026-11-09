// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Bubble } from "./Bubble";
import { Dock } from "./Dock";
import { setLocale, t } from "@/lib/i18n";
import type { AttentionItems, AttentionResult, AttentionWindowBridge } from "../attention-ui/bridge";

let root: Root, container: HTMLDivElement, bridge: AttentionWindowBridge, data: AttentionItems, change: () => void;
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const choose = async (index = 0) => { await act(async () => (container.querySelectorAll(".float-bot")[index] as HTMLButtonElement).click()); };
const mount = async (kind: "bubble" | "dock" = "bubble") => { await act(async () => root.render(kind === "bubble" ? <Bubble /> : <Dock />)); };
const enterReply = async (value: string) => {
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  const card = { cardId: "card", display: { botName: "Beta", title: "Read notes", willRun: "cat notes.txt\ncat more.txt" }, level: "", openToken: "card-open", actionToken: "card-action" };
  data = { ok: true, items: [card], openToken: "app", running: [], receipts: [], chief: null, bots: [
    { key: "a", name: "Alpha", state: "idle", openToken: "alpha-open", item: null },
    { key: "b", name: "Beta", state: "needs-you", openToken: "beta-open", item: card },
  ] };
  bridge = { items: vi.fn(async () => data), act: vi.fn(async () => ({ ok: true })), open: vi.fn(async () => ({ ok: true })),
    sendToChief: vi.fn(async () => ({ ok: true })), sendToPinned: vi.fn(async () => ({ ok: true })), pauseAutomations: vi.fn(async () => ({ ok: true })),
    hideForAnHour: vi.fn(async () => ({ ok: true })), setExpanded: vi.fn(async () => ({ ok: true })), onChange: vi.fn(cb => { change = cb; return vi.fn(); }) };
  window.attentionWindow = bridge; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.attentionWindow; });

it("Bubble shows only the pinned avatar; quick chat sends cleaned words exactly once and no bot id", async () => {
  let finish!: (value: AttentionResult) => void;
  bridge.sendToPinned = vi.fn(() => new Promise<AttentionResult>(resolve => { finish = resolve; }));
  await mount(); expect(container.querySelectorAll(".float-bot")).toHaveLength(1); expect(container.querySelector(".float-dot")).toBeNull();
  await choose(); expect(bridge.setExpanded).toHaveBeenCalledWith(true); expect(bridge.items).toHaveBeenCalledTimes(2);
  expect(button(t("trayPanel.send")).disabled).toBe(true);
  const input = container.querySelector("input")!; expect(input.maxLength).toBe(4000);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  hello  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { const send = button(t("trayPanel.send")); send.click(); send.click(); });
  expect(bridge.sendToPinned).toHaveBeenCalledExactlyOnceWith("hello"); expect(bridge.sendToChief).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true })); expect(container.textContent).toContain(t("float.sent"));
  expect(input.value).toBe("");
});
it("Bubble opens its pending card and dock clicks choose that bot's card with full detail and shared actions", async () => {
  data.bots = [data.bots![1]!]; await mount(); expect(container.querySelectorAll(".float-dot")).toHaveLength(1);
  await choose(); expect(container.querySelector("input")).toBeNull(); expect(container.querySelector("pre")!.textContent).toBe(data.items[0]!.display!.willRun);
  await click(t("trayPanel.deny")); expect(bridge.act).toHaveBeenCalledExactlyOnceWith("card-action", "deny", undefined);
  await act(async () => root.render(null));
  data.bots = [{ key: "a", name: "Alpha", state: "working", openToken: "alpha-open", item: null }, { key: "b", name: "Beta", state: "needs-you", openToken: "beta-open", item: data.items[0]! }];
  await mount("dock"); expect(container.querySelectorAll(".float-bot")).toHaveLength(2); expect(container.querySelectorAll(".float-dot")).toHaveLength(1);
  await choose(0); expect(container.querySelector("article")).toBeNull(); await click(t("trayPanel.open")); expect(bridge.open).toHaveBeenCalledWith("alpha-open");
  await choose(1); expect(container.querySelector("pre")!.textContent).toContain("cat more.txt");
  await click(t("trayPanel.allow")); expect(bridge.act).toHaveBeenLastCalledWith("card-action", "allow", undefined);
  expect(bridge.sendToPinned).not.toHaveBeenCalled();
});
it("an Open-only card has no answer buttons and never calls act", async () => {
  data.bots = [{ ...data.bots![1]!, item: { cardId: "private-card", display: null, level: "", openToken: "open-only" } }];
  await mount(); await choose(); expect(button(t("trayPanel.allow"))).toBeUndefined(); expect(button(t("trayPanel.reply"))).toBeUndefined();
  await click(t("trayPanel.open")); expect(bridge.open).toHaveBeenCalledExactlyOnceWith("open-only"); expect(bridge.act).not.toHaveBeenCalled();
});
it("the click boundary reads the current card even if the state did not change", async () => {
  data.bots = [data.bots![1]!]; await mount();
  data = { ...data, bots: [{ ...data.bots![0]!, item: { ...data.items[0]!, actionToken: "new-action", display: { botName: "Beta", title: "New request", willRun: "cat fresh.txt" } } }] };
  await choose(); expect(container.textContent).toContain("cat fresh.txt"); expect(container.textContent).not.toContain("cat more.txt");
  await click(t("trayPanel.allow")); expect(bridge.act).toHaveBeenCalledExactlyOnceWith("new-action", "allow", undefined);
});
it.each(["bubble", "dock"] as const)("%s retains the selected card and Reply through an unrelated bot transition", async kind => {
  // Put the pending bot first so the bubble also displays this card.
  data.bots = [data.bots![1]!, data.bots![0]!];
  await mount(kind); await choose(); await click(t("trayPanel.reply")); await enterReply("  Still writing  ");
  const input = container.querySelector("textarea")!;
  let finish!: (value: AttentionItems) => void;
  vi.mocked(bridge.items).mockImplementationOnce(() => new Promise<AttentionItems>(resolve => { finish = resolve; }));
  await act(async () => change());
  expect(container.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("  Still writing  ");
  expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
  expect(button(t("trayPanel.open")).disabled).toBe(true);
  await click(t("trayPanel.sendReply")); await click(t("trayPanel.open"));
  expect(bridge.act).not.toHaveBeenCalled(); expect(bridge.open).not.toHaveBeenCalled();
  const renewed = { ...data.items[0]!, actionToken: "fresh-action", openToken: "fresh-open" };
  data = { ...data, items: [renewed], bots: [
    { ...data.bots![0]!, item: renewed, openToken: "fresh-bot-open" },
    { ...data.bots![1]!, state: "working" },
  ] };
  await act(async () => finish(data));
  expect(container.querySelector("textarea")).toBe(input);
  expect(bridge.setExpanded).toHaveBeenCalledExactlyOnceWith(true);
  expect(container.querySelector("main")!.classList.contains("float-expanded")).toBe(true);
  await click(t("trayPanel.sendReply"));
  expect(bridge.act).toHaveBeenCalledExactlyOnceWith("fresh-action", "reply", "Still writing");
});
it.each(["request", "previews"])("forgets the selected Reply on a %s identity change", async reason => {
  data.bots = [data.bots![1]!];
  await mount(); await choose(); await click(t("trayPanel.reply")); await enterReply("Private reply");
  const renewed = { ...data.items[0]!, actionToken: "renewed-action", openToken: "renewed-open" };
  data = { ...data, items: [renewed], bots: [{ ...data.bots![0]!, item: renewed }] };
  await act(async () => change()); expect(container.querySelector("textarea")!.value).toBe("Private reply");
  const original = data.items[0]!;
  const changed = { ...original, cardId: "changed", openToken: "changed-open",
    ...(reason === "previews" ? { display: null, actionToken: undefined } : {}) };
  data = { ...data, items: [changed], bots: [{ ...data.bots![0]!, item: changed }] };
  await act(async () => change());
  expect(container.querySelector("textarea")).toBeNull();
  const restored = { ...original, cardId: "restored", openToken: "restored-open" };
  data = { ...data, items: [restored], bots: [{ ...data.bots![0]!, item: restored }] };
  await act(async () => change()); await click(t("trayPanel.reply"));
  expect(container.querySelector("textarea")!.value).toBe("");
});
it.each(["reject", "refuse"])("a refresh %s removes private content, drafts and selection", async failure => {
  data.bots = [data.bots![1]!];
  await mount(); await choose(); await click(t("trayPanel.reply")); await enterReply("Private reply");
  const renewed = { ...data.items[0]!, actionToken: "renewed-action", openToken: "renewed-open" };
  data = { ...data, items: [renewed], bots: [{ ...data.bots![0]!, item: renewed }] };
  await act(async () => change()); expect(container.querySelector("textarea")!.value).toBe("Private reply");
  bridge.items = vi.fn(async () => { if (failure === "reject") throw new Error("read failed"); return { ok: false }; });
  await act(async () => change());
  expect(container.querySelector("article")).toBeNull(); expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).not.toContain("cat notes.txt");
  expect(container.querySelector("main")!.classList.contains("float-expanded")).toBe(false);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(bridge.setExpanded).toHaveBeenLastCalledWith(false);
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("float.error"));
});
it("reads only on mount, clicks and pushes; removing the selected bot collapses and unsubscribe stops reads", async () => {
  const unsubscribe = vi.fn(); bridge.onChange = vi.fn(cb => { change = cb; return unsubscribe; });
  await mount("dock"); expect(bridge.items).toHaveBeenCalledTimes(1); await choose(1);
  data = { ...data, bots: [], items: [] }; await act(async () => change());
  expect(bridge.items).toHaveBeenCalledTimes(3); expect(container.querySelector("article")).toBeNull(); expect(bridge.setExpanded).toHaveBeenLastCalledWith(false);
  await act(async () => root.render(null)); expect(unsubscribe).toHaveBeenCalledOnce();
  await act(async () => change()); expect(bridge.items).toHaveBeenCalledTimes(3);
});
it.each(["bubble", "dock"] as const)("%s right click offers the gated hour hide; Escape collapses", async kind => {
  await mount(kind);
  await act(async () => container.querySelector("main")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="menuitem"]')!.textContent).toBe(t("float.hideHour"));
  await click(t("float.hideHour")); expect(bridge.hideForAnHour).toHaveBeenCalledExactlyOnceWith();
  await act(async () => container.querySelector("main")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(bridge.setExpanded).toHaveBeenLastCalledWith(false); expect(container.querySelector('[role="menu"]')).toBeNull();
});
it("a refused expansion leaves the card collapsed and shows a translated error", async () => {
  bridge.setExpanded = vi.fn(async () => ({ ok: false })); await mount(); await choose();
  expect(container.querySelector("form")).toBeNull(); expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("float.error"));
});
