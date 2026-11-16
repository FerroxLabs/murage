// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// THE LOCKUP WITH THE REAL EMBER (C8, real avatar). The welcome's tests elsewhere swap the avatar for a stub; this one
// keeps the real component and watches what it draws. With the face pinned and the body held still, a finished lockup
// draws the same picture a second later and three seconds later: nothing drifts, nothing loops.

import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { MurageLockup } from "./MurageLockup";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); document.body.replaceChildren(); });

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const drawing = (container: HTMLElement) => (container.querySelector(".murage-lockup-ember svg")?.innerHTML ?? "").replace(/\s+/g, " ");

it("C8b a finished lockup with the real Ember draws the same picture over time (no drift, no loop)", async () => {
  document.documentElement.dataset.skin = "dark";
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  const view = mount(createElement(MurageLockup, { mode: "static" }));
  await settle();
  await pause(300);
  const first = drawing(view.container);
  expect(first.length).toBeGreaterThan(500);
  await pause(1500);
  expect(drawing(view.container)).toBe(first);
  await pause(1500);
  expect(drawing(view.container)).toBe(first);
}, 15_000);
