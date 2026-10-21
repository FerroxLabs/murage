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

test("a script after node or Electron options is still the script (the memory worker is forked with --experimental-strip-types first)", () => {
  for (const file of Object.values(SPAWNED_PROXIES)) {
    const rel = relative(SERVER_ROOT, file).replace(/\\/g, "/").replace(/\.ts$/, ".js");
    for (const script of [file, `/Applications/Murage.app/Contents/Resources/server/${rel}`, `C:\\Program Files\\Murage\\resources\\server\\${rel.replace(/\//g, "\\")}`]) {
      for (const argv of [
        ["/x/Murage", "--experimental-strip-types", script],
        ["/x/Murage", "--experimental-strip-types", "--no-warnings", script, "--flag"],
        ["/x/Murage", "--import", "/tmp/prelude.mjs", script],
        ["/x/Murage", "--import=/tmp/prelude.mjs", "-r", "/tmp/pre.cjs", script],
        ["/x/Murage", "--inspect=9229", "--", script],
        ["/x/Murage", "-psn_0_1234", script],
        ["/x/Murage", "--max-old-space-size", "4096", script],
        ["/x/Murage", "--stack-size", "2000", "--title", "worker", script],
        ["/x/Murage", "--require", "/tmp/pre.cjs", "-r", "/tmp/pre2.cjs", "--loader", "/tmp/l.mjs", "--experimental-loader", "/tmp/l2.mjs", script],
        ["/x/Murage", "--conditions", "dev", "-C", "x", "--input-type", "module", "--inspect-port", "9230", script],
        ["/x/Murage", "-e", "1", "-p", "2", "--eval", "3", "--print", "4", script],
        ["/x/Murage", "--max-old-space-size=4096", "--title=w", "--inspect-port=9230", script],
        ["/x/Murage", "--report-dir", "/tmp/r", "--disable-warning", "ExperimentalWarning", "--env-file", ".env", script],
      ]) {
        assert.match(proxyLaunchRefusal(argv, {}) ?? "", /started without ELECTRON_RUN_AS_NODE/, argv.join(" "));
        assert.equal(proxyLaunchRefusal(argv, { ELECTRON_RUN_AS_NODE: "1" }), null, argv.join(" "));
      }
    }
  }
  // the real fork: what child_process.fork hands the binary for SPAWNED_PROXIES.memoryWorker
  assert.match(proxyLaunchRefusal(["/x/Murage", "--experimental-strip-types", SPAWNED_PROXIES.memoryWorker], {}) ?? "", /memory/);
  assert.match(proxyLaunchRefusal(["C:\\Murage\\Murage.exe", "--experimental-strip-types", "C:\\Murage\\resources\\server\\memory\\worker.js"], {}) ?? "", /worker\.js/);
});

test("a deep link or any other URL is never a script, whatever it ends with", () => {
  for (const url of [
    "murage://install?url=https://raw.githubusercontent.com/example/repo/main/bot.json#/permission-proxy.js",
    "murage://open/server/memory/worker.js",
    "MURAGE://x/drivers/memory-proxy.ts",
    "https://example.com/resources/server/computer-proxy.js",
    "file:///Applications/Murage.app/Contents/Resources/server/permission-proxy.js",
  ]) {
    for (const argv of [["/x/Murage", url], ["/x/Murage", "--hidden", url], ["/x/Murage", "--", url]]) {
      assert.equal(proxyLaunchRefusal(argv, {}), null, argv.join(" "));
      assert.equal(enforceProxyLaunchGuard(argv, {}, () => assert.fail("exit"), () => assert.fail("write")), false);
    }
  }
  // the true positives stay refused
  assert.match(proxyLaunchRefusal(["/x/Murage", "/Applications/Murage.app/Contents/Resources/server/permission-proxy.js"], {}) ?? "", /ELECTRON_RUN_AS_NODE/);
});

test("the value of a separated option is never the script, even when it looks like a proxy path", () => {
  const lookalike = SPAWNED_PROXIES.permission;
  for (const option of ["--max-old-space-size", "--stack-size", "--inspect-port", "--title", "--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--input-type", "-e", "--eval", "-p", "--print"]) {
    assert.equal(proxyLaunchRefusal(["/x/Murage", option, lookalike, "/tmp/app.js"], {}), null, option);
    assert.equal(proxyLaunchRefusal(["/x/Murage", option, lookalike], {}), null, option);
  }
  // the = spelling is one token, so the next argument is the script
  assert.match(proxyLaunchRefusal(["/x/Murage", `--require=${lookalike}`, lookalike], {}) ?? "", /ELECTRON_RUN_AS_NODE/);
});

test("an ordinary app launch is never refused", () => {
  for (const argv of [["/x/Murage"], ["/x/Murage", "."], ["/x/Murage", "murage://open"], ["/x/Murage", "--hidden"], ["/x/electron", join(here, "main.mjs")], ["/x/Murage", "/tmp/not-a-proxy.js"], ["/x/Murage", `/tmp/x${basename(SPAWNED_PROXIES.permission)}`], ["/x/Murage", "--hidden", "."], ["/x/Murage", "--import", SPAWNED_PROXIES.permission, "/tmp/app.js"], ["/x/Murage", "--inspect=9229"], ["/x/Murage", "--"]]) {
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
