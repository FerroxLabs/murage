// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BADGE_SURFACE_KEYS, badgeSurfaceText } from "./badge-surface-copy.mjs";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const catalogue = locale => JSON.parse(read(`../src/locales/${locale}.json`));
const locales = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
const en = catalogue("en");

test("native labels mirror all eight renderer catalogues with matching placeholders and plain copy", () => {
  for (const locale of locales) {
    const pack = catalogue(locale);
    for (const key of BADGE_SURFACE_KEYS) {
      assert.equal(badgeSurfaceText(locale, key), pack[key], `${locale}:${key}`);
      assert.deepEqual(pack[key].match(/\{\w+\}/g), en[key].match(/\{\w+\}/g));
      assert.doesNotMatch(pack[key], /\u2014|\b(?:safe|free|Forge|Composio)\b/i);
      if (locale !== "en") assert.notEqual(pack[key], en[key]);
    }
    assert.equal(badgeSurfaceText(locale, "badgeSurfaces.needsYouCount", { count: 7 }), pack["badgeSurfaces.needsYouCount"].replace("{count}", "7"));
  }
  assert.equal(badgeSurfaceText("unknown", "badgeSurfaces.newChief"), en["badgeSurfaces.newChief"]);
});

test("each translation records the English source hash", () => {
  const hashes = JSON.parse(read("../src/locales/source-hashes.json"));
  const expected = Object.fromEntries(BADGE_SURFACE_KEYS.map(key => [key, createHash("sha256").update(en[key]).digest("hex")]));
  for (const locale of locales.slice(1)) {
    assert.deepEqual(Object.fromEntries(BADGE_SURFACE_KEYS.map(key => [key, hashes.locales[locale][key]])), expected, locale);
  }
});

test("Linux desktop actions carry the same ids, labels and translations as the native menus", () => {
  const config = read("../electron-builder.yml");
  const desktop = config.slice(config.indexOf("  desktop:\n"), config.indexOf("\ndeb:"));
  assert.match(desktop, /    entry:[\s\S]*      Actions: new-chief;needs-you;pause;/);
  assert.match(desktop, /\n    desktopActions:\n/);
  for (const [index, id] of ["new-chief", "needs-you", "pause"].entries()) {
    const action = desktop.split(`      ${id}:\n`)[1].split(/\n      [a-z-]+:/)[0];
    assert.ok(action.includes(`        Name: ${en[BADGE_SURFACE_KEYS[index]]}\n`));
    for (const locale of locales.slice(1)) {
      const tag = locale === "pt-br" ? "pt_BR" : locale;
      assert.ok(action.includes(`        "Name[${tag}]": ${JSON.stringify(catalogue(locale)[BADGE_SURFACE_KEYS[index]])}`));
    }
  }
  // Commands depend on the artifact target; the packaging hook generates them.
  assert.equal((desktop.match(/        Exec:/g) ?? []).length, 0);
});
