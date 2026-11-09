// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ruleIds } from "../scripts/copy-lint.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
test("pill catalogues have translations, matching placeholders, copy rules and current hashes", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const hashes = JSON.parse(read("../src/locales/source-hashes.json"));
  const keys = Object.keys(en).filter(key => key.startsWith("pill.")).sort();
  assert.equal(keys.length, 9);
  const placeholders = value => [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
  const expected = Object.fromEntries(keys.map(key => [key, createHash("sha256").update(en[key]).digest("hex")]));
  for (const locale of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(read(`../src/locales/${locale}.json`));
    assert.deepEqual(Object.keys(pack).filter(key => key.startsWith("pill.")).sort(), keys);
    for (const key of keys) {
      assert.ok(pack[key].trim()); assert.deepEqual(placeholders(pack[key]), placeholders(en[key]));
      assert.doesNotMatch(pack[key], /—|\b(?:safe|free|Forge|Composio)\b/i);
      assert.deepEqual(ruleIds({ locale, value: pack[key] }, { english: en[key] }), [], `${locale}:${key}`);
    }
    if (locale !== "en") assert.deepEqual(Object.fromEntries(keys.map(key => [key, hashes.locales[locale][key]])), expected, locale);
  }
});
test("pill and shared renderers stay event driven, isolated, and included in the build and existing guard", () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? walk(url) : [url];
  });
  for (const directory of ["../src/pill/", "../src/attention-ui/", "../src/tray-panel/"]) {
    for (const url of walk(new URL(directory, import.meta.url)).filter(url => !/\.test\./.test(url.pathname))) {
      assert.doesNotMatch(readFileSync(url, "utf8"), /\b(?:setInterval|setTimeout|requestAnimationFrame|fetch|WebSocket|XMLHttpRequest)\s*\(|\banimation(?:-iteration-count)?\s*:[^;}]*\binfinite\b|window\.(?:muragebox|murageNative|close)\b/);
    }
  }
  assert.match(read("../src/pill/index.html"), /frame-src 'none'; object-src 'none'/);
  assert.match(read("../vite.config.ts"), /pill: fileURLToPath\(new URL\("\.\/src\/pill\/index.html"/);
  assert.match(read("../vite.config.ts"), /src\/pill\/Pill.test.tsx/);
  assert.match(read("./attention-panel-guards.node-test.mjs"), /\.\.\/src\/pill\//);
  assert.match(read("../src/pill/Pill.tsx"), /<AttentionCard\b/);
});
