// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// How the owner's own MCP servers become mounts on an engine turn (spec
// MCP-LINK 3.8). Three drivers used to carry their own copy of "skip an entry
// that asks for a Murage environment name, then mount the rest"; that filter and
// the merge of the harness's part of the environment now live here once.
//
// A mount has two environments. `env` is the owner's: the filter refuses it if it
// names anything Murage owns. `harnessEnv` is Murage's (the proxy's loopback URL
// and this turn's token), merged AFTER that check and only when it carries names
// Murage owns, so the owner can neither forge the harness's part nor get past
// the check through it.
import type { AppConfig } from "./config.ts";
import { customMcpServerDescriptors } from "./config.ts";
import { isHarnessOwnedMcpEnvName } from "./mcp-registry.ts";

export interface CustomMountInput {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Murage's part of the environment; see the header. */
  harnessEnv?: Record<string, string>;
}

/** What a driver mounts: one environment, already merged. */
export interface CustomMount {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Only names Murage owns, only text values. Anything else in `harnessEnv` is dropped. */
export function harnessEnvAllowed(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" && isHarnessOwnedMcpEnvName(name)) Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** True when the owner's part of the environment names something Murage owns. */
export function ownerEnvIsRefused(env: Record<string, string>): boolean {
  return Object.keys(env).some(isHarnessOwnedMcpEnvName);
}

/**
 * The owner's servers a driver should mount, with each environment merged. An
 * entry is left out when its owner environment names a Murage variable, or when
 * `isTaken` says its name is already a built-in mount (each driver knows its own
 * built-ins, so a residual collision keeps the built-in).
 */
export function customMountEntries(
  custom: Record<string, CustomMountInput> | undefined,
  isTaken: (name: string) => boolean = () => false,
): CustomMount[] {
  const mounts: CustomMount[] = [];
  for (const [name, server] of Object.entries(custom ?? {})) {
    if (isTaken(name)) continue;
    if (ownerEnvIsRefused(server.env)) continue;
    mounts.push({ name, command: server.command, args: server.args, env: { ...server.env, ...harnessEnvAllowed(server.harnessEnv) } });
  }
  return mounts;
}

export interface RemoteMountContext {
  execPath: string;
  proxyPath: string;
  harnessUrl: string;
  /** This turn's "mcp" capability token. Called once per turn, and only when a link server is mounted. */
  token: () => string;
}

/** The mount for one link server: the proxy, named in argv (Codex shares one
 * environment across every server it mounts, so a name in the environment would
 * collide), and the harness's part of the environment. No owner environment, no
 * credential of the server's own. */
export function buildRemoteMount(name: string, context: RemoteMountContext, token: string): CustomMountInput {
  return {
    command: context.execPath,
    args: [context.proxyPath, "--server", name],
    env: {},
    harnessEnv: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: context.harnessUrl, MURAGE_MCP_TOKEN: token },
  };
}

/** `integrations.custom` for a turn: every enabled command server as configured,
 * and every enabled link server as a proxy mount. Undefined when there is none. */
export function customIntegrations(cfg: AppConfig, context: RemoteMountContext): Record<string, CustomMountInput> | undefined {
  const { stdio, remote } = customMcpServerDescriptors(cfg);
  const out: Record<string, CustomMountInput> = {};
  for (const [name, server] of Object.entries(stdio)) out[name] = server;
  const remoteNames = Object.keys(remote);
  if (remoteNames.length > 0) {
    const token = context.token();
    for (const name of remoteNames) out[name] = buildRemoteMount(name, context, token);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
