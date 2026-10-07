// Restricted tool surface derived from agent-browser v0.36.0 cli/src/mcp.rs.
// The harness owns session/namespace, restore policy and launch configuration.
// No model-provided argument may override those or choose filesystem paths.
import { murageToolOnThisServer } from "./murage-tool-surface.ts";

type Json = Record<string, unknown>;
type Field = { type: "string" | "boolean" | "integer" | "array"; enum?: string[]; minimum?: number; maximum?: number; items?: { type: "string" }; minItems?: number };
type Policy = { properties: Record<string, Field>; required: string[] };
const string: Field = { type: "string" };
const boolean: Field = { type: "boolean" };
const integer: Field = { type: "integer" };
const nonnegative: Field = { type: "integer", minimum: 0 };
const waitTimeoutMs: Field = { type: "integer", minimum: 1 };
const policies: Record<string, Policy> = Object.create(null);
function allow(names: string[], properties: Record<string, Field> = {}, required: string[] = []) {
  for (const name of names) policies[`agent_browser_${name}`] = { properties, required };
}
allow(["open"], { url: string });
allow(["read"], { url: string, raw: boolean, requireMd: boolean, llms: { type: "string", enum: ["index", "full"] }, outline: boolean, filter: string, readTimeoutMs: integer });
allow(["snapshot"], { interactive: boolean, compact: boolean, depth: nonnegative, selector: string, includeUrls: boolean });
allow(["back", "forward", "reload", "get_url", "get_title", "tab_list", "close"]);
allow(["click"], { selector: string, newTab: boolean }, ["selector"]);
allow(["dblclick", "hover", "focus", "check", "uncheck", "scroll_into_view", "get_text", "get_html", "get_value", "get_count", "get_box", "get_styles", "is_visible", "is_enabled", "is_checked"], { selector: string }, ["selector"]);
allow(["fill"], { selector: string, text: string }, ["selector", "text"]);
allow(["type"], { selector: string, text: string, clear: boolean, delayMs: nonnegative }, ["selector", "text"]);
allow(["press", "keydown", "keyup"], { key: string }, ["key"]);
allow(["keyboard_type", "keyboard_insert_text"], { text: string }, ["text"]);
allow(["select"], { selector: string, values: { type: "array", items: { type: "string" }, minItems: 1 } }, ["selector", "values"]);
allow(["scroll"], { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: integer, selector: string });
allow(["wait_ms"], { ms: nonnegative }, ["ms"]);
allow(["wait_for_selector"], { selector: string, waitTimeoutMs }, ["selector"]);
allow(["wait_for_text"], { text: string, waitTimeoutMs }, ["text"]);
allow(["wait_for_url"], { url: string, waitTimeoutMs }, ["url"]);
allow(["wait_for_load"], { state: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }, waitTimeoutMs }, ["state"]);
allow(["get_attr"], { selector: string, name: string }, ["selector", "name"]);
allow(["tab_new"], { url: string, label: string });
allow(["tab_switch"], { tab: string }, ["tab"]);
allow(["tab_close"], { tab: string });
// Upstream emits image content for small PNG/JPEG captures. Destination is
// its harness-controlled default; neither path nor screenshotDir is exposed.
allow(["screenshot"], { selector: string, fullPage: boolean, annotate: boolean, format: { type: "string", enum: ["png", "jpeg"] }, quality: { type: "integer", minimum: 0, maximum: 100 } });
/** Every tool the unified browser may list, by name. */
export const AGENT_BROWSER_TOOLS: readonly string[] = Object.freeze(Object.keys(policies));
/** What the headless engine's model may list and call: the engine's core profile as pinned at be5df4c3e,
 * identical on every OS and independent of the engine's own `--tools`. Anything else is refused. */
export const HEADLESS_MODEL_TOOLS: readonly string[] = Object.freeze([
  "open", "read", "snapshot", "click", "fill", "type", "press", "check", "uncheck", "select", "scroll", "wait_ms",
  "wait_for_selector", "wait_for_text", "wait_for_load", "screenshot", "get_text", "get_url", "get_title", "close",
  "back", "forward", "reload", "tab_new", "tab_list", "tab_switch", "tab_close",
].map((name) => `agent_browser_${name}`));
const SIBLING_TOOL = new RegExp(`(?<![A-Za-z0-9_"])(${[...AGENT_BROWSER_TOOLS].sort((a, b) => b.length - a.length).join("|")})(?![A-Za-z0-9_"])`, "g");
/** The engine's own description (pinned, never a page's) names its sibling
 * tools bare, which an engine that reaches MCP only through use_tool cannot
 * call. The list cannot know the caller's engine or its mount alias, so each
 * is named on this server, as the harness's own results name them. */
function describeSiblings(description: string): string {
  return description.replace(SIBLING_TOOL, (name) => murageToolOnThisServer(name));
}

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function denied(message: string): never {
  throw Object.assign(new Error(message), { code: -32602, status: 400 });
}
function safeString(value: unknown): value is string {
  // MCP appends positional strings directly to CLI argv. Option-shaped values
  // could otherwise become global flags even without the extraArgs property.
  return typeof value === "string" && !value.startsWith("-") && !value.includes("\0");
}
function valid(field: Field, value: unknown): boolean {
  if (field.type === "string") return safeString(value) && (!field.enum || field.enum.includes(value));
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "array") return Array.isArray(value) && value.length >= (field.minItems ?? 0) && value.every(safeString);
  return typeof value === "number" && Number.isSafeInteger(value)
    && (field.minimum === undefined || value >= field.minimum)
    && (field.maximum === undefined || value <= field.maximum);
}

/** Throws a bounded safe protocol error before any browser child is called. */
export function validateHeadlessBrowserCall(name: unknown, args: unknown): { name: string; arguments: Json } {
  if (typeof name !== "string" || !Object.hasOwn(policies, name)) denied("Browser tool is not permitted");
  const policy = policies[name];
  const input = args === undefined ? {} : args;
  if (!object(input)) denied("Browser arguments must be an object");
  // The plain, bounded names of the arguments help a model correct itself; page text never reaches here.
  const label = (key: string) => `\`${key.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}\``;
  const bad = Object.keys(input).find((key) => !Object.hasOwn(policy.properties, key));
  if (bad !== undefined) denied(`Browser argument is not permitted: ${label(bad)}. This tool takes: ${Object.keys(policy.properties).map(label).join(", ") || "no arguments"}.`);
  const missing = policy.required.find((key) => !Object.hasOwn(input, key));
  if (missing !== undefined) denied(`Required browser argument is missing: ${label(missing)}.`);
  for (const [key, value] of Object.entries(input)) {
    if (!valid(policy.properties[key], value)) denied(`Browser argument has an invalid value: ${label(key)}.`);
  }
  if (["agent_browser_open", "agent_browser_read", "agent_browser_tab_new"].includes(name) && input.url !== undefined) {
    let url: URL;
    try { url = new URL(input.url as string); } catch { denied("Browser URL must use HTTP or HTTPS"); }
    if (!["http:", "https:"].includes(url.protocol)) denied("Browser URL must use HTTP or HTTPS");
  }
  // Private HTTP(S) hosts remain allowed. Network boundaries are a separate
  // explicit harness policy; this does not claim redirect/SSRF containment.
  return { name, arguments: { ...input } };
}

/** Advertise only tools actually offered by the child, with owned schemas. */
export function listHeadlessBrowserTools(upstreamTools: unknown): Json[] {
  if (!Array.isArray(upstreamTools)) return [];
  const seen = new Set<string>();
  return upstreamTools.flatMap((tool): Json[] => {
    if (!object(tool) || typeof tool.name !== "string" || !Object.hasOwn(policies, tool.name) || seen.has(tool.name)) return [];
    seen.add(tool.name);
    const policy = policies[tool.name];
    return [{ name: tool.name,
      ...(typeof tool.title === "string" ? { title: tool.title } : {}),
      ...(typeof tool.description === "string" ? { description: describeSiblings(tool.description) } : {}),
      inputSchema: { type: "object", properties: structuredClone(policy.properties), required: [...policy.required], additionalProperties: false },
    }];
  });
}
