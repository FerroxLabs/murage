// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileCacheDirectory, compileCacheEnvironment } from "./compile-cache.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));

test("cache dir is under userData and scoped by app version", () => {
  const a = compileCacheDirectory({ userData: "/u", appVersion: "1.0.0", electronVersion: "43.4.0" });
  const b = compileCacheDirectory({ userData: "/u", appVersion: "1.0.1", electronVersion: "43.4.0" });
  assert.ok(a.startsWith(path.join("/u", "node-compile-cache")));
  assert.notEqual(a, b);
  assert.match(a, /1\.0\.0/);
});

test("env points at the created version folder and prunes older versions", () => {
  const userData = tmp();
  const old = compileCacheEnvironment({ userData, appVersion: "1.0.0", electronVersion: "43" });
  assert.ok(fs.existsSync(old.NODE_COMPILE_CACHE));
  const now = compileCacheEnvironment({ userData, appVersion: "1.0.1", electronVersion: "43" });
  assert.ok(fs.existsSync(now.NODE_COMPILE_CACHE));
  assert.ok(!fs.existsSync(old.NODE_COMPILE_CACHE));
  safeWipeSync(userData);
});

test("fails open: unusable userData, throwing fs, operator override", () => {
  assert.deepEqual(compileCacheEnvironment({ userData: "relative", appVersion: "1" }), {});
  assert.deepEqual(compileCacheEnvironment({ userData: () => { throw new Error("x"); }, appVersion: "1" }), {});
  const fsImpl = { mkdirSync() { throw new Error("EACCES"); } };
  assert.deepEqual(compileCacheEnvironment({ userData: "/u", appVersion: "1", fsImpl }), {});
  assert.deepEqual(compileCacheEnvironment({ userData: "/u", appVersion: "1", env: { NODE_COMPILE_CACHE: "/x" } }), {});
});

test("main.mjs and companion.mjs pass the cache environment to their forks", () => {
  for (const file of ["main.mjs", "companion.mjs"]) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /\.\.\.\(?[^\n]*compileCacheEnvironment\(/, file);
  }
});
