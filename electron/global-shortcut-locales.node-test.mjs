// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = name => JSON.parse(readFileSync(new URL(`../src/locales/${name}.json`, import.meta.url), "utf8"));
const en = read("en"), hashes = read("source-hashes");
const keys = Object.keys(en).filter(key => key.startsWith("notifyMe.shortcut."));
test("shortcut copy has matching translations, placeholders and source hashes in all eight catalogues", () => {
  assert.equal(keys.length, 9);
  const expectedHashes = Object.fromEntries(keys.map(key => [key, createHash("sha256").update(en[key]).digest("hex")]));
  for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const translated = read(locale);
    assert.deepEqual(Object.keys(translated).filter(key => key.startsWith("notifyMe.shortcut.")).sort(), [...keys].sort());
    for (const key of keys) {
      assert.equal(typeof translated[key], "string", `${locale}:${key}`);
      assert.notEqual(translated[key], en[key], `${locale}:${key}`);
      assert.deepEqual(translated[key].match(/\{\w+\}/g), en[key].match(/\{\w+\}/g), `${locale}:${key}`);
      assert.doesNotMatch(translated[key], /—|\b(?:safe|free|Forge|Composio)\b/i);
    }
    assert.deepEqual(Object.fromEntries(keys.map(key => [key, hashes.locales[locale][key]])), expectedHashes, locale);
  }
});
