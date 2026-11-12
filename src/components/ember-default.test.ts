// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// C1 (part 2): the bundled default Ember face is one serialised render of the real EmberAvatar (orange, default body,
// resting face). It is regenerated here from the component and compared, so it cannot drift from the component.
// `EMBER_DEFAULT_OUT=<file> vitest run src/components/ember-default.test.ts` writes the fresh serialisation to <file>
// (used once to commit src/assets/brand/ember-default.svg and the constant in shared/murage-lockup.mjs).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterAll, beforeAll, expect, it } from "vitest";

import { cleanup, frame, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { EMBER_DEFAULT_SVG } from "../../shared/murage-lockup.mjs";
import { EmberAvatar } from "./Avatar";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());

/** The component's own drawing as a standalone SVG: namespace set, ids made stable, no animation state. */
export async function renderDefaultEmber(): Promise<string> {
  const view = mount(createElement(EmberAvatar, { color: "orange", size: 64, state: "idle", animated: false, trackPointer: false, bodyMotion: 0, lookAround: 0 }));
  await settle();
  await frame();
  await frame();
  const svg = view.container.querySelector("svg");
  if (!svg) throw new Error("EmberAvatar drew no svg");
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  let markup = clone.outerHTML;
  const ids = [...new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))];
  ids.forEach((id, index) => {
    const stable = `ember-default-${index}`;
    markup = markup.split(`"${id}"`).join(`"${stable}"`).split(`#${id}`).join(`#${stable}`).split(`url(${id})`).join(`url(${stable})`);
  });
  cleanup();
  return markup;
}

it("C1b the bundled default Ember face is exactly what the real component draws", async () => {
  const fresh = await renderDefaultEmber();
  if (process.env.EMBER_DEFAULT_OUT) writeFileSync(process.env.EMBER_DEFAULT_OUT, fresh);
  expect(fresh.length).toBeGreaterThan(200);
  expect(EMBER_DEFAULT_SVG).toBe(fresh);
  const file = readFileSync(join(process.cwd(), "src/assets/brand/ember-default.svg"), "utf8").trim();
  expect(file).toBe(fresh);
});
