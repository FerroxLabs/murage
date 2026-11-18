import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Guard for the send-fence hand-in holder (server/memory/send-fence-deps.ts).
// send-fence.ts imports modules that reach memory-revocation.ts, which hands its drain in while it loads. When computer-proxy.ts is the
// first module loaded (the real MCP bridge entry), that hand-in must not read a holder that is not initialised yet
// ("Cannot access ... before initialization"). A fresh process loads it as the entry and we read only whether that error appears.
it("T-SENDFENCE-ENTRY computer-proxy.ts loads as the process entry without a before-initialization error", async () => {
  const url = new URL("./computer-proxy.ts", import.meta.url), pathname = fileURLToPath(url);
  const home = mkdtempSync(join(tmpdir(), "murage-sendfence-entry-"));
  const script = `process.argv = [process.execPath, ${JSON.stringify(pathname)}];
    try { await import(${JSON.stringify(url.href)}); } catch (error) { process.stderr.write("ENTRY-IMPORT-THROW " + String(error?.stack ?? error) + "\\n"); process.exit(1); }`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    stdio: ["pipe", "ignore", "pipe"], env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: home, NODE_ENV: "test" },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 65536) stderr += chunk; });
  try {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 4000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    child.kill();
    await new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("close", () => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
  expect(stderr).not.toMatch(/before initiali[sz]ation/);
  expect(stderr).not.toContain("ENTRY-IMPORT-THROW");
}, 20000);
