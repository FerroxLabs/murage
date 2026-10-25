// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenClaw agents as Murage engines (lane 0163-openclaw-engine).
//
// An OpenClaw "agent" is an isolated agent: its own workspace, auth and
// routing, living at `<state dir>/agents/<name>`. The state dir is
// `$OPENCLAW_STATE_DIR` when set (OpenClaw's own override; `--profile <p>`
// makes it `~/.openclaw-<p>`), else `~/.openclaw`. The bridge picks the agent
// from the `agent:<name>:` prefix of `--session`, so every spawn names its
// agent and a terminal-side default can never change which agent answers. The
// rest of the key names the Murage conversation and its audience, so two
// conversations never share one OpenClaw conversation (audit 03-3).
//
// This module only reads the filesystem. It never starts the CLI: listing
// through `openclaw agents list` would boot a Node gateway client per call.
// Same discipline as hermes-profiles.ts.
import { createHash } from "node:crypto";
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

/** Who one Murage conversation runs for (SendTurnInput.warmIdentity's parts). */
export interface OpenclawSessionScope {
  threadId: string;
  audience?: "owner" | "non-owner";
  humanPrincipal?: string;
  /** How many times this conversation's session was reset (an edit, a rewind, a memory revocation).
   *  Each reset moves the conversation to a new gateway key so the gateway cannot hand back what was removed. */
  generation?: number;
}

/** The `--session` key for one Murage conversation on one agent.
 *
 * The bridge binds every session it opens or loads to this key, and the
 * gateway keeps one conversation per key. A fixed `agent:<agent>:main` let a
 * private owner conversation and any other conversation on the same agent
 * (another thread, a channel, a guest) read each other's history. So the key
 * carries the thread, and a turn that is not known to be the owner's gets a
 * separate key per person: the owner's key is never handed to anyone else.
 * Hashed, so the key holds no raw ids and stays in the bridge's key alphabet.
 *
 * Upgrade: the old shared `agent:<agent>:main` history stays in the gateway and
 * is attached to nobody (the owner included). The bridge binds a resumed
 * session to the argv key, so an old resume cursor does not carry that history
 * over: each conversation and each person starts fresh on its own key. */
export function openclawSessionKey(agent: string, scope: OpenclawSessionScope): string {
  if (!isOpenclawAgentName(agent)) throw new Error(`"${String(agent).slice(0, 80)}" is not an OpenClaw agent name`);
  if (typeof scope?.threadId !== "string" || !scope.threadId) throw new Error("an OpenClaw session key needs the conversation it belongs to");
  const owner = scope.audience === "owner";
  const part = owner ? "owner" : "guest";
  const digest = createHash("sha256")
    // Generation 0 hashes exactly as before, so a conversation that was never reset keeps its key.
    .update(["murage", agent, scope.threadId, part, owner ? "" : scope.humanPrincipal ?? "", ...(scope.generation && scope.generation > 0 ? [`gen${Math.floor(scope.generation)}`] : [])].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `agent:${agent}:murage-${part}-${digest}`;
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
