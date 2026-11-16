import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { vpsContainerName } from "./vps-computer.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { spawnBoundProxy, boundProxyTerminal } from "./testing/bound-proxy-fixture.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => removeTempDir(path)));
});

function runBridge(bin: string, input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./vps-container-mcp.ts", import.meta.url)),
        "production-vps",
        vpsContainerName("bridge-test"),
      ],
      {
        windowsHide: true,
        env: { ...process.env, MURAGE_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

describe.skipIf(process.platform === "win32")("VPS Cua MCP bridge", () => {
  it("preserves MCP fields with an isolated request id to docker exec over the validated SSH target", async () => {
    const bin = await mkdtemp(join(tmpdir(), "murage-vps-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    const wireFile = join(bin, "wire.json"), argsFile = join(bin, "args.json");
    await writeFile(fakeDocker, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  fs.writeFileSync(${JSON.stringify(wireFile)}, line + '\\n');
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] }, data: request.data }) + '\\n');
});
`, { mode: 0o700 });
    await chmod(fakeDocker, 0o700);

    const input = `{"jsonrpc":"2.0","id":1,"method":"tools/list","data":"${"x".repeat(2 * 1024 * 1024)}"}\n`;
    // MAIN RULING INT-CONFLICT-DEFAULT, legacy proxy consumers: use the real bound
    // supervisor for the reviewed consuming transport, retaining the isolated child-id proof.
    const entry = fileURLToPath(new URL("./vps-container-mcp.ts", import.meta.url));
    const child = await spawnBoundProxy("vpsContainerMcp", process.execPath, [entry, "production-vps", vpsContainerName("bridge-test")],
      { env: { ...process.env, MURAGE_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" } });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve =>
      child.once("exit", (code, signal) => resolve({ code, signal })));
    const result = await new Promise<string[]>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("bound bridge delivery timeout")), 8000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8").on("data", chunk => {
        output += chunk;
        if (output.includes("\n")) { clearTimeout(timer); resolve(output.trimEnd().split("\n")); }
      });
      child.stderr.resume();
      child.stdin.write(input);
    });
    child.stdin.end();
    // MAIN RULING INT-CONFLICT-DEFAULT, legacy proxy consumers: EOF now
    // requires authenticated terminal refusal and exit 1 after successful delivery.
    // Observe natural bounded exit, with no helper SIGTERM replacing this assertion.
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("bound bridge exit timeout")), 8000);
      exited.then(() => clearTimeout(timer));
    })]);
    expect(exit).toEqual({ code: 1, signal: null });
    expect(boundProxyTerminal(child)).toMatchObject({ error: { code: -32099, data: { terminal: true, code: "MEMORY_CONTEXT_REVOKED" } } });
    const upstream = await readFile(wireFile, "utf8");
    // C11 6.1 I1: the child sees a bridge id; every other byte remains the caller's.
    const wireId = JSON.parse(upstream).id;
    expect(wireId).toMatch(/^mb\.[0-9a-f]{12}\.1$/);
    expect(upstream).toBe(input.replace('"id":1', `"id":${JSON.stringify(wireId)}`));
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0])).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] }, data: JSON.parse(input).data });
    expect(JSON.parse(await readFile(argsFile, "utf8")).join(" ")).toBe(
      `-H ssh://production-vps exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 ` +
        `-e CUA_DRIVER_INSTALL_CHANNEL=python_package -e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${vpsContainerName("bridge-test")} ` +
        "/usr/local/libexec/murage/cua-driver mcp --socket /run/user/1000/murage-cua.sock",
    );
  });

  it("survives docker closing stdin before consuming the request", async () => {
    const bin = await mkdtemp(join(tmpdir(), "murage-vps-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(fakeDocker, 0o700);

    const result = await runBridge(bin, "x".repeat(4 * 1024 * 1024));

    expect(result.code, result.stderr).toBe(0);
  });
});
