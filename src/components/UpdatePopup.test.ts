// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bottom-left update pop-up: it shows the download with no click, stays out of the owner's way, and keeps the special
// paths' words and buttons.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "../types/muragebox";

const current = vi.hoisted(() => ({ value: null as UpdaterState | null }));
const following = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => current.value }));
// Static rendering runs no effects, so a state that only follows a download (an error) needs the latch set for it.
vi.mock("@/lib/update-card", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/update-card")>();
  return { ...real, useUpdatePopup: (state: UpdaterState | null) => following.value || real.useUpdatePopup(state) };
});
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => { vi.unstubAllGlobals(); current.value = null; following.value = false; });

const popup = (state: UpdaterState) => {
  vi.stubGlobal("window", { muragebox: { updater: {} } });
  current.value = state;
  return renderToStaticMarkup(createElement(UpdateBanner));
};

it("shows status and percent with no click, and no scrim or dialog", () => {
  const html = popup({ status: "downloading", version: "1.0.12", percent: 42 });
  expect(html).toContain('data-testid="update-popup"');
  expect(html).toContain("Downloading 1.0.12");
  expect(html).toContain("42%");
  expect(html).toContain('role="status"');
  expect(html).toContain("width:42%");
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("bg-black/40");
  expect(html).not.toContain("update-card-layer");
  expect(html).not.toContain("tabindex");
});

it("reads the percent out in tens, not on every tick", () => {
  const html = popup({ status: "downloading", version: "1.0.12", percent: 47 });
  expect(html).toContain('<span class="sr-only">40%</span>');
  expect(html).toContain('aria-hidden="true"');
});

it("an error with no download behind it stays on the round button", () => {
  expect(popup({ status: "error", message: "offline" })).toBe("");
});

it("a download can be closed, unlike the old card", () => {
  expect(popup({ status: "downloading", version: "1.0.12", percent: 10 })).toContain('aria-label="Dismiss"');
});

it("keeps Restart when the update is ready", () => {
  popup({ status: "downloading", version: "1.0.12" });
  const html = popup({ status: "downloaded", version: "1.0.12", installMode: "restart" });
  expect(html).toContain("Restart to finish updating");
  expect(html).toContain("Restart to update");
});

it("deferred backup keeps its words and offers no action", () => {
  const html = popup({ status: "deferred", version: "1.0.12", message: "PRIVATE_CANARY" });
  expect(html).toContain("waiting for the pre-upgrade backup flow");
  expect(html).not.toContain("PRIVATE_");
  expect(html).not.toMatch(/>Install<|>Download<|>Try again<|Restart to update/);
});

it("handed-off keeps the command and Done", () => {
  const html = popup({ status: "handed-off", version: "1.0.12", command: "sudo apt install ./murage.deb", terminalOpened: true });
  expect(html).toContain("Finish in a terminal");
  expect(html).toContain("sudo apt install ./murage.deb");
  expect(html).toContain("Done");
});

it("verification refused keeps one line and the website download", () => {
  following.value = true;
  const html = popup({ status: "error", version: "1.0.12", message: "PRIVATE_DIAGNOSTIC", action: "download-from-murage" });
  expect(html).toContain("This update could not be verified, so Murage did not install it.");
  expect(html).toContain("Download from murage.ai");
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("PRIVATE_DIAGNOSTIC");
  expect(html).not.toContain("Try again");
});

it("renders nothing with no bridge: the phone app and the browser", () => {
  vi.stubGlobal("window", {});
  current.value = null;
  expect(renderToStaticMarkup(createElement(UpdateBanner))).toBe("");
});

it("takes no focus: outside the centred card, focus only moves when a keyboard inside closes the pop-up", () => {
  const source = readFileSync(new URL("./UpdateBanner.tsx", import.meta.url), "utf8");
  const frame = source.slice(source.indexOf("function UpdatePopup("), source.indexOf("function updateTitle("));
  expect(frame).not.toMatch(/autoFocus|tabIndex/);
  expect(frame.match(/\.focus\(/g)).toHaveLength(1);
  expect(frame).toMatch(/if \(held\) document\.querySelector<HTMLElement>\([^)]*\)\?\.focus\(\)/);
  expect(source.slice(source.indexOf("function UpdateCardBody(")).match(/\.focus\(|autoFocus/)).toBeNull();
});

it("sits under dialogs and the Undo toast, and the card hands a download over", () => {
  const source = readFileSync(new URL("./UpdateBanner.tsx", import.meta.url), "utf8");
  expect(source).toContain("fixed z-40");
  expect(source).toContain('const cardShows = cardOpen && status !== "downloading"');
  expect(readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8")).toContain('if (status === "downloading") return showUpdatePopup();');
  expect(readFileSync(new URL("./UpdateIndicator.tsx", import.meta.url), "utf8")).toContain('s.status === "downloading" ? showUpdatePopup : openUpdateCard');
});
