// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle ws (the Cloud engine sign-in relay's socket, electron/cloud-home-engine-login.mjs) into one self-contained file
// the packaged main process can require. The app ships no node_modules for main (electron-builder.yml `!**/node_modules/**`),
// so a main-process dependency is vendored, as electron-updater is (scripts/bundle-updater.mjs). A bare `import "ws"` in
// electron/ packaged an app that died at launch with ERR_MODULE_NOT_FOUND (1.0.3, Linux package smoke).
// ws's optional native add-ons (bufferutil, utf-8-validate) stay external: ws falls back to JavaScript without them.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(require.resolve("ws/package.json"), "utf8"));

await build({
  entryPoints: [require.resolve("ws")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["bufferutil", "utf-8-validate"],
  outfile: join(root, "electron/vendor/ws.cjs"),
  banner: { js: `/* ws ${version} (MIT, https://github.com/websockets/ws), bundled by scripts/bundle-ws.mjs */` },
  legalComments: "inline",
  logLevel: "info",
});
