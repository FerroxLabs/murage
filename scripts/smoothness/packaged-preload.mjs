// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only witness of the addon loaded by the unmodified packaged server.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
// Witness the file the compiled loader really opened; no source import and no second addon load.
if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const watch = setInterval(() => {
    const files = Object.keys(require.cache).filter(file => /engine-exclusion\.node$/i.test(file));
    if (files.length) {
      clearInterval(watch);
      console.log(`[smooth-native] ${JSON.stringify({ pid: process.pid, files: files.map(file => realpathSync.native(file)) })}`);
    }
  }, 250);
  watch.unref();
}
