// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * How a turn names Murage's own MCP tools in text the model reads.
 *
 * Fuigo and Grok Build never list MCP tools to the model: they are reached
 * only through `use_tool` with a qualified `tool_name` "<server>__<tool>"
 * (xai-grok-tools registry/types.rs `tool_definitions_builtins_only`,
 * implementations/use_tool/mod.rs). There a bare `generate_image` in a
 * refusal or a prompt is called as-is and fails "Tool not found". Every other
 * engine lists the tools and the bare name is what the capabilities primer
 * already tells it to use ("call them by name").
 *
 * The style travels with the turn: the ACP driver sets it on the env of each
 * Murage MCP server it mounts, a proxy formats its own text with it and sends
 * it to the harness on every internal call, and prompt builders take it from
 * the turn's engine. Pure and dependency-free: the bundled proxies import it.
 */
export type ToolCallStyle = "direct" | "use-tool";

/** Set by the driver on a Murage MCP server's env. */
export const TOOL_CALL_STYLE_ENV = "MURAGE_TOOL_CALL_STYLE";
/** The name the driver mounted that server under (the <server> part). */
export const TOOL_SERVER_NAME_ENV = "MURAGE_MCP_SERVER_NAME";
/** Sent by a proxy to the harness so its refusals name tools the same way. */
export const TOOL_CALL_STYLE_HEADER = "x-murage-tool-call-style";

/** Engines that reach MCP tools only through use_tool. */
export function reachesMcpThroughUseTool(driverKind: string): boolean {
  return driverKind === "fuigoAgent" || driverKind === "grokAgent";
}

export function toolCallStyleFor(driverKind: string): ToolCallStyle {
  return reachesMcpThroughUseTool(driverKind) ? "use-tool" : "direct";
}

/** Anything but the exact "use-tool" is the unchanged, direct style. */
export function parseToolCallStyle(value: unknown): ToolCallStyle {
  return value === "use-tool" ? "use-tool" : "direct";
}

/** Murage's own tools, per server under its default mount name. Kept in
 * step with each proxy's tools/list by server/murage-tool-names.test.ts.
 * Only names with an underscore: a plain word like "click" is rewritten
 * only where a caller asks for it by name (`words`). */
export const MURAGE_MCP_TOOLS = {
  agents: [
    "allow_for_task", "archive_bot", "ask_bot", "check_delegation", "create_bot", "delegate_bot", "generate_image",
    "get_bot", "get_permission_status", "get_prompt_block", "list_bots", "list_image_models", "list_prompt_blocks",
    "list_reference_packs", "list_routines", "move_bot", "murage_help", "propose_routine", "propose_routine_action",
    "register_artifact", "request_bot_access", "request_credential", "resolve_image_reference", "restore_bot",
    "save_prompt_block", "save_reference_pack", "send_voice_note", "set_team_lead", "skill_manage", "skills_list",
    "tool_result_read", "update_bot", "wait_delegation", "web_search",
  ],
  // The built-in browser (drivers/browser-proxy.ts) and every agent_browser
  // tool the unified browser proxy can list under the same mount
  // (browser-engine-policy.ts AGENT_BROWSER_TOOLS).
  browser: [
    "browser_back", "browser_click", "browser_drag", "browser_fill", "browser_forward", "browser_hover",
    "browser_navigate", "browser_press", "browser_read", "browser_request_takeover", "browser_screenshot",
    "browser_scroll", "browser_select_option", "browser_snapshot", "browser_state", "browser_type", "browser_wait_for",
    "agent_browser_back", "agent_browser_check", "agent_browser_click", "agent_browser_close", "agent_browser_dblclick",
    "agent_browser_fill", "agent_browser_focus", "agent_browser_forward", "agent_browser_get_attr", "agent_browser_get_box",
    "agent_browser_get_count", "agent_browser_get_html", "agent_browser_get_styles", "agent_browser_get_text",
    "agent_browser_get_title", "agent_browser_get_url", "agent_browser_get_value", "agent_browser_hover",
    "agent_browser_is_checked", "agent_browser_is_enabled", "agent_browser_is_visible", "agent_browser_keyboard_insert_text",
    "agent_browser_keyboard_type", "agent_browser_keydown", "agent_browser_keyup", "agent_browser_open", "agent_browser_press",
    "agent_browser_read", "agent_browser_reload", "agent_browser_screenshot", "agent_browser_scroll",
    "agent_browser_scroll_into_view", "agent_browser_select", "agent_browser_snapshot", "agent_browser_tab_close",
    "agent_browser_tab_list", "agent_browser_tab_new", "agent_browser_tab_switch", "agent_browser_type",
    "agent_browser_uncheck", "agent_browser_wait_for_load", "agent_browser_wait_for_selector", "agent_browser_wait_for_text",
    "agent_browser_wait_for_url", "agent_browser_wait_ms",
  ],
  // Murage's own computer server (computer-proxy.ts). Its browser_* tools
  // are the cloud computer's Chrome, not the built-in browser.
  computer: [
    "browser_click", "browser_fill", "browser_snapshot", "browser_state", "computer_batch", "computer_exec",
    "computer_request_help", "computer_status", "observation_metrics", "open_url", "press_key", "type_text",
    "wait_for", "wait_for_navigation",
  ],
  dweb: ["dweb_opencode_models", "dweb_opencode_run", "dweb_repo_status", "dweb_status"],
  // The Android phone (drivers/phone-proxy.ts). Its one-word tools are in
  // MURAGE_TOOL_WORDS: only the phone skill's own text names them as tools.
  phone: ["list_apps", "open_app", "read_screen", "tap_text", "type_text"],
} as const satisfies Record<string, readonly string[]>;
export type MurageMcpServer = keyof typeof MURAGE_MCP_TOOLS;

/** A server's plain-word tools (status, tap), for the `words` of text that
 * uses them only as its tools. Kept in step with the proxy like the above. */
export const MURAGE_TOOL_WORDS = {
  phone: ["press", "screenshot", "status", "swipe", "tap"],
} as const satisfies Partial<Record<MurageMcpServer, readonly string[]>>;

/** Codex mounts the phone under a name of its own, never a bot's server's
 * (mcp-registry.ts reserves it); claude and pi mount it as "phone". */
export const CODEX_PHONE_MOUNT = "murage_phone";
/** The name this engine's driver mounts the phone server under. */
export function phoneMountName(driverKind: string): string {
  return driverKind === "codex" ? CODEX_PHONE_MOUNT : "phone";
}

/** The first of `servers` that has this tool. */
function serverOf(tool: string, servers: readonly MurageMcpServer[]): MurageMcpServer | undefined {
  return servers.find(server => (MURAGE_MCP_TOOLS[server] as readonly string[]).includes(tool));
}

/** One tool, as this engine calls it. `server` is the mount name when the
 * driver said so; otherwise the first Murage server that has the tool. */
export function murageToolName(tool: string, style: ToolCallStyle | undefined, server?: string): string {
  if (style !== "use-tool") return tool;
  return `use_tool with tool_name "${server ?? serverOf(tool, ["agents", "browser", "computer", "dweb"]) ?? "agents"}__${tool}"`;
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Murage-AUTHORED text only (a prompt sentence, a refusal template, a tool
 * description): every tool of `servers` in it, as this engine calls it. A
 * name on two of them goes to the first listed. `words` adds plain tool
 * names (screenshot, click) for a sentence that uses them only as tools.
 * Never run it over owner, bot or tool data: that is theirs, word for word. */
export function murageToolText(
  text: string,
  style: ToolCallStyle | undefined,
  servers: readonly MurageMcpServer[] = ["agents"],
  mounted: Partial<Record<MurageMcpServer, string>> = {},
  words: Partial<Record<MurageMcpServer, readonly string[]>> = {},
): string {
  if (style !== "use-tool" || !text) return text;
  const owner = new Map<string, MurageMcpServer>();
  for (const server of servers) for (const tool of [...MURAGE_MCP_TOOLS[server], ...words[server] ?? []]) if (!owner.has(tool)) owner.set(tool, server);
  const names = [...owner.keys()].sort((a, b) => b.length - a.length);
  // Not part of a longer identifier: propose_routine in
  // propose_routine_action, ask_bot in an already qualified agents__ask_bot.
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${names.map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
  return text.replace(pattern, tool => {
    const server = owner.get(tool)!;
    return murageToolName(tool, style, mounted[server] ?? server);
  });
}

/** A tools/list payload with every schema `description` (this server's own
 * text) naming sibling tools the way this engine calls them. */
export function murageToolDescriptions<T>(
  value: T,
  style: ToolCallStyle | undefined,
  servers: readonly MurageMcpServer[],
  mounted: Partial<Record<MurageMcpServer, string>> = {},
): T {
  if (style !== "use-tool") return value;
  const walk = (item: unknown): unknown => Array.isArray(item) ? item.map(walk)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, key === "description" && typeof inner === "string" ? murageToolText(inner, style, servers, mounted) : walk(inner)]))
      : item;
  return walk(value) as T;
}
