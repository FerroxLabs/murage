/** The integration -> stdio MCP mount builder shared by Pi and the OpenAI-chat engines (OPENAI-TOOLS-109 s1.2): moved
 *  unchanged out of pi.ts, which re-exports it. */
import type { SendTurnInput } from "../contracts.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";
import { connectedAppsServerName } from "../../shared/connected-app-names.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Mirror of the Claude driver's integration → stdio MCP mount: every entry is
 * a JSON-RPC 2.0 stdio server the pi-mcp-extension consumes. Returns null when
 * there is nothing to mount (the common case). */
export function buildMcpServers(turn: SendTurnInput, options: { askBeforeCustom?: boolean } = {}): Record<string, unknown> | null {
  const servers: Record<string, unknown> = {};
  // A session an earlier release started keeps the older name its history calls by.
  if (turn.integrations?.composio) servers[connectedAppsServerName(turn.integrations.composio.env)] = { ...turn.integrations.composio };
  if (turn.integrations?.computer) {
    servers.computer = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
    };
  } else if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind
      // a permission card; isolated computers deliberately omit it.
      ...(local.scope ? { scope: local.scope } : {}),
    };
  }
  if (turn.integrations?.memory) servers["murage-memory"] = { ...turn.integrations.memory };
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  // 1.0.9 S13b: the owner's phone; asks on every call like any non-listed own mount.
  if (turn.integrations?.phoneJobs) servers.phoneJobs = { ...turn.integrations.phoneJobs };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  // The owner's own servers (command or link). Not pre-allowed anywhere: the
  // extension gates a `custom` scope behind the same permission card as the
  // host computer, so every call asks, as Claude's Allow/Deny card does. An
  // instance that runs without asks (Full access) mounts them ungated, which
  // is what Claude's bypass mode does for the same servers.
  for (const mount of customMountEntries(turn.integrations?.custom, (name) => name in servers)) {
    // Rule 11: a name holding `__` cannot be told apart from its tools.
    if (mount.name.includes("__")) continue;
    servers[mount.name] = {
      command: mount.command,
      args: mount.args,
      env: mount.env,
      ...(options.askBeforeCustom === false ? {} : { scope: "custom" }),
    };
  }
  return Object.keys(servers).length ? servers : null;
}

/** Rule 54: one record per server in the mcp.json written for the MCP
 * extension. No external records. */
export function piMountRecords(turn: SendTurnInput, servers: Record<string, unknown> | null): McpMountRecord[] {
  const own = new Map<string, string>([["murage-memory", "own:memory"], ["agents", "own:agents"], ["phone", "own:phone"], ["dweb", "own:dweb"], ["computer", "own:computer"]]);
  // only a turn that mounts the phone owns that name; no other server may claim `own:phoneJobs`
  if (turn.integrations?.phoneJobs) own.set("phoneJobs", "own:phoneJobs");
  if (turn.integrations?.composio) own.set(connectedAppsServerName(turn.integrations.composio.env), "own:connector");
  const records: McpMountRecord[] = [];
  for (const name of Object.keys(servers ?? {})) {
    if (name.includes("__")) continue;
    const mountId = own.get(name);
    records.push(mountId ? { engineName: name, mountId, provenance: "own" } : { engineName: name, mountId: `custom:${name}`, provenance: "custom" });
  }
  return records;
}
