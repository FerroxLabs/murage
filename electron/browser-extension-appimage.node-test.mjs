// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage for Chrome from an AppImage. Chrome starts the native helper through
// the launcher Murage registered, long after (or without) the Murage window
// that registered it, so the launcher runs the AppImage FILE, which mounts
// itself afresh, as Node with a helper script copy outside the mount. This
// runs that launcher through the REAL AppRun text from app-builder-lib and the
// REAL Electron binary, with `unshare` answering as Ubuntu 24.04 does (AppRun
// then wants --no-sandbox) and as a system with user namespaces does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { unixLauncher } from "../scripts/browser-extension-host-registration.mjs";

const require = createRequire(import.meta.url);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pnpm = path.join(repo, "node_modules", ".pnpm");
const builderDir = existsSync(pnpm) ? readdirSync(pnpm).find(name => name.startsWith("app-builder-lib@")) : undefined;
const appRunScript = () => require(path.join(pnpm, builderDir, "node_modules", "app-builder-lib", "out", "targets", "appimage", "appImageUtil.js"))
  .generateAppRunScript({ ExecutableName: "murage", ProductName: "Murage", ProductFilename: "Murage" });
const electronBinary = process.platform === "darwin"
  ? path.join(repo, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : path.join(repo, "node_modules", "electron", "dist", "electron");
// A present Electron binary is not always a runnable one: a slim container
// without the desktop shared libraries (libnspr4, libnss3, ...) cannot start it
// (loader exit 127). That is the host lacking the libraries, not the launcher
// failing, so skip on exactly that loader error; any other failure still fails.
const missingSharedLibraries = () => {
  if (process.platform === "win32" || !existsSync(electronBinary)) return false;
  const probe = spawnSync(electronBinary, ["--version"], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return probe.status === 127 && /error while loading shared libraries/.test(probe.stderr ?? "");
};
const REAL = process.platform === "win32" ? "POSIX AppRun" : !existsSync(electronBinary) ? "electron binary not present" : !builderDir ? "app-builder-lib not present" : missingSharedLibraries() ? "electron cannot start here: desktop shared libraries are missing" : false;

test("Chrome's launch of the AppImage helper reaches the helper script with its config", { skip: REAL }, t => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "bx-appimage-")));
  t.after(() => safeWipeSync(root));
  for (const [name, unshareExit] of [["user namespaces allowed", 0], ["Ubuntu 24.04", 1]]) {
    const dir = path.join(root, `case-${unshareExit}`), appDir = path.join(dir, ".mount_MurageTEST"), bin = path.join(dir, "bin"), registration = path.join(dir, "registration");
    for (const folder of [dir, appDir, bin, registration]) mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(appDir, "AppRun"), appRunScript(), { mode: 0o755 });
    writeFileSync(path.join(appDir, "murage"), `#!/bin/bash\nexec "${electronBinary}" "$@"\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "unshare"), `#!/bin/sh\nexit ${unshareExit}\n`, { mode: 0o755 });
    // Stands in for the AppImage runtime: mount (here, a fixed folder), set
    // APPDIR and APPIMAGE, run AppRun with the arguments it was given.
    const appImage = path.join(dir, "Murage-0.1.61-x86_64.AppImage");
    writeFileSync(appImage, `#!/bin/bash\nexport APPDIR="${appDir}" APPIMAGE="$0"\nexec "${appDir}/AppRun" "$@"\n`, { mode: 0o755 });
    // Stands in for the staged helper copy: reports what it received.
    const hostScript = path.join(registration, "native-host-chrome.mjs");
    writeFileSync(hostScript, `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), node: typeof process.versions.node === "string" }) + "\\n");\n`, { mode: 0o600 });
    const configPath = path.join(dir, "runtime", "native-host.json");
    const launcherPath = path.join(registration, "browser-native-chrome");
    writeFileSync(launcherPath, unixLauncher({ electronPath: appImage, hostScriptPath: hostScript, configPath, appImage: true }), { mode: 0o700 });
    // Chrome passes the caller's origin; Murage's own environment is absent.
    const origin = `chrome-extension://${"b".repeat(32)}/`;
    const r = spawnSync(launcherPath, [origin], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: helper died: status ${r.status}, stderr ${r.stderr.trim()}`);
    const line = JSON.parse(r.stdout.trim().split("\n").at(-1));
    // browser-extension-host-entry.mjs reads its config from argv[2].
    assert.equal(line.argv[0], configPath, name);
    assert.deepEqual(line.argv, [configPath, origin, "--no-sandbox"], name);
    assert.equal(line.node, true, name);
  }
});
