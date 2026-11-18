// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S5: the chooser and Notify me logic (no DOM in the renderer suite), plus source and copy contracts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import { chooserRows, initialPicks, keepInside, osFamily, saveChooser, surfacesOnCount } from "./notify-chooser";
import type { NotifyCapabilities, NotifySurfaces, NotifySurfacesBridge } from "./notify-surfaces";

const IDS = ["notify", "receipt", "tray", "pill", "badge", "bubble", "dock", "shortcut"] as const;
const E = en as Record<string, string>;
const caps = (platform: string, over: Record<string, { available: boolean; reason?: any }> = {}): NotifyCapabilities =>
  ({ platform, session: platform === "linux" ? "x11" : null, surfaces: { ...Object.fromEntries(IDS.map(id => [id, { available: true }])), ...over } as any });
const state = (platform: string): NotifySurfaces => ({
  v: 1, origin: "new", chooser: "unseen", notifyActions: true, quietSummary: true, badgeMenu: true, badgeCount: "needs-you", receiptMinMinutes: 2, nudgeMinutes: 5,
  hideFullscreen: true, respectFocus: true, pinnedBotId: null, shortcut: null, asks: { backgroundApproval: false, longJob: false },
  surfaces: { notify: true, receipt: true, tray: platform !== "darwin", pill: platform === "darwin", badge: true, bubble: false, dock: false, shortcut: false },
} as unknown as NotifySurfaces);
const fakeBridge = (platform: string) => {
  const calls: Array<[string, unknown]> = [];
  const bridge = { get: async () => state(platform), set: vi.fn(async (k: string, v: unknown) => { calls.push([k, v]); return state(platform); }), reset: async () => state(platform),
    capabilities: async () => caps(platform), ensurePermission: vi.fn(async () => ({ authorized: true })) } as unknown as NotifySurfacesBridge & { ensurePermission: ReturnType<typeof vi.fn> };
  return { bridge, calls };
};

describe("chooser rows", () => {
  it("names each row for the OS, and shows the pill row on a Mac only", () => {
    const mac = chooserRows(caps("darwin")), win = chooserRows(caps("win32")), linux = chooserRows(caps("linux"));
    expect(mac.map(r => r.id)).toEqual([...IDS]);
    expect(win.map(r => r.id)).not.toContain("pill"); expect(linux.map(r => r.id)).not.toContain("pill");
    expect(E[mac.find(r => r.id === "tray")!.label]).toBe("Menu bar popover");
    expect(E[win.find(r => r.id === "tray")!.label]).toBe("Tray flyout");
    expect(E[linux.find(r => r.id === "tray")!.label]).toBe("Tray popup");
    expect(E[win.find(r => r.id === "notify")!.label]).toBe("Toasts");
    expect(E[win.find(r => r.id === "badge")!.label]).toBe("Taskbar badge and jump list");
    expect(osFamily("darwin")).toBe("mac"); expect(osFamily("win32")).toBe("windows"); expect(osFamily("freebsd")).toBe("linux");
  });
  it("ticks this computer's defaults, never the shortcut, never what it cannot do, with the reason", () => {
    const rows = chooserRows(caps("linux", { bubble: { available: false, reason: "wayland" }, tray: { available: false, reason: "no-tray-host" } }));
    const picks = initialPicks(state("linux"), rows);
    expect(picks).toMatchObject({ notify: true, receipt: true, badge: true, tray: false, shortcut: false, bubble: false });
    expect(rows.find(r => r.id === "bubble")).toMatchObject({ available: false, reason: "notifyChooser.reason.wayland" });
    expect(rows.find(r => r.id === "tray")).toMatchObject({ available: false, reason: "notifyChooser.reason.noTrayHost" });
    expect(rows.find(r => r.id === "shortcut")!.needsSettings).toBe(true);
    expect(initialPicks(state("darwin"), chooserRows(caps("darwin")))).toMatchObject({ pill: true, tray: false, notify: true });
    expect(initialPicks(state("win32"), chooserRows(caps("win32")))).toMatchObject({ tray: true });
  });
  it("counts N of 8 over the rows this computer can run", () => {
    expect(surfacesOnCount(state("win32"), caps("win32"))).toEqual({ on: 4, of: 8 });
    expect(surfacesOnCount(state("linux"), caps("linux", { tray: { available: false, reason: "no-tray-host" } }))).toEqual({ on: 3, of: 8 });
  });
});

describe("Continue and Keep inside", () => {
  it("Continue saves one key per row plus the chooser state, then asks the Mac for permission last", async () => {
    const { bridge, calls } = fakeBridge("darwin");
    const rows = chooserRows(await bridge.capabilities()), picks = { ...initialPicks(await bridge.get(), rows), badge: false };
    const result = await saveChooser({ bridge, platform: "darwin" }, rows, picks);
    expect(result).toEqual({ outcome: "saved" });
    expect(calls.at(-1)).toEqual(["chooser", "done"]);
    expect(calls).toContainEqual(["surfaces.badge", false]); expect(calls).toContainEqual(["surfaces.notify", true]);
    expect(calls.find(([k]) => k === "surfaces.shortcut")).toBeUndefined();
    expect((bridge as any).ensurePermission).toHaveBeenCalledTimes(1);
    expect(((bridge as any).ensurePermission.mock.invocationCallOrder[0])).toBeGreaterThan((bridge.set as any).mock.invocationCallOrder.at(-1));
  });
  it("Windows and Linux never ask for a system permission", async () => {
    for (const platform of ["win32", "linux"]) {
      const { bridge } = fakeBridge(platform);
      const rows = chooserRows(await bridge.capabilities());
      await saveChooser({ bridge, platform }, rows, initialPicks(await bridge.get(), rows));
      expect((bridge as any).ensurePermission).not.toHaveBeenCalled();
    }
  });
  it("a Mac with notify and pill both unticked does not ask", async () => {
    const { bridge } = fakeBridge("darwin");
    const rows = chooserRows(await bridge.capabilities());
    await saveChooser({ bridge, platform: "darwin" }, rows, { ...initialPicks(await bridge.get(), rows), notify: false, pill: false });
    expect((bridge as any).ensurePermission).not.toHaveBeenCalled();
  });
  it("a refused or failing permission prompt still counts as saved", async () => {
    const { bridge } = fakeBridge("darwin");
    (bridge as any).ensurePermission.mockRejectedValueOnce(new Error("denied"));
    const rows = chooserRows(await bridge.capabilities());
    await expect(saveChooser({ bridge, platform: "darwin" }, rows, initialPicks(await bridge.get(), rows))).resolves.toEqual({ outcome: "saved" });
  });
  it("a failed save rejects so the card can say so, and the chooser state is not marked done", async () => {
    const { bridge, calls } = fakeBridge("linux");
    (bridge.set as any).mockRejectedValueOnce(new Error("disk"));
    const rows = chooserRows(await bridge.capabilities());
    await expect(saveChooser({ bridge, platform: "linux" }, rows, initialPicks(await bridge.get(), rows))).rejects.toThrow();
    expect(calls.find(([k]) => k === "chooser")).toBeUndefined();
  });
  it("Keep inside saves every row off, marks kept-inside, and never asks for permission", async () => {
    const { bridge, calls } = fakeBridge("darwin");
    const rows = chooserRows(await bridge.capabilities());
    expect(await keepInside({ bridge, platform: "darwin" }, rows)).toEqual({ outcome: "kept-inside" });
    for (const row of rows.filter(r => !r.needsSettings)) expect(calls).toContainEqual([`surfaces.${row.id}`, false]);
    expect(calls.some(([, v]) => v === true)).toBe(false);
    expect(calls.at(-1)).toEqual(["chooser", "kept-inside"]);
    expect((bridge as any).ensurePermission).not.toHaveBeenCalled();
  });
});

describe("component contracts (source, the renderer suite has no DOM)", () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
  const chooser = read("NotifyChooser.tsx"), settings = read("NotifyMeSettings.tsx"), page = read("NotificationSettings.tsx");
  it("NotifyChooser keeps the exact contract FR19b depends on", () => {
    expect(chooser).toMatch(/export interface NotifyChooserProps \{\s*onDone: \(result: ChooserOutcome\) => void;\s*onError\?: \(message: string\) => void;\s*\}/);
    expect(chooser).toContain("export function NotifyChooser({ onDone, onError }: NotifyChooserProps)");
    expect(readFileSync(fileURLToPath(new URL("./notify-chooser.ts", import.meta.url)), "utf8")).toContain('export type ChooserOutcome = { outcome: "saved" | "kept-inside" };');
    expect(readFileSync(fileURLToPath(new URL("./notify-surfaces.ts", import.meta.url)), "utf8")).toContain("export async function shouldShowNotifyChooser");
  });
  it("renders nothing without the desktop bridge, has no timers and no animation loops", () => {
    for (const source of [chooser, settings]) { expect(source).toContain("if (!bridge"); expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|animate-/); }
  });
  it("every checkbox and switch is labelled, and Settings is folded into the notifications page", () => {
    expect(chooser).toContain('htmlFor={id}'); expect(chooser).toContain("aria-describedby");
    expect(settings).toContain("aria-labelledby={id}");
    expect(page).toContain("<NotifyMeSettings />");
  });
  it("the Mac permission prompt is requested inside the Continue click, through the saved-then-ensure order", () => {
    expect(chooser).toContain("onClick={() => void run(() => saveChooser(deps, rows, picks))}");
  });
});

describe("chooser and Notify me copy", () => {
  const keys = Object.keys(en).filter(key => key.startsWith("notifyChooser.") || key.startsWith("notifyMe."));
  it("has the strings and keeps to the house words: no em dash, no spaced en dash, never safe or free", () => {
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) {
      const text = (en as Record<string, string>)[key]!;
      expect(text, key).not.toMatch(/—| – /); expect(text, key).not.toMatch(/\b(safe|safely|safety|unsafe|free)\b/i); expect(text, key).not.toMatch(/\bForge\b/);
    }
  });
  it("carries the board copy fixes", () => {
    expect(E["notifyChooser.suits"]).toBe("The ones that suit {osName} are ticked.");
    expect(E["notifyChooser.notify.note"]).toBe("Allow, Deny or Reply right on the banner for short commands.");
    expect(E["notifyChooser.linuxLockNote"]).toBe("The buttons need this desktop to report its lock state.");
    expect(E["notifyChooser.sharingLine"]).toBe("Murage hides its own windows while you share your screen in the apps it can detect.");
    expect(E["notifyChooser.keepInside"]).toBe("Keep everything inside Murage for now");
    expect(E["notifyMe.badgeMenu.help"]).toMatch(/Pause automations/); expect(JSON.stringify(en)).not.toMatch(/Pause all bots.*notifyMe/);
    expect(E["notifyMe.finishedOff"]).toBe("Notifications for finished jobs are off. Turn on Task completed to get receipts.");
  });
});
