// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionPanel } from "./AttentionPanel";
import { setLocale, t } from "@/lib/i18n";
import type { AttentionItems, AttentionResult, AttentionWindowBridge } from "./bridge";

let root: Root, container: HTMLDivElement, change: () => void;
let bridge: AttentionWindowBridge, data: AttentionItems;
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const enter = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await setLocale("en");
  data = { ok: true, openToken: "app", items: [{ display: { botName: "Chief", title: "Read notes", willRun: "cat notes.txt\ncat details.txt" }, level: "", actionToken: "action", openToken: "open" }], running: [], receipts: [], chief: { name: "Chief" } };
  bridge = { items: vi.fn(async () => data), act: vi.fn(async () => ({ ok: true })), open: vi.fn(async () => ({ ok: true })),
    sendToChief: vi.fn(async () => ({ ok: true })), sendToPinned: vi.fn(async () => ({ ok: true })), pauseAutomations: vi.fn(async () => ({ ok: true })),
    onChange: vi.fn(cb => { change = cb; return vi.fn(); }) };
  window.attentionWindow = bridge;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.attentionWindow; });
const mount = async () => { await act(async () => { root.render(<AttentionPanel />); }); };

describe("attention panel", () => {
  it("shows the entire detail and sends one Allow across a double click", async () => {
    let finish!: (value: AttentionResult) => void;
    bridge.act = vi.fn(() => new Promise<AttentionResult>(resolve => { finish = resolve; }));
    await mount(); expect(container.querySelector("pre")!.textContent).toBe(data.items[0]!.display!.willRun);
    await act(async () => { const allow = button(t("trayPanel.allow")); allow.click(); allow.click(); });
    expect(bridge.act).toHaveBeenCalledTimes(1); expect(bridge.act).toHaveBeenCalledWith("action", "allow", undefined);
    expect(button(t("trayPanel.deny")).disabled).toBe(true);
    await act(async () => { finish({ ok: false, reason: "locked" }); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("trayPanel.refusedLocked"));
    await click(t("trayPanel.allow")); expect(bridge.act).toHaveBeenCalledTimes(1);
  });
  it.each([["card", "trayPanel.refusedCard"], ["unknown", "trayPanel.refusedOpen"]] as const)("explains %s refusals", async (reason, key) => {
    bridge.act = vi.fn(async () => ({ ok: false, reason })); await mount(); await click(t("trayPanel.deny"));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t(key));
  });
  it("Reply requires words, counts remaining characters and sends cleaned text", async () => {
    await mount(); await click(t("trayPanel.reply"));
    const input = container.querySelector("textarea")!;
    expect(input.maxLength).toBe(2000); expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
    await enter(input, "  Please\nwait  ");
    expect(container.textContent).toContain(t("trayPanel.remaining", { count: 2000 - input.value.length }));
    await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledTimes(1); expect(bridge.act).toHaveBeenCalledWith("action", "reply", "Please\nwait");
  });
  it("Open-only shows no answer controls and Open never calls act", async () => {
    data.items[0] = { display: null, level: "", openToken: "open" };
    await mount(); expect(button(t("trayPanel.allow"))).toBeUndefined(); expect(button(t("trayPanel.reply"))).toBeUndefined();
    await click(t("trayPanel.open")); expect(bridge.open).toHaveBeenCalledTimes(1); expect(bridge.open).toHaveBeenCalledWith("open"); expect(bridge.act).not.toHaveBeenCalled();
  });
  it("reads only on mount or push, replaces old cards, limits receipts, and unsubscribes", async () => {
    const unsubscribe = vi.fn(); bridge.onChange = vi.fn(cb => { change = cb; return unsubscribe; });
    data.receipts = [1, 2, 3, 4].map(n => ({ text: `receipt ${n}` }));
    await mount(); expect(bridge.items).toHaveBeenCalledTimes(1); expect(container.textContent).not.toContain("receipt 1");
    data = { ...data, items: [] }; await act(async () => { change(); });
    expect(bridge.items).toHaveBeenCalledTimes(2); expect(container.textContent).not.toContain("cat notes.txt");
    await act(async () => { root.render(null); }); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("Chief send, Open Murage and Pause use only their bridge methods; Escape does nothing", async () => {
    await mount(); await enter(container.querySelector("input")!, " hello "); await click(t("trayPanel.send"));
    expect(bridge.sendToChief).toHaveBeenCalledTimes(1); expect(bridge.sendToChief).toHaveBeenCalledWith("hello"); expect(bridge.sendToPinned).not.toHaveBeenCalled();
    await click(t("trayPanel.openMurage")); expect(bridge.open).toHaveBeenCalledWith("app");
    await click(t("trayPanel.pause")); expect(bridge.pauseAutomations).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(t("trayPanel.paused"));
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); expect(close).not.toHaveBeenCalled(); close.mockRestore();
  });
});
