import { boundProxyTerminal, spawnBoundProxy } from "./testing/bound-proxy-fixture.ts";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER, CUA_EXECUTABLE, CUA_SOCKET } from "./container-computer.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => removeTempDir(path)));
});

// The fake Docker executable below is a POSIX shell script. The production
// bridge remains portable; only this byte-for-byte process fixture is gated.
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Local VM Cua MCP bridge", () => {
  it("preserves MCP fields with an isolated request id to cua-driver mcp over the container runtime", async () => {
    const bin = await mkdtemp(join(tmpdir(), "murage-container-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    const argsFile = join(bin, "args.txt");
    const inputFile = join(bin, "input.json");
    await writeFile(
      fakeDocker,
      `#!${process.execPath}
const fs = require('node:fs'), rl = require('node:readline');
fs.writeFileSync(process.env.FIXTURE_ARGS_FILE, 'ARGS:' + process.argv.slice(2).join(' ') + '\\n');
rl.createInterface({ input: process.stdin }).on('line', line => {
  fs.writeFileSync(process.env.FIXTURE_INPUT_FILE, line);
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: request.jsonrpc, id: request.id, result: { tools: [] } }) + '\\n');
});
`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const child = await spawnBoundProxy(
      "containerMcp",
      process.execPath,
      [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
      {
        windowsHide: true,
        env: { ...process.env, MURAGE_EXTRA_PATH: bin, FIXTURE_ARGS_FILE: argsFile, FIXTURE_INPUT_FILE: inputFile, NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) child.stdin.end();
      });
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(input);
    });

    // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: first prove the live
    // response; subsequent EOF seals the consuming lease and exits terminally.
    expect(result.code).toBe(1);
    expect(boundProxyTerminal(child)).toMatchObject({ error: { code: -32099, data: { terminal: true } } });
    // C11 6.1 I1: the child sees a bridge id; every other byte remains the caller's.
    // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: the runtime must answer
    // the request, not echo a colliding server request. Check both actual wires.
    const forwarded = await readFile(inputFile, "utf8"), wireId = JSON.parse(forwarded).id;
    expect(wireId).toMatch(/^mb\.[0-9a-f]{12}\.1$/);
    expect(forwarded + "\n").toBe(input.replace('"id":1', `"id":${JSON.stringify(wireId)}`));
    expect(result.stdout).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: upstream diagnostics are
    // private; inspect the fake runtime capture while requiring empty stderr.
    expect(result.stderr).not.toContain("ARGS:");
    expect(await readFile(argsFile, "utf8")).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });
});
