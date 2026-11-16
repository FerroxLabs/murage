// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { nativeBannerLabels } from "./native-banner-labels.mjs";

const read = name => JSON.parse(readFileSync(new URL(`../src/locales/${name}.json`, import.meta.url), "utf8"));
const languages = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];

test("all eight native label packs match the renderer catalogue, without placeholders", () => {
  for (const code of languages) {
    const pack = read(code), labels = nativeBannerLabels(code);
    for (const action of ["allow", "deny", "reply"]) {
      const value = pack[`nativeBanner.${action}`];
      assert.equal(labels[action], value, `${code}:${action}`);
      assert.equal(typeof value, "string");
      assert.ok(value.length > 0);
      assert.doesNotMatch(value, /[{}\u2014]/u);
    }
  }
});

for (const action of ["allow", "deny", "reply"]) {
  test(`${action} translations record the English source hash`, () => {
    const key = `nativeBanner.${action}`;
    const expected = createHash("sha256").update(read("en")[key]).digest("hex");
    for (const code of languages.slice(1)) assert.equal(read("source-hashes").locales[code][key], expected, `${code}:${key}`);
  });
}

test("regional tags select translated words and unknown languages use English", () => {
  assert.deepEqual(nativeBannerLabels("de-DE"), nativeBannerLabels("de"));
  assert.deepEqual(nativeBannerLabels("pt_PT"), nativeBannerLabels("pt-br"));
  assert.deepEqual(nativeBannerLabels("zh-Hans-CN"), nativeBannerLabels("zh"));
  for (const tag of ["unknown", null, "__proto__"]) assert.deepEqual(nativeBannerLabels(tag), nativeBannerLabels("en"));
});
