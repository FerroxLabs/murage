// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PinToEdgeMenuItem } from "./PinToEdgeMenuItem";
import { notifySurfacesBridge, type NotifyCapabilities, type NotifySurfacesBridge } from "@/lib/notify-surfaces";
import { notifySurfaceDefaults } from "../../shared/notify-surfaces.mjs";
import { setLocale, t } from "@/lib/i18n";

vi.mock("@/lib/notify-surfaces", () => ({ notifySurfacesBridge: vi.fn() }));
let root: Root, container: HTMLDivElement, bridge: NotifySurfacesBridge, cap: NotifyCapabilities;
let onPinned: ReturnType<typeof vi.fn<() => void>>, onError: ReturnType<typeof vi.fn<(message: string) => void>>;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en");
  let state = notifySurfaceDefaults("new", "linux");
  cap = { platform: "linux", session: "x11", surfaces: Object.fromEntries(Object.keys(state.surfaces).map(key => [key, { available: true }])) as NotifyCapabilities["surfaces"] };
  bridge = { get: vi.fn(async () => state), reset: vi.fn(async () => state), capabilities: vi.fn(async () => cap),
    set: vi.fn(async (key: string, value: unknown) => {
      state = key === "pinnedBotId" ? { ...state, pinnedBotId: value as string } : { ...state, surfaces: { ...state.surfaces, bubble: value === true } };
      return state;
    }) } as NotifySurfacesBridge;
  vi.mocked(notifySurfacesBridge).mockReturnValue(bridge); onPinned = vi.fn<() => void>(); onError = vi.fn<(message: string) => void>();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
const mount = async () => { await act(async () => root.render(<PinToEdgeMenuItem botId="alpha" onPinned={onPinned} onError={onError} />)); };
const click = async () => { await act(async () => { container.querySelector("button")!.click(); }); };
it("pins the chosen bot before enabling the bubble, writes only through notify-surfaces, and closes once", async () => {
  await mount(); expect(container.querySelector('[role="menuitem"]')!.textContent).toBe(t("float.pin"));
  await act(async () => { container.querySelector("button")!.click(); container.querySelector("button")!.click(); });
  expect(vi.mocked(bridge.set).mock.calls).toEqual([["pinnedBotId", "alpha"], ["surfaces.bubble", true]]);
  expect(onPinned).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
});
it.each(["wayland", null] as const)("does not offer pinning in Linux session %s", async session => {
  cap.session = session; await mount(); expect(container.querySelector("button")).toBeNull(); expect(bridge.set).not.toHaveBeenCalled();
});
it("web and an unavailable capability render no item", async () => {
  vi.mocked(notifySurfacesBridge).mockReturnValue(null); await mount(); expect(container.querySelector("button")).toBeNull();
  await act(async () => root.render(null)); vi.mocked(notifySurfacesBridge).mockReturnValue(bridge); cap.surfaces.bubble.available = false;
  await mount(); expect(container.querySelector("button")).toBeNull();
});
it("rechecks capability at the click boundary and does not write after a change to Wayland", async () => {
  await mount(); cap.session = "wayland"; await click(); expect(bridge.set).not.toHaveBeenCalled(); expect(onPinned).not.toHaveBeenCalled();
});
it("a failed pin does not enable the surface or close the menu and reports translated copy", async () => {
  bridge.set = vi.fn(async () => { throw Error("write"); }); await mount(); await click();
  expect(bridge.set).toHaveBeenCalledExactlyOnceWith("pinnedBotId", "alpha"); expect(onPinned).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledExactlyOnceWith(t("float.pinError"));
});
