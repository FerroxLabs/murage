// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE RECONNECT BAND NEVER DRAWS UNDER A MAC WINDOW'S OWN BUTTONS (1.0.20, owner
// report): the window insets its red, yellow and green buttons over the top-left
// corner (electron/window-chrome.mjs, hiddenInset), and the band at the top of the
// window put "HighLevel needs you to sign in again" right under them. On a Mac the
// band leaves their width free before any word and moves the window like the
// sidebar header; on Windows and Linux (native title bar) nothing changes. The
// real band is rendered, after the real line store holds an app, with the desktop
// shell's own platform bridge (hooks/use-window-drag.ts reads it).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({ api: vi.fn(async () => ({ apps: [], notifications: [] })), openNotificationTarget: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

import { publishReconnectApps, ReconnectAppsBanner, ReconnectAppsBannerView } from "./ReconnectAppsBanner";

const highlevel = { slug: "highlevel", label: "HighLevel", incidentId: "inc-hl", incidentIds: ["inc-hl"], accounts: [{ id: "hl" }] };
const onPlatform = (platform: string) => { vi.stubGlobal("window", { muragebox: { platform } }); };
const band = () => renderToStaticMarkup(createElement(ReconnectAppsBanner, { enabled: true }));
const opening = (html: string) => html.slice(0, html.indexOf(">") + 1);

beforeEach(async () => { await setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("MAC1 on a Mac the band leaves the window buttons' width free before its first word, and moves the window", () => {
  onPlatform("darwin");
  publishReconnectApps([highlevel]);
  const html = band();
  expect(opening(html)).toContain("data-reconnect-line");
  expect(opening(html)).toContain('data-window-drag=""');
  // the very first child of the band is the space, 68px wide and never shrunk
  expect(html.slice(opening(html).length)).toMatch(/^<div data-window-buttons-space="" aria-hidden="true" class="[^"]*\bw-\[68px\][^"]*\bshrink-0\b/);
  expect(html.indexOf("data-window-buttons-space")).toBeLessThan(html.indexOf("HighLevel needs you to sign in again"));
  // Reconnect, Later and the X stay buttons (styles.css turns them back into click targets inside a drag region)
  expect(html.match(/<button/g)?.length).toBe(3);
});

it.each(["win32", "linux"])("MAC2 on %s (native title bar) the band is unchanged: no space, no drag region", platform => {
  onPlatform(platform);
  publishReconnectApps([highlevel]);
  const html = band();
  expect(html).toContain("HighLevel needs you to sign in again");
  expect(html).not.toContain("data-window-buttons-space");
  expect(html).not.toContain("data-window-drag");
  expect(html.slice(opening(html).length)).toMatch(/^<svg/);
});

it("MAC3 Needs you hosts the same view inside the page, never at the window's top: it takes no window-button space", () => {
  onPlatform("darwin");
  const html = renderToStaticMarkup(createElement(ReconnectAppsBannerView, { apps: [highlevel], busy: null, onReconnect: () => {} }));
  expect(html).not.toContain("data-window-buttons-space");
  expect(html).not.toContain("data-window-drag");
});
