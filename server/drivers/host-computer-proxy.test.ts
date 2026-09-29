// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The host computer's MCP proxy waits for its action however long it works;
// only Stop (MCP cancel, the engine closing the tool) or the harness ending
// the turn for silence ends it. A preload compresses any long deadline the
// proxy might set to 300 ms, so a fixed clock shows up at once.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "host-computer-proxy.ts");

describe("host computer proxy", () => {
  let dir = "";
  let server: Server;
  let port = 0;
  let delayMs = 1_500;
  const closed: IncomingMessage[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "host-proxy-"));
    writeFileSync(
      join(dir, "compress.mjs"),
      "const real = AbortSignal.timeout.bind(AbortSignal);\nAbortSignal.timeout = (ms) => real(ms >= 30000 ? 300 : ms);\n",
    );
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const timer = setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: `done ${JSON.parse(body).method}` }] }));
        }, delayMs);
        res.on("close", () => {
          clearTimeout(timer);
          if (!res.writableEnded) closed.push(req);
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", join(dir, "compress.mjs"), PROXY], {
      env: {
        ...process.env,
        MURAGE_CONTROL_URL: `http://127.0.0.1:${port}/api/internal/computer-control?botId=b1`,
        MURAGE_CONTROL_TOKEN: "t",
        MURAGE_BOT_ID: "b1",
        MURAGE_THREAD_ID: "th1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const results = new Map<number, any>();
    let buf = "";
    child.stdout!.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {
          /* not ours */
        }
      }
    });
    const rpc = (msg: unknown) => child.stdin!.write(JSON.stringify(msg) + "\n");
    return { child, results, rpc };
  };
  const waitFor = async (results: Map<number, any>, id: number, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no response for ${id}`);
  };
  const exited = (child: ChildProcess) => new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));

  it("waits out a slow action instead of giving up on a clock", async () => {
    delayMs = 1_500;
    const { child, results, rpc } = start();
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: {} } });
    const res = await waitFor(results, 1);
    expect(res.result).toEqual({ content: [{ type: "text", text: "done tools/call" }] });
    child.stdin!.end();
    await exited(child);
  }, 20_000);

  it("Stop (MCP cancel) withdraws the action at once and answers nothing", async () => {
    delayMs = 60_000;
    const before = closed.length;
    const { child, results, rpc } = start();
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } });
    await new Promise((r) => setTimeout(r, 500));
    rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    await expect.poll(() => closed.length, { timeout: 5_000 }).toBe(before + 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(results.has(2)).toBe(false);
    child.stdin!.end();
    await exited(child);
  }, 20_000);

  it("the engine closing the tool withdraws the action in flight", async () => {
    delayMs = 60_000;
    const before = closed.length;
    const { child, rpc } = start();
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: {} } });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    child.stdin!.end();
    await exited(child);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect.poll(() => closed.length, { timeout: 5_000 }).toBe(before + 1);
  }, 20_000);
});
