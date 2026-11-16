// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle dbus-next (the Linux actionable notifications, electron/linux-notify.mjs) into one self-contained file the packaged
// main process can require. The app ships no node_modules for main (electron-builder.yml `!**/node_modules/**`), so a main-process
// dependency is vendored, as electron-updater and ws are (scripts/bundle-updater.mjs, scripts/bundle-ws.mjs).
// dbus-next optional add-ons stay external: usocket (Unix file-descriptor passing: the notification calls never pass
// descriptors) and x11 (finding the bus address on a desktop that does not export DBUS_SESSION_BUS_ADDRESS). The library loads without them.
//
// dbus-next is NOT a dependency of this repository (its install tree would add about 150 packages to pnpm-lock.yaml for one vendored file).
// This script uses the committed scripts/dbus-next/package-lock.json with npm ci in a throw-away temp directory with --ignore-scripts (no install script of dbus-next or
// of any of its dependencies runs), bundles it with the repository's esbuild, and removes the temp directory. Run it with
// `pnpm build:dbus-next` (network needed) and commit electron/vendor/dbus-next.cjs.
//
// Recorded bundle sha256 (dbus-next 0.10.2, this script, the repository's esbuild; update it together with the bundle):
//   electron/vendor/dbus-next.cjs = c358b8f9177695c41c2f5b5b1b5894f21c35fe9b0be0d982858488e939c43c60
// The script prints the sha256 it produced and exits 1 when it differs from the recorded one. Update the lock and review
// the bundle together; the repository's pnpm lock also pins esbuild.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DBUS_NEXT_VERSION = "0.10.2";
const RECORDED_SHA256 = "c358b8f9177695c41c2f5b5b1b5894f21c35fe9b0be0d982858488e939c43c60";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "electron/vendor/dbus-next.cjs");

const temp = mkdtempSync(join(tmpdir(), "murage-dbus-next-"));
let sha256;
try {
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(root, "scripts/dbus-next", name), join(temp, name));
  const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", temp],
    { stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) throw new Error(`npm ci dbus-next@${DBUS_NEXT_VERSION} failed (${install.status ?? install.error})`);
  const require = createRequire(join(temp, "noop.js"));
  const { version } = JSON.parse(readFileSync(require.resolve("dbus-next/package.json"), "utf8"));
  if (version !== DBUS_NEXT_VERSION) throw new Error(`installed dbus-next ${version}, expected ${DBUS_NEXT_VERSION}`);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: temp,
    entryPoints: [require.resolve("dbus-next")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["usocket", "x11"],
    outfile,
    banner: { js: `/* dbus-next ${version} (MIT, https://github.com/dbusjs/node-dbus-next), bundled by scripts/bundle-dbus-next.mjs */` },
    legalComments: "inline",
    logLevel: "info",
  });
  sha256 = createHash("sha256").update(readFileSync(outfile)).digest("hex");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`electron/vendor/dbus-next.cjs sha256 ${sha256}`);
if (sha256 !== RECORDED_SHA256) {
  console.error(`bundle differs from the recorded sha256 ${RECORDED_SHA256}: diff the bundle, then record the new hash in this script and commit both`);
  process.exit(1);
}
