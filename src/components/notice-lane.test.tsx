// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE FLOATING NOTICE AT A TIME (1.0.20, owner report on 1.0.19: "popups
// stacked on top of popups"). The real corner notices, mounted together: the
// Undo toast (a real undo host), a team action's toast, the update pop-up and
// the update-check line. Only one is ever drawn; the rest wait in priority
// order and each shows when the one above it is closed. Each has its own X.
// B-1 (1.0.20 review): the call-budget stop (the real CallOverlaySlot, ended
// by the real call store) and the home-screen invitation (the real
// InstallPrompt, invited by a real beforeinstallprompt) are in the same lane,
// and no corner notice covers the composer when they share a column (phone).
import { act, createElement, Fragment, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { createUndoHost, type UndoHost } from "@/lib/undo";
import { UndoToastHost } from "./ui/UndoToast";
import { UpdateStaleNotice } from "./UpdateStaleNotice";
import { UpdateBanner } from "./UpdateBanner";
import { TeamFeedbackToast } from "./Sidebar";
import { CallOverlaySlot } from "./CallControls";
import { InstallPrompt } from "./InstallPrompt";
import { dismissCallBudgetEnded, endCall, startCall } from "@/lib/call";
import type { ComponentProps } from "react";

let root: Root, container: HTMLDivElement, host: UndoHost;
let updater: { status: string; staleCheckSince?: string; version?: string };
const stateListeners = new Set<(state: unknown) => void>();
const pushState = (state: unknown) => { for (const listener of stateListeners) listener(state); };
let showTeam: (on: boolean) => void = () => {};

function Corner() {
  const [team, setTeam] = useState(false);
  showTeam = setTeam;
  return createElement(Fragment, null,
    createElement(UndoToastHost, { host }),
    team && createElement(TeamFeedbackToast, { feedback: { error: false, text: "Team loaded" }, onUndoTeam: () => {}, onUndoBot: () => {}, onDismiss: () => setTeam(false) }),
    createElement(UpdateBanner),
    createElement(UpdateStaleNotice),
    createElement(CallOverlaySlot, { state: callState, dispatch: () => {} }),
    createElement(InstallPrompt));
}
const callState = { bots: [], groups: [], activeView: "chat", selectedId: null } as unknown as ComponentProps<typeof CallOverlaySlot>["state"];
const BUDGET_STOP = "The call ended because this Flux key has reached its budget.";

/** The Flux budget ends a call, through the real call store. */
async function budgetEndsCall() {
  await act(async () => { startCall("fixture-bot"); endCall("fixture-bot", "budget"); });
}
/** The browser says this page can be installed. */
async function installable() {
  await act(async () => { window.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) })); });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  window.localStorage.clear();
  updater = { status: "idle", staleCheckSince: "2026-11-16T09:00:00Z" };
  Object.assign(window, { muragebox: { updater: {
    onState: (listener: (state: unknown) => void) => { stateListeners.add(listener); listener(updater); return () => { stateListeners.delete(listener); }; },
    check: async () => {},
  }, speechStop: async () => {} } });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  host = createUndoHost();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Corner)));
});
afterEach(async () => { dismissCallBudgetEnded(); await act(async () => root.unmount()); container.remove(); document.querySelector("[data-fixture-composer]")?.remove(); delete (window as { muragebox?: unknown }).muragebox; });

/** Which corner notices are drawn, by name. */
function drawn(): string[] {
  const names: string[] = [];
  if (document.querySelector("[data-undo-toast]")) names.push("undo");
  if ([...document.querySelectorAll("[role=status]")].some(node => node.textContent?.includes("Team loaded"))) names.push("team");
  if (document.querySelector("[data-testid=update-popup]")) names.push("update");
  if (document.querySelector("[data-testid=update-stale-notice]")) names.push("stale");
  if ([...document.querySelectorAll("[role=status]")].some(node => node.textContent?.includes(BUDGET_STOP))) names.push("call-budget");
  if (document.querySelector("[aria-label='Add Murage to your home screen']")) names.push("install");
  return names;
}

it("the corner shows one notice at a time, queued by priority, and closing each shows the next", async () => {
  expect(drawn()).toEqual(["stale"]);
  // The person does something undoable: Undo comes first, the update-check line waits.
  await act(async () => { host.offerUndo({ kind: "local", key: "fixture:hide", message: "Tip hidden.", undo: () => {} }); });
  expect(drawn()).toEqual(["undo"]);
  // A team action's note arrives meanwhile: it waits under Undo, it does not stack.
  await act(async () => { showTeam(true); });
  expect(drawn()).toEqual(["undo"]);
  // Undo's X: the team note takes the corner.
  const undoClose = document.querySelector<HTMLButtonElement>("[data-undo-toast] button[aria-label='Dismiss']")!;
  await act(async () => { undoClose.click(); });
  expect(drawn()).toEqual(["team"]);
  // The team note can always be closed, and then the update-check line comes back.
  const teamClose = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label='Dismiss']")].find(button => button.closest("[role=status]")?.textContent?.includes("Team loaded"))!;
  expect(teamClose).toBeTruthy();
  await act(async () => { teamClose.click(); });
  expect(drawn()).toEqual(["stale"]);
  expect(document.querySelector("[data-testid=update-stale-notice] button[aria-label='Dismiss']")).not.toBeNull();
});

it("an update ready to install waits under the Undo toast instead of floating above it", async () => {
  await act(async () => { pushState({ status: "downloaded", version: "9.9.9", staleCheckSince: undefined }); });
  expect(drawn()).toEqual(["update"]);
  await act(async () => { host.offerUndo({ kind: "local", key: "fixture:hide", message: "Tip hidden.", undo: () => {} }); });
  expect(drawn()).toEqual(["undo"]);
  await act(async () => { host.dismiss(); });
  expect(drawn()).toEqual(["update"]);
});

it("the call-budget stop and the home-screen invitation wait their turn in the same corner, each with its own close", async () => {
  await installable();
  expect(drawn()).toEqual(["stale"]);
  await act(async () => { host.offerUndo({ kind: "local", key: "fixture:hide", message: "Tip hidden.", undo: () => {} }); });
  await budgetEndsCall();
  // Undo, the budget stop, the update-check line and the invitation all want the corner: one is drawn.
  expect(drawn()).toEqual(["undo"]);
  await act(async () => { host.dismiss(); });
  expect(drawn()).toEqual(["call-budget"]);
  const budgetClose = [...document.querySelectorAll<HTMLButtonElement>("[role=status] button")].find(button => button.closest("[role=status]")?.textContent?.includes(BUDGET_STOP) && button.textContent === "Dismiss")!;
  expect(budgetClose).toBeTruthy();
  await act(async () => { budgetClose.click(); });
  expect(drawn()).toEqual(["stale"]);
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-testid=update-stale-notice] button[aria-label='Dismiss']")!.click(); });
  // Last of all, the invitation; its own close puts it away for good.
  expect(drawn()).toEqual(["install"]);
  await act(async () => { document.querySelector<HTMLButtonElement>("[aria-label='Add Murage to your home screen'] button[aria-label='Not now']")!.click(); });
  expect(drawn()).toEqual([]);
});

/** A composer across the foot of the screen, as on a phone (top at 700 of 844), or beside the rail, as on a wide window. */
function placeComposer(rect: { left: number; right: number; top: number; bottom: number }) {
  const composer = document.createElement("div");
  composer.setAttribute("data-composer", ""); composer.setAttribute("data-fixture-composer", "");
  composer.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => ({}) }) as DOMRect;
  document.body.append(composer);
}
/** Every drawn corner notice spans the phone's width (16..374), as its frame does below 640 px. */
function phoneWide() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () { return { left: 16, right: 374, top: 760, bottom: 828, x: 16, y: 760, width: 358, height: 68, toJSON: () => ({}) } as DOMRect; };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

it("on a phone each corner notice sits above the composer, never over it; beside the rail it keeps its corner", async () => {
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  const restore = phoneWide();
  try {
    placeComposer({ left: 0, right: 390, top: 700, bottom: 844 });
    const bottomOf = (selector: string) => document.querySelector<HTMLElement>(selector)!.style.bottom;
    // 844 - 700 + 8: the notice's bottom edge is 8 px above the composer's top.
    await budgetEndsCall();
    expect(drawn()).toEqual(["call-budget"]);
    expect(bottomOf("[data-testid=call-budget-notice]")).toBe("152px");
    await act(async () => { dismissCallBudgetEnded(); });
    await installable();
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-testid=update-stale-notice] button[aria-label='Dismiss']")!.click(); });
    expect(drawn()).toEqual(["install"]);
    expect(bottomOf("[aria-label='Add Murage to your home screen']")).toBe("152px");
    await act(async () => { host.offerUndo({ kind: "local", key: "fixture:hide", message: "Tip hidden.", undo: () => {} }); });
    expect(drawn()).toEqual(["undo"]);
    expect(bottomOf("[data-undo-toast]")).toBe("152px");
    await act(async () => { host.dismiss(); });
    // A wide window: the composer starts right of the rail, so the corner notice keeps its own place.
    document.querySelector("[data-fixture-composer]")!.remove();
    placeComposer({ left: 400, right: 1280, top: 700, bottom: 844 });
    await budgetEndsCall();
    expect(drawn()).toEqual(["call-budget"]);
    expect(bottomOf("[data-testid=call-budget-notice]")).toBe("");
  } finally { restore(); }
});
