// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, createElement, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { BrowserApprovalMode, BrowserApprovalModeView, FullPermissiveDialog, HazardStripe, setApprovalMode, setActionCheck } from "./BrowserApprovalMode";
import * as store from "@/state/store";
import { BrowserExtensionPanelView, endedBindingIds } from "./BrowserExtensionPanel";
import { approvalSaveOutcome, ModeNotConfirmed, saveApprovalMode } from "@/lib/browser-approval-read";
import { readFileSync } from "node:fs";

function find(node: ReactNode, predicate: (props: Record<string, any>) => boolean): Record<string, any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return; }
  if (!isValidElement(node)) return;
  const p = node.props as Record<string, any>;
  return predicate(p) ? p : find(p.children, predicate);
}
const base = () => ({ botName: "Mira", mode: "task" as const, actionCheck: "flux" as const, phone: false, pending: false, error: "", dialogOpen: false, typed: "", onMode: vi.fn(), onOpenFull: vi.fn(), onTyped: vi.fn(), onConfirmFull: vi.fn(), onCancelFull: vi.fn(), onTurnOff: vi.fn(), onActionCheck: vi.fn() });

describe("mode selector", () => {
  it("shows the label, three modes, Recommended and the always-visible floor sentence", () => {
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, base()));
    for (const text of ["How Mira asks in your browser", "Ask each step", "Ask once per task", "Recommended", "Full access", "Danger zone", "never agrees to terms or cookies", "never presses the final pay button"]) expect(html).toContain(text);
  });
  it("picking a step or task mode saves it; picking Full opens the dialog instead of saving", () => {
    const p = base(); const tree = BrowserApprovalModeView(p);
    find(tree, i => i["data-mode"] === "step")!.onClick(); expect(p.onMode).toHaveBeenCalledWith("step");
    find(tree, i => i["data-mode"] === "full")!.onClick(); expect(p.onOpenFull).toHaveBeenCalled(); expect(p.onMode).toHaveBeenCalledTimes(1);
  });
  it("the phone surface hides the Full access control while it is off", () => {
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), phone: true }));
    expect(html).not.toContain('data-mode="full"'); expect(html).toContain("Ask each step");
  });
  it("Full on shows the banner with Turn off (phone says Full access is on.)", () => {
    const p = { ...base(), mode: "full" as const }; const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, p));
    expect(html).toContain("Full access is on for Mira."); find(BrowserApprovalModeView(p), i => i.children === "Turn off")!.onClick(); expect(p.onTurnOff).toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...p, phone: true }))).toContain("Full access is on.");
  });
  it("action check: Flux default, the bot's own engine, settings line, and the Ask each step note when unavailable", () => {
    const p = base(); const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, p));
    expect(html).toContain("Action check"); expect(html).toContain("Murage&#x27;s check service (default)"); expect(html).toContain("Mira&#x27;s own engine"); expect(html).toContain("Turning this on sends your task and the page details to Flux to check browser actions."); expect(html).not.toContain("Ask each step until the action check is available.");
    find(BrowserApprovalModeView(p), i => i["data-check"] === "bot")!.onClick(); expect(p.onActionCheck).toHaveBeenCalledWith("bot");
    expect(renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...p, checkerAvailable: false }))).toContain("Ask each step until the action check is available.");
  });
});

describe("danger-zone dialog", () => {
  const dlg = (typed: string) => ({ botName: "Mira", typed, pending: false, error: "", onTyped: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() });
  it("keeps the button disabled until the typed name matches exactly", () => {
    for (const typed of ["", "mira", "Mira ", "Mir"]) expect(find(FullPermissiveDialog(dlg(typed)), i => i.children === "Turn on Full access")!.disabled).toBe(true);
    expect(find(FullPermissiveDialog(dlg("Mira")), i => i.children === "Turn on Full access")!.disabled).toBe(false);
  });
  it("carries the title, the four warnings and the confirm label", () => {
    const html = renderToStaticMarkup(createElement(FullPermissiveDialog, dlg(""))); expect(html).toContain("Turn on Full access for Mira?"); expect(html).toContain("Type Mira to confirm"); expect(html).toContain("hidden instructions"); expect(html).toContain("will still stop for terms"); expect(html).toContain("Cancel"); expect(html).toContain('role="dialog"');
  });
  it("turning Full on sends PATCH with confirmName; turning off sends none", async () => {
    const request = vi.fn(async () => ({ mode: "full" }));
    await setApprovalMode(request, "bot 1", "full", "Mira");
    expect(request).toHaveBeenCalledWith("/api/bots/bot%201/browser-extension/mode", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full", confirmName: "Mira" }) });
    await setApprovalMode(request, "bot 1", "task");
    expect(request).toHaveBeenLastCalledWith("/api/bots/bot%201/browser-extension/mode", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "task" }) });
  });
});

describe("copy rules and Full stated once (1.0.18)", () => {
  it("Full on shows the banner in place of the cards, and compact keeps only the cards and the floor line", () => {
    const full = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), mode: "full" as const }));
    expect(full).toContain("data-full-on"); expect(full).not.toContain("data-mode=");
    const compact = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), compact: true }));
    expect(compact).toContain('data-mode="task"'); expect(compact).not.toContain("<h4"); expect(compact).not.toContain("data-check=");
  });
  it("uses no banned words in the markup", () => {
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), mode: "full" as const }));
    expect(html).not.toMatch(/—|\bsafe|safely|safety|unsafe|composio|always-on|price/i);
  });
});

describe("panel wiring", () => {
  it("the connected panel shows mode, approved sites and activity sections", () => {
    const status = { profiles: [{ profileId: "p1", browser: "Chrome" }], bindings: [], helper: { running: true }, storeUrl: null };
    const html = renderToStaticMarkup(createElement(BrowserExtensionPanelView, { botName: "Mira", profileId: "p1", status, pending: false, error: "", connectBrowser: "chrome", onConnectBrowser: vi.fn(), onCheck: vi.fn(), onProfile: vi.fn(), onAction: vi.fn(), onSite: vi.fn(), onOwnBrowser: vi.fn(), settings: createElement("div", { "data-slot": "settings" }, "SETTINGS-SLOT") }));
    expect(html).toContain("SETTINGS-SLOT");
  });
});

describe("Your turn banner", () => {
  it("shows for a paused handoff binding only", () => {
    const status = (handoff: boolean) => ({ profiles: [{ profileId: "p1", browser: "Chrome" }], bindings: [{ bindingId: "b", botId: "x", threadId: "t", profileId: "p1", state: "paused" as const, handoff, sites: {} }], helper: { running: true }, storeUrl: null });
    const view = (handoff: boolean) => renderToStaticMarkup(createElement(BrowserExtensionPanelView, { botName: "Mira", profileId: "p1", status: status(handoff), pending: false, error: "", connectBrowser: "chrome", onConnectBrowser: vi.fn(), onCheck: vi.fn(), onProfile: vi.fn(), onAction: vi.fn(), onSite: vi.fn(), onOwnBrowser: vi.fn() }));
    expect(view(true)).toContain("Your turn"); expect(view(false)).not.toContain("data-your-turn");
  });
});

describe("hazard stripe and action-check route (T34 follow-up)", () => {
  it("Full access uses the amber and black hazard stripe on the dialog and the banner, not a plain amber border", () => {
    const stripe = renderToStaticMarkup(createElement(HazardStripe)); expect(stripe).toContain("repeating-linear-gradient(135deg"); expect(stripe).toContain("--color-warning"); expect(stripe).toContain("--color-app");
    const dialog = renderToStaticMarkup(createElement(FullPermissiveDialog, { botName: "Mira", typed: "", pending: false, error: "", onTyped: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() }));
    expect(dialog).toContain("data-hazard"); expect(dialog).not.toContain("border-warning");
    const banner = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), mode: "full" as const })); expect(banner).toContain("data-hazard"); expect(banner).not.toContain("border-warning");
  });
  it("saves the action check through PATCH …/browser-extension/check", async () => {
    const request = vi.fn(async () => ({ actionCheck: "bot" }));
    await setActionCheck(request, "bot 1", "bot");
    expect(request).toHaveBeenCalledWith("/api/bots/bot%201/browser-extension/check", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ check: "bot" }) });
  });
  it("shows the Ask each step note and the reason when the server says the check is unavailable", () => {
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), checkerAvailable: false, checkerReason: "Murage is waiting." }));
    expect(html).toContain("Ask each step until the action check is available."); expect(html).toContain("Murage is waiting.");
  });
});

describe("D3: the recommended mode is offered only when its check resolves, and a fallback is said once", () => {
  const html = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), ...over }));
  it("available: Task carries Recommended and is selectable", () => {
    const out = html({ checkerAvailable: true });
    expect(out).toContain("Recommended");
    expect(find(BrowserApprovalModeView({ ...base(), checkerAvailable: true }), i => i["data-mode"] === "task")!.disabled).toBe(false);
  });
  it("unavailable: no Recommended tag, Task cannot be newly chosen, and the reason is shown (Ask each step is not hidden)", () => {
    const out = html({ mode: "step", checkerAvailable: false, checkerReason: "Connect Flux." });
    expect(out).not.toContain("Recommended");
    expect(find(BrowserApprovalModeView({ ...base(), mode: "step", checkerAvailable: false }), i => i["data-mode"] === "task")!.disabled).toBe(true);
    expect(out).toContain("Ask each step until the action check is available."); expect(out).toContain("Connect Flux.");
  });
  it("unavailable while already on Task: the choice stays visible and the note says what actually happens", () => {
    const out = html({ mode: "task", checkerAvailable: false });
    expect(find(BrowserApprovalModeView({ ...base(), mode: "task", checkerAvailable: false }), i => i["data-mode"] === "task")!.disabled).toBe(false);
    expect(out).toContain("Ask each step until the action check is available.");
  });
  it("fallback to the bot's own engine says so in one line", () => {
    const out = html({ checkerAvailable: true, checkerFallback: true });
    expect(out).toContain("Murage&#x27;s check service is not live yet, so Mira&#x27;s own engine checks each step.");
    expect(out).not.toContain("Ask each step until");
    expect(html({ checkerAvailable: true })).not.toContain("not live yet");
  });
  it("no jargon: Full access, no Flux Router or Full permissive on the settings screen", () => {
    const out = html({});
    expect(out).toContain("Full access"); expect(out).not.toMatch(/Flux Router|permissive/i);
  });
});

describe("gate e and b: tighten-only on the phone, and the end-of-task signal", () => {
  const html = (mode: "step" | "task" | "full", phone: boolean) => renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), mode, phone }));
  it("the phone hides every option looser than the current mode", () => {
    expect(html("step", true)).toContain('data-mode="step"');
    expect(html("step", true)).not.toContain('data-mode="task"');
    expect(html("task", true)).toContain('data-mode="step"'); expect(html("task", true)).toContain('data-mode="task"');
    expect(html("task", true)).not.toContain('data-mode="full"');
    // Full is stated once (1.0.18): the phone sees the banner and Turn off, which only tightens, in place of the cards.
    expect(html("full", true)).toContain("data-full-on"); expect(html("full", true)).toContain("Turn off"); expect(html("full", true)).not.toContain("data-mode=");
  });
  it("the desktop still shows every option", () => {
    for (const key of ["step", "task", "full"]) expect(html("step", false)).toContain(`data-mode="${key}"`);
  });
  it("the end-of-task offer reads the server's taskEnded flag", () => {
    const status = { profiles: [], bindings: [
      { bindingId: "a", botId: "x", threadId: "t", profileId: "p", state: "stopped" as const, taskEnded: true, sites: {} },
      { bindingId: "b", botId: "x", threadId: "t", profileId: "p", state: "stopped" as const, sites: {} },
      { bindingId: "c", botId: "x", threadId: "t", profileId: "p", state: "active" as const, sites: {} },
    ], helper: { running: true }, storeUrl: null };
    expect(endedBindingIds(status as never)).toEqual(["a"]);
    expect(endedBindingIds(undefined)).toEqual([]);
  });
});

describe("a mode that is not known is never shown as the bot's", () => {
  it("an unconfirmed save or a failed read shows the reason and Try again, with no mode marked", () => {
    const onReread = vi.fn();
    const p = { ...base(), mode: "full" as const, onReread, error: "" };
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, p));
    expect(html).toContain('role="alert"');
    expect(html).toContain("could not read how Mira asks");
    expect(html).not.toContain("aria-checked");
    expect(html).not.toContain("data-full-on");
    find(BrowserApprovalModeView(p), (i) => i["data-action"] === "mode-reread")!.onClick();
    expect(onReread).toHaveBeenCalledTimes(1);
  });
  it("a save whose answer is lost is read back: confirmed only when the read says so, else unknown; a server refusal is passed on", async () => {
    let stored = "task";
    const make = (readWorks: boolean) => async (_path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") { stored = JSON.parse(String(init.body)).mode; throw new TypeError("Failed to fetch"); }
      if (!readWorks) throw new TypeError("Failed to fetch");
      return { mode: stored };
    };
    await expect(saveApprovalMode(make(true), "bot", "full", "Mira")).resolves.toBe("full");
    const lost = await saveApprovalMode(make(false), "bot", "step").catch((cause: unknown) => cause);
    expect(approvalSaveOutcome(lost)).toBe("unconfirmed");
    const refusal = Object.assign(new Error("Type Mira exactly"), { status: 400 });
    const refused = await saveApprovalMode(async () => { throw refusal; }, "bot", "full", "x").catch((cause: unknown) => cause);
    expect(refused).toBe(refusal);
    expect(approvalSaveOutcome(refused)).toBe("refused");
  });
  it("a server failure after the write (5xx) is read back too, never taken as a refusal", async () => {
    const committedThen500 = (read: "works" | "fails" | "other") => async (_path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw Object.assign(new Error("Something went wrong"), { status: 500 });
      if (read === "fails") throw Object.assign(new Error("Unavailable"), { status: 503 });
      return { mode: read === "works" ? "full" : "task" };
    };
    await expect(saveApprovalMode(committedThen500("works"), "bot", "full", "Mira")).resolves.toBe("full");
    expect(approvalSaveOutcome(await saveApprovalMode(committedThen500("fails"), "bot", "full", "Mira").catch((cause: unknown) => cause))).toBe("unconfirmed");
    expect(approvalSaveOutcome(await saveApprovalMode(committedThen500("other"), "bot", "full", "Mira").catch((cause: unknown) => cause))).toBe("unconfirmed");
  });
  it("an unconfirmed save marks the mode unknown and closes the Full dialog; a refusal keeps the stored mode", () => {
    expect(approvalSaveOutcome(new ModeNotConfirmed())).toBe("unconfirmed");
    expect(approvalSaveOutcome(new Error("Type Mira exactly"))).toBe("refused");
    const source = readFileSync("src/components/BrowserApprovalMode.tsx", "utf8");
    expect(source).toContain('if (approvalSaveOutcome(cause) === "unconfirmed") {\n        // It may have changed');
    expect(source).toContain('setRead("failed"); setDialogOpen(false); setTyped("");');
    expect(source).toContain('onReread={read === "failed" ?');
  });
});

it("ROOM-ROUTING-CONSENT the Flux checker choice renders its processing disclosure", () => {
  const copy = "Turning this on sends your task and the page details to Flux to check browser actions.";
  for (const actionCheck of ["flux", "bot"] as const) {
    const html = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), actionCheck }));
    expect(html).toContain('data-check="flux"');
    expect(html).toContain(copy);
  }
  const compact = renderToStaticMarkup(createElement(BrowserApprovalModeView, { ...base(), compact: true }));
  expect(compact).not.toContain('data-check="flux"');
});

it.each([
  { actionCheck: undefined, selected: "false", label: "no saved actionCheck" },
  { actionCheck: "flux" as const, selected: "true", label: "saved Flux choice" },
])("ROOM-ROUTING-CONSENT $label renders Flux selected=$selected", async ({ actionCheck, selected }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const request = vi.spyOn(store, "api").mockResolvedValue({ mode: "task", ...(actionCheck ? { actionCheck } : {}), checkerAvailable: actionCheck === "flux" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BrowserApprovalMode, { bot: { id: "consent-fixture", name: "Mira" }, phone: false })));
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots/consent-fixture/browser-extension/mode");
    expect(container.querySelector('[role="radio"][data-check="flux"]')?.getAttribute("aria-checked")).toBe(selected);
    if (!actionCheck) expect(container.querySelectorAll('[data-check][aria-checked="true"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    request.mockRestore();
    vi.unstubAllGlobals();
  }
});
