// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 client witnesses: W1 (the Chief's More-actions menu and "Remove Chief of Staff" open the sheet, send no PATCH),
// W4 (the role control routes a Chief election to the sheet; the reducer does not paint it), the team-import undo pre-check (W19 client half).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), state: { bots: [] as any[], instances: [] as any[] } as any }));
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: mocks.api, useStore: () => ({ state: mocks.state, dispatch: mocks.dispatch }), useStoreActions: () => ({ dispatch: mocks.dispatch }) }));

import { BotContextMenu, Sidebar } from "./Sidebar";
import { BotRoleControl } from "./BotRoleControl";
type ChiefTransferRouting = typeof import("@/lib/chief-transfer");
let routing: ChiefTransferRouting | undefined;
const closeChiefTransfer = () => routing?.closeChiefTransfer();
const currentChiefTransfer = () => routing?.currentChiefTransfer() ?? null;
import { reducer } from "@/state/store";
vi.mock("./TeamLibraryPanel", () => ({
  TeamLibraryPanel: ({ onImported }: { onImported: (result: unknown) => void }) => createElement("button", {
    onClick: () => onImported({ name: "Fixture", members: 1, skillErrors: [], archived: [{ id: "c", name: "Charlie" }],
      importedBotIds: ["a"], importedRoutineIds: ["routine"], importedGroupIds: ["group"] }),
  }, "Load fixture team"),
}));

const bot = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id === "a" ? "Alpha" : "Bravo", threadId: `t-${id}`, modelSelection: { instanceId: "x", model: "m" }, tasks: [], messages: [], ...extra });
let root: Root, host: HTMLDivElement;
const texts = () => document.body.textContent ?? "";
const press = async (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("button,[role=menuitem]")].find((el) => el.textContent?.trim().startsWith(label));
  expect(found, `control ${label}`).toBeDefined();
  await act(async () => found!.click());
};
/** A role card is a label around a radio: choosing it clicks the radio, as a person does. */
const chooseRole = async (title: string) => {
  const card = [...document.querySelectorAll<HTMLLabelElement>("label")].find((el) => el.querySelector("input[type=radio]") && el.textContent?.trim().startsWith(title));
  expect(card, `role ${title}`).toBeDefined();
  await act(async () => card!.querySelector<HTMLInputElement>("input[type=radio]")!.click());
};

beforeEach(async () => {
  routing = await vi.importActual<ChiefTransferRouting>("@/lib/chief-transfer").catch(error => {
    if (error instanceof Error && /Cannot find module|Failed to resolve import/.test(error.message) && error.message.includes("chief-transfer")) return undefined;
    throw error;
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.dispatch.mockReset(); mocks.api.mockReset(); closeChiefTransfer();
  mocks.state = { bots: [bot("a", { chiefOfStaff: true, chiefScope: "workspace" }), bot("b")], instances: [{ instanceId: "x", capabilities: { agentsMcp: true } }] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); closeChiefTransfer(); });

const menu = (botId: string, onClose = vi.fn(), onArchive = vi.fn()) => act(async () => root.render(createElement(BotContextMenu, { menu: { botId, x: 10, y: 10 } as never, onClose, onArchive, onToggleHidden: vi.fn(), onRequestDelete: vi.fn(), onMoveToSection: vi.fn() })));

describe("W1 sidebar", () => {
  it("W1 More-actions on the workspace Chief shows the hint and a button that opens the sheet with from set; Archive is not offered", async () => {
    const onArchive = vi.fn();
    await menu("a", vi.fn(), onArchive);
    expect(texts()).toContain("Choose a new Chief first.");
    expect(texts()).toContain("Alpha runs the workspace. Hand the role over, then you can archive it.");
    expect([...document.querySelectorAll("[role=menuitem]")].some((el) => el.textContent?.trim() === "Archive")).toBe(false);
    await press("Choose new Chief");
    expect(currentChiefTransfer()).toEqual({ from: "a", source: "archive" });
    expect(onArchive).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("W1 Remove Chief of Staff opens the same sheet and sends no PATCH and no role update", async () => {
    await menu("a");
    await press("Remove Chief of Staff");
    expect(currentChiefTransfer()).toEqual({ from: "a", source: "sidebar" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("a team member still archives the ordinary way", async () => {
    const onArchive = vi.fn();
    await menu("b", vi.fn(), onArchive);
    expect(texts()).not.toContain("Choose a new Chief first.");
    await press("Archive");
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(currentChiefTransfer()).toBeNull();
  });
});

describe("W4 role control", () => {
  it("W4 choosing Chief on B while A is Chief opens the sheet (from A, to B), sends no PATCH and dispatches no role update", async () => {
    await act(async () => root.render(createElement(BotRoleControl, { bot: mocks.state.bots[1], canCoordinate: true })));
    await chooseRole("Chief of Staff");
    expect(currentChiefTransfer()).toEqual({ from: "a", to: "b", source: "role" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("W4 choosing another role on the Chief opens the sheet with no target", async () => {
    await act(async () => root.render(createElement(BotRoleControl, { bot: mocks.state.bots[0], canCoordinate: true })));
    await chooseRole("Team member");
    expect(currentChiefTransfer()).toEqual({ from: "a", source: "role" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("with no workspace Chief today's direct election stays", async () => {
    mocks.state = { ...mocks.state, bots: [bot("a"), bot("b")] };
    await act(async () => root.render(createElement(BotRoleControl, { bot: mocks.state.bots[1], canCoordinate: true })));
    await chooseRole("Chief of Staff");
    expect(currentChiefTransfer()).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "updateBot", botId: "b", patch: expect.objectContaining({ chiefOfStaff: true, chiefTier: "workspace" }) }));
  });

  it("W4 the reducer does not move the workspace tier on updateBot while a Chief exists", () => {
    const state = { ...mocks.state, selectedId: "a" } as never;
    const election = reducer(state, { type: "updateBot", botId: "b", patch: { chiefOfStaff: true, chiefTier: "workspace", individual: false } } as never) as { bots: any[] };
    expect(election.bots.find((b) => b.id === "a")).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
    expect(election.bots.find((b) => b.id === "b").chiefOfStaff).not.toBe(true);
    const demote = reducer(state, { type: "updateBot", botId: "a", patch: { chiefOfStaff: false, chiefTier: null, individual: false } } as never) as { bots: any[] };
    expect(demote.bots.find((b) => b.id === "a")).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
  });
});

describe("team-import undo pre-check", () => {
  it("an imported bot that now holds the workspace Chief role stops the undo before anything is deleted", () => {
    expect(routing!.undoTouchesChief(mocks.state.bots, ["a"])).toBe(true);
    expect(routing!.undoTouchesChief(mocks.state.bots, ["b"])).toBe(false);
    expect(routing!.undoTouchesChief([bot("a"), bot("b")], ["a"])).toBe(false);
  });
});


it("W19 Undo preflights the current Chief before deleting any imported routine or group", async () => {
  Object.assign(mocks.state, {
    groups: [], routines: [], routineRuns: [], selectedId: "a", config: {}, teamLibrary: { open: true },
  });
  mocks.api.mockResolvedValue({ bot: bot("a") });
  await act(async () => root.render(createElement(Sidebar, { open: true, onClose: vi.fn() })));
  await vi.waitFor(() => expect(texts()).toContain("Load fixture team"));
  await press("Load fixture team");
  await press("Undo");
  expect(mocks.api.mock.calls.filter(([, init]) => init?.method === "DELETE" || init?.method === "PATCH")).toEqual([]);
  expect(texts()).toContain("Choose a new Chief first. The imported Chief of Staff runs the workspace");
});
