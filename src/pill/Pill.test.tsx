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
let bridge: AttentionWindowBridge, data: AttentionItems, rev = 0;
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const mount = async () => { await act(async () => { root.render(<Pill />); }); };
const push = async () => { await act(async () => { change(); }); };
// S8R rev 2.2 rig: focus requests ("focus" and "fresh-focus" tokens), one act and one Open("open") can be held open as queues of
// deferreds, released (resolved or rejected) in any order; `outside` is something else that can take focus.
type Held = { token: string; resolve: (result: AttentionResult) => void; reject: (error: unknown) => void };
let holdFocus = false, holdAct = false, holdOpen = false, outside: HTMLInputElement | null = null;
let heldFocus: Held[] = [], heldAct: Held[] = [], heldOpen: Held[] = [];
const hold = (queue: Held[], token: string) => new Promise<AttentionResult>((resolve, reject) => { queue.push({ token, resolve, reject }); });
const releaseFocus = (result: AttentionResult, at = 0) => heldFocus.splice(at, 1)[0]!.resolve(result);
const rejectFocus = (at = 0) => heldFocus.splice(at, 1)[0]!.reject(new Error("focus failed"));
const reply = () => button(t("trayPanel.reply"));
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
let hasFocusSpy: { mockRestore: () => void } | null = null;
const stubHasFocus = (value: boolean) => { hasFocusSpy?.mockRestore(); hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(value); };
const addOutside = () => { outside = document.createElement("input"); document.body.append(outside); return outside; };
const area = () => container.querySelector("textarea")!;
// jsdom ignores .blur() on a disabled element, so model Chromium blurring a field that becomes disabled.
const disabledBlur = async (el: HTMLTextAreaElement) => {
  expect(el.disabled).toBe(true);
  let related: unknown = "unset";
  el.addEventListener("focusout", event => { related = (event as FocusEvent).relatedTarget; }, { once: true });
  await act(async () => { el.disabled = false; el.blur(); el.disabled = true; });
  expect(document.activeElement).not.toBe(el); expect(related).toBeNull();
};
const refocusButton = async (btn: HTMLButtonElement) => {
  let fired = 0; const count = () => { fired++; };
  btn.addEventListener("focusin", count);
  await act(async () => { btn.blur(); btn.focus(); });
  btn.removeEventListener("focusin", count);
  expect(fired).toBeGreaterThanOrEqual(1);
};
const startRefresh = async (map?: (item: AttentionItems["items"][number]) => AttentionItems["items"][number]) => {
  let finish!: (value: AttentionItems) => void;
  vi.mocked(bridge.items).mockImplementationOnce(() => new Promise<AttentionItems>(resolve => { finish = resolve; }));
  await push();
  return async () => { await act(async () => finish({ ...data, rev: ++rev,
    items: data.items.map(item => { const next = { ...item, actionToken: "fresh-action", openToken: "fresh-open", replyFocusToken: "fresh-focus" }; return map ? map(next) : next; }) })); };
};
const restoreDraft = async (value = "Draft survives") => {
  data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
  await mount(); await click(t("trayPanel.reply")); await enter(value);
  data = { ...data, pill: { ...data.pill!, state: "collapsed" } }; await push();
  data = { ...data, pill: { ...data.pill!, state: "expanded" } }; await push();
  expect(area().value).toBe(value);
};
const enter = async (value: string) => {
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  rev = 0; holdFocus = holdAct = holdOpen = false; heldFocus = []; heldAct = []; heldOpen = [];
  data = { ok: true, rev: 0, items: [{ cardId: "card", display: { botName: "Chief", title: "Read notes", willRun: "cat notes.txt\ncat details.txt" }, level: "quick", openToken: "open", actionToken: "action" }],
    openToken: "app", running: [], receipts: [], chief: null, pill: { state: "collapsed", count: 1, toggleToken: "toggle" } };
  bridge = { items: vi.fn(async () => ({ ...data, rev: ++rev })), act: vi.fn(async () => holdAct ? hold(heldAct, "act") : { ok: true }),
    open: vi.fn(async token => {
      if (holdFocus && (token === "focus" || token === "fresh-focus")) return hold(heldFocus, token);
      if (holdOpen && token === "open") return hold(heldOpen, token);
      if (token === "toggle") {
        data = { ...data, pill: { ...data.pill!, state: data.pill!.state === "collapsed" ? "expanded" : "collapsed" } };
        change();
      }
      return { ok: true };
    }), onChange: vi.fn(cb => { change = cb; return vi.fn(); }),
    sendToChief: vi.fn(async () => ({ ok: true })), sendToPinned: vi.fn(async () => ({ ok: true })), pauseAutomations: vi.fn(async () => ({ ok: true })) };
  window.attentionWindow = bridge; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); delete window.attentionWindow;
  outside?.remove(); outside = null; hasFocusSpy?.mockRestore(); hasFocusSpy = null; holdFocus = holdAct = holdOpen = false;
});

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
    await act(async () => finish({ ...data, rev: ++rev }));
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
    await act(async () => { finish({ ...oldData, rev: ++rev }); });
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
  it("P1d keeps a Reply in an expanded stack through a superseded read while the re-read is still pending", async () => {
    const second = { ...data.items[0]!, cardId: "card-2", openToken: "open-2", actionToken: "action-2", replyFocusToken: "focus-2" };
    data.items[0]!.replyFocusToken = "focus"; data.items = [data.items[0]!, second];
    data.pill = { ...data.pill!, state: "stacked", count: 2 };
    await mount(); await click(t("trayPanel.reply")); await enter("Keep these words");
    const fresh = { ...data, items: data.items.map(item => ({ ...item, actionToken: `fresh-${item.cardId}`, openToken: `open-${item.cardId}-2`, replyFocusToken: `focus-${item.cardId}-2` })) };

    let finish1!: (value: AttentionResult | AttentionItems) => void, finish2!: (value: AttentionResult | AttentionItems) => void;
    const reads = vi.fn().mockImplementationOnce(() => new Promise<AttentionResult | AttentionItems>(resolve => { finish1 = resolve; }))
      .mockImplementationOnce(() => new Promise<AttentionResult | AttentionItems>(resolve => { finish2 = resolve; }))
      .mockImplementation(async () => ({ ...fresh, rev: ++rev }));
    bridge.items = reads as unknown as AttentionWindowBridge["items"];
    await act(async () => { change(); }); await act(async () => { change(); });
    await act(async () => { finish1({ ok: false, reason: "superseded" }); });
    expect(container.querySelector("textarea")?.value).toBe("Keep these words");
    expect(container.querySelector("textarea")!.disabled).toBe(true); expect(button(t("trayPanel.sendReply")).disabled).toBe(true);
    expect(container.querySelectorAll("article")[0]!.contains(container.querySelector("textarea"))).toBe(true);
    await act(async () => { finish2({ ...fresh, rev: ++rev }); });
    expect(container.querySelector("textarea")!.disabled).toBe(false); expect(button(t("trayPanel.sendReply")).disabled).toBe(false);
    await click(t("trayPanel.sendReply"));
    expect(bridge.act).toHaveBeenCalledExactlyOnceWith("fresh-card", "reply", "Keep these words");
  });
  it("P2 restores a Reply when the stack collapses and expands again with the same cardId", async () => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Draft survives");
    data = { ...data, pill: { ...data.pill!, state: "collapsed" } }; await push();
    expect(container.querySelector("textarea")).toBeNull();
    data = { ...data, pill: { ...data.pill!, state: "expanded" } }; await push();
    expect(container.querySelector("textarea")?.value).toBe("Draft survives");
    // Restoration never steals focus; pressing Reply again moves focus into the restored field.
    expect(document.activeElement).not.toBe(container.querySelector("textarea"));
    await click(t("trayPanel.reply"));
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });
  it("P3 keeps words typed while the focus request is pending (the card never writes a stale draft back)", async () => {
    await restoreDraft();
    holdFocus = true; await click(t("trayPanel.reply"));
    await enter("Draft survives, edited");
    await act(async () => releaseFocus({ ok: true }));
    expect(area().value).toBe("Draft survives, edited"); expect(document.activeElement).toBe(area());
    data = { ...data, pill: { ...data.pill!, state: "collapsed" } }; await push();
    data = { ...data, pill: { ...data.pill!, state: "expanded" } }; await push();
    expect(area().value).toBe("Draft survives, edited");
  });
  it("P4a focus moved elsewhere during a refresh stays there after recovery (Chromium blur-on-disable path)", async () => {
    stubHasFocus(true); const other = addOutside();
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words stay");
    const input = area(); expect(document.activeElement).toBe(input);
    const finish = await startRefresh(); expect(input.disabled).toBe(true);
    await disabledBlur(input);
    await act(async () => { other.focus(); });
    await finish();
    expect(document.activeElement).toBe(other); expect(area().value).toBe("Words stay");
  });
  it("P4b a click on a non-focusable area during a refresh is not undone by recovery", async () => {
    stubHasFocus(true);
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words stay");
    const input = area(); const finish = await startRefresh();
    await disabledBlur(input);
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await finish();
    expect(document.activeElement).not.toBe(area()); expect(area().value).toBe("Words stay");
  });
  it("P4g guard: a plain refresh recovery gives the field its focus back", async () => {
    stubHasFocus(true);
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words stay");
    const input = area(); const finish = await startRefresh();
    await disabledBlur(input); await finish();
    expect(document.activeElement).toBe(area());
  });
  it("P4e guard: blurring to nowhere (not refreshing, window focused) is respected after a refresh", async () => {
    stubHasFocus(true);
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words stay");
    const input = area(); expect(document.activeElement).toBe(input);
    await act(async () => { input.blur(); });
    const finish = await startRefresh(); await finish();
    expect(document.activeElement).not.toBe(area());
  });
  it("P4f switching windows keeps the place in the field across a refresh", async () => {
    stubHasFocus(true);
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words stay");
    const input = area(); expect(document.activeElement).toBe(input);
    stubHasFocus(false);
    await act(async () => { input.blur(); });
    const finish = await startRefresh(); await finish();
    expect(document.activeElement).toBe(area());
  });
  it("P5 focus moved elsewhere during the focus request is not stolen back", async () => {
    stubHasFocus(true); const other = addOutside();
    await restoreDraft();
    holdFocus = true; await click(t("trayPanel.reply"));
    await act(async () => { other.focus(); });
    await act(async () => releaseFocus({ ok: true }));
    expect(document.activeElement).toBe(other); expect(area().value).toBe("Draft survives");
  });
  it("P6 guard: the window handing focus back to the Reply button does not cancel the intent", async () => {
    stubHasFocus(true);
    await restoreDraft();
    holdFocus = true; await click(t("trayPanel.reply"));
    await refocusButton(button(t("trayPanel.reply")) as HTMLButtonElement);
    await act(async () => releaseFocus({ ok: true }));
    expect(document.activeElement).toBe(area());
  });
  // ---- S8R rev 2.2: async continuations own what they write (E1) ----
  const collapse = async () => { data = { ...data, pill: { ...data.pill!, state: "collapsed" } }; await push(); };
  const expand = async () => { data = { ...data, pill: { ...data.pill!, state: "expanded" } }; await push(); };
  const openCalls = () => vi.mocked(bridge.open).mock.calls.map(call => call[0]);
  it("P7 a deferred Reply on an unmounted card writes nothing after a remount", async () => {
    await restoreDraft();
    holdFocus = true; await click(t("trayPanel.reply"));
    expect(heldFocus).toHaveLength(1);
    await collapse(); expect(container.querySelector("textarea")).toBeNull();
    await expand(); expect(area().value).toBe("Draft survives");
    await enter("Edited after remount");
    await act(async () => releaseFocus({ ok: true }));
    expect(area().value).toBe("Edited after remount");
    await collapse(); await expand();
    expect(area().value).toBe("Edited after remount");
  });
  const obsolete = async (failure: "refuse" | "throw") => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus"; holdFocus = true;
    await mount(); await click(t("trayPanel.reply"));                       // A, on "focus"
    const finish = await startRefresh(); await finish();
    await click(t("trayPanel.reply"));                                      // B, on "fresh-focus"
    expect(heldFocus.map(held => held.token)).toEqual(["focus", "fresh-focus"]);
    await act(async () => { if (failure === "throw") rejectFocus(0); else releaseFocus({ ok: false }, 0); });
    expect(openCalls()).toEqual(["focus", "fresh-focus"]); expect(alertText()).toBeNull();
    await act(async () => releaseFocus({ ok: true }, 0));
    expect(container.querySelector("textarea")).not.toBeNull(); expect(document.activeElement).toBe(area());
  };
  it("P8 an obsolete refusal does not clear or replace a newer Reply request", async () => { await obsolete("refuse"); });
  it("P8t an obsolete throw does not clear or replace a newer Reply request", async () => { await obsolete("throw"); });
  it("P8f an owned refusal after a token refresh falls back to the current Open authority", async () => {
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus"; holdFocus = true;
    await mount(); await click(t("trayPanel.reply"));
    const finish = await startRefresh(); await finish();
    await act(async () => releaseFocus({ ok: false }));
    expect(openCalls()).toEqual(["focus", "fresh-open"]); expect(alertText()).toBeNull();
  });
  it("P9 the Reply-typing-off fallback cancels the focus intent", async () => {
    stubHasFocus(true);
    data.pill!.state = "expanded"; data.items[0]!.replyFocusToken = "focus";
    await mount(); await click(t("trayPanel.reply")); await enter("Words");
    expect(document.activeElement).toBe(area());
    const off = await startRefresh(item => ({ ...item, replyFocusToken: undefined })); await off();
    expect(area().value).toBe("Words");
    stubHasFocus(false);
    await act(async () => { area().blur(); });
    const replyBtn = reply() as HTMLButtonElement;
    await act(async () => { replyBtn.focus(); });
    await act(async () => { replyBtn.click(); });
    expect(openCalls().at(-1)).toBe("fresh-open");
    const finish = await startRefresh(); await finish();
    expect(document.activeElement).not.toBe(area());
    expect(document.activeElement).toBe(replyBtn);
  });
  it("P10 a stale act refusal after a token refresh shows nothing", async () => {
    data.pill!.state = "expanded"; holdAct = true;
    await mount(); await click(t("trayPanel.allow"));
    const finish = await startRefresh(); await finish();
    await act(async () => heldAct.shift()!.resolve({ ok: false, reason: "card" }));
    expect(alertText()).toBeNull(); expect(button(t("trayPanel.allow")).disabled).toBe(false);
  });
  it("P11 a stale Open refusal after a token refresh shows nothing", async () => {
    data.pill!.state = "expanded"; holdOpen = true;
    await mount(); await click(t("pill.open"));
    const finish = await startRefresh(); await finish();
    await act(async () => heldOpen.shift()!.resolve({ ok: false, reason: "card" }));
    expect(alertText()).toBeNull(); expect(button(t("pill.open")).disabled).toBe(false);
  });
  it("P12 guard: a successful act still clears the draft and refreshes after the pill collapsed", async () => {
    await restoreDraft(); holdAct = true;
    await click(t("trayPanel.sendReply"));
    await collapse(); const reads = vi.mocked(bridge.items).mock.calls.length;
    await act(async () => heldAct.shift()!.resolve({ ok: true }));
    expect(vi.mocked(bridge.items).mock.calls.length).toBe(reads + 1);
    await expand(); expect(container.querySelector("textarea")).toBeNull();
  });
});
