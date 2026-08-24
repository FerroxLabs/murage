// pi-mcp-extension — the Pi-side half of "hands" for the pi engine.
//
// Pi core deliberately ships no MCP client (see pi's docs: "does not include
// built-in MCP"). This extension is that client: loaded into the per-turn
// `pi --mode rpc --no-session` process via `-e`, it reads a JSON file whose
// path is handed in through OMB_MCP_CONFIG and mounts every server described
// there as first-class pi tools (pi.registerTool). OpenMausBot ships this file
// and the pi driver spawns it — the pi repo itself is never touched.
//
// Protocol: the OpenMausBot proxies speak raw JSON-RPC 2.0 over stdio, one
// frame per line (no MCP SDK, no Content-Length framing) — see
// server/mcp-bridge.ts and server/drivers/agents-proxy.ts. This client matches
// that exactly.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** "local-computer" marks the user's real host desktop: every tool on such
   * a server is gated behind a permission card before it executes. */
  scope?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerDef>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A minimal stdio JSON-RPC 2.0 MCP client, matched to OpenMausBot's
 * newline-delimited house protocol. */
class StdioMcp {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(def: McpServerDef) {
    this.child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(def.env ?? {}) },
    });
    this.child.stderr.on("data", () => {
      /* best-effort drain so a chatty server never blocks */
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.failAll(err));
    // A server that starts and then dies emits `exit`, never `error`; without
    // settling on it, an in-flight init/listTools would hang the extension
    // load for the whole turn.
    this.child.on("exit", (code) => this.failAll(new Error(`MCP server exited (code ${code ?? "?"})`)));
    // A write to a dead child errors asynchronously on the stream; an
    // unhandled stream error would kill the pi process (the same hazard
    // spawnCli documents for driver-spawned children in procs.ts).
    this.child.stdin.on("error", () => this.failAll(new Error("MCP server stdin closed")));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id as number)) {
        const p = this.pending.get(msg.id as number)!;
        this.pending.delete(msg.id as number);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      }
      // Server notifications/requests (e.g. notifications/tools/list_changed)
      // carry no id and are intentionally ignored for this single-shot mount.
    }
  }

  private call(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openmausbot-pi", version: "1" },
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.call("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return res?.tools ?? [];
  }

  /** tools/call → pi text result. Non-text content (screenshots, etc.) is
   * folded into a marker so the agent still gets the structured state the
   * proxies return alongside it. */
  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const res = (await this.call("tools/call", { name, arguments: args ?? {} })) as
      | { content?: unknown[]; isError?: boolean }
      | undefined;
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .filter((c): c is { type: "text"; text: unknown } => (c as { type?: string })?.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("\n");
    const other = content.filter((c) => (c as { type?: string })?.type !== "text");
    const note = other.length ? `\n[${other.length} non-text content item(s) omitted]` : "";
    return {
      text: (text || "(empty result)") + note,
      isError: Boolean(res?.isError),
    };
  }

  dispose(): void {
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Best-effort JSON Schema → typebox for the common MCP tool shapes.
 * Anything unrecognized degrades to a permissive record rather than failing
 * the mount: a tool that works loosely beats one that never registers. */
function toTypebox(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return Type.Record(Type.String(), Type.Any());
  const s = schema as {
    type?: string;
    enum?: unknown[];
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
    items?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (Array.isArray(s.enum)) {
    const lits = s.enum.filter((v) => ["string", "number", "boolean"].includes(typeof v));
    if (lits.length === s.enum.length && lits.length > 0) {
      return Type.Union(lits.map((v) => Type.Literal(v as string | number | boolean)));
    }
    return Type.Any();
  }
  if (s.anyOf || s.oneOf || s.allOf) return Type.Any();
  switch (s.type) {
    case "string":
      return Type.String();
    case "number":
      return Type.Number();
    case "integer":
      return Type.Integer();
    case "boolean":
      return Type.Boolean();
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(s.items ? toTypebox(s.items) : Type.Any());
    case "object": {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const required = Array.isArray(s.required) && s.required.includes(k);
        props[k] = required ? toTypebox(v) : Type.Optional(toTypebox(v));
      }
      return Type.Object(props);
    }
    default:
      return Type.Record(Type.String(), Type.Any());
  }
}

/** pi tool names are lowercase snake identifiers; MCP tool names are not
 * (COMPOSIO_SEARCH_TOOLS, browser_navigate, mcp__x…). Normalize and prefix
 * with the server so two servers can never collide. */
function sanitizeToolName(server: string, tool: string): string {
  const raw = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return raw.slice(0, 64) || `mcp_tool`;
}

/** A short human-readable line for the permission card's detail. */
function summarizeParams(params: unknown): string {
  try {
    const s = JSON.stringify(params ?? {});
    return s === "{}" ? "" : s.slice(0, 300);
  } catch {
    return "";
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const configPath = process.env.OMB_MCP_CONFIG;
  if (!configPath) return;

  let config: McpConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfig;
  } catch {
    return;
  }

  const used = new Set<string>();
  const clients: StdioMcp[] = [];

  for (const [serverName, def] of Object.entries(config.mcpServers ?? {})) {
    if (!def || typeof def.command !== "string") continue;
    const gated = def.scope === "local-computer";
    let client: StdioMcp | undefined;
    try {
      client = new StdioMcp(def);
      await client.init();
      const tools = await client.listTools();
      for (const tool of tools) {
        let name = sanitizeToolName(serverName, tool.name);
        while (used.has(name)) name = `${name}_2`;
        used.add(name);
        pi.registerTool({
          name,
          label: `${serverName}:${tool.name}`,
          description: tool.description ?? `${tool.name} (MCP tool from ${serverName})`,
          parameters: toTypebox(tool.inputSchema),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // Host tools ask first, using pi's native permission card
            // (ctx.ui.confirm → extension_ui_request → Allow/Deny card). This
            // mirrors ACP's session/request_permission and Codex's elicitation.
            if (gated) {
              const detail = summarizeParams(params);
              const allowed = await ctx.ui.confirm(
                `Allow ${tool.name} on your computer?`,
                detail || `Run ${serverName}:${tool.name}`,
              );
              if (!allowed) {
                return { content: [{ type: "text", text: "Blocked by the user." }], details: {} };
              }
            }
            const res = await client.callTool(tool.name, params);
            const text = res.isError ? `(tool returned an error)\n${res.text}` : res.text;
            return { content: [{ type: "text", text }], details: {} };
          },
        });
      }
      clients.push(client);
    } catch (err) {
      // A server that fails to initialize must not take the whole turn down:
      // skip its tools and let the agent work with whatever else mounted.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[openmausbot-pi-mcp] ${serverName}: ${message}\n`);
      client?.dispose();
    }
  }

  pi.on("session_shutdown", () => {
    for (const c of clients) c.dispose();
    clients.length = 0;
  });
}
