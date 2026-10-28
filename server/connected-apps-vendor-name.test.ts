// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The connection service's name never reaches a bot or a person. A bot that
// reads it in a tool id, a tool description or a prompt says it back ("use the
// ... tools", "Connected apps -> ..."), so this test reads what a model is
// handed and what a window prints, and fails on the name in any spelling.
// Internal identifiers (credential keys, environment names, broker routes,
// event types) may carry it; each file that does is listed below with why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectorSystemPrompt, requiredAppsSystemPrompt, type ConnectorAccess } from "./composio.ts";
import { STANDARD_SESSION_TOOLS } from "./composio-standard-tools.ts";
import { capabilitiesPrimer, type PrimerFacts } from "./capabilities-primer.ts";
import { DEFAULT_HOUSE_RULES } from "./house-rules/default.ts";
import { loadBundledSkills } from "./skill-library.ts";
import { buildMcpServers, piGateAsk } from "./drivers/pi.ts";
import { REQUIRED_MCP_SERVERS } from "./drivers/mcp-readiness.ts";
import { parseStoredMcpServer, RESERVED_MCP_NAMES } from "./mcp-registry.ts";
import { autoVerdict } from "./auto-approve.ts";
import { CONNECTED_APP_STATUS_TOOL_DEFINITION, isConnectedAppLookup } from "../shared/connected-app-calls.ts";
import { classifyConnectedAppCall } from "../shared/connected-app-readonly.ts";
import { plainConnectedAppText } from "../shared/connected-app-tools.ts";
import {
  CONNECTED_APPS_SERVER,
  LEGACY_CONNECTED_APPS_SERVER,
  canonicalConnectedAppToolName,
  exposedMessage,
  resumesLegacySession,
  sameToolGrant,
  serviceMessage,
  withLegacyNames,
} from "../shared/connected-app-names.ts";
import type { SendTurnInput } from "./contracts.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const VENDOR = /composio/i;
const around = (text: string): string[] => [...text.matchAll(/.{0,40}composio.{0,40}/gis)].map((match) => match[0]);

/** A list the way the service could answer it: its own name in prose, a docs link and its ids. */
const UPSTREAM_LIST = {
  jsonrpc: "2.0",
  id: 7,
  result: {
    tools: [
      ...STANDARD_SESSION_TOOLS,
      {
        name: "COMPOSIO_SEARCH_TOOLS",
        title: "Composio Search Tools",
        description: "Search Composio's catalogue (see https://docs.composio.dev/tool-router) and then call COMPOSIO_MULTI_EXECUTE_TOOL. Composio handles auth.",
        inputSchema: { type: "object", properties: { queries: { type: "array", description: "Use cases for Composio to plan." } } },
      },
    ],
  },
};

describe("connected apps: the service's name stays out of what a bot reads", () => {
  it("names no vendor in any connected-apps prompt a bot is given", () => {
    const texts: string[] = [];
    for (const access of ["mounted", "package-off", "bot-off", "unconfigured", "unreachable", "engine"] as ConnectorAccess[]) texts.push(connectorSystemPrompt(access));
    texts.push(requiredAppsSystemPrompt([{ slug: "gmail", label: "Gmail", reason: "to read the inbox" }, { slug: "slack", label: "Slack", reason: "to post", optional: true }]));
    const facts: PrimerFacts = {
      engine: "Claude Code", model: "Sonnet 4.6", toolAccess: "direct", imageInput: "file-reference",
      mounted: { agents: true, composio: true, browser: true, memory: true, custom: true }, memory: "active",
      imageProvider: true, folder: "trusted", peers: 2, canAskOwner: true,
    };
    texts.push(capabilitiesPrimer(facts), capabilitiesPrimer({ ...facts, mounted: { agents: true } }));
    texts.push(DEFAULT_HOUSE_RULES);
    for (const skill of loadBundledSkills(join(ROOT, "skills"))) texts.push(skill.instructions);
    expect(texts.flatMap(around)).toEqual([]);
    // the mounted prompt names the tools the way the engine is shown them
    expect(connectorSystemPrompt("mounted")).toContain("APPS_SEARCH_TOOLS");
  });

  it("shows the tool catalogue with plain names and descriptions, the bundled stand-in and the status tool included", () => {
    const shown = exposedMessage({ ...UPSTREAM_LIST, result: { tools: [...UPSTREAM_LIST.result.tools, CONNECTED_APP_STATUS_TOOL_DEFINITION] } });
    expect(around(JSON.stringify(shown))).toEqual([]);
    const names = (shown.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain("APPS_SEARCH_TOOLS");
    expect(names).toContain("APPS_MULTI_EXECUTE_TOOL");
    expect(names).toContain(CONNECTED_APP_STATUS_TOOL_DEFINITION.name);
  });

  it("says a lookup's answer plainly, and leaves an action's data exactly as the app sent it", () => {
    const lookup = exposedMessage({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Composio found 2 tools. Next call COMPOSIO_MULTI_EXECUTE_TOOL." }] } }, { lookup: true });
    expect(around(JSON.stringify(lookup))).toEqual([]);
    expect(JSON.stringify(lookup)).toContain("APPS_MULTI_EXECUTE_TOOL");
    // an app's data is the user's: an id, a path or a word that looks like the service's is never rewritten
    const data = { content: [{ type: "text", text: "Email from billing@composio.example: set COMPOSIO_API_KEY, saved /tmp/COMPOSIO_RESULT.json, then COMPOSIO_SEARCH_TOOLS." }] };
    const action = exposedMessage({ jsonrpc: "2.0", id: 2, result: data });
    expect(action.result).toEqual(data);
  });

  it("says a JSON-RPC error without the service's name, whatever the call", () => {
    const shown = exposedMessage({ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "Composio authentication failed", data: { hint: "check the Composio key" } } });
    expect(around(JSON.stringify(shown))).toEqual([]);
    expect((shown.error as { message: string }).message).toBe("connected apps authentication failed");
    expect((shown.error as { code: number }).code).toBe(-32001);
  });

  it("calls the service by its own id whichever name the engine used", () => {
    const call = (name: string) => serviceMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } });
    expect((call("APPS_MULTI_EXECUTE_TOOL").params as { name: string }).name).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect((call("COMPOSIO_SEARCH_TOOLS").params as { name: string }).name).toBe("COMPOSIO_SEARCH_TOOLS");
    expect((call("CHECK_CONNECTED_APP_ACTION").params as { name: string }).name).toBe("CHECK_CONNECTED_APP_ACTION");
  });

  it("mounts connected apps under a plain server name that no user's own server could already hold", () => {
    const servers = buildMcpServers({ integrations: { composio: { command: "node", args: ["connector-proxy.js"], env: {} } } } as unknown as SendTurnInput);
    expect(Object.keys(servers ?? {})).toEqual([CONNECTED_APPS_SERVER]);
    expect(CONNECTED_APPS_SERVER).not.toMatch(VENDOR);
    expect(REQUIRED_MCP_SERVERS[CONNECTED_APPS_SERVER]).toBe("connected apps");
    // reserved since before 1.0.2, so a custom server can never have taken it
    expect(RESERVED_MCP_NAMES.has(CONNECTED_APPS_SERVER)).toBe(true);
    expect(RESERVED_MCP_NAMES.has(LEGACY_CONNECTED_APPS_SERVER)).toBe(true);
  });

  it("keeps a custom server named connected_apps working, as it did in 1.0.1", () => {
    expect(RESERVED_MCP_NAMES.has("connected_apps")).toBe(false);
    expect(parseStoredMcpServer("connected_apps", { command: "node", args: ["my-server.js"] })).toMatchObject({ ok: true });
    // and its tools are its own: never read as Murage's connected-app tools
    expect(canonicalConnectedAppToolName("mcp__connected_apps__APPS_SEARCH_TOOLS")).toBe("mcp__connected_apps__APPS_SEARCH_TOOLS");
    expect(canonicalConnectedAppToolName("connected_apps_apps_search_tools")).toBe("connected_apps_apps_search_tools");
  });

  it("resumes a 1.0.1 session or routine run with the tool names its history calls, and runs those calls unchanged", () => {
    // A 1.0.1 task record: a cursor, and no mark that its session was shown the plain names.
    const task101 = { resumeCursors: { pi: "pi-session-101" } as Record<string, unknown>, resumePlainToolNames: undefined as Record<string, true> | undefined };
    const legacy = resumesLegacySession({ resumeCursor: task101.resumeCursors.pi, sessionReset: false, plainMarked: task101.resumePlainToolNames?.pi === true });
    expect(legacy).toBe(true);
    const mount = { command: "node", args: ["connector-proxy.js"], env: {} as Record<string, string> };
    const servers = buildMcpServers({ integrations: { composio: withLegacyNames(mount) } } as unknown as SendTurnInput);
    // mounted under the name 1.0.1 mounted it under, so Pi registers composio_composio_* as 1.0.1 did
    expect(Object.keys(servers ?? {})).toEqual([LEGACY_CONNECTED_APPS_SERVER]);
    // the bridge lists the older names beside the plain ones for this session only
    const list = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run tools.", inputSchema: { type: "object" } }] } };
    const names = (message: Record<string, unknown>) => ((message.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names(exposedMessage(list, { legacyNames: true }))).toEqual(["APPS_MULTI_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL"]);
    expect(names(exposedMessage(list))).toEqual(["APPS_MULTI_EXECUTE_TOOL"]);
    // the old call reaches the service by the same id it always did
    const call = serviceMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} } });
    expect((call.params as { name: string }).name).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
    // Pi's gate names the mount and tool from its table (Rule 14b), so the old
    // call reads as the connector's own tool and a 1.0.1 grant covers it
    const ask = piGateAsk(JSON.stringify({ tool: "composio_composio_multi_execute_tool", mount: "composio", mcpTool: "COMPOSIO_MULTI_EXECUTE_TOOL", input: { tools: [] } }), [{ engineName: "composio", mountId: "own:connector", provenance: "own" }]);
    expect(ask.toolCall?.name).toBe("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(sameToolGrant("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ask.toolCall!.name)).toBe(true);
    // A session started now is marked, and a turn that starts over is never legacy.
    expect(resumesLegacySession({ resumeCursor: "s", sessionReset: false, plainMarked: true })).toBe(false);
    expect(resumesLegacySession({ resumeCursor: "s", sessionReset: true, plainMarked: false })).toBe(false);
    expect(resumesLegacySession({ resumeCursor: undefined, sessionReset: false, plainMarked: false })).toBe(false);
  });

  it("reads the plain names and the older ones as the same tool, so saved grants and checks keep working", () => {
    for (const [engine, older] of [
      ["mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"],
      ["murage_connectors__APPS_SEARCH_TOOLS", "composio__COMPOSIO_SEARCH_TOOLS"],
      ["murage_connectors_apps_multi_execute_tool", "composio_composio_multi_execute_tool"],
      ["APPS_GET_TOOL_SCHEMAS", "COMPOSIO_GET_TOOL_SCHEMAS"],
    ]) {
      expect(canonicalConnectedAppToolName(engine!), engine).toBe(older);
      expect(sameToolGrant(older!, engine!), engine).toBe(true);
    }
    // a 1.0.1 Codex grant (Codex mounted the bridge under murage_connectors then too)
    expect(sameToolGrant("mcp__murage_connectors__COMPOSIO_SEARCH_TOOLS", "mcp__murage_connectors__APPS_SEARCH_TOOLS")).toBe(true);
    // another server's tool, or an APPS_ word that is not a session tool, is left alone
    expect(canonicalConnectedAppToolName("mcp__github__APPS_LIST")).toBe("mcp__github__APPS_LIST");
    expect(sameToolGrant("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", "mcp__other__APPS_MULTI_EXECUTE_TOOL")).toBe(false);
    expect(isConnectedAppLookup("mcp__murage_connectors__APPS_SEARCH_TOOLS")).toBe(true);
    expect(classifyConnectedAppCall("mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_LIST_LABELS" }] })).toBe("read");
    expect(plainConnectedAppText("mcp__murage_connectors__APPS_SEARCH_TOOLS")).toBe("Look up which app tools to use");
    expect(plainConnectedAppText("export APPS_DIR=/tmp")).toBe("export APPS_DIR=/tmp");
  });

  it("never lets a grant for one custom server's tool cover a differently named tool on it", () => {
    // Under a server Murage does not own, COMPOSIO_X and APPS_X are two tools, whatever they are called.
    expect(sameToolGrant("mcp__custom__COMPOSIO_SEARCH_TOOLS", "mcp__custom__APPS_SEARCH_TOOLS")).toBe(false);
    expect(canonicalConnectedAppToolName("mcp__custom__APPS_SEARCH_TOOLS")).toBe("mcp__custom__APPS_SEARCH_TOOLS");
    const bot = { autoApprove: false, alwaysAllow: ["mcp__custom__COMPOSIO_SEARCH_TOOLS"] };
    const verdict = autoVerdict(bot as never, "mcp__custom__APPS_SEARCH_TOOLS", "search");
    expect(typeof verdict.approve).not.toBe("string");
    // Murage's own mount still reads a 1.0.1 grant
    expect(autoVerdict({ autoApprove: false, alwaysAllow: ["mcp__composio__COMPOSIO_SEARCH_TOOLS"] } as never, "mcp__murage_connectors__APPS_SEARCH_TOOLS", "search").approve).toEqual(expect.any(String));
  });

  it("names no vendor in any locale string", () => {
    const dir = join(ROOT, "src", "locales");
    const hits: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") { if (VENDOR.test(value)) hits.push(`${path}: ${value.slice(0, 80)}`); return; }
      if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    };
    const files = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "source-hashes.json");
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) walk(JSON.parse(readFileSync(join(dir, file), "utf8")), file);
    expect(hits).toEqual([]);
  });
});

// Shipped source whose string literals carry the name. None of these strings
// reaches a model or a window; a new file needs its reason here first.
const INTERNAL_ONLY: Record<string, string> = {
  "electron/composio-legacy-claim.mjs": "broker route names and credential keys",
  "electron/composio-release-config.mjs": "the broker's address",
  "electron/diagnostics.mjs": "environment names redacted from diagnostics",
  "electron/flux-composio-token.mjs": "credential storage keys",
  "electron/ipc-channel-classes.mjs": "IPC channel names",
  "electron/main.mjs": "broker address, credential keys and IPC event types",
  "electron/managed-composio.mjs": "environment names and credential keys",
  "electron/preload.cjs": "IPC channel names",
  "electron/restored-connections.mjs": "environment names",
  "server/bot-access.ts": "the service's tool id; the bridge shows engines the plain name",
  "server/connector-scope-hint.ts": "matches tool-name prefixes in a relayed call; never shown to users",
  "server/cloud-home/credential-projection.ts": "credential keys a Cloud home projects from the supervisor",
  "server/cloud-home/credentials.ts": "a config section id and an environment name",
  "server/cloud-home/supervisor-port.ts": "supervisor IPC event types",
  "server/bot-calls-calendar.ts": "the service's batch-execute tool id the free/busy read sends",
  "server/composio-standard-tools.ts": "the service's tool ids; the bridge shows engines the plain names",
  "server/composio.ts": "event types, log tags, the service's host and error codes",
  "server/config.ts": "environment names",
  "server/data-dir-inventory.ts": "a credential file name",
  "server/flux-composio-dev-token.ts": "a credential file name and the broker's route",
  "server/flux-contract-endpoints.ts": "broker routes",
  "server/flux-memory-headers.ts": "the broker's route",
  "server/index.ts": "an event type",
  "server/mcp-registry.ts": "the older reserved server name, kept reserved",
  "server/stop-line.ts": "an internal app key for an unreadable batch",
  "shared/announcements.ts": "a check message for announcement authors",
  "shared/connected-app-calls.ts": "the service's tool ids, compared after canonicalising",
  "shared/connected-app-names.ts": "the internal ids the plain names map to",
  "shared/connected-app-read-tools.ts": "doc links kept as evidence",
  "shared/connected-app-readonly.ts": "the service's tool id",
  "shared/engine-switch.ts": "a capability key",
  "src/components/PluginsPanel.tsx": "an error code",
  "src/components/SettingsPanel.tsx": "a settings section id",
  "src/state/bot-patch-queue.ts": "a bot field name",
  "src/state/store.tsx": "a config section id",
};

const SOURCE_DIRS = ["server", "shared", "src", "electron", "companion/src"];
const SKIP = /(\.test\.|\.spec\.|node-test|[\\/]testing[\\/]|[\\/]e2e[\\/]|\.d\.m?ts$|fixture|[\\/]node_modules[\\/])/;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry) && !SKIP.test(full)) out.push(full);
  }
  return out;
}

/** String literals naming the vendor, comments and module paths left out. */
function vendorLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
  return code.split("\n")
    .filter((line) => !/^\s*(import|export)\b.*\bfrom\s|^\s*\}\s*from\s|\bimport\s*\(/.test(line))
    .flatMap((line) => [...line.matchAll(STRING)].map((match) => match[2]!).filter((text) => VENDOR.test(text)));
}

describe("connected apps: shipped strings", () => {
  const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it("names the vendor only in files that keep it internal", () => {
    const found = files.flatMap((file) => {
      const path = relative(ROOT, file).split("\\").join("/");
      if (INTERNAL_ONLY[path]) return [];
      return vendorLiterals(readFileSync(file, "utf8")).map((text) => `${path}: ${text.slice(0, 80)}`);
    });
    expect(found).toEqual([]);
  });

  it("keeps the internal list honest: every file on it still holds such a string", () => {
    for (const path of Object.keys(INTERNAL_ONLY)) {
      expect(vendorLiterals(readFileSync(join(ROOT, path), "utf8")).length, path).toBeGreaterThan(0);
    }
  });
});
