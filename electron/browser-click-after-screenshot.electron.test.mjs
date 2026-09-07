import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);

it.runIf(process.platform === "darwin")("keeps the actual browser host click target and viewport stable after screenshots", async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [fileURLToPath(new URL("./fixtures/browser-click-after-screenshot.cjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill(); }, 25000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
  expect(result.stdout).toContain("actual-host-screenshot-click-regression-passed");
}, 30000);
