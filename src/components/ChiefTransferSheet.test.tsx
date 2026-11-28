// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 D3 on the client: the sheet renders one server preview (W5 copy), commits with that preview's fence and only the
// checked apps, re-reads on a stale or busy answer, shows the one outcome, and Cancel writes nothing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: {
  instances: [{ instanceId: "fixture", capabilities: { agentsMcp: true } }],
  bots: [
    { id: "a", name: "Alpha", chiefOfStaff: true, chiefScope: "workspace", modelSelection: { instanceId: "fixture", model: "model" } },
    { id: "b", name: "Bravo", modelSelection: { instanceId: "fixture", model: "model" } },
  ],
} }));
vi.mock("@/state/store", () => ({ api: mocks.api, useStore: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));

import { BotRoleControl } from "./BotRoleControl";

type SheetModule = typeof import("./ChiefTransferSheet");
type RoutingModule = typeof import("@/lib/chief-transfer");
async function featureModule<T>(path: string): Promise<T | undefined> {
  try { return await vi.importActual<T>(path); }
  catch (error) {
    if (error instanceof Error && /Cannot find module|Failed to resolve import/.test(error.message) && error.message.includes(path.split("/").at(-1)!)) return undefined;
    throw error;
  }
}
let sheetModule: SheetModule | undefined, routing: RoutingModule | undefined;
const screen = () => sheetModule
  ? createElement(sheetModule.ChiefTransferSheet)
  : createElement(BotRoleControl, { bot: mocks.state.bots[1] as never, canCoordinate: true });

const FENCE = { epoch: 4, fromId: "a", toId: "b" };
const preview = (extra: Record<string, unknown> = {}) => ({
  from: { id: "a", name: "Alpha", level: "Full access", rank: 2, standingAllows: 0 },
  to: { id: "b", name: "Bravo", level: "No limits", rank: 3, standingAllows: 0, eligible: true, reason: null },
  formerRole: "leader", candidates: [{ id: "b", name: "Bravo", eligible: true, reason: null }],
  routines: [{ id: "r1", name: "Morning digest", schedule: { label: "every day at 8" } }, { id: "r2", name: "Weekly review", schedule: { label: "Mondays" } }],
  archiveRoutinesFail: true,
  pairings: [{ channel: "telegram", connectionId: "t", live: true, checked: true }, { channel: "slack", connectionId: "s", live: true, checked: true }, { channel: "discord", connectionId: "d", live: false, checked: false }],
  appAccessResets: [{ id: "a", name: "Alpha", apps: ["gmail", "googlecalendar"] }, { id: "b", name: "Bravo", apps: ["slack"] }],
  higherLevelApps: ["telegram", "slack"], inFlight: 1, fence: FENCE, ...extra,
});
let root: Root, host: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const press = async (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  await act(async () => found!.click());
};
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const posts = () => mocks.api.mock.calls.filter(([path, init]) => path === "/api/chief-transfer" && init?.method === "POST");

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockReset(); mocks.dispatch.mockReset();
  sheetModule = await featureModule<SheetModule>("./ChiefTransferSheet");
  routing = await featureModule<RoutingModule>("@/lib/chief-transfer");
  mocks.api.mockImplementation(async (path: string) => (path.startsWith("/api/chief-transfer/preview") ? preview() : path === "/api/chief-transfer/outcome" ? { outcome: null } : {}));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(screen()));
});
afterEach(async () => { routing?.closeChiefTransfer(); await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const open = async (request = { from: "a", to: "b", source: "archive" as const }) => {
  await act(async () => {
    if (routing) routing.openChiefTransfer(request);
    else {
      // Before the sheet existed, choosing Chief here immediately sent the role change.
      const card = [...document.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.trim().startsWith("Chief of Staff"));
      card?.querySelector<HTMLInputElement>("input[type=radio]")?.click();
    }
  });
  await settle();
};

describe("W5 the sheet's copy", () => {
  it("names both bots, lists both routines as staying, the archive line, both levels, the higher-level warning and the in-flight line", async () => {
    await open();
    expect(text()).toContain("Alpha hands the Chief role to Bravo.");
    expect(text()).toContain("Alpha stays on as a team leader.");
    expect(text()).toContain("Alpha runs 2 routines. They stay with Alpha.");
    expect(text()).toContain("Morning digest, every day at 8");
    expect(text()).toContain("If you archive Alpha, these routines will fail each time they are due until you restore it.");
    expect(text()).toContain("Telegram: move to Bravo");
    expect(text()).toContain("Slack: move to Bravo");
    expect(text()).toContain("Discord: not connected, nothing to move.");
    expect(text()).toContain("Alpha: Full access. Bravo: No limits. Approval levels stay with each bot.");
    expect(text()).toContain("Alpha's connected-app access is reset when its role changes (Gmail, Google Calendar). You will grant it again.");
    expect(text()).toContain("Bravo's connected-app access is reset when its role changes (Slack). You will grant it again.");
    expect(text()).toContain("Routines that use Alpha's connected apps may need you to grant access again.");
    expect(text()).toContain("Messages from Telegram, Slack will reach Bravo, which works with No limits.");
    expect(text()).toContain("Alpha is answering 1 message. It will be stopped; send it again after the move. Your chat account stays linked.");
    expect([...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((box) => box.checked)).toEqual([true, true]);
    expect(posts()).toHaveLength(0);
  });

  it("the archive line only shows when the sheet was opened from the archive hint", async () => {
    await open({ from: "a", to: "b", source: "role" } as never);
    expect(text()).not.toContain("will fail each time they are due");
  });

  it("an unchecked app says it stays paused and is left out of the commit", async () => {
    await open();
    await act(async () => document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.click());
    expect(text()).toContain("Slack: stays paused. You will pair it again in Settings.");
    expect(text()).not.toContain("Messages from Telegram, Slack");
    await press("Hand over");
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ fence: FENCE, move: ["telegram"] });
  });
});

describe("outcome on open, permissions link", () => {
  it("a hand-over that finished while the app was closed is shown once on mount, from the server's one outcome", async () => {
    mocks.api.mockImplementation(async (path: string) => path === "/api/chief-transfer/outcome"
      ? { outcome: { from: "a", to: "b", fromName: "Alpha", toName: "Bravo", status: "done", channels: [{ channel: "telegram", result: "moved" }], stoppedRuns: 0 } } : {});
    // a fresh mount (the app opened after the hand-over finished), not a re-render of the one beforeEach mounted
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(screen()));
    await settle();
    expect(text()).toContain("Bravo is now Chief of Staff");
    expect(text()).toContain("Telegram: moved to Bravo.");
    expect(mocks.api.mock.calls.some(([path]) => String(path).startsWith("/api/chief-transfer/preview"))).toBe(false);
    await press("Done");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Change {To}'s permissions closes the sheet without committing and opens that bot's settings", async () => {
    await open();
    await press("Change Bravo's permissions");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "select", id: "b" });
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true });
  });
});

describe("commit, stale, cancel", () => {
  it("Hand over posts the preview's fence with the checked apps and renders the one outcome, with Archive offered from the archive hint", async () => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => path.startsWith("/api/chief-transfer/preview") ? preview()
      : init?.method === "POST" && path === "/api/chief-transfer" ? { outcome: { from: "a", to: "b", fromName: "Alpha", toName: "Bravo", status: "done", channels: [{ channel: "telegram", result: "moved" }, { channel: "slack", result: "paused:save-failed" }], stoppedRuns: 1 } } : {});
    await open();
    await press("Hand over"); await settle();
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ fence: FENCE, move: ["telegram", "slack"] });
    expect(text()).toContain("Bravo is now Chief of Staff");
    expect(text()).toContain("Telegram: moved to Bravo.");
    expect(text()).toContain("Slack is paused. Pair it again in Settings.");
    expect(text()).toContain("One message in progress was stopped. Send it again.");
    await press("Archive Alpha");
    expect(mocks.api.mock.calls.some(([path, init]) => path === "/api/bots/a" && init?.method === "PATCH" && JSON.parse(init.body).hidden === true)).toBe(true);
  });

  it("a stale answer re-reads the preview and says so; nothing is applied", async () => {
    let first = true;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/chief-transfer/preview")) return preview();
      if (init?.method === "POST" && first) { first = false; throw Object.assign(new Error("stale"), { status: 409, body: { code: "chief-transfer-stale" } }); }
      return {};
    });
    await open();
    await press("Hand over"); await settle();
    expect(text()).toContain("Something changed. Check again.");
    expect(mocks.api.mock.calls.filter(([path]) => String(path).startsWith("/api/chief-transfer/preview"))).toHaveLength(2);
    expect(text()).not.toContain("is now Chief of Staff");
  });

  it("Cancel closes the sheet and writes nothing", async () => {
    await open();
    expect(mocks.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateBot" }));
    await press("Cancel");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(mocks.api.mock.calls.every(([path, init]) => (String(path).startsWith("/api/chief-transfer/preview") || path === "/api/chief-transfer/outcome") && !init?.method)).toBe(true);
  });

  it("with no target the picker lists eligible bots, greys the others, and Hand over stays disabled until one is chosen", async () => {
    mocks.api.mockImplementation(async (path: string) => path.startsWith("/api/chief-transfer/preview") ? preview(path.includes("&to=") ? {} : { to: null, formerRole: null,
      candidates: [{ id: "b", name: "Bravo", eligible: true, reason: null }, { id: "c", name: "Carol", eligible: false, reason: "This engine cannot lead." }] }) : {});
    await open({ from: "a", source: "sidebar" } as never);
    expect(text()).toContain("Pick who runs the workspace next.");
    const options = [...document.querySelectorAll<HTMLOptionElement>("option")];
    expect(options.find((o) => o.value === "c")).toMatchObject({ disabled: true });
    expect(options.find((o) => o.value === "c")!.textContent).toContain("This engine cannot lead.");
    expect(document.querySelector<HTMLButtonElement>("button[data-primary]")!.disabled).toBe(true);
    const select = document.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(document.querySelector<HTMLButtonElement>("button[data-primary]")!.disabled).toBe(false);
  });
});
