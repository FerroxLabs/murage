// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the import guard off the server's main thread. The same guard code
// (bot-package-guard.ts) reads the package here; this file only passes the
// bytes in, progress out and the answer back, so a large package never holds
// up chats or routines while it is checked.
import { parentPort } from "node:worker_threads";
import { scanBotPackageForImport } from "./bot-package-guard.ts";
import type { BotPackageScanFile } from "./bot-package-scan.ts";

const port = parentPort;
if (port) {
  port.once("message", (message: { files: BotPackageScanFile[] }) => {
    let last = -Infinity;
    const result = scanBotPackageForImport(message.files, (fraction) => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      port.postMessage({ type: "progress", fraction });
    });
    port.postMessage({ type: "result", result });
  });
}
