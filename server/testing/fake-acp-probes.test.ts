import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { expect, it } from "vitest";

it.each([
  { args: ["--version"], expected: "fake-acp 1.0.62\n" },
  { args: ["status", "--format", "json"], expected: '{"isAuthenticated":false}\n' },
  { args: ["models"], expected: "cursor-live - Cursor Live\n" },
])("flushes delayed stdout before the $args probe exits", ({ args, expected }) => {
  const fixture = new URL("./fake-acp-cli.ts", import.meta.url).href;
  const source = `
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      setTimeout(() => originalWrite(...args), 50);
      return true;
    };
    process.argv = [process.execPath, "fixture", ...${JSON.stringify(args)}];
    await import(${JSON.stringify(fixture)});
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true,
    encoding: "utf8", timeout: 5_000,
    env: { ...process.env, FAKE_ACP_AUTH: "0", FAKE_ACP_MODELS: "" },
  });
  expect(stdout).toContain(expected);
});


it.each([["response", true], ["start", true], ["response", false], ["start", false]] as const)("C11 catalog readiness with %s held and complete=%s", async (held, complete) => {
  const home = mkdtempSync(join(tmpdir(), "c11-catalog-order-"));
  const gate = join(home, "release"), waiting = held === "start" ? gate + ".waiting" : join(home, "waiting");
  const shim = join(home, "cli-mount-shim-fixture.mjs");
  writeFileSync(shim, `
    import { createInterface } from 'node:readline';
    import { existsSync, writeFileSync } from 'node:fs';
    for await (const line of createInterface({ input: process.stdin })) {
      const msg = JSON.parse(line);
      let result = {};
      if (msg.method === 'tools/list') {
        writeFileSync(${JSON.stringify(waiting)}, 'waiting');
        while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 10));
        result = { tools: [{ name: 'project_propose' }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    }
  `);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, FAKE_ACP_MODE: "c11-budget", FAKE_C11_LOG: join(home, "rpc.jsonl"),
      FAKE_C11_SPEC: JSON.stringify({ catalogs: { agents: ["project_propose"] }, native: 0, limit: 100, awaitCatalogExit: complete,
        ...(held === "start" ? { markerGate: gate, heldMount: "agents" } : {}) }) },
  });
  const frames: any[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => frames.push(JSON.parse(line)));
  const send = (id: number, method: string, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const response = async (id: number) => {
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 5000 }).toBeTruthy();
    expect(frames.find(frame => frame.id === id).error).toBeUndefined();
  };
  try {
    send(1, "initialize"); await response(1);
    send(2, "session/new", { cwd: home, mcpServers: [{ name: "agents", command: process.execPath, args: [shim], env: [] }] });
    await expect.poll(() => existsSync(waiting), { timeout: 5000 }).toBe(true);
    // A later RPC reply is the observation barrier while tools/list is held.
    send(3, "initialize"); await response(3);
    if (complete) expect(frames.some(frame => frame.id === 2), "complete catalogs must delay session/new").toBe(false);
    else expect(frames.some(frame => frame.id === 2), "early session replies must leave driver marker waits observable").toBe(true);
    writeFileSync(gate, "release");
    await response(2);
  } finally {
    writeFileSync(gate, "release");
    lines.close();
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
});
