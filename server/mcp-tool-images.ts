// An image an MCP tool returns is bytes the engine handed us and we threw
// away. `claude.ts` read a tool_result only for its ok/failed flag,
// `codex.ts` emitted `assistant_image` for `imageGeneration` and nothing
// else, and `acp/core.ts` reduced a completed tool call to a chip. The
// receiving half has been there the whole time — an `assistant_image` item
// is retained, receipted, attached and saved to Files — so all that was
// missing was pulling the blocks out and emitting them.
//
// WHICH IMAGES ARE DELIVERABLES
//
// Murage's receiving branch is not upstream's. Upstream attaches the bytes
// to the message; Murage runs them through `publishAssistantImage`, which
// commits them to the managed output root and registers a permanent
// "Generated image" artifact in Files. So "surface every image" is a
// retention decision here, not a display one, and it has to exclude the
// harness's own screen surfaces:
//
//   * Volume. `server/computer-proxy.ts` attaches a fresh frame to nearly
//     every action it exposes (`observed()` — click, type_text, scroll,
//     open_url, computer_batch, the browser_* actions…). One cloud-computer
//     turn would deposit dozens of permanent artifacts.
//   * Privacy. A screen frame is deliberately NOT durable. The preview
//     poller runs every capture through `captureOutsideHumanControl`
//     (server/private-screen-capture.ts), which throws a frame away if the
//     human-control lease was taken OR its revision moved while the capture
//     was in flight. `browser-proxy.ts` checks the lease once, before the
//     request (`callTool`), so a takeover that begins mid-screenshot still
//     returns a frame that may hold what the person started typing. That
//     frame is survivable as a transient preview; it is not survivable as a
//     file in Files. An in-flight capture during a takeover therefore keeps
//     exactly the handling it has today — live preview, discarded on any
//     control transition, one settled frame folded into the transcript at
//     turn end (server/screen-frame-gate.ts) — and gains no durable copy.
//
// Everything else is a deliverable: a diagram, a chart, a render, the
// custom MCP tool's screenshot of something that is not a Murage surface.
// Those had no path at all before this.

/** One image block, normalized to the MCP-native spelling. */
export interface McpImageContent {
  data: string;
  mimeType: string;
}

/** How many images one tool result may contribute. A result is a message,
 * not an album; a tool that answers with more than a handful of rasters is
 * flooding, and each one costs a managed-root file and a Files row. */
export const MCP_TOOL_IMAGE_LIMIT = 4;

/** Harness-mounted server keys whose tools answer with a live screen frame.
 * These are reserved names — `server/mcp-registry.ts` refuses them to custom
 * servers — so a user's MCP server cannot put itself in this set to have its
 * output silently dropped, nor impersonate one to escape it. */
const SCREEN_SURFACE_SERVERS = new Set(["computer", "browser", "phone", "murage_phone"]);

/** The same surfaces by bare tool name, for the drivers that hand us an
 * unqualified leaf (Codex's `click`) or a single-underscore prefix (pi's
 * `computer_click`). Deliberately the WHOLE surface rather than only the
 * tools known to return pixels today: over-inclusion costs nothing — those
 * images already have the preview/settle path — while a missed one becomes
 * a permanent file. Sources: `server/computer-proxy.ts`,
 * `server/drivers/browser-proxy.ts`, `server/drivers/phone-proxy.ts`, and
 * the Cua Driver surface enumerated in `server/screen-frame-gate.ts`. */
const SCREEN_SURFACE_TOOLS = new Set([
  // server/computer-proxy.ts
  "screenshot", "browser_state", "browser_snapshot", "browser_click", "browser_fill",
  "wait_for_navigation", "observation_metrics", "computer_status", "computer_request_help",
  "click", "type_text", "press_key", "scroll", "computer_batch", "computer_exec",
  "wait_for", "open_url",
  // server/drivers/browser-proxy.ts
  "browser_navigate", "browser_type", "browser_press", "browser_scroll", "browser_hover",
  "browser_drag", "browser_select_option", "browser_wait_for", "browser_read",
  "browser_back", "browser_forward", "browser_request_takeover", "browser_screenshot",
  // server/drivers/phone-proxy.ts
  "status", "read_screen", "list_apps", "open_app", "tap_text", "tap", "swipe", "press",
  // Cua Driver (local Mac, Local VM, VPS)
  "double_click", "right_click", "drag", "hotkey", "move_cursor", "launch_app",
  "bring_to_front", "zoom",
]);

/** `mcp__computer__click` and the server-qualified `computer__click` both
 * name the server; Codex's `click` and pi's `computer_click` do not. Returns
 * the server key when the name carries one. (Same namespace grammar as
 * `server/screen-frame-gate.ts`: MCP_NAME in `server/mcp-registry.ts`.) */
function serverNamespace(lowerName: string): string | null {
  const scoped = /^mcp__(.+?)__/.exec(lowerName);
  if (scoped) return scoped[1]!;
  // Lazy, so `murage_phone__screenshot` yields the server and not a longer
  // run that swallowed part of the tool's own name.
  const qualified = /^([a-z][a-z0-9_-]{0,31}?)__/.exec(lowerName);
  return qualified ? qualified[1]! : null;
}

/** Does this tool name belong to a Murage screen surface? A qualified name
 * is decided by its server alone, so a custom server's `screenshot` stays a
 * deliverable; only an unqualified leaf falls back to the name list. */
export function screenSurfaceTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (!lower) return false;
  const namespace = serverNamespace(lower);
  if (namespace) return SCREEN_SURFACE_SERVERS.has(namespace);
  return SCREEN_SURFACE_TOOLS.has(lower) || SCREEN_SURFACE_TOOLS.has(lower.replace(/^(?:computer|browser|phone)_/, ""));
}

const asMcpImage = (block: unknown): McpImageContent | null => {
  const record = block && typeof block === "object" ? (block as Record<string, unknown>) : null;
  if (!record || record.type !== "image") return null;
  const { data, mimeType } = record;
  return typeof data === "string" && data.trim() && typeof mimeType === "string" && mimeType.startsWith("image/")
    ? { data, mimeType }
    : null;
};

/** The Claude CLI rewrites an MCP image block into Anthropic Messages API
 * shape — `{type:"image", source:{type:"base64", media_type, data}}` —
 * before a driver ever sees the tool_result. Codex and ACP pass the
 * MCP-native shape through untouched, which is why a normalizer that knew
 * only one spelling would have worked for two drivers and silently returned
 * nothing for the third. */
const asAnthropicImage = (block: unknown): McpImageContent | null => {
  const record = block && typeof block === "object" ? (block as Record<string, unknown>) : null;
  if (!record || record.type !== "image") return null;
  const source = record.source && typeof record.source === "object" ? (record.source as Record<string, unknown>) : null;
  if (!source || source.type !== "base64") return null;
  const { media_type: mediaType, data } = source;
  return typeof data === "string" && data.trim() && typeof mediaType === "string" && mediaType.startsWith("image/")
    ? { data, mimeType: mediaType }
    : null;
};

/** ACP wraps each part of a tool call's output as `{type:"content",
 * content:<block>}`; the MCP and Anthropic shapes are flat. Unwrap one
 * level when there is one, exactly as `toolFailureText` does for text. */
const unwrap = (entry: unknown): unknown => {
  const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  return record && record.type === "content" && record.content && typeof record.content === "object" ? record.content : entry;
};

/**
 * Pull the image blocks out of one tool result so a driver can emit them as
 * `assistant_image` items instead of dropping them.
 *
 * Accepts a raw content array or a `{ content: [...] }` wrapper, because the
 * three drivers hand differently shaped payloads. `toolName` is what decides
 * retention: name the tool when you know it, and images from Murage's own
 * screen surfaces are left to the preview path that already owns them.
 */
export function extractMcpImages(value: unknown, toolName?: string): McpImageContent[] {
  if (toolName && screenSurfaceTool(toolName)) return [];
  const wrapper = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const entries = Array.isArray(value) ? value : Array.isArray(wrapper?.content) ? (wrapper.content as unknown[]) : null;
  if (!entries) return [];
  const images: McpImageContent[] = [];
  for (const entry of entries) {
    const block = unwrap(entry);
    const image = asMcpImage(block) ?? asAnthropicImage(block);
    if (image) images.push(image);
    if (images.length === MCP_TOOL_IMAGE_LIMIT) break;
  }
  return images;
}
