// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { enforceProxyLaunchGuard, PROXY_LAUNCH_EXIT_CODE, proxyLaunchRefusal } from "./proxy-launch-guard.mjs";
import { SERVER_ROOT, SPAWNED_PROXIES } from "../server/proxy-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("every spawned server file, dev or packaged, refuses to start the app without ELECTRON_RUN_AS_NODE", () => {
  const files = Object.values(SPAWNED_PROXIES);
  assert.ok(files.length > 10);
  for (const file of files) {
    const rel = relative(SERVER_ROOT, file).replace(/\\/g, "/").replace(/\.ts$/, ".js");
    for (const script of [file, `/Applications/Murage.app/Contents/Resources/server/${rel}`, `C:\\Program Files\\Murage\\resources\\server\\${rel.replace(/\//g, "\\")}`]) {
      assert.match(proxyLaunchRefusal(["/x/Murage", script], {}) ?? "", /started without ELECTRON_RUN_AS_NODE/, script);
      assert.equal(proxyLaunchRefusal(["/x/Murage", script], { ELECTRON_RUN_AS_NODE: "1" }), null, script);
    }
  }
});

test("an ordinary app launch is never refused", () => {
  for (const argv of [["/x/Murage"], ["/x/Murage", "."], ["/x/Murage", "murage://open"], ["/x/Murage", "--hidden"], ["/x/electron", join(here, "main.mjs")], ["/x/Murage", "/tmp/not-a-proxy.js"], ["/x/Murage", `/tmp/x${basename(SPAWNED_PROXIES.permission)}`]]) {
    assert.equal(proxyLaunchRefusal(argv, {}), null, argv.join(" "));
  }
});

test("the guard exits 86 with one line on stderr", () => {
  const exits = [];
  const lines = [];
  assert.equal(enforceProxyLaunchGuard(["/x/Murage", SPAWNED_PROXIES.permission], {}, (code) => exits.push(code), (line) => lines.push(line)), true);
  assert.deepEqual(exits, [PROXY_LAUNCH_EXIT_CODE]);
  assert.equal(PROXY_LAUNCH_EXIT_CODE, 86);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[desktop\] .+permission-proxy\.ts was started without ELECTRON_RUN_AS_NODE; exiting so it does not open Murage a second time\n$/);
  assert.equal(enforceProxyLaunchGuard(["/x/Murage", "."], {}, () => exits.push("no"), () => lines.push("no")), false);
  assert.equal(exits.length, 1);
});

test("main.mjs runs the guard before any other statement and before the single-instance lock", () => {
  const source = readFileSync(join(here, "main.mjs"), "utf8");
  const call = source.indexOf("\nenforceProxyLaunchGuard();");
  assert.ok(call > 0, "main.mjs calls enforceProxyLaunchGuard()");
  assert.ok(call < source.indexOf("requestSingleInstanceLock("), "before requestSingleInstanceLock");
  assert.ok(source.startsWith('import { enforceProxyLaunchGuard } from "./proxy-launch-guard.mjs";'), "its module is evaluated first");
  // no top-level statement of the app runs first (everything above it is imports and comments)
  const firstStatement = source.search(/^(const|let|var|if|function|app\.|process\.)/m);
  assert.ok(firstStatement > call, "the first top-level statement");
});
