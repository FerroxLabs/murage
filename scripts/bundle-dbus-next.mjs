// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle dbus-next (the Linux actionable notifications, electron/linux-notify.mjs) into one self-contained file the packaged
// main process can require. The app ships no node_modules for main (electron-builder.yml `!**/node_modules/**`), so a main-process
// dependency is vendored, as electron-updater and ws are (scripts/bundle-updater.mjs, scripts/bundle-ws.mjs).
// dbus-next optional add-ons stay external: usocket (Unix file-descriptor passing: the notification calls never pass
// descriptors) and x11 (finding the bus address on a desktop that does not export DBUS_SESSION_BUS_ADDRESS). The library loads without them. Run with `pnpm build:dbus-next` and commit the output.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(require.resolve("dbus-next/package.json"), "utf8"));

await build({
  entryPoints: [require.resolve("dbus-next")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["usocket", "x11"],
  outfile: join(root, "electron/vendor/dbus-next.cjs"),
  banner: { js: `/* dbus-next ${version} (MIT, https://github.com/dbusjs/node-dbus-next), bundled by scripts/bundle-dbus-next.mjs */` },
  legalComments: "inline",
  logLevel: "info",
});
