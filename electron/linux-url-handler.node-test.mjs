// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LINUX_HANDLER_FILE, SCHEME_MIME, ensureLinuxUrlHandler, linuxHandlerDesktopEntry } from "./linux-url-handler.mjs";

let dataHome;
test.beforeEach(() => { dataHome = mkdtempSync(path.join(tmpdir(), "xdg-data-")); });
test.afterEach(() => { safeWipeSync(dataHome); });
const appWith = (isDefault) => {
  const calls = [];
  return { calls, app: { isDefaultProtocolClient: (scheme) => { calls.push(["isDefault", scheme]); return isDefault; }, setAsDefaultProtocolClient: (scheme) => { calls.push(["setDefault", scheme]); return true; } } };
};

test("linux: writes desktop file when not default", async () => {
  const { app, calls } = appWith(false);
  const execs = [];
  const outcome = await ensureLinuxUrlHandler({ app, platform: "linux", appImagePath: "/home/ann/Apps/Murage-1.0.3.AppImage", execPath: "/tmp/.mount_MurageX/murage",
    dataHome, exec: async (file, args) => { execs.push([file, ...args]); } });
  assert.deepEqual(outcome, { registered: true });
  const file = path.join(dataHome, "applications", LINUX_HANDLER_FILE);
  const entry = readFileSync(file, "utf8");
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec="\/home\/ann\/Apps\/Murage-1\.0\.3\.AppImage" %U$/m, "the AppImage file, never the temporary mount");
  assert.ok(!entry.includes(".mount_"));
  assert.match(entry, new RegExp(`^MimeType=${SCHEME_MIME.replace("/", "\\/")};$`, "m"));
  assert.match(entry, /^NoDisplay=true$/m);
  assert.deepEqual(execs, [["xdg-mime", "default", LINUX_HANDLER_FILE, "x-scheme-handler/murage"]]);
  assert.deepEqual(calls, [["isDefault", "murage"]], "xdg-mime has the last word; Electron's own default is not set again over it");
});

test("linux: no-op when default", async () => {
  const { app, calls } = appWith(true);
  const execs = [];
  assert.deepEqual(await ensureLinuxUrlHandler({ app, platform: "linux", dataHome, exec: async (...args) => { execs.push(args); } }), { registered: false, reason: "already" });
  assert.equal(existsSync(path.join(dataHome, "applications", LINUX_HANDLER_FILE)), false);
  assert.deepEqual(execs, []);
  assert.deepEqual(calls, [["isDefault", "murage"]]);
  assert.deepEqual(await ensureLinuxUrlHandler({ app: appWith(false).app, platform: "darwin", dataHome }), { registered: false, reason: "not-linux" });
});

test("linux: without an AppImage the running executable is named; a failing xdg-mime is reported, never thrown", async () => {
  const { app } = appWith(false);
  const outcome = await ensureLinuxUrlHandler({ app, platform: "linux", appImagePath: undefined, execPath: "/opt/Murage/murage", dataHome, exec: async () => { throw new Error("xdg-mime: not found"); } });
  assert.deepEqual(outcome, { registered: false, reason: "failed" });
  assert.match(readFileSync(path.join(dataHome, "applications", LINUX_HANDLER_FILE), "utf8"), /^Exec="\/opt\/Murage\/murage" %U$/m);
  assert.equal(linuxHandlerDesktopEntry("/a b/c\"d$e`f\\g").split("\n").find((line) => line.startsWith("Exec=")), "Exec=\"/a b/c\\\"d\\$e\\`f\\\\g\" %U");
});
