import { describe, expect, it, vi } from "vitest";
import {
  handleToolCall,
  processMcpMessage,
  TOOLS,
} from "../scripts/mcp-server.ts";

describe("MCP Server JSON-RPC Protocol", () => {
  it("responds to initialize with protocol version and serverInfo", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const resStr = await processMcpMessage(raw);
    expect(resStr).not.toBeNull();
    const res = JSON.parse(resStr!);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "openmausbot-mcp",
          version: "1.0.0",
        },
      },
    });
  });

  it("handles ping method", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const resStr = await processMcpMessage(raw);
    const res = JSON.parse(resStr!);
    expect(res).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  it("returns registered tools on tools/list", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const resStr = await processMcpMessage(raw);
    const res = JSON.parse(resStr!);

    expect(res.result.tools).toBeInstanceOf(Array);
    expect(res.result.tools.length).toBe(TOOLS.length);
    expect(res.result.tools.map((t: any) => t.name)).toContain("list_bots");
    expect(res.result.tools.map((t: any) => t.name)).toContain("send_bot_message");
    expect(res.result.tools.map((t: any) => t.name)).toContain("set_bot_model");
  });

  it("returns parse error for invalid JSON", async () => {
    const resStr = await processMcpMessage("not-a-valid-json");
    const res = JSON.parse(resStr!);
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("returns invalid request error for non-object, null, or array JSON", async () => {
    const nullRes = JSON.parse((await processMcpMessage("null"))!);
    expect(nullRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });

    const arrayRes = JSON.parse((await processMcpMessage("[1, 2, 3]"))!);
    expect(arrayRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });

    const primitiveRes = JSON.parse((await processMcpMessage('"just a string"'))!);
    expect(primitiveRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("suppresses response for JSON-RPC notifications without id", async () => {
    // Standard notification
    const initNotification = await processMcpMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(initNotification).toBeNull();

    // Ping notification without id
    const pingNotification = await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    expect(pingNotification).toBeNull();

    // tools/list notification without id
    const listNotification = await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }));
    expect(listNotification).toBeNull();
  });

  it("negotiates protocol version by returning server-supported version", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const resStr = await processMcpMessage(raw);
    const res = JSON.parse(resStr!);
    // Per MCP spec: server returns its supported version for client negotiation
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "openmausbot-mcp",
          version: "1.0.0",
        },
      },
    });
  });

  it("returns method not found for unrecognized methods", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "unknown/method" });
    const resStr = await processMcpMessage(raw);
    const res = JSON.parse(resStr!);
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Method not found: unknown/method" },
    });
  });

  it("rejects requests missing or invalid jsonrpc 2.0 field with null id", async () => {
    // Missing jsonrpc entirely
    const noField = JSON.parse((await processMcpMessage(JSON.stringify({ id: 50, method: "ping" })))!);
    expect(noField).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: missing or invalid jsonrpc version" },
    });

    // Wrong jsonrpc version with malformed ID object
    const wrongVersion = JSON.parse(
      (await processMcpMessage(JSON.stringify({ jsonrpc: "1.0", id: { objectId: true }, method: "ping" })))!,
    );
    expect(wrongVersion).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: missing or invalid jsonrpc version" },
    });
  });

  it("validates message.id accepting string or number and rejecting other types", async () => {
    // Valid string ID
    const strIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: "req-abc", method: "ping" })))!);
    expect(strIdRes).toEqual({ jsonrpc: "2.0", id: "req-abc", result: {} });

    // Valid number ID
    const numIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "ping" })))!);
    expect(numIdRes).toEqual({ jsonrpc: "2.0", id: 123, result: {} });

    // Invalid ID: boolean
    const boolIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: true, method: "ping" })))!);
    expect(boolIdRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be a string or number" },
    });

    // Invalid ID: object
    const objIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: { sub: 1 }, method: "ping" })))!);
    expect(objIdRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be a string or number" },
    });

    // Invalid ID: array
    const arrIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: [1, 2], method: "ping" })))!);
    expect(arrIdRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be a string or number" },
    });

    // Invalid ID: null
    const nullIdRes = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" })))!);
    expect(nullIdRes).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be a string or number" },
    });
  });
});

describe("MCP Server Tool Execution", () => {
  it("executes get_system_health", async () => {
    const mockFetcher = vi.fn(async (path: string) => {
      if (path === "/api/health") return { ok: true, uptime: 1234 };
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall("get_system_health", {}, mockFetcher);
    expect(mockFetcher).toHaveBeenCalledWith("/api/health");
    expect(res).toMatchObject({ status: "connected", ok: true, uptime: 1234 });
  });

  it("executes list_bots", async () => {
    const mockFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots") {
        return {
          bots: [
            { id: "bot-1", name: "Deckard", description: "Detective", busy: false, unread: false, messages: [{ id: "m1" }] },
            { id: "bot-2", name: "Rachael", description: "Assistant", busy: true, unread: true, messages: [] },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall("list_bots", {}, mockFetcher);
    expect(res.bots).toHaveLength(2);
    expect(res.bots[0]).toMatchObject({ id: "bot-1", name: "Deckard", messageCount: 1, busy: false });
    expect(res.bots[1]).toMatchObject({ id: "bot-2", name: "Rachael", messageCount: 0, busy: true });
  });

  it("executes get_bot_messages with limit", async () => {
    const mockFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots") {
        return {
          bots: [
            {
              id: "bot-1",
              name: "Deckard",
              messages: [
                { id: "m1", role: "user", text: "hello" },
                { id: "m2", role: "assistant", text: "world" },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall("get_bot_messages", { bot_id: "bot-1", limit: 1 }, mockFetcher);
    expect(res.botId).toBe("bot-1");
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toMatchObject({ id: "m2", text: "world" });

    // Verify negative or non-positive limit falls back to default without breaking slice
    const defaultLimitRes: any = await handleToolCall("get_bot_messages", { bot_id: "bot-1", limit: -5 }, mockFetcher);
    expect(defaultLimitRes.messages).toHaveLength(2);
  });

  it("throws when get_bot_messages targets non-existent bot", async () => {
    const mockFetcher = vi.fn(async () => ({ bots: [] }));
    await expect(handleToolCall("get_bot_messages", { bot_id: "missing" }, mockFetcher)).rejects.toThrow(
      "Bot not found: missing",
    );
  });

  it("executes send_bot_message with URL encoding", async () => {
    const mockFetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots/bot%2Fspecial%231/messages") {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(options?.body as string)).toEqual({ text: "investigate scene" });
        return { ok: true };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall(
      "send_bot_message",
      { bot_id: "bot/special#1", text: "investigate scene" },
      mockFetcher,
    );
    expect(res).toMatchObject({ success: true, result: { ok: true } });
  });

  it("executes set_bot_model with optional effort and encoded bot_id", async () => {
    const mockFetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots/bot%201") {
        expect(options?.method).toBe("PATCH");
        expect(JSON.parse(options?.body as string)).toEqual({
          modelSelection: { instanceId: "openaiCompat", effort: "high" },
        });
        return { bot: { id: "bot 1", modelSelection: { instanceId: "openaiCompat", effort: "high" } } };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall(
      "set_bot_model",
      { bot_id: "bot 1", instance_id: "openaiCompat", effort: "high" },
      mockFetcher,
    );
    expect(res.success).toBe(true);
    expect(res.bot.modelSelection.instanceId).toBe("openaiCompat");
  });

  it("executes list_rooms mapping bulletin to topic and get_room_messages", async () => {
    const mockFetcher = vi.fn(async (path: string) => {
      if (path === "/api/bots") {
        return {
          groups: [
            {
              id: "room-1",
              name: "War Room",
              bulletin: "Shared incident brief",
              memberIds: ["bot-1", "bot-2"],
              messages: [{ id: "rm-1", role: "user", text: "Status update please" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const roomsRes: any = await handleToolCall("list_rooms", {}, mockFetcher);
    expect(roomsRes.rooms).toHaveLength(1);
    expect(roomsRes.rooms[0].name).toBe("War Room");
    expect(roomsRes.rooms[0].topic).toBe("Shared incident brief");

    const messagesRes: any = await handleToolCall("get_room_messages", { group_id: "room-1", limit: -10 }, mockFetcher);
    expect(messagesRes.roomId).toBe("room-1");
    expect(messagesRes.messages).toHaveLength(1);
    expect(messagesRes.messages[0].text).toBe("Status update please");
  });

  it("executes interrupt_bot with encoded bot_id", async () => {
    const mockFetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/bots/bot%3A1/interrupt") {
        expect(options?.method).toBe("POST");
        return { ok: true };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const res: any = await handleToolCall("interrupt_bot", { bot_id: "bot:1" }, mockFetcher);
    expect(res.success).toBe(true);
  });

  it("throws on unknown tool", async () => {
    await expect(handleToolCall("non_existent_tool", {})).rejects.toThrow("Unknown tool: non_existent_tool");
  });
});

describe("MCP Base URL Security & Timeout", () => {
  it("allows loopback http URLs and https URLs", async () => {
    const { validateBaseUrl } = await import("../scripts/mcp-server.ts");
    expect(validateBaseUrl("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    expect(validateBaseUrl("http://localhost:8799/")).toBe("http://localhost:8799");
    expect(validateBaseUrl("http://[::1]:8799")).toBe("http://[::1]:8799");
    expect(validateBaseUrl("https://openmausbot.internal.net/api/")).toBe("https://openmausbot.internal.net/api");
  });

  it("rejects non-loopback http endpoints unless ALLOW_INSECURE_HTTP is enabled", async () => {
    const { validateBaseUrl } = await import("../scripts/mcp-server.ts");
    const prevEnv = process.env.ALLOW_INSECURE_HTTP;
    try {
      delete process.env.ALLOW_INSECURE_HTTP;
      expect(() => validateBaseUrl("http://remote-server.com:8799")).toThrow(
        "Insecure cleartext HTTP origin 'http://remote-server.com:8799' is rejected",
      );

      process.env.ALLOW_INSECURE_HTTP = "true";
      expect(validateBaseUrl("http://remote-server.com:8799")).toBe("http://remote-server.com:8799");
    } finally {
      if (prevEnv !== undefined) {
        process.env.ALLOW_INSECURE_HTTP = prevEnv;
      } else {
        delete process.env.ALLOW_INSECURE_HTTP;
      }
    }
  });

  it("attaches timeout signal to request fetch calls", async () => {
    const { request } = await import("../scripts/mcp-server.ts");
    const originalFetch = globalThis.fetch;
    try {
      let passedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn(async (_url: any, options: any) => {
        passedSignal = options?.signal;
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as any;
      });

      await request("/api/health");
      expect(passedSignal).toBeDefined();
      expect(passedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
