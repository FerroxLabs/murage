import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir } from "./cleanup.ts";

it("reaps the permission MCP child before completing the fake Claude turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-fake-claude-reap-"));
  const pidFile = join(dir, "pid");
  const eofFile = join(dir, "eof");
  const releaseFile = join(dir, "release");
  const server = join(dir, "permission.cjs");
  // Keep the answered server alive after EOF until the test releases it.
  // Completing the turn meanwhile lets driver disposal kill its parent
  // before Node reaps this child (a zombie without an adopting init reaper).
  writeFileSync(server, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (msg.id === undefined) continue;
        const result = msg.id === 1 ? {} : {content: [{text: JSON.stringify({behavior: "deny"})}]};
        process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: msg.id, result}) + "\\n");
      }
    });
    process.stdin.on("end", () => {
      fs.writeFileSync(${JSON.stringify(eofFile)}, "EOF");
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(timer); process.exit(0); }
      }, 10);
    });
  `);
  const config = join(dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { permission: { command: process.execPath, args: [server] } } }));
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SHELL_PREFIX;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-claude-cli.ts", import.meta.url)),
    "--mcp-config", config, "--permission-prompt-tool", "mcp__permission__approve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  const completed = () => output.split("\n").filter(Boolean).some(line => JSON.parse(line).type === "result");
  const serverGone = () => {
    if (!existsSync(pidFile)) return true;
    try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  try {
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "__fixture_permission_tool__" } }) + "\n");
    await expect.poll(() => existsSync(eofFile)).toBe(true);
    // Let stdout drain while the child is deliberately still held, independent
    // of how quickly a normal permission proxy happens to exit on this host.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(serverGone()).toBe(false);
    expect(completed(), "turn completed with its permission child still running").toBe(false);
    writeFileSync(releaseFile, "release");
    await expect.poll(completed).toBe(true);
    expect(serverGone(), "the permission child must be reaped before result").toBe(true);
  } finally {
    writeFileSync(releaseFile, "release");
    await expect.poll(serverGone).toBe(true);
    child.stdin.end();
    await closed;
    await removeTempDir(dir);
  }
});
