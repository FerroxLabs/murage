// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenClaw agents as Murage engines (lane 0163-openclaw-engine).
//
// An OpenClaw "agent" is an isolated agent: its own workspace, auth and
// routing, living at `<state dir>/agents/<name>`. The state dir is
// `$OPENCLAW_STATE_DIR` when set (OpenClaw's own override; `--profile <p>`
// makes it `~/.openclaw-<p>`), else `~/.openclaw`. The bridge picks the agent
// from `--session agent:<name>:main`, so every spawn names its agent and a
// terminal-side default can never change which agent answers.
//
// This module only reads the filesystem. It never starts the CLI: listing
// through `openclaw agents list` would boot a Node gateway client per call.
// Same discipline as hermes-profiles.ts.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";

export const OPENCLAW_DRIVER_KIND = "openclawAgent";
/** OpenClaw's own default agent id (`openclaw agents list` always has it). */
export const DEFAULT_OPENCLAW_AGENT = "main";
/** The instance id prefix an imported OpenClaw agent's engine gets. */
export const OPENCLAW_INSTANCE_PREFIX = "openclaw-agent-";

/** OpenClaw normalises agent ids to lowercase `[a-z0-9_-]`, 1..64 chars,
 * starting alphanumeric. A name outside this never becomes argv or a path. */
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_AGENTS = 200;

export function isOpenclawAgentName(value: unknown): value is string {
  return typeof value === "string" && AGENT_NAME.test(value);
}

function userHome(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** The state dir a `openclaw` child runs in under this env. */
export function openclawStateDir(env: Record<string, string | undefined>): string {
  const exported = (env.OPENCLAW_STATE_DIR ?? "").trim();
  return exported || join(userHome(env), ".openclaw");
}

/** `<state dir>/agents`. */
export function openclawAgentsDir(env: Record<string, string | undefined>): string {
  return join(openclawStateDir(env), "agents");
}

/** The agent an instance config pins. Absent or invalid means `main`. */
export function openclawAgentOf(config: unknown): string {
  const agent = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { agent?: unknown }).agent
    : undefined;
  return isOpenclawAgentName(agent) ? agent : DEFAULT_OPENCLAW_AGENT;
}

/** The `--session` key that selects an agent at the ACP bridge. */
export function openclawSessionKey(agent: string): string {
  if (!isOpenclawAgentName(agent)) throw new Error(`"${String(agent).slice(0, 80)}" is not an OpenClaw agent name`);
  return `agent:${agent}:main`;
}

/** Entries OpenClaw creates inside a real agent dir (`agent/` holds
 * auth-profiles.json and models.json, `sessions/` the transcripts). */
const AGENT_MARKERS = ["agent", "sessions"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLiveAgent(dir: string): boolean {
  if (!isDir(dir)) return false;
  return AGENT_MARKERS.some((marker) => {
    try {
      lstatSync(join(dir, marker));
      return true;
    } catch {
      return false;
    }
  });
}

export interface OpenclawAgentInfo {
  name: string;
  label: string;
  isDefault: boolean;
}

export interface OpenclawAgentListing {
  found: boolean;
  agents: OpenclawAgentInfo[];
}

/** Every agent under the state dir this env names: `main` first when present,
 * then the rest in name order. Never starts the CLI. */
export function listOpenclawAgents(env: Record<string, string | undefined>): OpenclawAgentListing {
  const root = openclawAgentsDir(env);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  const names = entries
    .filter((name) => isOpenclawAgentName(name) && isLiveAgent(join(root, name)))
    .sort((a, b) => (a === DEFAULT_OPENCLAW_AGENT ? -1 : b === DEFAULT_OPENCLAW_AGENT ? 1 : a.localeCompare(b)))
    .slice(0, MAX_AGENTS);
  return {
    found: names.length > 0,
    agents: names.map((name) => ({
      name,
      label: name === DEFAULT_OPENCLAW_AGENT ? "OpenClaw" : `OpenClaw · ${name}`,
      isDefault: name === DEFAULT_OPENCLAW_AGENT,
    })),
  };
}

export function openclawInstanceIdFor(agent: string): string {
  if (!isOpenclawAgentName(agent)) throw new Error("not an OpenClaw agent name");
  return `${OPENCLAW_INSTANCE_PREFIX}${agent}`;
}

function objectConfig(entry: InstanceConfig | undefined): Record<string, unknown> {
  const raw = entry?.config;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The OpenClaw instances of a fleet with the agent each one runs. */
export function openclawInstanceAgents(instances: InstanceConfigMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, entry] of Object.entries(instances)) {
    if (entry.driver !== OPENCLAW_DRIVER_KIND) continue;
    out.set(id, openclawAgentOf(objectConfig(entry)));
  }
  return out;
}
