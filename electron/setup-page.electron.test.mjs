// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019: a real Electron window against the real server entry (see fixtures/setup-page-window.mjs). Runs where an
// Electron binary can start (set MURAGE_TEST_ELECTRON to one, and use xvfb-run on a display-less Linux box); skipped elsewhere.
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
const bundledServer = existsSync(fileURLToPath(new URL("../dist-server/index.js", import.meta.url)));

async function runWindow(lang) {
  const env = { ...process.env, MURAGE_TEST_LANG: lang }; delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--no-sandbox", fileURLToPath(new URL("./fixtures/setup-page-window.mjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
    const timeout = setTimeout(() => child.kill(), 150000);
    child.once("error", (e) => { clearTimeout(timeout); reject(e); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

it.runIf(binary && bundledServer && (process.platform === "darwin" || process.env.MURAGE_TEST_ELECTRON))("the real window never shows JSON, shows the setup page in its language, opens the app by itself and opens the log", async () => {
  for (const lang of ["", "de"]) {
    const result = await runWindow(lang);
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain("setup-page-window-passed");
    for (const step of ["step0-real-server-up-without-index-html", lang ? "step1-setup-page-shown-de" : "step1-setup-page-shown-en", "step2-show-the-log-opens-once", "step3-retry-stays-on-setup-page", "step4-app-arrived-by-itself", "step5-no-reload-after-success", "step6-no-json-main-frame-responses", "step6b-request-headers-document-navigate", "step7-error-page-log-link-opens-log", "step8-other-data-page-refused", "step9a-window-on-error-document-after-kill", "step9b-setup-page-back-in-", "step9bprime-setup-page-back-without-kick-in-", "step9c-app-back-no-json", "step9d-no-unsolicited-reload", "step9e-sandboxed-frame-left-alone"]) expect(result.stdout).toContain(step);
  }
}, 340000);
