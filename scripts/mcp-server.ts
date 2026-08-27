#!/usr/bin/env node
// Model Context Protocol (MCP) Server for OpenMausBot
// Standard JSON-RPC 2.0 stdio transport for external agent orchestration (Hermes, Claude Desktop, Cursor, etc.).
import readline from "node:readline";

export const OMB_BASE_URL = (
  process.env.OPENMAUSBOT_URL ||
  (process.env.OMB_PORT ? `http://127.0.0.1:${process.env.OMB_PORT}` : "http://127.0.0.1:8799")
).replace(/\/+$/, "");

export function log(msg: string) {
  process.stderr.write(`[openmausbot-mcp] ${msg}\n`);
}

export async function request(path: string, options: RequestInit = {}, baseUrl = OMB_BASE_URL) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenMausBot API error (${response.status}): ${text || response.statusText}`);
  }
  return response.json().catch(() => ({}));
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: McpToolDefinition[] = [
  {
    name: "get_system_health",
    description: "Check OpenMausBot server connectivity, uptime, and health status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_bots",
    description: "List all bots in OpenMausBot with their IDs, names, descriptions, assigned model instances, and busy statuses.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_bot_messages",
    description: "Retrieve recent conversation messages and transcripts for a specific bot.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        limit: { type: "number", description: "Maximum number of messages to retrieve (default: 30)." },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "send_bot_message",
    description: "Send a user message to a bot and start a new turn.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot to message." },
        text: { type: "string", description: "The message content/instruction to send." },
      },
      required: ["bot_id", "text"],
    },
  },
  {
    name: "list_rooms",
    description: "List all multi-agent conversation rooms/groups in OpenMausBot.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_room_messages",
    description: "Retrieve recent conversation messages in a multi-agent room/group.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "The ID of the room/group." },
        limit: { type: "number", description: "Maximum number of messages to retrieve (default: 30)." },
      },
      required: ["group_id"],
    },
  },
  {
    name: "send_room_message",
    description: "Send a message into a multi-agent room/group.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "The ID of the room/group to message." },
        text: { type: "string", description: "The message content to post into the room." },
      },
      required: ["group_id", "text"],
    },
  },
  {
    name: "set_bot_model",
    description: "Change the active model provider or instance for a bot (e.g. 'claude', 'codex', 'openaiCompat', etc.).",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        instance_id: { type: "string", description: "The instance ID (e.g. 'claude', 'codex', 'openaiCompat', etc.)." },
        effort: { type: "string", description: "Optional reasoning effort level (e.g. 'low', 'medium', 'high')." },
      },
      required: ["bot_id", "instance_id"],
    },
  },
  {
    name: "list_available_models",
    description: "List all configured model engines, providers, and available models in OpenMausBot.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "interrupt_bot",
    description: "Interrupt and cancel an ongoing turn for a bot.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot to interrupt." },
      },
      required: ["bot_id"],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  fetcher: (path: string, options?: RequestInit) => Promise<any> = request,
): Promise<unknown> {
  switch (name) {
    case "get_system_health": {
      const res = await fetcher("/api/health");
      return { status: "connected", endpoint: OMB_BASE_URL, ...res };
    }

    case "list_bots": {
      const res = await fetcher("/api/bots");
      const bots = ((res.bots as Array<Record<string, unknown>>) || []).map((bot) => ({
        id: bot.id,
        name: bot.name,
        title: bot.title,
        description: bot.description,
        modelSelection: bot.modelSelection,
        busy: Boolean(bot.busy),
        unread: Boolean(bot.unread),
        messageCount: (bot.messages as Array<unknown> | undefined)?.length || 0,
      }));
      return { bots };
    }

    case "get_bot_messages": {
      const res = await fetcher("/api/bots");
      const bot = ((res.bots as Array<Record<string, unknown>>) || []).find((b) => b.id === args.bot_id);
      if (!bot) throw new Error(`Bot not found: ${args.bot_id}`);
      const limit = Number(args.limit) || 30;
      const messages = ((bot.messages as Array<Record<string, unknown>>) || []).slice(-limit).map((msg) => ({
        id: msg.id,
        role: msg.role,
        text: msg.text,
        kind: msg.kind,
        createdAt: msg.createdAt,
        error: msg.error,
        card: msg.card,
      }));
      return { botId: bot.id, name: bot.name, messages };
    }

    case "send_bot_message": {
      const res = await fetcher(`/api/bots/${args.bot_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: args.text }),
      });
      return { success: true, result: res };
    }

    case "list_rooms": {
      const res = await fetcher("/api/bots");
      const groups = ((res.groups as Array<Record<string, unknown>>) || []).map((g) => ({
        id: g.id,
        name: g.name,
        topic: g.topic,
        memberIds: g.memberIds,
        busyBotId: g.busyBotId,
        messageCount: (g.messages as Array<unknown> | undefined)?.length || 0,
      }));
      return { rooms: groups };
    }

    case "get_room_messages": {
      const res = await fetcher("/api/bots");
      const group = ((res.groups as Array<Record<string, unknown>>) || []).find((g) => g.id === args.group_id);
      if (!group) throw new Error(`Room/Group not found: ${args.group_id}`);
      const limit = Number(args.limit) || 30;
      const messages = ((group.messages as Array<Record<string, unknown>>) || []).slice(-limit).map((msg) => ({
        id: msg.id,
        role: msg.role,
        from: msg.from,
        text: msg.text,
        kind: msg.kind,
        createdAt: msg.createdAt,
        error: msg.error,
      }));
      return { roomId: group.id, name: group.name, messages };
    }

    case "send_room_message": {
      const res = await fetcher(`/api/groups/${args.group_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: args.text }),
      });
      return { success: true, result: res };
    }

    case "set_bot_model": {
      const patch: Record<string, unknown> = {
        modelSelection: {
          instanceId: args.instance_id,
        },
      };
      if (args.effort) (patch.modelSelection as Record<string, unknown>).effort = args.effort;
      const res = await fetcher(`/api/bots/${args.bot_id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { success: true, bot: res.bot };
    }

    case "list_available_models": {
      const res = await fetcher("/api/instances");
      return res;
    }

    case "interrupt_bot": {
      const res = await fetcher(`/api/bots/${args.bot_id}/interrupt`, {
        method: "POST",
      });
      return { success: true, result: res };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function formatResponse(id: string | number | null, result?: unknown, error?: { code?: number; message?: string }) {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error) {
    payload.error = {
      code: error.code || -32603,
      message: error.message || String(error),
    };
  } else {
    payload.result = result;
  }
  return JSON.stringify(payload);
}

export async function processMcpMessage(
  raw: string,
  toolHandler: typeof handleToolCall = handleToolCall,
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let message: any;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return formatResponse(null, undefined, { code: -32700, message: "Parse error" });
  }

  const { id = null, method, params } = message;

  try {
    if (method === "initialize") {
      return formatResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "openmausbot-mcp",
          version: "1.0.0",
        },
      });
    }

    if (method === "notifications/initialized") {
      log("MCP client initialized session");
      return null;
    }

    if (method === "ping") {
      return formatResponse(id, {});
    }

    if (method === "tools/list") {
      return formatResponse(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      const { name, arguments: toolArgs } = params || {};
      const result = await toolHandler(name, toolArgs || {});
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      });
    }

    return formatResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  } catch (err: any) {
    log(`Error handling ${method}: ${err?.message || err}`);
    if (id !== undefined && id !== null) {
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: `Error: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      });
    }
    return null;
  }
}

// Start stdio interface when executed directly
if (process.argv[1] && (process.argv[1].endsWith("mcp-server.ts") || process.argv[1].endsWith("mcp-server.js"))) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const response = await processMcpMessage(line);
    if (response) {
      process.stdout.write(response + "\n");
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  log("OpenMausBot MCP server running on stdio");
}
