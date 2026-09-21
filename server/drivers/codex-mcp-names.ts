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

/** Mount name for each of a bot's custom servers, keyed by the bot's own name.
 * A server keeps its name unless the owner's Codex config already declares one
 * by that name; then it is moved aside.
 *
 * Every value is distinct, and that is the whole reason this takes the servers
 * together rather than one at a time. An alias has to dodge three things, not
 * just the owner's file: the owner's declared names, the bot's OTHER custom
 * names, and the aliases already handed out in this same pass. Move `foo` aside
 * while the bot also has a server literally called `foo_murage` and both mount
 * under `mcp_servers.foo_murage` — the second `-c` override merges into the
 * first, which is the same silent capability merge this module exists to stop,
 * only now caused by Murage instead of the owner.
 *
 * Deterministic: the same inputs give the same mount names on every turn, so
 * Codex's per-server state stays with the right server. Insertion order of
 * `names` is part of that determinism, and it comes from the bot's stored
 * config, which is stable. */
export function mountedMcpServerNames(
  names: Iterable<string>,
  declared: ReadonlySet<string>,
): Map<string, string> {
  const wanted = [...names];
  // Seeded with the bot's own names so an alias never lands on a sibling that
  // is about to mount, or has already mounted, under that exact name.
  const taken = new Set<string>([...declared, ...wanted]);
  const mounts = new Map<string, string>();
  for (const name of wanted) {
    if (!declared.has(name)) {
      mounts.set(name, name);
      continue;
    }
    let candidate = `${name}_murage`;
    for (let i = 2; taken.has(candidate); i++) candidate = `${name}_murage${i}`;
    taken.add(candidate);
    mounts.set(name, candidate);
  }
  return mounts;
}
