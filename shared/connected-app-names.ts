// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The names a model reads for the connected-app tools. The connection service
// names its session tools with its own prefix, and a bot that reads that
// prefix repeats it to people ("use the ... tools", "Connected apps -> ...").
// So every name an engine is handed is a plain one: the MCP server is
// `murage_connectors` and the tools are `APPS_SEARCH_TOOLS`,
// `APPS_MULTI_EXECUTE_TOOL` and so on.
//
// The service's own ids stay inside Murage: on the wire to the broker, and as
// the one canonical form every check compares. A grant, rule or transcript
// saved under the names earlier releases used therefore keeps matching.
//
// A conversation an earlier release started already holds the older names in
// its history, and an engine only runs a tool it was listed. Such a session is
// mounted the older way (LEGACY_NAMES_ENV): under the older server name, with
// the older tool names listed beside the plain ones, so it resumes and its
// calls run unchanged. Every other session never sees an older name.

/** The MCP server name every engine mounts connected apps under. Reserved for
 * Murage since before 1.0.2, so no custom server a user already has can hold it. */
export const CONNECTED_APPS_SERVER = "murage_connectors";
/** The server name earlier releases mounted (Codex excepted). Internal: mounted
 * only for a session an earlier release started. */
export const LEGACY_CONNECTED_APPS_SERVER = "composio";
/** Set to "1" on the bridge's environment for a session an earlier release
 * started: the mount keeps its older names (connectedAppsServerName, exposedMessage). */
export const LEGACY_NAMES_ENV = "MURAGE_CONNECTOR_LEGACY_NAMES";
/** Murage's own connected-apps mounts. Both names are reserved (mcp-registry.ts),
 * so a tool under either is always Murage's, never a user's custom server. */
const OWN_SERVERS = new Set([CONNECTED_APPS_SERVER, LEGACY_CONNECTED_APPS_SERVER]);

/** Whether a mount is the bridge's environment for a session an earlier release started. */
export function usesLegacyNames(env: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return env?.[LEGACY_NAMES_ENV] === "1";
}

/** The server name a driver mounts the bridge under for this turn. */
export function connectedAppsServerName(env: Readonly<Record<string, string | undefined>> | undefined): string {
  return usesLegacyNames(env) ? LEGACY_CONNECTED_APPS_SERVER : CONNECTED_APPS_SERVER;
}

/** Whether a mounted server name is Murage's connected-apps bridge. */
export function isConnectedAppsServer(name: string): boolean {
  return OWN_SERVERS.has(name.toLowerCase());
}

/** Whether this turn resumes a session an earlier release started: it carries
 * a cursor, does not start over, and the cursor was never marked as made by a
 * session shown the plain names (store.ts resumePlainToolNames). */
export function resumesLegacySession(turn: { resumeCursor: unknown; sessionReset: boolean; plainMarked: boolean }): boolean {
  return turn.resumeCursor !== undefined && !turn.sessionReset && !turn.plainMarked;
}

/** The bridge's environment marked for a session an earlier release started. */
export function withLegacyNames<T extends { env: Record<string, string> }>(mount: T): T {
  return { ...mount, env: { ...mount.env, [LEGACY_NAMES_ENV]: "1" } };
}

/** The tool prefix an engine sees. */
export const EXPOSED_TOOL_PREFIX = "APPS_";
/** The service's own tool prefix. Internal only. */
export const SERVICE_TOOL_PREFIX = "COMPOSIO_";

/** The session tools the service publishes, without a prefix: a bare name under a
 * server Murage does not own is only read as one of these. */
const SESSION_TOOLS = /^(SEARCH_TOOLS|GET_TOOL_SCHEMAS|MULTI_EXECUTE_TOOL|MANAGE_CONNECTIONS|WAIT_FOR_CONNECTIONS|REMOTE_WORKBENCH|REMOTE_BASH_TOOL)$/i;

function swapPrefix(name: string, from: string, to: string): string {
  if (name.startsWith(from)) return `${to}${name.slice(from.length)}`;
  if (name.startsWith(from.toLowerCase())) return `${to.toLowerCase()}${name.slice(from.length)}`;
  return name;
}

/** The service's id said the way an engine sees it (COMPOSIO_X to APPS_X). Any other name is unchanged. */
export function exposedToolName(name: string): string {
  return swapPrefix(name, SERVICE_TOOL_PREFIX, EXPOSED_TOOL_PREFIX);
}

/** An exposed name back to the service's id (APPS_X to COMPOSIO_X). Any other name is unchanged.
 * Inside the bridge every tool is a connected-app tool, so any APPS_ name maps. */
export function serviceToolName(name: string): string {
  return swapPrefix(name, EXPOSED_TOOL_PREFIX, SERVICE_TOOL_PREFIX);
}

/** Every service tool id in a text said by its exposed name. Uppercase ids only:
 * that is how the service writes them, and it leaves other words alone. */
export function withExposedToolNames(text: string): string {
  return text.replace(/(?<![A-Za-z0-9])COMPOSIO_(?=[A-Z0-9])/g, EXPOSED_TOOL_PREFIX);
}

/** A bare tool part, as the canonical service id when it is one. */
function canonicalTool(tool: string, ownServer: boolean): string {
  const upper = tool.toUpperCase();
  if (!upper.startsWith(EXPOSED_TOOL_PREFIX)) return tool;
  if (!ownServer && !SESSION_TOOLS.test(upper.slice(EXPOSED_TOOL_PREFIX.length))) return tool;
  return serviceToolName(tool);
}

function canonicalServer(server: string): string {
  return isConnectedAppsServer(server) ? LEGACY_CONNECTED_APPS_SERVER : server;
}

/** The one internal form of an engine's name for a connected-app tool, so a
 * check and a saved grant compare the same thing whichever release named it.
 * `mcp__murage_connectors__APPS_SEARCH_TOOLS`, `murage_connectors__APPS_SEARCH_TOOLS`,
 * `murage_connectors:APPS_SEARCH_TOOLS`, Pi's `murage_connectors_apps_search_tools`
 * and a bare `APPS_SEARCH_TOOLS` all become the form earlier releases used.
 * Only Murage's own mounts are read this way: a tool under any other server
 * keeps its name, whatever it is called, so a grant for one server's tool
 * never covers another's. Every other tool name comes back unchanged.
 * Internal: never shown to anyone. */
export function canonicalConnectedAppToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return isConnectedAppsServer(mcp[1]!) ? `mcp__${canonicalServer(mcp[1]!)}__${canonicalTool(mcp[2]!, true)}` : name;
  const namespaced = /^([A-Za-z0-9_-]+?)(__|[:/.]\s*)(.+)$/.exec(name);
  if (namespaced && isConnectedAppsServer(namespaced[1]!)) {
    return `${canonicalServer(namespaced[1]!)}${namespaced[2]}${canonicalTool(namespaced[3]!, true)}`;
  }
  // Pi joins server and tool with one underscore, lower-cased (pi-mcp-extension.ts): an
  // upper-case id (the service's own COMPOSIO_X) is never one of these.
  if (name === name.toLowerCase()) for (const server of OWN_SERVERS) {
    const pi = `${server}_`;
    if (name.toLowerCase().startsWith(pi)) return `${LEGACY_CONNECTED_APPS_SERVER}_${canonicalTool(name.slice(pi.length), true)}`;
  }
  // A bare name carries no server at all: only the service's own session tools are read.
  return canonicalTool(name, false);
}

/** Whether two tool grants name the same tool, whichever release wrote either. */
export function sameToolGrant(a: string, b: string): boolean {
  // A mount-identity key (Rule 43) matches only itself, decoded mount and
  // tool exactly: a custom grant never answers an external server's tool.
  if (a.startsWith("acp-tool:") || b.startsWith("acp-tool:")) return a === b;
  return a === b || canonicalConnectedAppToolName(a) === canonicalConnectedAppToolName(b);
}

/** A text the service wrote for the model (a tool's description, a lookup's
 * answer) with its name said as "connected apps". Its ids become the exposed
 * ones; a web address, a host name or a slug that carries the name is left as
 * it is, since changing one would break it. */
export function withoutServiceName(text: string): string {
  return withExposedToolNames(text)
    .replace(/(?<![\w./@:-])composio['’]s(?![\w.-])/gi, "connected apps'")
    .replace(/(?<![\w./@:-])composio(?![\w-]|\.\w)/gi, "connected apps");
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** Every string in a value passed through `say`, keys kept. */
function mapStrings(value: unknown, say: (text: string) => string, key?: string, only?: ReadonlySet<string>): unknown {
  if (typeof value === "string") return !only || (key !== undefined && only.has(key)) ? say(value) : value;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, say, key, only));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entry, inner]) => [entry, mapStrings(inner, say, entry, only)]));
}

const PROSE_KEYS: ReadonlySet<string> = new Set(["description", "title"]);

/** A tool description as the model reads it: the service's own web links
 * (its docs) dropped, since the model needs none of them to call the tool,
 * and its name said as "connected apps". */
function describedPlainly(text: string): string {
  return withoutServiceName(text.replace(/\(?\s*(?:https?:\/\/)?[\w.-]*composio\.[a-z]{2,}(?:\/[^\s)]*)?\s*\)?/gi, "").replace(/[ \t]{2,}/g, " "));
}

/** One tool of a tools/list answer the way an engine is shown it: its exposed
 * name, and its descriptions and titles (schema ones too) without the service's name. */
export function exposedTool(tool: unknown): unknown {
  if (!isObject(tool)) return tool;
  const shown = mapStrings(tool, describedPlainly, undefined, PROSE_KEYS) as Json;
  return typeof tool.name === "string" ? { ...shown, name: exposedToolName(tool.name) } : shown;
}

/** The same tool kept under the name an earlier release listed it by, for a
 * session that already holds that name; null when the name never changed. */
function legacyAlias(tool: unknown): unknown {
  if (!isObject(tool) || typeof tool.name !== "string" || exposedToolName(tool.name) === tool.name) return null;
  return { ...(mapStrings(tool, describedPlainly, undefined, PROSE_KEYS) as Json), name: tool.name };
}

/** A JSON-RPC message from the bridge to the engine, as the engine is shown it.
 * A tools/list answer gets exposed tool names and plain descriptions (and, for
 * a session an earlier release started, the older names beside them). A
 * lookup's answer is the service's own prose and is said plainly. Any other
 * call's answer is the app's data and reaches the engine exactly as it came.
 * A JSON-RPC error is the service's (or the bridge's) words, never app data,
 * so it is said plainly too. */
export function exposedMessage<T extends Json>(message: T, options: { lookup?: boolean; legacyNames?: boolean } = {}): T {
  if (isObject(message.error)) return { ...message, error: mapStrings(message.error, withoutServiceName) };
  const result = message.result;
  if (!isObject(result)) return message;
  if (Array.isArray(result.tools)) {
    const tools = result.tools.map(exposedTool);
    const aliases = options.legacyNames ? result.tools.map(legacyAlias).filter((tool) => tool !== null) : [];
    return { ...message, result: { ...result, tools: [...tools, ...aliases] } };
  }
  return options.lookup ? { ...message, result: mapStrings(result, withoutServiceName) } : message;
}

/** A JSON-RPC message from the engine, as the service is asked it: a tools/call
 * names the service's id, whether the engine used the exposed name or an older one. */
export function serviceMessage<T extends Json>(message: T): T {
  if (message.method !== "tools/call" || !isObject(message.params) || typeof message.params.name !== "string") return message;
  return { ...message, params: { ...message.params, name: serviceToolName(message.params.name) } };
}
