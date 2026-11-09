// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { AttentionItems, AttentionResult, AttentionWindowBridge } from "../attention-ui/bridge";
import { Pill } from "./Pill";

let root: Root, container: HTMLDivElement, change: () => void;
let bridge: AttentionWindowBridge, data: AttentionItems;
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const mount = async () => { await act(async () => { root.render(<Pill />); }); };
const push = async () => { await act(async () => { change(); }); };
const enter = async (value: string) => {
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  data = { ok: true, items: [{ cardId: "card", display: { botName: "Chief", title: "Read notes", willRun: "cat notes.txt\ncat details.txt" }, level: "quick", openToken: "open", actionToken: "action" }],
    openToken: "app", running: [], receipts: [], chief: null, pill: { state: "collapsed", count: 1, toggleToken: "toggle" } };
  bridge = { items: vi.fn(async () => data), act: vi.fn(async () => ({ ok: true })),
    open: vi.fn(async token => {
      if (token === "toggle") {
        data = { ...data, pill: { ...data.pill!, state: data.pill!.state === "collapsed" ? "expanded" : "collapsed" } };
        change();
      }
      return { ok: true };
    }), onChange: vi.fn(cb => { change = cb; return vi.fn(); }),
    sendToChief: vi.fn(async () => ({ ok: true })), sendToPinned: vi.fn(async () => ({ ok: true })), pauseAutomations: vi.fn(async () => ({ ok: true })) };
  window.attentionWindow = bridge; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.attentionWindow; });

describe("pill", () => {
  it("starts collapsed with bot and count, expands via its capability and reuses the full attention card", async () => {
    await mount(); expect(container.querySelector("main")!.dataset.state).toBe("collapsed");
    expect(container.textContent).toContain(t("pill.capsule", { bot: "Chief", count: 1 }));
    expect(container.querySelector("article")).toBeNull();
    await click(t("pill.capsule", { bot: "Chief", count: 1 }));
    expect(bridge.open).toHaveBeenCalledWith("toggle");
    expect(container.querySelector("main")!.dataset.state).toBe("expanded");
    expect(container.querySelector("pre")!.textContent).toBe("cat notes.txt\ncat details.txt");
    expect(button(t("trayPanel.allow"))).toBeDefined(); expect(button(t("pill.open"))).toBeDefined();
    expect(container.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
  });
  it("preserves oldest-first host order in the stack and makes Chief questions Open only", async () => {
    data.pill = { ...data.pill!, state: "stacked", count: 2 };
    data.items = [{ cardId: "question-card", display: { botName: "Chief", title: "Which folder?", willRun: "Choose in Murage" }, level: "", openToken: "question" }, data.items[0]!];
    await mount(); const cards = [...container.querySelectorAll("article")];
    expect(cards.map(card => card.querySelector("h3")!.textContent)).toEqual(["Which folder?", "Read notes"]);
    expect([...cards[0]!.querySelectorAll("button")].map(node => node.textContent)).toEqual([t("pill.open")]);
    await act(async () => { cards[0]!.querySelector("button")!.click(); });
    expect(bridge.open).toHaveBeenCalledWith("question"); expect(bridge.act).not.toHaveBeenCalled();
    expect(bridge.sendToChief).not.toHaveBeenCalled(); expect(bridge.sendToPinned).not.toHaveBeenCalled(); expect(bridge.pauseAutomations).not.toHaveBeenCalled();
  });
  it.each(["allow", "deny"] as const)("%s sends one answer across repeat clicks and displays a refusal", async action => {
    data.pill!.state = "expanded";
    let finish!: (result: AttentionResult) => void;
    bridge.act = vi.fn(() => new Promise<AttentionResult>(resolve => { finish = resolve; }));
    await mount();
    await act(async () => { button(t(`trayPanel.${action}`)).click(); button(t(`trayPanel.${action}`)).click(); });
    expect(bridge.act).toHaveBeenCalledTimes(1); expect(bridge.act).toHaveBeenCalledWith("action", action, undefined);
    await act(async () => { finish({ ok: false, reason: "locked" }); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("trayPanel.refusedLocked"));
    expect(button(t("trayPanel.allow")).disabled).toBe(true); expect(button(t("trayPanel.deny")).disabled).toBe(true);
  });
  it("Reply defaults to Open in Murage, without typing or an answer", async () => {
    data.pill!.state = "expanded"; await mount(); await click(t("trayPanel.reply"));
    expect(bridge.open).toHaveBeenCalledTimes(1); expect(bridge.open).toHaveBeenCalledWith("open");
    expect(bridge.act).not.toHaveBeenCalled(); expect(container.querySelector("textarea")).toBeNull();
  });
  it("opt-in Reply requests one-use focus first, requires text, and sends cleaned words", async () => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply"));
    expect(bridge.open).toHaveBeenCalledWith("focus"); expect(bridge.act).not.toHaveBeenCalled();
    expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
    await enter("  Please\nwait  "); await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledTimes(1); expect(bridge.act).toHaveBeenCalledWith("action", "reply", "Please\nwait");
  });
  it("a refused focus request falls back to Open in Murage", async () => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    bridge.open = vi.fn(async token => ({ ok: token !== "focus" }));
    await mount(); await click(t("trayPanel.reply"));
    expect(vi.mocked(bridge.open).mock.calls.map(call => call[0])).toEqual(["focus", "open"]);
    expect(container.querySelector("textarea")).toBeNull(); expect(bridge.act).not.toHaveBeenCalled();
  });
  it("keeps a Reply by cardId through stack changes and submits with fresh authority", async () => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    data.receipts = [{ text: "Expiring receipt" }];
    await mount(); await click(t("trayPanel.reply")); await enter("  Keep these words  ");
    const input = container.querySelector("textarea")!;
    let finish!: (value: AttentionItems) => void;
    vi.mocked(bridge.items).mockImplementationOnce(() => new Promise<AttentionItems>(resolve => { finish = resolve; }));
    await push();
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("  Keep these words  ");
    expect([...container.querySelectorAll("button")].every(node => node.disabled)).toBe(true);
    await click(t("trayPanel.sendReply")); await click(t("pill.open"));
    expect(bridge.act).not.toHaveBeenCalled(); expect(bridge.open).toHaveBeenCalledExactlyOnceWith("focus");
    const renewed = { ...data.items[0]!, openToken: "fresh-open", actionToken: "fresh-action", replyFocusToken: "fresh-focus" };
    data = { ...data, items: [{ ...renewed, cardId: "other-card", openToken: "other-open", actionToken: "other-action" }, renewed],
      receipts: [], pill: { ...data.pill!, count: 2, state: "stacked" } };
    await act(async () => finish(data));
    expect(container.querySelector("textarea")).toBe(input);
    expect(container.querySelectorAll("article")[1]!.contains(input)).toBe(true);
    expect(container.textContent).not.toContain("Expiring receipt");
    await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledExactlyOnceWith("fresh-action", "reply", "Keep these words");
  });
  it.each(["request", "previews"])("forgets the Reply on a %s identity change", async reason => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Private words");
    data = { ...data, items: [{ ...data.items[0]!, actionToken: "renewed-action", openToken: "renewed-open" }] };
    await push(); expect(container.querySelector("textarea")!.value).toBe("Private words");
    const original = data.items[0]!;
    data = { ...data, items: [{ ...original, cardId: "changed", openToken: "changed-open",
      ...(reason === "previews" ? { display: null, actionToken: undefined, replyFocusToken: undefined } : {}) }] };
    await push(); expect(container.querySelector("textarea")).toBeNull();
    data = { ...data, items: [{ ...original, cardId: "restored", openToken: "restored-open" }] };
    await push(); await click(t("trayPanel.reply"));
    expect(container.querySelector("textarea")!.value).toBe("");
  });
  it("renders receipts until main pushes Hidden, then removes all content", async () => {
    data.items = []; data.pill!.state = "finished"; data.receipts = [{ text: "Chief finished in 2 minutes" }];
    await mount(); expect(container.querySelector('[role="status"]')!.textContent).toBe("Chief finished in 2 minutes");
    expect(bridge.items).toHaveBeenCalledTimes(1);
    data = { ...data, receipts: [], pill: { ...data.pill!, count: 0, state: "hidden" } }; await push();
    expect(container.childElementCount).toBe(0); expect(bridge.items).toHaveBeenCalledTimes(2);
  });
  it("uses translated generic copy for hidden previews and receipts", async () => {
    data.items[0] = { cardId: "private-card", display: null, level: "", openToken: "open" }; await mount();
    expect(container.textContent).toContain(t("pill.capsule", { bot: t("pill.waiting"), count: 1 }));
    data = { ...data, items: [], receipts: [{ text: "" }], pill: { ...data.pill!, state: "finished" } }; await push();
    expect(container.textContent).toContain(t("pill.finished")); expect(container.textContent).not.toContain("Chief");
  });
  it("coalesces pushed reads, disables retained cards and unsubscribes", async () => {
    const unsubscribe = vi.fn(); bridge.onChange = vi.fn(cb => { change = cb; return unsubscribe; });
    data.pill!.state = "expanded"; await mount();
    let finish!: (value: AttentionItems) => void;
    const oldData = data;
    vi.mocked(bridge.items).mockImplementationOnce(() => new Promise<AttentionItems>(resolve => { finish = resolve; }));
    await act(async () => { change(); change(); }); expect(container.querySelector("article")).not.toBeNull();
    expect([...container.querySelectorAll("button")].every(node => node.disabled)).toBe(true);
    data = { ...data, items: [], pill: { ...data.pill!, state: "hidden", count: 0 } };
    await act(async () => { finish(oldData); });
    expect(container.childElementCount).toBe(0); expect(bridge.items).toHaveBeenCalledTimes(3);
    await act(async () => { root.render(null); }); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it.each(["reject", "refuse"])("read %s removes stale controls and drafts and shows translated recovery copy", async failure => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    data.receipts = [{ text: "Private receipt" }];
    await mount(); await click(t("trayPanel.reply")); await enter("Private reply");
    data = { ...data, items: [{ ...data.items[0]!, actionToken: "renewed-action", openToken: "renewed-open" }] };
    await push(); expect(container.querySelector("textarea")!.value).toBe("Private reply");
    bridge.items = vi.fn(async () => { if (failure === "reject") throw new Error("read failed"); return { ok: false }; }); await push();
    expect(container.querySelector("article")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull(); expect(container.textContent).not.toContain("Private receipt");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("pill.loadError"));
  });
});
