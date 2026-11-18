// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The packaged app ships no node_modules for main: the Linux banners load the vendored dbus-next bundle (scripts/bundle-dbus-next.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { loadSessionBus } from "./linux-notify.mjs";

test("the vendored dbus-next bundle is present and loadSessionBus finds it without node_modules", () => {
  assert.equal(loadSessionBus.available(), true);
  const bundle = createRequire(import.meta.url)("./vendor/dbus-next.cjs");
  assert.equal(typeof bundle.sessionBus, "function");
  assert.equal(typeof bundle.Variant, "function");
  const head = readFileSync(new URL("./vendor/dbus-next.cjs", import.meta.url), "utf8").slice(0, 200);
  assert.match(head, /dbus-next 0\.10\.2 \(MIT/);
});

test("linux-notify.mjs requires the vendored file by path, never a bare specifier", () => {
  const source = readFileSync(new URL("./linux-notify.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /require\("dbus-next"\)|from "dbus-next"|import\("dbus-next"\)/);
  assert.match(source, /\.\/vendor\/dbus-next\.cjs/);
});
