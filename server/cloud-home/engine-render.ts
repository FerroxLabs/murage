// SPDX-License-Identifier: AGPL-3.0-or-later
// The server half of the Cloud engine render contract (lanes/release103/CLOUD-ENGINES-DESIGN.md
// 2.3): the MCP proxy kinds the launcher may start and the conversion from the stdio server
// specs the drivers build to the launcher's typed stanzas. The launcher (deploy/cloud-home/
// murage-turn-launch.py MCP_PROXIES) holds the same table; engine-render-launcher.test.ts
// asserts the two agree, so neither side can rename a kind, argument or env name alone.
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { CloudMcpProxyKind, CloudMcpStanza } from "./turn-process.ts";

/** One MCP proxy kind (launcher MCP_PROXIES): the bundled script it runs, the one extra
 * argument it takes, and the environment names it reads. The launcher holds the same
 * table; engine-render-launcher.test.ts asserts the two agree. */
export const CLOUD_MCP_PROXIES = {
  permission: { script: "permission-proxy", arg: "socket", env: [] },
  agents: { script: "drivers/agents-proxy", arg: null, env: ["MURAGE_HARNESS_URL", "MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_COMMS_TOKEN", "MURAGE_TURN_DEPTH",
    "MURAGE_SKILL_AUTHORING_ENABLED", "MURAGE_IMAGE_LIBRARY", "MURAGE_PROJECT_ROLE", "MURAGE_GENERATE_IMAGE_WAIT_MS", "MURAGE_AGENTS_UNAVAILABLE"] },
  memory: { script: "drivers/memory-proxy", arg: null, env: ["MURAGE_HARNESS_URL", "MURAGE_MEMORY_TOKEN"] },
  phone: { script: "drivers/phone-proxy", arg: null, env: ["PH_ANDROID_SERIAL"] },
  browser: { script: "drivers/unified-browser-proxy", arg: null, env: ["MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_BROWSER_TRANSPORT", "MURAGE_BROWSER_CALL_TIMEOUT_MS",
    "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN"] },
  computer: { script: "computer-proxy", arg: null, env: ["MURAGEBOX_BOX_ID", "MURAGEBOX_BOX_API", "MURAGEBOX_BOX_TOKEN", "MURAGEBOX_WAKE_BUDGET_MS",
    "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN", "MURAGE_CONTROL_POLL_MS", "MURAGE_CONTROL_WAIT_MS"] },
  hostComputer: { script: "drivers/host-computer-proxy", arg: null, env: ["MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN"] },
  dweb: { script: "drivers/dweb-proxy", arg: null, env: ["DWEB_URL", "DWEB_DISPLAY"] },
  connectors: { script: "connector-proxy", arg: null, env: ["MURAGE_CONNECTOR_UPSTREAM_URL", "MURAGE_CONNECTOR_UPSTREAM_HEADERS", "MURAGE_HARNESS_URL",
    "MURAGE_CONNECTORS_TOKEN", "MURAGE_BOT_ID", "MURAGE_THREAD_ID"] },
  remote: { script: "drivers/remote-mcp-proxy", arg: "server", env: ["MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN"] },
  vpsRelay: { script: "cloud-home/vps-relay-mcp", arg: null, env: ["MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN"] },
  url: { script: null, arg: "url", env: [] },
} as const satisfies Record<CloudMcpProxyKind, { script: string | null; arg: "socket" | "server" | "url" | null; env: readonly string[] }>;
/** Where each kind's script is spawned from by this server (SPAWNED_PROXIES). */
const PROXY_SOURCES: Record<Exclude<CloudMcpProxyKind, "url">, string> = {
  permission: SPAWNED_PROXIES.permission, agents: SPAWNED_PROXIES.agents, memory: SPAWNED_PROXIES.memory, phone: SPAWNED_PROXIES.phone,
  browser: SPAWNED_PROXIES.unifiedBrowser, computer: SPAWNED_PROXIES.computer, hostComputer: SPAWNED_PROXIES.hostComputer, dweb: SPAWNED_PROXIES.dweb,
  connectors: SPAWNED_PROXIES.connectors, remote: SPAWNED_PROXIES.remoteMcp, vpsRelay: SPAWNED_PROXIES.vpsRelayMcp,
};

/** The launcher's stanza for a server this process would otherwise spawn itself: the
 * proxy kind its script names, its one argument and the env names that kind reads
 * (ELECTRON_RUN_AS_NODE comes from the launcher's template). Null when the server is
 * not one of the proxies, such as an owner's own stdio command, which a Cloud home
 * offers only as a remote server. */
export function cloudMcpStanza(server: unknown, options: { ask?: boolean } = {}): CloudMcpStanza | null {
  if (!server || typeof server !== "object") return null;
  const spec = server as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown };
  const ask = options.ask ? { ask: true } : {};
  if (typeof spec.url === "string" && (spec.type === undefined || spec.type === "http") && spec.command === undefined) return { proxy: "url", url: spec.url, ...ask };
  const args = Array.isArray(spec.args) ? spec.args : [];
  const kind = (Object.keys(PROXY_SOURCES) as Array<Exclude<CloudMcpProxyKind, "url">>).find(name => args[0] === PROXY_SOURCES[name]);
  if (!kind) return null;
  const row = CLOUD_MCP_PROXIES[kind];
  const source = spec.env && typeof spec.env === "object" ? spec.env as Record<string, unknown> : {};
  const env: Record<string, string> = {};
  for (const name of row.env as readonly string[]) if (typeof source[name] === "string") env[name] = source[name] as string;
  const stanza: CloudMcpStanza = { proxy: kind, ...(Object.keys(env).length ? { env } : {}), ...ask };
  if (row.arg === "socket") { if (args.length !== 2 || typeof args[1] !== "string") return null; stanza.socket = args[1]; }
  else if (row.arg === "server") { if (args.length !== 3 || args[1] !== "--server" || typeof args[2] !== "string") return null; stanza.server = args[2]; }
  else if (args.length !== 1) return null;
  return stanza;
}
/** cloudMcpStanza for every server; the ones a Cloud home cannot express are left out. */
export function cloudRenderMcp(servers: Record<string, unknown>, ask: (name: string) => boolean = () => false): Record<string, CloudMcpStanza> {
  const out: Record<string, CloudMcpStanza> = {};
  for (const [name, server] of Object.entries(servers)) {
    const stanza = cloudMcpStanza(server, { ask: ask(name) });
    if (stanza) out[name] = stanza;
  }
  return out;
}
/** The launcher's HTTPS_URL accepts loopback only as 127.0.0.1 (the plan gateway). */
export function cloudRouteUrl(url: string): string {
  return url.replace(/^http:\/\/(?:localhost|\[::1\])(?=[:/]|$)/u, "http://127.0.0.1");
}
