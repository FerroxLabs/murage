// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hermes profiles as Murage engines (0.1.61, DESIGN-0161-PROFILES-AND-GATEWAYS).
//
// A Hermes profile is a complete, separate Hermes home: `<root>/profiles/<name>`
// with its own config.yaml, SOUL.md, credentials, skills and memory. The root
// itself is the profile called `default`. Hermes picks the home in
// `hermes_cli/main.py` `_apply_profile_override`, in this order:
//
//  1. `-p/--profile <name>` wins.
//  2. With no flag, a HERMES_HOME whose parent directory is named `profiles`
//     is trusted as given.
//  3. Otherwise the sticky `<root>/active_profile` is read, even when
//     HERMES_HOME is set to the root.
//
// `HERMES_PROFILE` is never used to pick the home (it is the kanban author
// name). Before 0.1.61 Murage keyed its profile support on that variable and
// spawned a bare `hermes acp`, so on a machine with a sticky profile the
// engine ran that profile while Murage read and wrote `default`'s files.
// Every Hermes spawn now carries `-p <profile>` and everything Murage reads or
// writes resolves through `hermesHome(env, profile)` below, so the two agree.
//
// This module only reads the filesystem. It never starts the CLI: listing
// profiles through `hermes profile list` prints banners and would start a
// Python process per call.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";

import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { DEFAULT_HERMES_PROFILE, HERMES_INSTANCE_PREFIX, isHermesProfileName } from "../shared/hermes-profile-name.ts";

export { DEFAULT_HERMES_PROFILE, HERMES_INSTANCE_PREFIX, isHermesProfileName };
export const HERMES_DRIVER_KIND = "hermesAgent";

function userHome(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** `~/.hermes`: Hermes' platform default home. */
function nativeHermesHome(env: Record<string, string | undefined>): string {
  return join(userHome(env), ".hermes");
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** The Hermes root an exported HERMES_HOME names, as `profile_root_for_env_home`
 * computes it: the grandparent of a `<root>/profiles/<name>` value, the value
 * itself otherwise, `~/.hermes` when unset. */
export function hermesRoot(env: Record<string, string | undefined>): string {
  const exported = (env.HERMES_HOME ?? "").trim();
  if (!exported) return nativeHermesHome(env);
  return basename(dirname(exported)) === "profiles" ? dirname(dirname(exported)) : exported;
}

/** The home a `hermes -p <profile>` child runs in, under this env. `default`
 * is the root; any other name is `<root>/profiles/<name>`. Throws on a name
 * Hermes would refuse, so a caller can never build a path from one. */
export function hermesHome(env: Record<string, string | undefined>, profile: string = DEFAULT_HERMES_PROFILE): string {
  if (!isHermesProfileName(profile)) throw new Error(`"${String(profile).slice(0, 80)}" is not a Hermes profile name`);
  const root = hermesRoot(env);
  return profile === DEFAULT_HERMES_PROFILE ? root : join(root, "profiles", profile);
}

/** The profile an instance config pins. Absent or invalid means `default`
 * (design Q1: a bot must not change identity because someone ran
 * `hermes profile use` in a terminal). */
export function hermesProfileOf(config: unknown): string {
  const profile = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { profile?: unknown }).profile
    : undefined;
  return isHermesProfileName(profile) ? profile : DEFAULT_HERMES_PROFILE;
}

/** Whether a pinned profile owns this instance's identity, so Flux and
 * provider-connection routing (which replace the whole Hermes home) must
 * refuse it. `default` does not: it has always been swappable. A profile
 * pinned on upgrade from the sticky default keeps the routing it had before
 * 0.1.61, because on those turns it never ran the profile either. */
export function hermesProfileOwnsIdentity(config: { profile?: string; profileOrigin?: string } | undefined): boolean {
  const profile = hermesProfileOf(config);
  return profile !== DEFAULT_HERMES_PROFILE && config?.profileOrigin !== "sticky";
}

const IDENTITY_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];

function isFileOrLink(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Hermes' `named_profile_is_live`: a directory with an identity marker and
 * no tombstone in `profiles/.deleted/`. */
function profileIsLive(root: string, profile: string): boolean {
  const home = profile === DEFAULT_HERMES_PROFILE ? root : join(root, "profiles", profile);
  try {
    if (!statSync(home).isDirectory()) return false;
  } catch {
    return false;
  }
  if (profile !== DEFAULT_HERMES_PROFILE && existsSync(join(root, "profiles", ".deleted", profile))) return false;
  return IDENTITY_MARKERS.some((marker) => isFileOrLink(join(home, marker)));
}

/** The Hermes root `get_default_hermes_root` uses for `active_profile`: `~/.hermes`
 * whenever HERMES_HOME sits under it, else the root that HERMES_HOME names. */
function activeProfileRoot(env: Record<string, string | undefined>): string {
  const native = nativeHermesHome(env);
  const exported = (env.HERMES_HOME ?? "").trim();
  if (!exported || within(native, exported)) return native;
  return hermesRoot(env);
}

/** The profile a bare `hermes acp` (what Murage spawned before 0.1.61)
 * resolves to under this env, following `_apply_profile_override` with no
 * flag. A sticky name Hermes could not start (invalid, deleted, missing) ran
 * nothing at all, so it resolves to `default`. */
export function stickyHermesProfile(env: Record<string, string | undefined>): string {
  const exported = (env.HERMES_HOME ?? "").trim();
  if (exported && basename(dirname(exported)) === "profiles") {
    const name = basename(exported);
    return isHermesProfileName(name) && profileIsLive(dirname(dirname(exported)), name) ? name : DEFAULT_HERMES_PROFILE;
  }
  const root = activeProfileRoot(env);
  let name = "";
  try {
    name = readFileSync(join(root, "active_profile"), "utf8").trim();
  } catch {
    return DEFAULT_HERMES_PROFILE;
  }
  if (!name || name === DEFAULT_HERMES_PROFILE || !isHermesProfileName(name)) return DEFAULT_HERMES_PROFILE;
  return profileIsLive(root, name) ? name : DEFAULT_HERMES_PROFILE;
}

// ── config.yaml ─────────────────────────────────────────────────────────

function yamlString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the model/provider forms accepted by Hermes' `_normalize_root_model_keys`:
 * a scalar `model`, or a mapping whose id is `default`, `model`, or `name`.
 * Those id fields may themselves be `{ provider, model/default }` mappings.
 * An explicit outer provider wins, except `auto`, where the nested provider is
 * the more specific routing choice. Root-level `provider` is Hermes' legacy
 * fallback. YAML parsing also handles quotes and trailing comments correctly.
 */
export function hermesConfigDefault(text: string): { model: string; provider: string } | null {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const config = raw as Record<string, unknown>;
  const rootProvider = yamlString(config.provider);
  if (typeof config.model === "string") {
    const model = config.model.trim();
    return model ? { model, provider: rootProvider } : null;
  }
  if (!config.model || typeof config.model !== "object" || Array.isArray(config.model)) return null;

  const modelConfig = config.model as Record<string, unknown>;
  const outerProvider = yamlString(modelConfig.provider) || rootProvider;
  for (const key of ["default", "model", "name"] as const) {
    const candidate = modelConfig[key];
    const scalar = yamlString(candidate);
    if (scalar) return { model: scalar, provider: outerProvider };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    const nestedModel = yamlString(nested.model) || yamlString(nested.default);
    if (!nestedModel) continue;
    const nestedProvider = yamlString(nested.provider);
    const provider = !outerProvider || outerProvider === "auto" ? nestedProvider || outerProvider : outerProvider;
    return { model: nestedModel, provider };
  }
  return null;
}

// ── discovery ───────────────────────────────────────────────────────────

export interface HermesProfileInfo {
  name: string;
  /** `profile.yaml` display_name, else the id. */
  label: string;
  /** `profile.yaml` description, else the first sentence of SOUL.md. */
  description: string;
  model: string | null;
  provider: string | null;
  skillCount: number;
  hasSoul: boolean;
  /** Hermes' current default (`active_profile`), marked in the list. */
  sticky: boolean;
}

export interface HermesProfileListing {
  /** A Hermes root with at least one live profile exists. */
  found: boolean;
  profiles: HermesProfileInfo[];
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_PROFILES = 200;

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The first sentence of SOUL.md, skipping headings and blank lines. */
export function firstSentence(markdown: string): string {
  const body = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !/^[-*_]{3,}$/.test(line))
    .join(" ")
    .replace(/[*_`>]+/g, "")
    .trim();
  if (!body) return "";
  const match = /^.*?[.!?](?=\s|$)/.exec(body);
  return clip(match ? match[0] : body, 200);
}

/** Count SKILL.md files under `skills/`, bounded, the way `hermes profile list`
 * counts them (it prunes `.git` and `node_modules`). */
function countSkills(skillsDir: string): number {
  let count = 0;
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || visited > 5000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".hub") continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        count += 1;
      }
    }
  };
  walk(skillsDir, 0);
  return count;
}

function profileMeta(home: string): { displayName: string; description: string } {
  const text = readSmall(join(home, "profile.yaml"));
  if (!text) return { displayName: "", description: "" };
  try {
    const raw = parseYaml(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { displayName: "", description: "" };
    return { displayName: clip(yamlString(raw.display_name), 80), description: clip(yamlString(raw.description), 280) };
  } catch {
    return { displayName: "", description: "" };
  }
}

function describeProfile(root: string, name: string, sticky: string): HermesProfileInfo {
  const home = name === DEFAULT_HERMES_PROFILE ? root : join(root, "profiles", name);
  const meta = profileMeta(home);
  const soul = readSmall(join(home, "SOUL.md"));
  const configText = readSmall(join(home, "config.yaml"));
  const configured = configText ? hermesConfigDefault(configText) : null;
  return {
    name,
    label: meta.displayName || name,
    description: meta.description || (soul ? firstSentence(soul) : ""),
    model: configured?.model || null,
    provider: configured?.provider || null,
    skillCount: countSkills(join(home, "skills")),
    hasSoul: soul !== null,
    sticky: name === sticky,
  };
}

/** Every live profile under the Hermes root this env names: `default` first
 * (when the root itself is a Hermes home), then the named ones in name order. */
export function listHermesProfiles(env: Record<string, string | undefined>): HermesProfileListing {
  const root = activeProfileRoot(env);
  const sticky = stickyHermesProfile(env);
  const names: string[] = [];
  if (profileIsLive(root, DEFAULT_HERMES_PROFILE)) names.push(DEFAULT_HERMES_PROFILE);
  let entries: string[] = [];
  try {
    entries = readdirSync(join(root, "profiles"));
  } catch {
    entries = [];
  }
  for (const name of entries.sort()) {
    if (names.length >= MAX_PROFILES) break;
    if (name === DEFAULT_HERMES_PROFILE || !isHermesProfileName(name)) continue;
    if (profileIsLive(root, name)) names.push(name);
  }
  return { found: names.length > 0, profiles: names.map((name) => describeProfile(root, name, sticky)) };
}

// ── instances and import ────────────────────────────────────────────────

export function hermesInstanceIdFor(profile: string): string {
  if (!isHermesProfileName(profile)) throw new Error("not a Hermes profile name");
  return `${HERMES_INSTANCE_PREFIX}${profile}`;
}

function objectConfig(entry: InstanceConfig | undefined): Record<string, unknown> {
  const raw = entry?.config;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The Hermes instances of a fleet with the profile each one runs. With
 * `baseEnv`, only those whose own env resolves to the same Hermes root: a
 * `fred` under another HERMES_HOME is another agent with its own identity and
 * sign-ins (audit round 1, Astra 2). */
export function hermesInstanceProfiles(instances: InstanceConfigMap, baseEnv?: Record<string, string | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  const root = baseEnv ? resolve(hermesRoot(baseEnv)) : undefined;
  for (const [id, entry] of Object.entries(instances)) {
    if (entry.driver !== HERMES_DRIVER_KIND) continue;
    if (root !== undefined && resolve(hermesRoot({ ...baseEnv, ...entry.environment })) !== root) continue;
    out.set(id, hermesProfileOf(entry.config));
  }
  return out;
}

export interface HermesImportBot {
  id: string;
  name: string;
  instanceId: string;
}

export type HermesImportPlanItem =
  | { profile: string; action: "create"; instanceId: string; newInstance: boolean }
  | { profile: string; action: "skip"; reason: "already-imported" | "not-found" | "invalid" | "limit"; botName?: string };

/**
 * What Import from Hermes does for each requested profile. Pure, so the
 * idempotence and the bot limit are testable without a server:
 *
 * - a profile some bot already runs is skipped, naming that bot;
 * - a profile Hermes does not have (or a name Hermes would refuse) is skipped;
 * - an existing instance pinned to the profile is reused, otherwise
 *   `hermes-profile-<profile>` is added;
 * - creation stops at `maxBots`, and the rest are skipped as over the limit.
 */
export function planHermesImport(input: {
  requested: readonly string[];
  available: ReadonlySet<string>;
  instances: InstanceConfigMap;
  bots: readonly HermesImportBot[];
  maxBots: number;
  /** The env the profiles were listed under; instances in other roots are
   *  neither reused nor counted as already imported. */
  baseEnv?: Record<string, string | undefined>;
}): HermesImportPlanItem[] {
  const profiles = hermesInstanceProfiles(input.instances, input.baseEnv);
  const instanceFor = new Map<string, string>();
  for (const [id, profile] of profiles) if (!instanceFor.has(profile)) instanceFor.set(profile, id);
  const boundBot = new Map<string, string>();
  for (const bot of input.bots) {
    const profile = profiles.get(bot.instanceId);
    if (profile !== undefined && !boundBot.has(profile)) boundBot.set(profile, bot.name);
  }
  let room = Math.max(0, input.maxBots - input.bots.length);
  const seen = new Set<string>();
  const plan: HermesImportPlanItem[] = [];
  for (const profile of input.requested) {
    if (seen.has(profile)) continue;
    seen.add(profile);
    if (!isHermesProfileName(profile)) {
      plan.push({ profile: String(profile).slice(0, 80), action: "skip", reason: "invalid" });
      continue;
    }
    const botName = boundBot.get(profile);
    if (botName !== undefined) {
      plan.push({ profile, action: "skip", reason: "already-imported", botName });
      continue;
    }
    if (!input.available.has(profile)) {
      plan.push({ profile, action: "skip", reason: "not-found" });
      continue;
    }
    if (room <= 0) {
      plan.push({ profile, action: "skip", reason: "limit" });
      continue;
    }
    room -= 1;
    const existing = instanceFor.get(profile);
    // An id already taken by an engine in another root is never overwritten.
    let instanceId = existing ?? hermesInstanceIdFor(profile);
    for (let n = 2; !existing && Object.hasOwn(input.instances, instanceId); n += 1) instanceId = `${hermesInstanceIdFor(profile)}-${n}`;
    plan.push({ profile, action: "create", instanceId, newInstance: existing === undefined });
    if (!existing) instanceFor.set(profile, instanceId);
  }
  return plan;
}

// ── upgrade pin (0.1.61, owner decision O12) ─────────────────────────────

export interface HermesPin {
  instanceId: string;
  profile: string;
  /** "sticky": pinned to what Hermes' sticky default ran (gets the chat note).
   *  "import": a `hermes-profile-<name>` instance given back its own name. */
  origin: "sticky" | "import";
}

/**
 * The pins 0.1.61 writes on its first start: each Hermes instance that does
 * not name a profile yet is pinned to the profile a bare `hermes acp` resolves
 * to under that instance's own env today, so no bot changes identity. A
 * resolution to `default` needs no write (an absent profile is `default`).
 */
export function planHermesProfilePins(
  instances: InstanceConfigMap,
  baseEnv: Record<string, string | undefined>,
): HermesPin[] {
  const pins: HermesPin[] = [];
  for (const [instanceId, entry] of Object.entries(instances)) {
    if (entry.driver !== HERMES_DRIVER_KIND) continue;
    if (Object.hasOwn(objectConfig(entry), "profile")) continue;
    // An imported profile's instance is named for it; one that lost its
    // config (an older restore) is pinned back to that name, never to the
    // sticky profile.
    const named = instanceId.startsWith(HERMES_INSTANCE_PREFIX) ? instanceId.slice(HERMES_INSTANCE_PREFIX.length) : "";
    // Only a name that is a live profile in this instance's root counts: an
    // id with a collision suffix (`-2`) is not a profile name (audit, Kimi 4).
    if (isHermesProfileName(named) && profileIsLive(activeProfileRoot({ ...baseEnv, ...entry.environment }), named)) {
      pins.push({ instanceId, profile: named, origin: "import" });
      continue;
    }
    const profile = stickyHermesProfile({ ...baseEnv, ...entry.environment });
    if (profile !== DEFAULT_HERMES_PROFILE) pins.push({ instanceId, profile, origin: "sticky" });
  }
  return pins;
}
