// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ruleIds } from "../scripts/copy-lint.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
  return entry.isDirectory() ? walk(url) : [url];
});
test("attention renderers have no standing timers, animation loops, network or other privileged bridges", () => {
  const forbidden = /\b(?:setInterval|requestAnimationFrame|setTimeout|fetch|XMLHttpRequest|WebSocket)\s*\(|\banimation(?:-iteration-count)?\s*:[^;}]*\binfinite\b|\bwindow\.(?:muragebox|murageNative|close)\b/;
  for (const directory of ["../src/tray-panel/", "../src/attention-ui/", "../src/float/"]) {
    for (const file of walk(new URL(directory, import.meta.url)).filter(url => !/\.test\./.test(url.pathname))) assert.doesNotMatch(readFileSync(file, "utf8"), forbidden, file.pathname);
  }
  const html = read("../src/tray-panel/index.html");
  assert.match(html, /frame-src 'none'/); assert.match(html, /object-src 'none'/);
  assert.match(read("../vite.config.ts"), /trayPanel: fileURLToPath\(new URL\("\.\/src\/tray-panel\/index\.html"/);
});
test("all eight panel catalogues agree on keys and placeholders, obey copy rules, and have current source hashes", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const hashes = JSON.parse(read("../src/locales/source-hashes.json"));
  const keys = Object.keys(en).filter(key => key.startsWith("trayPanel.")).sort();
  assert.ok(keys.length >= 25);
  const placeholders = text => [...text.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
  for (const locale of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(read(`../src/locales/${locale}.json`));
    assert.deepEqual(Object.keys(pack).filter(key => key.startsWith("trayPanel.")).sort(), keys);
    for (const key of keys) {
      assert.ok(pack[key].trim()); assert.deepEqual(placeholders(pack[key]), placeholders(en[key]));
      assert.doesNotMatch(pack[key], /—|\b(?:safe|free|Forge|Composio)\b/i);
      assert.deepEqual(ruleIds({ locale, value: pack[key] }, { english: en[key] }), [], `${locale}:${key}`);
      if (locale !== "en") assert.equal(hashes.locales[locale][key], createHash("sha256").update(en[key]).digest("hex"), `${locale}:${key}`);
    }
  }
});
