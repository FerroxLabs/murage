// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// G43: what a phone may read about one bot's MCP servers. Names and switches
// only: command, args, url, env and headers never leave (each row is built
// field by field). `on` means "starts on this bot's owner turns": the same
// filter the turn mounts through (customIntegrations, then customMountEntries:
// pending keys, Netlify, reserved names, Murage env names), plus the engine
// and bot gates the two mount sites in index.ts apply. The per-turn safe-mode
// rule is not part of a static list.
import type { AppConfig } from "./config.ts";
import { customIntegrations, customMountEntries } from "./custom-mcp-mounts.ts";
import { listAllMcpServers } from "./mcp-registry.ts";
import { redactSecretsInText } from "./redact.ts";

export interface BotMcpServerRow {
  name: string;
  enabled: boolean;
  /** Starts on this bot's owner turns. */
  on: boolean;
}

export interface BotMcpGates {
  /** The bot's engine mounts the owner's own servers (adapter capability customMcp). */
  engineMountsCustom: boolean;
  /** ownServersAllowedFor(bot): the owner has not restricted or hidden this bot. */
  ownServersAllowed: boolean;
}

// The mount filter needs a context; nothing here is mounted, so no token is minted.
const LIST_ONLY = { execPath: "", proxyPath: "", harnessUrl: "", token: () => "" };

export function botMcpServers(cfg: AppConfig, gates: BotMcpGates): { servers: BotMcpServerRow[] } {
  const raw = (cfg.mcpServers ?? {}) as Record<string, unknown>;
  const mounted = gates.engineMountsCustom && gates.ownServersAllowed
    ? new Set(customMountEntries(customIntegrations(cfg, LIST_ONLY)).map((mount) => mount.name))
    : new Set<string>();
  const servers = listAllMcpServers(raw).map((listing): BotMcpServerRow => ({
    name: redactSecretsInText(listing.name),
    enabled: listing.enabled === true,
    on: listing.enabled === true && mounted.has(listing.name),
  }));
  return { servers };
}
