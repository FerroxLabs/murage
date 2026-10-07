// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopTrace } from "./desktop-trace.mjs";

test("marks are off by default", () => {
  const lines = [];
  createDesktopTrace({ env: {}, sink: l => lines.push(l) })("ready");
  createDesktopTrace({ env: { MURAGE_TURN_TRACE: "0" }, sink: l => lines.push(l) })("ready");
  assert.deepEqual(lines, []);
});

test("marks print step and ms since process start when on", () => {
  const lines = [];
  createDesktopTrace({ env: { MURAGE_TURN_TRACE: "1" }, now: () => 1234.6, sink: l => lines.push(l) })("fork");
  assert.deepEqual(lines, ["[desktop-trace] phase=fork ms=1235"]);
});

test("a throwing sink never breaks startup", () => {
  assert.doesNotThrow(() => createDesktopTrace({ env: { MURAGE_TURN_TRACE: "1" }, sink: () => { throw new Error("x"); } })("a"));
});
