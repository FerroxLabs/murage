// Restricted tool surface derived from agent-browser v0.36.0 cli/src/mcp.rs.
// The harness owns session/namespace, restore policy and launch configuration.
// No model-provided argument may override those or choose filesystem paths.
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
  if (Object.keys(input).some((key) => !Object.hasOwn(policy.properties, key))) denied("Browser argument is not permitted");
  if (policy.required.some((key) => !Object.hasOwn(input, key))) denied("Required browser argument is missing");
  for (const [key, value] of Object.entries(input)) {
    if (!valid(policy.properties[key], value)) denied("Browser argument has an invalid value");
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
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: { type: "object", properties: structuredClone(policy.properties), required: [...policy.required], additionalProperties: false },
    }];
  });
}
