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
let bridge: AttentionWindowBridge, data: AttentionItems, rev = 0;
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
  rev = 0;
  data = { ok: true, rev: 0, openToken: "app", items: [{ cardId: "card", display: { botName: "Chief", title: "Read notes", willRun: "cat notes.txt\ncat details.txt" }, level: "", actionToken: "action", openToken: "open" }], running: [], receipts: [], chief: { name: "Chief" } };
  bridge = { items: vi.fn(async () => ({ ...data, rev: ++rev })), act: vi.fn(async () => ({ ok: true })), open: vi.fn(async () => ({ ok: true })),
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
    data.items[0] = { cardId: "card", display: null, level: "", openToken: "open" };
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
  it("keeps a typed reply through a pending push and fresh tokens for the same card", async () => {
    await mount(); await click(t("trayPanel.reply"));
    await enter(container.querySelector("textarea")!, "Please wait for my notes");
    let finish!: (value: AttentionItems) => void;
    bridge.items = vi.fn(() => new Promise<AttentionItems>(resolve => { finish = resolve; }));
    await act(async () => { change(); });
    expect(container.querySelector("textarea")!.value).toBe("Please wait for my notes");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
    const fresh = { ...data, items: [{ ...data.items[0]!, actionToken: "fresh-action", openToken: "fresh-open" }], running: [{ botName: "Other", doing: "Working" }], receipts: [{ text: "Done" }] };
    await act(async () => { finish({ ...fresh, rev: ++rev }); });
    expect(container.querySelector("textarea")!.value).toBe("Please wait for my notes");
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(button(t("trayPanel.sendReply")).disabled).toBe(false);
    await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledExactlyOnceWith("fresh-action", "reply", "Please wait for my notes");
  });
  it.each(["request", "previews"])("forgets the draft when %s changes", async reason => {
    await mount(); await click(t("trayPanel.reply"));
    await enter(container.querySelector("textarea")!, "Unsent words");
    data = { ...data, items: [{ ...data.items[0]!, openToken: "refreshed", actionToken: "refreshed-action" }] };
    await act(async () => { change(); });
    expect(container.querySelector("textarea")!.value).toBe("Unsent words");
    const original = data.items[0]!;
    data = { ...data, items: [{ ...original, cardId: "changed", openToken: "fresh", ...(reason === "previews" ? { display: null, actionToken: undefined } : {}) }] };
    await act(async () => { change(); });
    expect(container.querySelector("textarea")).toBeNull();
    if (reason === "previews") {
      expect(container.textContent).not.toContain("Unsent words");
      data = { ...data, items: [{ ...original, cardId: "restored", openToken: "restored" }] };
      await act(async () => { change(); });
    }
    await click(t("trayPanel.reply")); expect(container.querySelector("textarea")!.value).toBe("");
  });
  it("Open works again after a cached panel push renews its single-use token", async () => {
    const used = new Set<string>(); let opens = 0;
    bridge.open = vi.fn(async token => {
      if (used.has(token)) return { ok: false, reason: "unknown" };
      used.add(token); opens++; return { ok: true };
    });
    await mount(); await click(t("trayPanel.open")); await click(t("trayPanel.open"));
    expect(opens).toBe(1); expect(button(t("trayPanel.open")).disabled).toBe(true);
    data = { ...data, items: [{ ...data.items[0]!, openToken: "renewed" }] };
    await act(async () => { change(); });
    expect(button(t("trayPanel.open")).disabled).toBe(false);
    await click(t("trayPanel.open")); await click(t("trayPanel.open"));
    expect(opens).toBe(2); expect(bridge.open).toHaveBeenCalledTimes(2);
    expect([...used]).toEqual(["open", "renewed"]);
  });
  it.each(["reject", "refuse"])("redacts a populated panel after a refresh %s and leaves controls disabled", async failure => {
    data.running = [{ botName: "Private bot", doing: "Private work" }];
    data.receipts = [{ text: "Private receipt" }];
    await mount(); await click(t("trayPanel.reply"));
    await enter(container.querySelector("textarea")!, "Private reply");
    await enter(container.querySelector("input")!, "Private Chief draft");
    let resolve!: (value: AttentionResult) => void, reject!: (error: Error) => void;
    bridge.items = vi.fn(() => new Promise<AttentionResult>((yes, no) => { resolve = yes; reject = no; }));
    await act(async () => change());
    expect([...container.querySelectorAll("button")].every(node => node.disabled)).toBe(true);
    await act(async () => {
      if (failure === "reject") reject(new Error("read failed")); else resolve({ ok: false });
    });
    expect(container.querySelector("article")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")!.value).toBe("");
    for (const privateText of ["cat notes.txt", "Private bot", "Private work", "Private receipt", "Private reply"])
      expect(container.textContent).not.toContain(privateText);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("trayPanel.loadError"));
    await act(async () => { for (const control of container.querySelectorAll("button")) { expect(control.disabled).toBe(true); control.click(); } });
    expect(bridge.act).not.toHaveBeenCalled(); expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.sendToChief).not.toHaveBeenCalled(); expect(bridge.pauseAutomations).not.toHaveBeenCalled();
    bridge.items = vi.fn(async () => ({ ...data, rev: ++rev }));
    await act(async () => change()); await click(t("trayPanel.reply"));
    expect(container.querySelector("textarea")!.value).toBe("");
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
  it("T1d keeps a typed reply when a push lands during a pending read that comes back superseded", async () => {
    await mount(); await click(t("trayPanel.reply"));
    await enter(container.querySelector("textarea")!, "Please wait for my notes");
    const fresh = { ...data, items: [{ ...data.items[0]!, actionToken: "fresh-action", openToken: "fresh-open" }] };

    let finish1!: (value: AttentionResult | AttentionItems) => void, finish2!: (value: AttentionResult | AttentionItems) => void;
    const reads = vi.fn().mockImplementationOnce(() => new Promise<AttentionResult | AttentionItems>(resolve => { finish1 = resolve; }))
      .mockImplementationOnce(() => new Promise<AttentionResult | AttentionItems>(resolve => { finish2 = resolve; }))
      .mockImplementation(async () => ({ ...fresh, rev: ++rev }));
    bridge.items = reads as unknown as AttentionWindowBridge["items"];
    await act(async () => { change(); }); await act(async () => { change(); });
    await act(async () => { finish1({ ok: false, reason: "superseded" }); });
    expect(container.querySelector("textarea")?.value).toBe("Please wait for my notes");
    expect(container.querySelector("textarea")!.disabled).toBe(true); expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
    await act(async () => { finish2({ ...fresh, rev: ++rev }); });
    expect(container.querySelector("textarea")!.disabled).toBe(false); expect(button(t("trayPanel.sendReply")).disabled).toBe(false);
    await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledExactlyOnceWith("fresh-action", "reply", "Please wait for my notes");
  });
});
