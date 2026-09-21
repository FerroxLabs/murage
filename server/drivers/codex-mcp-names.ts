// MCP server names the owner already declared in Codex's own config.toml.
//
// Murage mounts a bot's custom MCP servers as `-c mcp_servers.<name>.…`
// overrides on the app-server command line. Codex does not treat an override
// as a fresh definition: it MERGES it into any same-named table already in
// `config.toml`. Two things go wrong when the owner happens to have a server
// of their own under that name.
//
// 1. A stdio `command` laid over a remote `url` entry is a contradiction.
//    Codex rejects the whole file as "invalid configuration", so the turn dies
//    on config/read before the model is ever asked — and the failure names the
//    config, not the bot's MCP server, so it reads as a broken Codex install.
//
// 2. The keys Murage does NOT write survive from the owner's table. The one
//    that matters is `default_tools_approval_mode`: Murage mounts custom
//    servers with `preApproved = false` precisely so their tool calls arrive
//    as approval cards (see mountMcpServer in codex.ts). An `auto` left in the
//    owner's own entry silently cancels that, and nothing in Murage can see it
//    happen. `enabled = false` there is the mirror image — the bot's server is
//    mounted and then quietly never started.
//
// Neither case is the owner misconfiguring anything: both files are correct on
// their own, and the collision only exists because Murage reuses the name.
// So Murage gives its own mount a name of its own and leaves both definitions
// intact.
//
// Harness-owned mounts (`computer`, `browser`, `agents`, `murage_connectors`,
// `murage-memory`, `murage_phone`) are NOT handled here: a bot's custom server
// can never take one of those names, because mcp-registry.ts rejects them at
// the config boundary (RESERVED_MCP_NAMES).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { codexHome } from "./codex-catalog.ts";

// A table header at the start of a line: `[mcp_servers.<name>]` or a sub-table
// of one, `[mcp_servers.<name>.env]`. The name may be bare, "double-quoted" or
// 'single-quoted'. Anchoring the `[` to the line start is what keeps a
// commented-out header (`# [mcp_servers.x]`) out of the result; requiring a
// `.` or `]` immediately after the name is what keeps a header whose own
// quoted key merely contains the text (`[projects."/srv/mcp_servers.decoy"]`)
// out of it. Over-collecting here only moves a server aside needlessly;
// under-collecting lets the merge happen, so the bias is deliberate.
const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*[.\]]/gm;

/** Server names declared as `[mcp_servers.<name>]` in a Codex config.toml.
 * Inline-table form (`mcp_servers = { … }`) is not scanned; a collision there
 * still surfaces as Codex's own configuration error rather than silently. */
export function mcpServerNamesInToml(toml: string): Set<string> {
  const names = new Set<string>();
  for (const match of toml.matchAll(HEADER)) {
    const name = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

/** Server names in the config.toml of the Codex home THIS child will use.
 * The env is the child's own, so `CODEX_HOME` is honoured exactly as the
 * spawned CLI will honour it. A missing or unreadable file means "none": a
 * config Murage cannot read is not a reason to refuse the turn. */
export function codexConfigMcpServerNames(env: Record<string, string | undefined>): Set<string> {
  try {
    return mcpServerNamesInToml(readFileSync(join(codexHome(env), "config.toml"), "utf8"));
  } catch {
    return new Set();
  }
}

/** The name to mount a custom server under: its own, unless that name is
 * already taken in the owner's Codex config. Deterministic, so the same
 * collision produces the same mount name on every turn and Codex's own
 * per-server state stays with the right server. */
export function mountedMcpServerName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name}_murage`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}_murage${i}`;
  return candidate;
}
