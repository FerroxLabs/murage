// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The two bot phone call tools (BOT-CALLS-1020 3b), in a module with no side effects: agents-proxy.ts lists them when the harness
// mounted phone calls for the turn (MURAGE_PHONE_CALLS), and tests read them without loading the proxy. Listing is presentation only:
// the harness checks the key, the owner audience and the active settings revision again at every call (server/phone-calls/service.ts).
// Neither tool has an assistant, number, voice or settings field, so a bot cannot swap them. Same two tools on every engine.

/** The env the harness sets on the agents integration: "1" lists both phone tools. Absent: none. */
export const PHONE_TOOLS_ENV = "MURAGE_PHONE_CALLS";
export const PHONE_TOOL_NAMES = ["phone_call_place", "phone_call_result"] as const;
export type PhoneToolName = typeof PHONE_TOOL_NAMES[number];
export const isPhoneToolName = (name: string): name is PhoneToolName => (PHONE_TOOL_NAMES as readonly string[]).includes(name);

/** What an owner turn's primer says when phone calls are set up but this bot's engine has no Murage tools on the turn (OpenClaw, and
 *  Antigravity outside full-auto). Plain words; the bot passes it on instead of pretending to call. */
export const PHONE_ENGINE_ABSENT = "This bot's engine cannot use Murage's phone call tools. Say so plainly if asked to call, and suggest switching this bot to Fuigo or another engine with Murage tools. Phone call settings are in Settings > Connected apps > Phone calls.";

export const PHONE_TOOLS = [
  {
    name: "phone_call_place",
    description: "Phone a business for the owner, like booking a table, using the owner's own phone call settings (opening lines, recording, language, max length). Returns a call id; read the outcome later with phone_call_result. Callee speech never comes back as text.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object", additionalProperties: false, required: ["to", "goal"],
      properties: {
        to: { type: "string", maxLength: 16, description: "The number to call, in +E.164 form." },
        goal: { type: "string", minLength: 1, maxLength: 500, description: "What the call is for, in one or two lines." },
        details: { type: "string", maxLength: 2000, description: "Facts the caller may give, such as names, party size, times." },
        limits: { type: "string", maxLength: 1000, description: "What the caller must not agree to." },
        language: { type: "string", maxLength: 10, description: "A language code; the owner's fixed language wins." },
        when: { type: "string", maxLength: 40, description: "ISO 8601 date-time for a scheduled call." },
      },
    },
  },
  {
    name: "phone_call_result",
    description: "Read the result of a phone call placed earlier: status, outcome, reason, whether a reference was given, the time agreed, length and cost.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["call"], properties: { call: { type: "string", maxLength: 40 } } },
  },
];

/** The tools one turn lists. */
export function phoneToolsFor(env: string | undefined): typeof PHONE_TOOLS {
  return env === "1" ? PHONE_TOOLS : [];
}

/** Ask card (3f): the harness registers the service's askPreview here once, so every engine's card path can show number, goal,
 *  details, limits, when, resolved language and settings revision without importing the service. No side effects at import. */
export type PhoneAskPreview = (args: Record<string, unknown>) => { to: string; goal: string; details: string; limits: string; when?: string; language: string; settings_revision: number } | null;
let askPreviewImpl: PhoneAskPreview | null = null;
export function setPhoneAskPreview(fn: PhoneAskPreview | null): void { askPreviewImpl = fn; }
/** The name each engine shape gives the place tool: bare, with an MCP prefix (mcp__agents__phone_call_place, Claude, Codex, Pi,
 *  the OpenAI-chat engines), a server path (agents/phone_call_place, agents.phone_call_place) or an ACP title that names the
 *  server after it ("phone_call_place (agents MCP Server)"). Any server named must be Murage's own agents mount (agents,
 *  murage-agents, murage-agents-<id>, or Codex's underscore spelling): a tool of the same name on another MCP server keeps that
 *  engine's own card line, so a phone call card never stands in front of somebody else's tool. */
const AGENTS_SERVER = String.raw`(?:agents|murage[-_]agents(?:[-_][a-f0-9]{20})?)`;
const PHONE_PLACE_NAME = new RegExp(String.raw`^(?:(?:mcp__)?${AGENTS_SERVER}(?:__|\s*[/.:]\s*))?phone_call_place(?:\s*\(${AGENTS_SERVER}(?: MCP Server)?\))?$`, "i");
/** The tool name may carry an MCP prefix (mcp__agents__phone_call_place). Returns the card line, or null for any other tool. */
export function phoneAskLine(tool: string | undefined, input: Record<string, unknown> | undefined): string | null {
  if (!tool || !input || !PHONE_PLACE_NAME.test(tool.trim())) return null;
  const p = askPreviewImpl?.(input);
  if (!p) return null;
  return [`Call ${p.to}`, `Goal: ${p.goal}`, p.details && `Details: ${p.details}`, p.limits && `Limits: ${p.limits}`, p.when && `When: ${p.when}`,
    `Language: ${p.language}`, `Settings revision ${p.settings_revision}`].filter(Boolean).join("\n").slice(0, 3200);
}

const plainRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const innerInput = (raw: Record<string, unknown>) => plainRecord(raw.tool_input ?? raw.toolInput ?? raw.arguments ?? raw.args ?? raw.input);
/** The ACP card (Fuigo, Cursor, Hermes, Grok, Kimi, Qwen and the other ACP engines). When the engine stamped the call
 *  (`_meta["fuigo/tool"]`), the stamp alone names it: an MCP stamp for Murage's own place tool gets the card, and any other stamp
 *  (a shell command, an edit, another server's tool) never does, whatever the model-written title or input says. Without a stamp,
 *  a call that carries a command or file target never gets the card; otherwise a wrapper's inner tool (`tool_name` + `tool_input`)
 *  or the title names it. Same line as phoneAskLine. */
export function acpPhoneAskLine(toolCall: { title?: unknown; rawInput?: unknown; _meta?: unknown; kind?: unknown } | undefined): string | null {
  if (!toolCall) return null;
  const raw = plainRecord(toolCall.rawInput);
  const meta = plainRecord(toolCall._meta);
  if (meta && "fuigo/tool" in meta) {
    const stamp = plainRecord(meta["fuigo/tool"]);
    if (!stamp || stamp.version !== 1) return null;
    if (stamp.namespace === "mcp" && typeof stamp.name === "string") return phoneAskLine(stamp.name, raw);
    // the engine's own dispatcher, naming the MCP tool it runs in its structured input
    if (stamp.name === "use_tool" && typeof raw?.tool_name === "string") return phoneAskLine(raw.tool_name, innerInput(raw));
    return null;
  }
  if (typeof toolCall.kind === "string" && ["execute", "edit", "delete", "move"].includes(toolCall.kind)) return null;
  if (raw && ["command", "cmd", "path", "paths", "file_path", "filePath"].some((key) => key in raw)) return null;
  const inner = raw?.tool_name ?? raw?.toolName;
  if (inner !== undefined) return typeof inner === "string" && raw ? phoneAskLine(inner, innerInput(raw)) : null;
  return phoneAskLine(typeof toolCall.title === "string" ? toolCall.title : undefined, raw);
}
