import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import extension, {
  allocateToolName,
  StdioMcp,
  toTypebox,
  truncateToolText,
} from "./pi-mcp-extension.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const tempDirs: string[] = [];
const clients: StdioMcp[] = [];
const originalMcpConfig = process.env.MURAGE_MCP_CONFIG;

type ExtensionApi = Parameters<typeof extension>[0];
type RegisteredTool = Parameters<ExtensionApi["registerTool"]>[0];
type ShutdownHandler = Parameters<ExtensionApi["on"]>[1];

interface SchemaNode {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  properties?: Record<string, SchemaNode>;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "murage-pi-mcp-ext-"));
  tempDirs.push(dir);
  return dir;
}

function fakeMcpScript(source: string): string {
  const dir = tempDir();
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function createClient(source: string, env: Record<string, string> = {}): StdioMcp {
  const client = new StdioMcp({ command: process.execPath, args: [fakeMcpScript(source)], env });
  clients.push(client);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
  if (originalMcpConfig === undefined) delete process.env.MURAGE_MCP_CONFIG;
  else process.env.MURAGE_MCP_CONFIG = originalMcpConfig;
});

describe("Pi MCP JSON Schema conversion", () => {
  it("keeps the cua browser_prepare regression schema object-shaped at the root", () => {
    const schema = toTypebox({
      type: "object",
      additionalProperties: true,
      anyOf: [
        { required: ["pid"] },
        {
          properties: {
            allow_launch: { const: true },
            profile: { properties: { mode: { enum: ["isolated_new", "isolated_named"] } } },
          },
          required: ["allow_launch", "profile"],
        },
      ],
      properties: {
        allow_launch: { type: "boolean" },
        pid: { type: "integer" },
        profile: {
          type: "object",
          properties: { mode: { type: "string", enum: ["isolated_new", "isolated_named"] } },
          required: ["mode"],
        },
      },
      required: [],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.additionalProperties).toBe(true);
    expect(inspected.properties?.pid.type).toBe("integer");
    expect(inspected.properties?.profile.type).toBe("object");
    expect(inspected.properties?.profile.required).toEqual(["mode"]);
  });

  it("preserves nested combinators, nullability, const and Google-compatible string enums", () => {
    const schema = toTypebox({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        flag: { type: ["boolean", "null"] },
        mode: { type: "string", enum: ["ax", "vision"] },
        enabled: { const: true },
      },
      required: ["value"],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.required).toEqual(["value"]);
    expect(inspected.properties?.value.anyOf?.map((item) => item.type)).toEqual(["string", "null"]);
    expect(inspected.properties?.flag.anyOf?.map((item) => item.type)).toEqual(["boolean", "null"]);
    expect(inspected.properties?.mode).toMatchObject({ type: "string", enum: ["ax", "vision"] });
    expect(inspected.properties?.enabled).toMatchObject({ type: "boolean", const: true });
  });

  it("collects properties declared only inside root combinator branches", () => {
    const schema = toTypebox({
      oneOf: [
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(Object.keys(inspected.properties ?? {})).toEqual(["query", "id"]);
    // A field required by only one choice cannot be globally required.
    expect(inspected.required).toBeUndefined();
  });

  it("always returns an object schema for malformed, nullable or absent root schemas", () => {
    expect(toTypebox(undefined)).toMatchObject({ type: "object" });
    expect(toTypebox({ anyOf: [] })).toMatchObject({ type: "object" });
    expect(toTypebox({ type: "object", nullable: true })).toMatchObject({ type: "object" });
  });
});

describe("Pi MCP tool names and output bounds", () => {
  it("keeps collision suffixes inside the provider 64-character limit", () => {
    const used = new Set<string>();
    const long = "x".repeat(100);
    const names = Array.from({ length: 12 }, () => {
      const name = allocateToolName("computer", long, used);
      used.add(name);
      return name;
    });

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names.at(-1)).toMatch(/_12$/);
  });

  it("truncates by lines and UTF-8 bytes without splitting a code point", () => {
    const manyLines = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
    expect(truncateToolText(manyLines)).toContain("2000-line limit");

    const manyAccents = "á".repeat(30_000);
    const truncated = truncateToolText(manyAccents);
    expect(truncated).toContain("50KB limit");
    expect(truncated).not.toContain("�");
  });
});

describe("StdioMcp", () => {
  it("initializes, paginates tools/list, preserves images and truncates text", async () => {
    const client = createClient(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list" && !msg.params?.cursor) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "second", inputSchema: { type: "object" } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [
            { type: "text", text: "x".repeat(60 * 1024) },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
          ] } });
        }
      });
    `);

    await client.init();
    await expect(client.listTools()).resolves.toMatchObject([{ name: "first" }, { name: "second" }]);
    const result = await client.callTool("first", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("50KB limit") });
    expect(result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });

  it("propagates abort and sends MCP notifications/cancelled", async () => {
    const dir = tempDir();
    const dump = join(dir, "cancel.json");
    const client = createClient(
      `
        import { writeFileSync } from "node:fs";
        let buffer = "";
        process.stdin.setEncoding("utf8");
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
            else if (msg.method === "notifications/cancelled") writeFileSync(process.env.DUMP, JSON.stringify(msg.params));
          }
        });
      `,
      { DUMP: dump },
    );
    await client.init();
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8"))).toMatchObject({ requestId: 2 }));
  });

  it("gives a tool call no fixed deadline: it runs until it answers or the turn stops", async () => {
    const client = createClient(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
        }
      });
    `);
    await client.init();
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const controller = new AbortController();
      const pending = client.callTool("long_job", {}, controller.signal);
      const settled = pending.then(() => "answered", (error: Error) => error.message);
      // the old ten-minute call deadline stopped long work that was still running
      expect(timers.mock.calls.filter(([, ms]) => typeof ms === "number" && ms >= 60_000)).toEqual([]);
      controller.abort();
      expect(await settled).toMatch(/aborted/);
    } finally {
      timers.mockRestore();
    }
  });
});

describe("Pi MCP extension registration", () => {
  it("keeps earlier tools alive when a later registration fails", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "good", inputSchema: { type: "object", properties: {} } },
            { name: "bad", inputSchema: { type: "object", properties: {} } }
          ] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "still alive" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        if (tool.name.endsWith("_bad")) throw new Error("synthetic registration failure");
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("synthetic registration failure"));
    await expect(
      tools[0].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "still alive" }] });
    await handlers.get("session_shutdown")?.();
  });

  it("throws when an MCP tool result declares isError", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "remote failure" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;

    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools).toHaveLength(1);
    await expect(
      tools[0].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).rejects.toThrow("remote failure");
    await handlers.get("session_shutdown")?.();
  });

  it("asks before every call to a server with scope custom, and a deny blocks the call (MCP-LINK T9)", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "run_workflow", inputSchema: { type: "object", properties: {} } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ran it" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { comfy: { command: process.execPath, args: [script], scope: "custom" } } }));
    process.env.MURAGE_MCP_CONFIG = config;

    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) { tools.push(tool); },
      on(event, handler) { handlers.set(event, handler); },
    });
    expect(tools).toHaveLength(1);

    const asked: string[] = [];
    const deny = await tools[0].execute("call-1", {}, undefined, undefined, { ui: { confirm: async (title: string) => { asked.push(title); return false; } } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("run_workflow");
    expect(deny).toMatchObject({ content: [{ type: "text", text: "Blocked by the user." }] });

    const allow = await tools[0].execute("call-2", {}, undefined, undefined, { ui: { confirm: async (title: string) => { asked.push(title); return true; } } });
    expect(asked).toHaveLength(2);
    expect(allow).toMatchObject({ content: [{ type: "text", text: "ran it" }] });
    await handlers.get("session_shutdown")?.();
  });

  it("does not ask for a server without a scope", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "go", inputSchema: { type: "object", properties: {} } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "went" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { plain: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    let asked = 0;
    await expect(tools[0].execute("c", {}, undefined, undefined, { ui: { confirm: async () => { asked += 1; return false; } } }))
      .resolves.toMatchObject({ content: [{ type: "text", text: "went" }] });
    expect(asked).toBe(0);
    await handlers.get("session_shutdown")?.();
  });

  it("lists again while the server's list is a stand-in, so Pi mounts the real tools", async () => {
    const script = fakeMcpScript(`
      let buffer = "", lists = 0;
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: { listChanged: true } } } });
          else if (msg.method === "tools/list") {
            lists += 1;
            if (lists < 3) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "STANDIN", inputSchema: { type: "object", properties: {} } }], _meta: { "murage/provisional": true } } });
            else send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "REAL", inputSchema: { type: "object", properties: {} } }] } });
          }
        }
      });
    `);
    const config = join(tempDir(), "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    expect(tools.map((tool) => tool.name)).toEqual([expect.stringMatching(/real$/i)]);
    await handlers.get("session_shutdown")?.();
  });

  it("registers tools the server announces after the mount (list_changed), since Pi cannot refresh a session", async () => {
    const script = fakeMcpScript(`
      let buffer = "", lists = 0;
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: { listChanged: true } } } });
          else if (msg.method === "tools/list") {
            lists += 1;
            const tools = [{ name: "first", inputSchema: { type: "object", properties: {} } }];
            if (lists > 1) tools.push({ name: "second", inputSchema: { type: "object", properties: {} } });
            send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
            if (lists === 1) setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 200);
          }
        }
      });
    `);
    const config = join(tempDir(), "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    expect(tools).toHaveLength(1);
    await vi.waitFor(() => expect(tools.map((tool) => tool.name)).toEqual([expect.stringMatching(/first$/), expect.stringMatching(/second$/)]), { timeout: 3_000 });
    await handlers.get("session_shutdown")?.();
  });

  it("keeps a mount alive when the list is still a stand-in after the settle window, and mounts the tools when they arrive (never disposed for a slow harness)", async () => {
    const script = fakeMcpScript(`
      let buffer = "", ready = false;
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      setTimeout(() => { ready = true; send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }, 5200);
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: { listChanged: true } } } });
          else if (msg.method === "tools/list") {
            if (!ready) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [], _meta: { "murage/provisional": true } } });
            else send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "APPROVED", inputSchema: { type: "object", properties: {} } }] } });
          }
        }
      });
    `);
    const config = join(tempDir(), "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    expect(tools).toHaveLength(0); // the settle window ended with nothing but a stand-in
    await vi.waitFor(() => expect(tools.map((tool) => tool.name)).toEqual([expect.stringMatching(/approved$/i)]), { timeout: 8_000 });
    await handlers.get("session_shutdown")?.();
  }, 30_000);

  it("replaces a tool whose description or schema changed, and retires a tool the server dropped", async () => {
    const script = fakeMcpScript(`
      let buffer = "", lists = 0;
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: { listChanged: true } } } });
          else if (msg.method === "tools/list") {
            lists += 1;
            const tools = lists === 1
              ? [
                  { name: "EXEC", description: "accounts: A", inputSchema: { type: "object", properties: { account: { type: "string", enum: ["A"] } } } },
                  { name: "DROPPED", description: "old", inputSchema: { type: "object", properties: {} } },
                ]
              : [{ name: "EXEC", description: "accounts: A, B", inputSchema: { type: "object", properties: { account: { type: "string", enum: ["A", "B"] } } } }];
            send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
            if (lists === 1) setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 200);
          }
        }
      });
    `);
    const config = join(tempDir(), "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script], murageMountId: "custom:test" } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const registrations: RegisteredTool[] = [];
    let active = ["test_exec", "test_dropped", "read"];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) { registrations.push(tool); },
      getActiveTools() { return active; },
      setActiveTools(names: string[]) { active = names; },
      on(event, handler) { handlers.set(event, handler); },
    });
    expect(registrations.map((tool) => tool.name)).toEqual(["test_exec", "test_dropped"]);
    await vi.waitFor(() => expect(registrations.length).toBe(4), { timeout: 3_000 });
    const replaced = registrations.filter((tool) => tool.name === "test_exec");
    expect(replaced).toHaveLength(2);
    expect(replaced[1]!.description).toBe("accounts: A, B");
    expect(JSON.stringify(replaced[1]!.parameters)).toContain('"B"');
    const retired = registrations.filter((tool) => tool.name === "test_dropped")[1]!;
    await expect(retired.execute("c", {}, undefined, undefined, { ui: { confirm: async () => true } }))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("no longer available") }] });
    expect(active).toEqual(["test_exec", "read"]);
    // Rule 14b: the gate's table holds the live tool with its mount, and the retired one is gone
    const table = (globalThis as Record<string, unknown>).__murageMcpTools as Map<string, unknown>;
    expect(table.get("test_exec")).toEqual({ piName: "test_exec", mount: "test", mcpTool: "EXEC", mountId: "custom:test" });
    expect(table.has("test_dropped")).toBe(false);
    await handlers.get("session_shutdown")?.();
  });

  const listServer = (names: string[]) => fakeMcpScript(`
    let buffer = "";
    process.stdin.setEncoding("utf8");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
        else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: ${JSON.stringify(names)}.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) } });
        else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ran" }] } });
      }
    });
  `);

  it("T12/T37: a suffixed piName maps to the right mount and tool in the table, by entry, not by parsing", async () => {
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: {
      a: { command: process.execPath, args: [listServer(["b_c"])], murageMountId: "custom:a" },
      a_b: { command: process.execPath, args: [listServer(["c"])], murageMountId: "custom:a_b" },
    } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["a_b_c", "a_b_c_2"]);
    const table = (globalThis as Record<string, unknown>).__murageMcpTools as Map<string, { mount: string; mcpTool: string }>;
    const rows = names.map((name) => `${table.get(name)!.mount}/${table.get(name)!.mcpTool}`).sort();
    expect(rows).toEqual(["a/b_c", "a_b/c"]);
    await handlers.get("session_shutdown")?.();
  });

  it("raises no confirm of its own when the permission gate asks for the call", async () => {
    const config = join(tempDir(), "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { cust: { command: process.execPath, args: [listServer(["go"])], scope: "custom", murageGated: true } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    let asked = 0;
    await expect(tools[0]!.execute("c", {}, undefined, undefined, { ui: { confirm: async () => { asked += 1; return false; } } }))
      .resolves.toMatchObject({ content: [{ type: "text", text: "ran" }] });
    expect(asked).toBe(0);
    await handlers.get("session_shutdown")?.();
  });
});
