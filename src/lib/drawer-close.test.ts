// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { closedDrawerInert, drawerCloseKey, focusLeavesClosedDrawer } from "./drawer-close";
import { initialState, reducer, type Action, type AppState } from "@/state/store";
import { openInboxLink } from "./open-inbox-link";

// The Inbox switches the task over HTTP itself, then reports it
// (taskSwitched) and selects; it never dispatches switchTask.
const inboxApi = vi.hoisted(() => ({ reply: {} as unknown }));
vi.mock("@/state/store", async (actual) => ({ ...(await actual<typeof import("@/state/store")>()), api: async () => inboxApi.reply }));

const base = { ...initialState, selectedId: "chief", activeView: "chat", pluginsOpen: false, settingsOpen: false, bots: [{ id: "chief", threadId: "main" }], groups: [] } as never;

describe("the phone drawer closes when a conversation is picked", () => {
  it("counts the Inbox opening another conversation of the selected bot (0.1.61 audit)", async () => {
    const chief = { id: "chief", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "channel-request" }] };
    let state = { ...initialState, selectedId: "chief", activeView: "chat", bots: [chief] } as unknown as AppState;
    inboxApi.reply = { bot: { ...chief, threadId: "channel-request" } };
    const before = drawerCloseKey(state);
    await openInboxLink({ threadId: "channel-request" }, state, (action: Action) => { state = reducer(state, action); });
    expect(drawerCloseKey(state)).not.toBe(before);
  });

  it("counts another conversation of the same selected bot as a pick", () => {
    // The Inbox opens a request by switching the selected Chief's task.
    const switched = reducer(base, { type: "switchTask", botId: "chief", threadId: "channel-request" });
    expect(drawerCloseKey(switched)).not.toBe(drawerCloseKey(base));
    expect(drawerCloseKey(reducer(base, { type: "switchGroupTask", groupId: "room", threadId: "t2" }))).not.toBe(drawerCloseKey(base));
    expect(drawerCloseKey(reducer(base, { type: "newTask", botId: "chief" }))).not.toBe(drawerCloseKey(base));
    expect(drawerCloseKey({ ...(base as object) } as never)).toBe(drawerCloseKey(base));
  });

  // Another surface switching or deleting the open task moves the thread
  // with nobody touching this phone: the drawer the person has open stays.
  // Hydration settles which conversation is selected a moment after load; a
  // drawer opened in that moment stayed shut (b35 on a phone, 0.1.61). A
  // selected bot deleted elsewhere moves the selection the same way.
  it("does not count the selection the app settles by itself", () => {
    // Built through the reducer's own hydrate, the way the app settles it.
    const loading = { ...initialState, activeView: "chat" } as AppState;
    const settled = reducer(loading, { type: "hydrate", bots: [{ id: "chief", threadId: "main", messages: [] }] as never, groups: [], computerControl: {} });
    expect(settled.selectedId).toBe("chief");
    expect(drawerCloseKey(settled)).toBe(drawerCloseKey(loading));
    expect(drawerCloseKey(reducer(base, { type: "select", id: "chief" }))).not.toBe(drawerCloseKey(base));
    expect(drawerCloseKey(reducer(base, { type: "botAdded", bot: { id: "new", threadId: "t", messages: [] } } as never))).not.toBe(drawerCloseKey(base));
  });

  it("does not count a thread change nobody asked for here", () => {
    const moved = { ...(base as object), bots: [{ id: "chief", threadId: "remote-switch" }] } as never;
    expect(drawerCloseKey(moved)).toBe(drawerCloseKey(base));
  });

  it("counts App settings opening over the chat, like bot settings", () => {
    const opened = { ...(base as object), appSettingsOpen: true } as never;
    expect(drawerCloseKey(opened)).not.toBe(drawerCloseKey({ ...(base as object), appSettingsOpen: false } as never));
  });

  it("is what App closes the drawer on", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/setDrawerOpen\(false\);\n  \}, \[closeKey\]\);/);
  });
});

// A closed phone drawer is off screen, but its buttons were still reachable
// with Tab and announced by a screen reader (0.1.61 CI audit, Low). On the
// desktop the sidebar is always there and never inert.
describe("the closed phone drawer is out of reach", () => {
  it("is inert only when closed below md", () => {
    expect(closedDrawerInert(true, false)).toBe(true);
    expect(closedDrawerInert(true, true)).toBe(false);
    expect(closedDrawerInert(false, false)).toBe(false);
  });

  // Picking a row or opening something closes the drawer from an effect, not
  // from its own close; focus was left on a control that is now off screen.
  it("hands focus back only when the drawer held it as it closed", () => {
    expect(focusLeavesClosedDrawer(true, false, true)).toBe(true);
    expect(focusLeavesClosedDrawer(true, false, false)).toBe(false);
    expect(focusLeavesClosedDrawer(false, false, true)).toBe(false);
    expect(focusLeavesClosedDrawer(true, true, true)).toBe(false);
  });

  it("is wired into the sidebar and back to the menu button", () => {
    const sidebar = readFileSync(fileURLToPath(new URL("../components/Sidebar.tsx", import.meta.url)), "utf8");
    expect(sidebar).toContain("inert={closedDrawerInert(narrow, open) || undefined}");
    expect(sidebar).toContain("focusLeavesClosedDrawer(wasOpen.current, open,");
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    // The menu button lives in each view's header now (OpenBotListButton.tsx,
    // mobile/v1); App hands the return to the drawer hook, which focuses the
    // button on screen or the one the next view mounts.
    expect(app).toContain("onReturnFocus={returnDrawerFocus}");
    const button = readFileSync(fileURLToPath(new URL("../components/OpenBotListButton.tsx", import.meta.url)), "utf8");
    const hook = button.slice(button.indexOf("const returnDrawerFocus = useCallback("), button.indexOf("return { drawerOpen, setDrawerOpen, closeDrawer, returnDrawerFocus, control };"));
    expect(hook).toContain("returnFocus.current = true;");
    expect(hook).toContain("buttonRef.current?.focus();");
  });
});
