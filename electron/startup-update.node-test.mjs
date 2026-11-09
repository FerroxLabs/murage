// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice E: the update screen and the memory-upgrade restyle (tests E2, E4, E5, E7).
// E1 (the update layout) and E6 (closing during an upgrade still quits) are pinned in startup-splash.node-test.mjs and
// memory-upgrade-status.node-test.mjs / update-start-gate.node-test.mjs; E3 (What's new delivery) is src/lib/whats-new-startup.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { STARTUP_TEXT, splashPage } from "./startup-splash.mjs";
import { UPGRADE_TEXT } from "./upgrade-screen.mjs";
import { EMBER_DEFAULT_SVG, lockupSvg } from "../shared/murage-lockup.mjs";

const page = (options) => decodeURIComponent(splashPage(options).split(",").slice(1).join(","));
const LANGUAGES = ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"];

test("E2 the note is in all 8 shipped languages and never on a brand-new install", () => {
  assert.deepEqual(Object.keys(STARTUP_TEXT).sort(), [...LANGUAGES].sort());
  for (const language of LANGUAGES) {
    const words = STARTUP_TEXT[language];
    assert.ok(typeof words.note === "string" && words.note.length > 0, `${language} has the note`);
    assert.ok(page({ mode: "update", version: "1.0.19", language }).includes(words.note), `${language} update screen says it`);
    if (language !== "en") assert.notEqual(words.note, STARTUP_TEXT.en.note, `${language} is translated`);
    for (const mode of ["first", "tip"]) {
      assert.ok(!page({ mode, language, note: "", version: "1.0.19" }).includes(`>${words.note}<`), `${language} ${mode} start never carries the update note`);
    }
  }
});

test("E4 the upgrade view keeps the shipped words and controls, and only gains the calm look", () => {
  // every word on the memory-upgrade screen stays in upgrade-screen.mjs; the splash page defines none of them
  const html = page({ mode: "update", picture: null, version: "1.0.19", language: "en" });
  for (const key of ["title", "footer", "minimize", "quit", "quit.note", "wait", "keep"]) {
    assert.ok(typeof UPGRADE_TEXT.en[key] === "string" && UPGRADE_TEXT.en[key].length > 0, `UPGRADE_TEXT.en.${key} is still there`);
    assert.ok(!html.includes(UPGRADE_TEXT.en[key]), `the splash page does not restate "${key}"`);
  }
  // the controls and the counters the shipped script writes into
  for (const id of ["min", "quit", "q", "c", "e", "f", "bar", "pb"]) assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  // the lockup at 44 px on top in the upgrade layout; minimise a pill and quit a text link
  assert.match(html, /<div class="hero upg" data-lockup="/);
  assert.match(html, /body\[data-layout=upgrade\] \.hero\.upg\{display:flex/);
  assert.match(html, /body\[data-layout=upgrade\] #min\{[^}]*border-radius:999px/);
  assert.match(html, /body\[data-layout=upgrade\] #quit\{[^}]*text-decoration:underline/);
  // the shipped page (no mode) is unchanged: no new hero
  assert.doesNotMatch(page({ language: "en", note: true }), /class="hero upg"/);
});

test("E5 finishing mode hides the controls (pinned)", () => {
  const html = page({ mode: "update", version: "1.0.19", language: "en" });
  assert.ok(html.includes("body[data-mode=finishing] .ctl,body[data-mode=finishing] .q{display:none}"));
});

test("E7 default lockup when no picture exists (the 1.0.18 to 1.0.19 update)", () => {
  const html = page({ mode: "update", picture: null, version: "1.0.19", language: "en" });
  assert.ok(html.includes("ember-default-0"), "the bundled Ember, not a saved face");
  assert.ok(EMBER_DEFAULT_SVG.includes("ember-default-0"));
  assert.ok(!html.includes("<image "), "no saved face is drawn");
});

test("a saved photo face (an svg holding one inline raster image) is drawn, and a refused face falls back to the bundled Ember", () => {
  const photo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><clipPath id="c"><circle cx="48" cy="48" r="48"/></clipPath></defs><g clip-path="url(#c)"><image href="data:image/png;base64,AAAA" x="0" y="0" width="96" height="96" preserveAspectRatio="none"/></g></svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(photo).toString("base64")}`;
  assert.doesNotThrow(() => lockupSvg({ size: 30, face: uri, ember: "static" }));
  assert.ok(lockupSvg({ size: 30, face: uri, ember: "static" }).includes(`href="${uri}"`));
  const external = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><image href="https://example.com/x.png" width="9" height="9"/></svg>`;
  assert.throws(() => lockupSvg({ size: 30, face: `data:image/svg+xml;base64,${Buffer.from(external).toString("base64")}`, ember: "static" }));
  const bad = { v: 1, tipNext: 1, faceA: external, faceB: external, at: 1, tip: { id: "search", head: "H", line: "l", try: "t" } };
  const html = page({ mode: "tip", picture: bad, language: "en" });
  assert.ok(html.includes("ember-default-0"), "the bundled Ember is drawn instead");
});
