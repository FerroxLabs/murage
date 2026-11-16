// SPDX-License-Identifier: AGPL-3.0-or-later
// NOTIFY-EVERYWHERE-1019 S3R V1: real Electron (see fixtures/attention-notice-window.mjs). Runs where an Electron binary can start
// (set MURAGE_TEST_ELECTRON, and use xvfb-run on a display-less Linux box); skipped elsewhere.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);

function electronBinary() {
  if (process.env.MURAGE_TEST_ELECTRON) return process.env.MURAGE_TEST_ELECTRON;
  try { const bin = require("electron"); return typeof bin === "string" && existsSync(bin) ? bin : null; } catch { return null; }
}
const binary = electronBinary();

function run() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // No notification daemon (headless Linux): the OS `failed` event fires at once and legitimately retires the record. Suppress only that
  // listener registration so the reload / crash / settle lifecycle can be checked; the fixture prints whether it did.
  if (process.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS) env.MURAGE_V1_SUPPRESS_FAILED = "1";
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--no-sandbox", fileURLToPath(new URL("./fixtures/attention-notice-window.mjs", import.meta.url))], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    const timeout = setTimeout(() => child.kill(), 120000);
    child.once("error", e => { clearTimeout(timeout); reject(e); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

it.runIf(binary && (process.platform === "darwin" || process.env.MURAGE_TEST_ELECTRON))("a real Notification for a router ref survives a renderer reload and a forced crash, and settle closes the same one once", async () => {
  const result = await run();
  console.log(result.stdout);
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
  for (const step of ["session-bound", "notice-shown-real-notification", "survives-reload", "survives-crash", "settle-closes-same-notice-once", "attention-notice-passed"]) expect(result.stdout).toContain(step);
}, 150000);
