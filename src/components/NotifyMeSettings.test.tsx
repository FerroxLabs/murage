// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { notifySurfaceDefaults } from "../../shared/notify-surfaces.mjs";
import { NotifyMeSettings } from "./NotifyMeSettings";
import { notifySurfacesBridge, type NotifyCapabilities, type NotifySurfacesBridge } from "@/lib/notify-surfaces";

vi.mock("@/lib/notify-surfaces", () => ({ notifySurfacesBridge: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [
  { id: "helper", name: "Helper" },
  { id: "chief", name: "Chief", chiefOfStaff: true, chiefScope: "workspace" },
  { id: "hidden", name: "Hidden", hidden: true },
] } }) }));

let root: Root, host: HTMLDivElement, prefs: ReturnType<typeof notifySurfaceDefaults>, caps: NotifyCapabilities & { trayHidden?: boolean };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  prefs = notifySurfaceDefaults("new", "darwin");
  caps = { platform: "darwin", session: null,
    surfaces: Object.fromEntries(Object.keys(prefs.surfaces).map(key => [key, { available: true }])) as NotifyCapabilities["surfaces"] };
  vi.mocked(notifySurfacesBridge).mockReturnValue({
    get: async () => prefs, capabilities: async () => ({ ...caps }), reset: async () => prefs,
    set: vi.fn(async (_key, value) => (prefs = { ...prefs, pinnedBotId: value as string })),
  } as NotifySurfacesBridge);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("explains a hidden Mac menu bar icon in the enabled row and clears the message once it is visible", async () => {
  const copy = "Your menu bar is full, so macOS is hiding Murage's icon. Hold Cmd and drag it left, or turn on the notch pill.";
  prefs.surfaces.tray = true;
  caps.trayHidden = true;
  await act(async () => root.render(<NotifyMeSettings />));
  const row = host.querySelector("#notify-me-tray")!.closest("li")!;
  expect(row.textContent).toContain(copy);
  expect(row.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  caps.trayHidden = false;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(row.textContent).not.toContain(copy);
});

it("asks for a pin inline, suggests the Chief, and saves only an explicit choice", async () => {
  prefs.surfaces.bubble = true;
  await act(async () => root.render(<NotifyMeSettings />));
  const row = host.querySelector("#notify-me-bubble")!.closest("li")!;
  const chooser = row.querySelector("select")!;
  expect(row.textContent).toContain("Pick a bot to pin");
  expect([...chooser.options].map(option => option.value)).toEqual(["helper", "chief"]);
  expect(chooser.value).toBe("chief");
  const bridge = notifySurfacesBridge()!;
  expect(bridge.set).not.toHaveBeenCalled();
  await act(async () => {
    chooser.value = "helper";
    chooser.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(bridge.set).not.toHaveBeenCalled();
  await act(async () => row.querySelector<HTMLButtonElement>('button[type="button"]:not([role="switch"])')!.click());
  expect(bridge.set).toHaveBeenCalledExactlyOnceWith("pinnedBotId", "helper");
  expect(row.textContent).not.toContain("Pick a bot to pin");
});
