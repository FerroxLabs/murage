// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { closePopupLatch, indicatorLabelKey, indicatorShows, nextPopupLatch, popupFocusReturn, popupVisible, subscribeUpdatePopupAnchor, updatePopupAnchor, updatePopupAnchorRef, updatePopupPlace, type UpdatePopupLatch } from "./update-card";
import type { UpdaterState } from "@/types/muragebox";

describe("update indicator state table", () => {
  it("shows for every actionable or in-flight state and hides for idle, checking and no bridge", () => {
    for (const status of ["available", "downloading", "downloaded", "installing", "deferred", "handed-off", "error"] as const) expect(indicatorShows(status)).toBe(true);
    for (const status of ["idle", "checking", undefined] as const) expect(indicatorShows(status)).toBe(false);
  });
  it("names the button by state", () => {
    expect(indicatorLabelKey("available")).toBe("updates.indicatorAvailable");
    expect(indicatorLabelKey("downloaded")).toBe("updates.indicatorReady");
    expect(indicatorLabelKey("error")).toBe("updates.indicatorProblem");
    expect(indicatorLabelKey("downloading")).toBe("updates.indicatorBusy");
  });
});

describe("update pop-up latch", () => {
  const start: UpdatePopupLatch = { following: false, closed: "no" };
  const run = (latch: UpdatePopupLatch, ...states: Array<[UpdaterState["status"], string?]>) =>
    states.reduce((next, [status, version]) => nextPopupLatch(next, { status, version }), latch);

  it("stays down for news and comes up by itself when a download starts", () => {
    const news = run(start, ["checking"], ["available", "1.0.12"]);
    expect(popupVisible(news, "available")).toBe(false);
    const started = run(news, ["downloading", "1.0.12"]);
    expect(popupVisible(started, "downloading")).toBe(true);
  });

  it("stays up through the rest of the update", () => {
    const latch = run(start, ["downloading", "1.0.12"]);
    for (const status of ["downloaded", "installing", "deferred", "handed-off", "error", "available"] as const) {
      expect(popupVisible(run(latch, [status, "1.0.12"]), status)).toBe(true);
    }
  });

  it("a failed check on its own never brings it up", () => {
    expect(popupVisible(run(start, ["error"]), "error")).toBe(false);
    expect(popupVisible(run(start, ["error", "1.0.12"]), "error")).toBe(false);
  });

  it("closed during a download it stays closed, and comes back once when the update is ready", () => {
    const closed = closePopupLatch(run(start, ["downloading", "1.0.12"]), "downloading");
    expect(closed.closed).toBe("during");
    const stillDown = run(closed, ["downloading", "1.0.12"], ["error", "1.0.12"], ["available", "1.0.12"], ["downloading", "1.0.12"]);
    expect(popupVisible(stillDown, "downloading")).toBe(false);
    const ready = run(stillDown, ["downloaded", "1.0.12"]);
    expect(popupVisible(ready, "downloaded")).toBe(true);
    const closedAgain = closePopupLatch(ready, "downloaded");
    expect(popupVisible(run(closedAgain, ["downloaded", "1.0.12"]), "downloaded")).toBe(false);
    expect(popupVisible(run(closedAgain, ["installing", "1.0.12"], ["deferred", "1.0.12"]), "deferred")).toBe(false);
  });

  it("a newer version starts fresh", () => {
    const closed = closePopupLatch(run(start, ["downloaded", "1.0.12"]), "downloaded");
    expect(popupVisible(run(closed, ["available", "1.0.13"]), "available")).toBe(false);
    expect(popupVisible(run(closed, ["available", "1.0.13"], ["downloading", "1.0.13"]), "downloading")).toBe(true);
  });

  it("a Later on the available card cannot hide the download that follows", () => {
    const later = closePopupLatch(run(start, ["available", "1.0.12"]), "available");
    expect(popupVisible(run(later, ["downloading", "1.0.12"]), "downloading")).toBe(true);
  });

  it("a remembered close holds when the window comes back, for that version only", () => {
    const remembered: UpdatePopupLatch = { following: false, version: "1.0.12", closed: "ready" };
    expect(popupVisible(run(remembered, ["downloaded", "1.0.12"]), "downloaded")).toBe(false);
    expect(popupVisible(run({ ...remembered, closed: "during" }, ["downloading", "1.0.12"]), "downloading")).toBe(false);
    expect(popupVisible(run({ ...remembered, closed: "during" }, ["downloaded", "1.0.12"]), "downloaded")).toBe(true);
  });

  it("returns the same latch when nothing changed, and shows nothing while checking or idle", () => {
    const latch = run(start, ["downloading", "1.0.12"]);
    expect(nextPopupLatch(latch, { status: "downloading" })).toBe(latch);
    expect(nextPopupLatch(latch, null)).toBe(latch);
    expect(popupVisible(latch, "checking")).toBe(false);
    expect(popupVisible(run(latch, ["idle"]), "idle")).toBe(false);
  });
});

describe("update pop-up place", () => {
  const screen = { viewportWidth: 1400, viewportHeight: 900, toastHeight: 0 };
  const sidebar = { left: 0, top: 832, width: 320 };

  it("sits inside the sidebar just above its footer", () => {
    expect(updatePopupPlace({ ...screen, footer: sidebar })).toEqual({ left: 12, width: 296, bottom: 76, maxHeight: 808 });
  });
  it("on the rail it clears the rail's taller footer and is wider than the rail", () => {
    const place = updatePopupPlace({ ...screen, viewportWidth: 900, footer: { left: 0, top: 700, width: 64 } });
    expect(place).toMatchObject({ left: 8, width: 300, bottom: 208 });
  });
  it("lifts clear of an Undo toast, and comes back down when it goes", () => {
    const place = updatePopupPlace({ ...screen, toastHeight: 96, footer: sidebar });
    expect(place.bottom).toBe(16 + 96 + 8);
  });
  it("hangs under the header in a narrow window, whatever the drawer is doing", () => {
    for (const footer of [null, sidebar]) {
      const place = updatePopupPlace({ ...screen, viewportWidth: 600, footer });
      expect(place.bottom).toBeUndefined();
      expect(place).toMatchObject({ left: 12, right: 12 });
      expect(place.top).toContain("56px");
    }
  });
  it("falls back to the corner when there is no sidebar", () => {
    expect(updatePopupPlace({ ...screen, footer: null })).toEqual({ left: 16, width: 300, bottom: 16, maxHeight: 868 });
  });
});

describe("the footer the pop-up sits above", () => {
  it("registers when the sidebar mounts (after the terms), and a replaced footer does not clear the new one", () => {
    const first = { id: "first" } as unknown as HTMLElement;
    const second = { id: "second" } as unknown as HTMLElement;
    const changes: unknown[] = [];
    const stop = subscribeUpdatePopupAnchor(() => changes.push(updatePopupAnchor()));
    expect(updatePopupAnchor()).toBeNull(); // the terms screen: no sidebar yet
    const dropFirst = updatePopupAnchorRef(first);
    expect(changes).toEqual([first]); // the pop-up hears it and measures again
    const dropSecond = updatePopupAnchorRef(second);
    dropFirst?.();
    expect(updatePopupAnchor()).toBe(second);
    expect(updatePopupAnchorRef(null)).toBeUndefined();
    dropSecond?.();
    expect(updatePopupAnchor()).toBeNull();
    expect(changes).toEqual([first, second, null]);
    stop();
  });
});

describe("focus after a keyboard closes the pop-up", () => {
  type El = { name: string; isConnected: boolean };
  const el = (name: string, isConnected = true): El => ({ name, isConnected });
  const popupButton = el("dismiss");
  const button = el("round button");
  const base = { inPopup: (e: El) => e === popupButton, button: () => button };

  it("inside an open window it never offers the inert sidebar: where it came from, then the window's controls, then the window", () => {
    const win = el("what's new");
    const close = el("close");
    const next = el("next");
    const outside = el("composer");
    const inHost = (e: El) => e === close || e === next || e === popupButton;
    // The origin first; if it turned disabled or hidden meanwhile, the caller's focus check moves on to the next.
    expect(popupFocusReturn({ ...base, host: win, origin: close, inHost, hostControls: () => [popupButton, close, next] })).toEqual([close, next, win]);
    expect(popupFocusReturn({ ...base, host: win, origin: outside, inHost, hostControls: () => [popupButton, close] })).toEqual([close, win]);
    expect(popupFocusReturn({ ...base, host: win, origin: null, inHost, hostControls: () => [popupButton] })).toEqual([win]);
    expect(popupFocusReturn({ ...base, host: win, origin: el("gone", false), inHost: () => true, hostControls: () => [] })).toEqual([win]);
    expect(popupFocusReturn({ ...base, host: win, origin: null, inHost, hostControls: () => [] })).not.toContain(button);
  });
  it("with no window open: where focus came from, then the round button", () => {
    const composer = el("composer");
    const none = { host: null, inHost: () => false, hostControls: () => [] };
    expect(popupFocusReturn({ ...base, ...none, origin: composer })).toEqual([composer, button]);
    expect(popupFocusReturn({ ...base, ...none, origin: null })).toEqual([button]);
    expect(popupFocusReturn({ ...base, ...none, origin: popupButton })).toEqual([button]);
    expect(popupFocusReturn({ ...base, ...none, origin: null, button: () => el("gone", false) })).toEqual([]);
  });
});

it("installer cards only open allow-listed release links",async()=>{
 const {installerOffer}=await import("./update-card");
 expect(installerOffer({status:"error",action:"download-installer",version:"1.0.18",downloadUrl:"https://attacker.example/evil.dmg"})?.url).toBe("https://github.com/FerroxLabs/murage-releases/releases/latest");
 expect(installerOffer({status:"downloaded",version:"1.0.18"})).toBe(null);
});
