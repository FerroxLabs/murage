import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { probeMcpServer } from "./mcp-probe.ts";

// A minimal stdio MCP server, written to a temp dir rather than shipped as a
// repo fixture: it exists only for this file. FAKE_MCP_MODE=silent never
// answers the handshake, which is what the timeout and cancel cases need.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_MCP_MODE ?? "healthy";
if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));
if (mode === "silent") setInterval(() => {}, 60_000);
else {
  const lines = createInterface({ input: process.stdin });
  let initialized = false;
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === "notifications/initialized") initialized = true;
    if (frame.method === "initialize") {
      if (mode === "tools-before-initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }) + "\\n");
        return;
      }
      if (mode === "initialize-error") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: {
          code: -32603, message: "Untrusted native details: " + process.env.SECRET_TOKEN,
        } }) + "\\n");
        return;
      }
      if (mode === "malformed-initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: true }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1" },
        },
      }) + "\\n");
    }
    if (frame.method === "tools/list") {
      if (!initialized || mode === "tools-error") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: {
          code: -32603, message: "Untrusted tools error: " + process.env.SECRET_TOKEN,
        } }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: { tools: [{
          name: "read_notes",
          description: process.env.FAKE_MCP_DESCRIPTION ?? "Read saved notes",
        }] },
      }) + "\\n");
    }
  });
}
`;

let dir = "";
let fakeServer = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-mcp-probe-"));
  fakeServer = join(dir, "fake-mcp-server.mjs");
  writeFileSync(fakeServer, FAKE_SERVER);
});

afterAll(async () => {
  if (dir) await removeTempDir(dir);
});

describe("custom MCP probe", () => {
  it("performs an MCP handshake and returns the bounded public tool list", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: [fakeServer],
      env: {},
      enabled: false,
    }, 5_000)).resolves.toEqual({
      ok: true,
      tools: [{ name: "read_notes", description: "Read saved notes" }],
    });
  });

  it("times out a server that never completes initialization", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: [fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }, 100)).resolves.toEqual({ ok: false, error: "The server did not answer in time." });
  });

  it.each(["tools-before-initialize", "initialize-error", "malformed-initialize"])(
    "rejects %s promptly, sanitizes the failure, and stops the child",
    async (mode) => {
      const pidFile = join(dir, `${mode}.pid`);
      const result = await probeMcpServer({
        command: process.execPath,
        args: [fakeServer],
        env: { FAKE_MCP_MODE: mode, FAKE_MCP_PID_FILE: pidFile, SECRET_TOKEN: "never-render-this" },
        enabled: false,
      }, 2_000);
      // The fake child stays alive and never follows this response with a
      // valid initialize result. A timeout/close is not an acceptable stand-in
      // for recognizing and reporting the initialization failure.
      expect(result).toEqual({ ok: false, error: "The server did not complete MCP initialization." });
      expect(JSON.stringify(result)).not.toMatch(/never-render-this|Untrusted|SECRET_TOKEN/);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      await expect.poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, { timeout: 2_000 }).toBe(true);
    },
  );

  it("sanitizes tools-list errors after a successful initialization", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: [fakeServer],
      env: { FAKE_MCP_MODE: "tools-error", SECRET_TOKEN: "never-render-this" },
      enabled: false,
    }, 2_000)).resolves.toEqual({ ok: false, error: "The command did not return a valid MCP tools list." });
  });

  it("stops a probe when its caller disconnects", async () => {
    const controller = new AbortController();
    const pending = probeMcpServer({
      command: process.execPath,
      args: [fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }, 5_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: "Connection test was cancelled." });
  });

  it("does not expose native spawn details", async () => {
    const result = await probeMcpServer({
      command: "/definitely/missing/murage-mcp",
      args: [],
      env: { SECRET_TOKEN: "never-render-this" },
      enabled: false,
    }, 1_000);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(result)).not.toContain("never-render-this");
    expect(JSON.stringify(result)).not.toContain("/definitely/missing");
  });

  it("redacts a configured value even if a server echoes it in tool metadata", async () => {
    const result = await probeMcpServer({
      command: process.execPath,
      args: [fakeServer],
      env: { FAKE_MCP_DESCRIPTION: "token=very-secret-value" },
      enabled: false,
    }, 5_000);
    expect(result).toEqual({
      ok: true,
      tools: [{ name: "read_notes", description: "[redacted]" }],
    });
    expect(JSON.stringify(result)).not.toContain("very-secret-value");
  });
  it("answers instead of hanging when a server closes stdin mid-handshake", async () => {
    // A server that replies to initialize and then closes its read end. The
    // probe writes two more frames after that reply, so this is the shape
    // where a write can meet a pipe with no reader.
    //
    // HONEST SCOPE: an unhandled stdin 'error' DOES kill a node process — I
    // reproduced that standalone (uncaught EPIPE, exit 42) — but I could not
    // reach it through probeMcpServer with any fixture I tried; the probe
    // settles on `close` first. The listener in mcp-probe.ts is therefore
    // cheap defensive hardening, NOT a fix for a demonstrated crash, and this
    // test pins the behaviour that is actually observable: the probe answers.
    const dir = mkdtempSync(join(tmpdir(), "murage-mcp-epipe-"));
    const server = join(dir, "answers-then-closes.mjs");
    writeFileSync(server, [
      'process.stdin.once("data", () => {',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } } }) + "\\n");',
      '  process.stdin.destroy();',
      '  setTimeout(() => {}, 5000);',
      '});',
    ].join("\n"));

    const result = await probeMcpServer({
      command: process.execPath,
      args: [server],
      env: {},
      enabled: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe("string");
    await removeTempDir(dir);
  }, 30_000);
});
