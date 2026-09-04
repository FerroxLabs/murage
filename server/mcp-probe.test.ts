import { mkdtempSync, writeFileSync } from "node:fs";
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

const mode = process.env.FAKE_MCP_MODE ?? "healthy";
if (mode === "silent") setInterval(() => {}, 60_000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === "initialize") {
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
});
