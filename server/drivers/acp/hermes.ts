import { cloudEngineHome } from "../../cloud-home/turn-process.ts";
import { cloudHomeCopy } from "../../cloud-home/copy.ts";
// Hermes Agent — Nous Research's `hermes acp` CLI. Custom-only: Hermes is
// a BYOK/local harness. ACP ignores `hermes -m` (cmd_acp does not forward
// it), and setting OPENAI_API_KEY makes provider:auto resolve to OpenRouter
// without an OpenRouter key — that is the "HTTP 401: Missing Authentication
// header" failure. Inject writes providers.<host> and session/set_model
// `custom:<host>:<model>` instead.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { writeFileAtomic } from "../../atomic.ts";
import { quietChildPipes } from "../../child-pipe-quiet.mjs";
import { killCliTree, spawnCli } from "../../procs.ts";
import { DATA_DIR } from "../../config.ts";
import { fluxKey } from "../../flux-config.ts";
import { FLUX_OPENAI_BASE, fluxModelId } from "../../flux-routing.ts";
import { FLUX_HEADER_REFUSAL, type FluxMemoryDecision } from "../../flux-memory-headers.ts";
import { mergeFluxCatalog } from "../../flux-surface.ts";
import { decodeInjectId, hostApiKey, INJECT_SEP, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { LocalHost } from "../local-inject.ts";
import { displayConfigPath, NativeConfigRefusal } from "../native-config-file.ts";
import {
  DEFAULT_HERMES_PROFILE,
  hermesConfigDefault,
  hermesHome,
  hermesProfileOf,
  hermesProfileOwnsIdentity,
  isHermesProfileName,
} from "../../hermes-profiles.ts";
import { OWN_BUILTINS, OWN_UNASKED, ownToolListedOnTurn, type OwnBuiltin } from "../../../shared/own-servers.ts";
import { EMAIL_TOOLS_ENV } from "../email-tool-schemas.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

export const HERMES_OPENMAUS_SCREENSHOT_COMPAT = "HERMES_OPENMAUS_SCREENSHOT_COMPAT";
export const HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL = "HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL";

/** Bind screenshot pseudo-call compatibility to one exact injected model. */
export function bindHermesScreenshotCompat(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): void {
  delete env[HERMES_OPENMAUS_SCREENSHOT_COMPAT];
  delete env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL];
  const inject = decodeInjectId(modelId);
  if (!inject) return;
  env[HERMES_OPENMAUS_SCREENSHOT_COMPAT] = "1";
  env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL] = inject.model;
}

type HermesProfileConfig = { profile?: string; profileOrigin?: "sticky" } | undefined;

/** Set beside HERMES_HOME when Murage made that home for one turn (the Flux
 * home, a provider-connection home). Named explicitly: inferring it from
 * "the home is under the data dir" also caught an owner's own Hermes root
 * kept there, and started a pinned profile as `default` (audit round 1,
 * Astra 3). */
export const HERMES_ROUTED_HOME_ENV = "MURAGE_HERMES_ROUTED_HOME";

export function markHermesRoutedHome(env: Record<string, string | undefined>): void {
  if (env.HERMES_HOME) env[HERMES_ROUTED_HOME_ENV] = resolve(env.HERMES_HOME);
}

/** True when HERMES_HOME is the home Murage marked for this turn. `-p <name>`
 * must not be passed then: Hermes would look for `<that home>/profiles/<name>`. */
function murageRoutedHome(env: Record<string, string | undefined> | undefined): boolean {
  const home = env?.HERMES_HOME;
  const marked = env?.[HERMES_ROUTED_HOME_ENV];
  return !!home && !!marked && resolve(home) === marked;
}

/**
 * Hermes asks on its own only for a command it judges dangerous and for edits;
 * every other tool (an ordinary shell command, execute_code, a browser or MCP
 * tool) runs with no request_permission, so at Ask a bot ran `echo > file`
 * unasked (real hermes 0.22.2 on the gate box). Hermes lets a `pre_tool_call`
 * shell hook answer {"action":"approve"}, which sends THAT call through the
 * same human gate as a dangerous command, and the gate reaches Murage as
 * session/request_permission. So every spawn carries one Murage-owned hook for
 * every tool that is not on the read-only list below.
 *
 * Left alone: Hermes's reads and lookups; write_file and patch, which already
 * ask through Hermes's own edit approval (a second card would double-ask);
 * Murage's own OWN_UNASKED tools (HERMES_OWN_UNASKED_TOOLS); and, on a host-computer turn only, Murage's own `computer` MCP tools, which
 * Murage's computer service asks for per action (hostComputerAskedByMurage).
 */
export const HERMES_ASK_FREE_TOOLS = [
  "read_file", "search_files", "tool_describe", "skills_list", "skill_view", "session_search", "todo_list", "clarify",
  "web_search", "web_extract", "vision_analyze", "video_analyze", "show_tip", "read_terminal", "read_window_below",
  "x_search", "memory", "write_file", "patch",
] as const;

/** Murage's own tools that run with no card on every engine (shared/own-servers.ts OWN_UNASKED), as the exact
 *  names Hermes gives them: `mcp__<server, - as _>__<tool>`. Each is one whole name, so a third-party server
 *  whose name only starts like an own one (`murage_memory_evil`) still asks, and so does every OWN_ALWAYS_ASK tool. */
export const HERMES_OWN_UNASKED_TOOLS: readonly string[] = OWN_UNASKED.flatMap((row) => {
  const server = OWN_BUILTINS[row.mount.slice("own:".length) as OwnBuiltin].replace(/-/g, "_");
  return row.tools.map((tool) => `mcp__${server}__${tool}`);
});

const regexLiteral = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The hook's `matcher`: Hermes full-matches it against the tool name. */
export function hermesAskMatcher(hostComputer: boolean, phoneJobs = false, emailMode?: string): string {
  // the email tools are ask-free only on a turn whose email mount listed them (dark launch: no mode, the matcher of the build without email)
  const own = HERMES_OWN_UNASKED_TOOLS.filter((name) => (phoneJobs || !name.startsWith("mcp__phoneJobs__")) && ownToolListedOnTurn(name.slice(name.lastIndexOf("__") + 2), emailMode)).map(regexLiteral);
  const free = hostComputer ? [...HERMES_ASK_FREE_TOOLS, ...own, "mcp__computer__.*"] : [...HERMES_ASK_FREE_TOOLS, ...own];
  return `(?!(?:${free.join("|")})$).+`;
}

/** Hermes events that run an owner's own shell hooks while a bot turn works. The turn accepts shell hooks
 *  unattended (HERMES_ACCEPT_HOOKS) so its own hook can register, which would also accept an owner hook
 *  never approved at a terminal, so the owner's hooks on these events are replaced by none for the turn. */
const HERMES_OWNER_HOOK_EVENTS = [
  "post_tool_call", "transform_terminal_output", "transform_tool_result", "transform_llm_output", "pre_llm_call",
  "post_llm_call", "pre_verify", "pre_api_request", "post_api_request", "api_request_error", "pre_auxiliary_call",
  "post_auxiliary_call", "on_session_start", "on_session_end", "on_session_finalize", "on_session_reset",
  "subagent_start", "subagent_stop", "on_stream_start", "on_stream_delta", "on_stream_end", "on_interim_message",
] as const;

/** The hook program: whatever tool it is told about, it answers "ask". Hermes only runs it for the tools the
 *  matcher selects, so it needs no list of its own. */
export const HERMES_ASK_HOOK_SOURCE = `"use strict";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let call = {};
  try { call = JSON.parse(raw) || {}; } catch { call = {}; }
  const tool = typeof call.tool_name === "string" && call.tool_name ? call.tool_name : "tool";
  const input = call.tool_input && typeof call.tool_input === "object" ? call.tool_input : {};
  const detail = typeof input.command === "string" ? input.command : typeof input.code === "string" ? input.code : JSON.stringify(input);
  process.stdout.write(JSON.stringify({ action: "approve", message: tool + ": " + String(detail).slice(0, 400) }));
});
`;

function hermesAskDir(env: Record<string, string | undefined>): string {
  return join(env.MURAGE_DATA_DIR || DATA_DIR, "native", "hermes-ask");
}

/**
 * Put the ask hook on this Hermes child, per process: a Murage-owned script, a managed-scope overlay
 * (HERMES_MANAGED_DIR, the layer Hermes merges over every config and the Flux Memory overlay already uses) that
 * carries the hook, and HERMES_ACCEPT_HOOKS so the unattended ACP child registers it. The owner's own config.yaml
 * is never written. The overlay starts from whatever managed config the child was already given (the Flux
 * Memory overlay, or an administrator's), so both still apply.
 */
/** Hermes env switches that approve without asking (tools/approval.py HERMES_YOLO_MODE, the ACP adapter's
 *  HERMES_ACP_AUTO_APPROVE). An owner's shell export of one would skip the hook gate, so the child never sees them. */
export const HERMES_AUTO_APPROVE_ENV = ["HERMES_YOLO_MODE", "HERMES_ACP_AUTO_APPROVE"] as const;

export function applyHermesAskHook(env: Record<string, string | undefined>, opts: { hostComputer: boolean; phoneJobs?: boolean; emailMode?: string }): void {
  for (const name of HERMES_AUTO_APPROVE_ENV) delete env[name];
  const dir = hermesAskDir(env);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const script = join(dir, `ask-hook-${hash(HERMES_ASK_HOOK_SOURCE)}.cjs`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing: string | null = null;
  try { existing = readFileSync(script, "utf8"); } catch { existing = null; }
  if (existing !== HERMES_ASK_HOOK_SOURCE) writeFileAtomic(script, HERMES_ASK_HOOK_SOURCE, { mode: 0o600 });
  const named = (env.HERMES_MANAGED_DIR ?? "").trim();
  const baseDir = named || (process.platform === "win32" ? "" : HERMES_DEFAULT_MANAGED_DIR);
  let base: Record<string, unknown> = {};
  if (baseDir) {
    try {
      const parsed: unknown = parseYaml(readFileSync(join(baseDir, "config.yaml"), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch { base = {}; }
  }
  const held = base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks) ? base.hooks as Record<string, unknown> : {};
  const forward = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
  const command = `"${forward(process.execPath)}" "${forward(script)}"`;
  const hooks = {
    ...held,
    ...Object.fromEntries(HERMES_OWNER_HOOK_EVENTS.map((event) => [event, []])),
    // an administrator's own pre_tool_call hooks stay, after this one
    pre_tool_call: [{ matcher: hermesAskMatcher(opts.hostComputer, opts.phoneJobs === true, opts.emailMode), command, timeout: 10, fail_closed: true }, ...(Array.isArray(held.pre_tool_call) ? held.pre_tool_call as unknown[] : [])],
  };
  const overlay = stringifyYaml({ ...base, hooks });
  const overlayDir = join(dir, `overlay-${hash(overlay)}`);
  const file = join(overlayDir, "config.yaml");
  let current: string | null = null;
  try { current = readFileSync(file, "utf8"); } catch { current = null; }
  if (current !== overlay) {
    mkdirSync(overlayDir, { recursive: true, mode: 0o700 });
    try { chmodSync(overlayDir, 0o700); } catch { /* Windows ignores POSIX modes */ }
    writeFileAtomic(file, overlay, { mode: 0o600 });
  }
  env.HERMES_MANAGED_DIR = overlayDir;
  env.HERMES_ACCEPT_HOOKS = "1";
  // the hook runs as `<this program> <script>`; a packaged app is its own node only with this set
  env.ELECTRON_RUN_AS_NODE = "1";
}

/** argv for a Hermes child: every spawn names its profile, so a sticky
 * `hermes profile use` in a terminal can never change which agent answers. */
export function hermesSpawnArgs(config: HermesProfileConfig, env?: Record<string, string | undefined>): string[] {
  const profile = murageRoutedHome(env) ? DEFAULT_HERMES_PROFILE : hermesProfileOf(config);
  return ["-p", profile, "acp"];
}

const DRIVER_KIND = "hermesAgent";

/**
 * The scoped HOME a Flux-routed hermes spawn runs under.
 *
 * App-private and disposable. Nothing under `~/.hermes` is read or written on
 * this path — that is the entire reason hermes needs no backup, no receipt and
 * no rollback, and why it is capability `env` rather than `setup` despite
 * involving a file. `MURAGE_DATA_DIR` is read off the passed env rather than
 * the module constant so a test rig can redirect the whole thing.
 */
export function fluxHermesHome(env: Record<string, string | undefined>): string {
  return join(process.env.MURAGE_CLOUD_ROLE === "home" ? cloudEngineHome("hermesAgent") : env.MURAGE_DATA_DIR || DATA_DIR, "flux-hermes-home");
}

/**
 * Write the scoped `config.yaml` and return the directory to set as HERMES_HOME.
 *
 * Regenerated on EVERY flux-routed spawn (Wayland hermesConfig.ts:47 does the
 * same) so a rotated key can never be served from a stale file, and so a
 * half-written home from a crashed run cannot survive.
 *
 * It holds NO tier. Every Flux Hermes bot shares this one file and Hermes
 * re-reads it through an mtime cache, so a `model.default` here was last
 * writer wins: two overlapping turns on different tiers could both run, and be
 * billed, on whichever tier spawned second (audit 03-4 / G03-1). The tier
 * rides the per-turn managed-scope overlay instead (`writeHermesTurnOverlay`),
 * the same channel the Flux Memory headers use, so the bytes here are the same
 * for every bot and every tier.
 *
 * Three details are load-bearing and were paid for in Wayland
 * (hermesConfig.ts:20-30, HERMES-PROOF.md:32-35, proven against hermes 0.14.0):
 *
 *  - `provider` MUST be the literal `custom`. Hermes has a closed provider
 *    registry; an invented `provider: flux` dies with
 *    `AuthError: Unknown provider 'flux'`.
 *  - the key MUST be INLINE. For a `custom` provider hermes ignores `key_env`
 *    entirely and resolves from config or its own auth store, falling back to
 *    a stale stored token → HTTP 401 `token_not_found`. Inline → 200. This is
 *    also why `applyFluxSurface` is a no-op for hermes: there is no env var
 *    hermes would read.
 *  - `providers: {}` is written explicitly so the scoped home cannot inherit
 *    or imply any hosted provider.
 *
 * 0600 on the file and 0700 on the directory because the file holds a bearer
 * token in plaintext; `writeFileAtomic` applies the mode to the temp inode
 * itself, so the token is never briefly world-readable.
 */
export function materializeFluxHermesHome(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const dir = fluxHermesHome(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows ignores POSIX modes; a scoped home is still better than none.
  }
  const text = [
    "model:",
    "  provider: custom",
    `  base_url: ${quoteYaml(FLUX_OPENAI_BASE)}`,
    "  api_mode: chat_completions",
    `  api_key: ${quoteYaml(key)}`,
    "providers: {}",
    // The scoped home is shared by every Flux Hermes bot, so Hermes's own memory stays off in it.
    "memory:",
    "  memory_enabled: false",
    "  user_profile_enabled: false",
    "",
  ].join("\n");
  // Hermes is not in a Cloud home's engine manifest, and the launcher renders no Hermes config.
  if (process.env.MURAGE_CLOUD_ROLE === "home") throw new Error(cloudHomeCopy.hermesOnHome);
  writeFileAtomic(join(dir, "config.yaml"), text, { mode: 0o600 });
  return dir;
}

/**
 * Point one child env at a Flux-routed Hermes, in place, and report the tier.
 *
 * Split out of `resolveTurnModel` so the env mutation is directly testable:
 * the fake ACP CLI dumps only an allowlist of names and cannot see
 * HERMES_HOME, so an integration test can prove the FILE landed but not that
 * the child was aimed at it. Both halves matter — a scoped home nobody points
 * at is a no-op, and a HERMES_HOME with no config.yaml is a 401.
 *
 * Returns null (touching nothing) for a native model or a missing key, so it
 * is safe to call on every turn.
 */
export function applyHermesFluxHome(
  env: Record<string, string | undefined>,
  model: string | null | undefined,
  key: string | null,
  config?: HermesProfileConfig,
): string | null {
  const tier = fluxModelId(model);
  if (!tier) return null;
  // No key degrades to native rather than to a half-written home that 401s —
  // the same choice `applyFluxSurface` makes for the env engines.
  if (!key) return null;
  // Wayland accepts "a profile spawn silently stays native"
  // (AcpAgentManager.ts:707-713). We refuse instead. The persona lives in
  // `<HERMES_HOME>/profiles/<name>` and the scoped home has none, so the
  // choice is between running the wrong persona and saying so; this codebase
  // already treats "answered OK but ran something else" as the worse outcome
  // (core.ts:645-651).
  //
  // The check keys on the pinned profile, the selector Hermes actually
  // honours. HERMES_PROFILE was the old key and Hermes never reads it to pick
  // a home. A profile pinned on upgrade from the sticky default is exempt: on
  // Flux turns it ran this scoped home before 0.1.61 too (O12).
  if (hermesProfileOwnsIdentity(config)) {
    throw new Error(
      `This bot runs the Hermes profile "${hermesProfileOf(config)}", whose persona and sign-ins live in that profile. Flux Router would replace it, so pick one of the profile's own models.`,
    );
  }
  env.HERMES_HOME = materializeFluxHermesHome(env, key);
  markHermesRoutedHome(env);
  writeHermesTurnOverlay(env, { model: { default: tier } });
  return tier;
}

/** Murage's own per-turn overlays live here, content addressed. */
function hermesOverlayRoot(env: Record<string, string | undefined>): string {
  return join(env.MURAGE_DATA_DIR || DATA_DIR, "native", "flux-memory");
}

function ownOverlay(env: Record<string, string | undefined>): string | null {
  const named = (env.HERMES_MANAGED_DIR ?? "").trim();
  return named && resolve(named).startsWith(resolve(hermesOverlayRoot(env))) ? named : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** What this child's overlay already holds: Murage's own overlay when an
 * earlier step of this turn wrote one, else the administrator's managed config. */
function overlayBase(env: Record<string, string | undefined>): Record<string, unknown> {
  const own = ownOverlay(env);
  if (!own) return adminManagedConfig(env);
  try { return asRecord(parseYaml(readFileSync(join(own, "config.yaml"), "utf8"))); } catch { return {}; }
}

/**
 * Write this turn's managed-scope overlay and point the child at it.
 *
 * The base is what this child would already read: Murage's own overlay when an
 * earlier step of this turn wrote one (it already carries the administrator's
 * config), else the administrator's managed config. `model` keys are merged
 * over the base's `model`; anything else is replaced. Content addressed, so a
 * child only ever reads its own turn's tier and headers, and the pool key (a
 * digest of the child env) never reuses a warm child across tiers.
 */
function writeHermesTurnOverlay(
  env: Record<string, string | undefined>,
  patch: { model: Record<string, unknown> },
): void {
  const base = overlayBase(env);
  const overlay = stringifyYaml({ ...base, model: { ...asRecord(base.model), ...patch.model } });
  const dir = join(hermesOverlayRoot(env), `hermes-${createHash("sha256").update(overlay).digest("hex").slice(0, 16)}`);
  const file = join(dir, "config.yaml");
  let current: string | null = null;
  try { current = readFileSync(file, "utf8"); } catch { current = null; }
  if (current !== overlay) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* Windows ignores POSIX modes */ }
    writeFileAtomic(file, overlay, { mode: 0o600 });
  }
  env.HERMES_MANAGED_DIR = dir;
}

/** Hermes's built-in managed-scope directory (hermes_cli/managed_scope.py `_DEFAULT_MANAGED_DIR`). */
const HERMES_DEFAULT_MANAGED_DIR = "/etc/hermes";

/**
 * Carries one turn's Flux Memory headers to its Hermes child without touching
 * the shared home.
 *
 * Every Flux Hermes child shares ONE home (state.db, sessions/), so native
 * history, resume and conversation deletion all see one store. The headers
 * cannot live in that home's config.yaml: Hermes re-reads it lazily (an
 * mtime-keyed cache in hermes_cli/config.py `load_config`, called again by
 * agent/auxiliary_client.py `_apply_user_default_headers` whenever a main or
 * side-task client is built), so a concurrent turn's rewrite would reach a
 * running child. Instead each child gets `HERMES_MANAGED_DIR`: Hermes
 * deep-merges `<that dir>/config.yaml` over the home's config on every load
 * (hermes_cli/managed_scope.py `get_managed_dir`, config.py
 * `_merge_managed_overlay`). The overlay is content-addressed and written
 * once, so a child only ever reads its own turn's headers, and the pool key
 * (a digest of the child env) never reuses a warm child across contracts.
 * It holds no key and no history. An administrator's own managed config, if
 * the machine has one, is carried into the overlay so its policy still holds.
 */
export function applyHermesFluxMemory(env: Record<string, string | undefined>, decision: FluxMemoryDecision): void {
  // Only Murage's own scoped home is on Flux. A native Hermes turn (no key, or
  // the user's own home) is not, so there is nothing to carry.
  if (!murageRoutedHome(env)) return;
  const home = env.HERMES_HOME;
  let text: string | null = null;
  try { text = home ? readFileSync(join(home, "config.yaml"), "utf8") : null; } catch { text = null; }
  if (!text || !/\nproviders:/.test(text) || !text.startsWith("model:\n")) {
    if (decision.capture === "off" || decision.inject === "off") throw new Error(FLUX_HEADER_REFUSAL);
    return;
  }
  const base = overlayBase(env);
  const held = asRecord(asRecord(base.model).extra_headers);
  const kept = Object.fromEntries(Object.entries(held).filter(([name]) => !name.toLowerCase().startsWith("x-flux-memory")));
  writeHermesTurnOverlay(env, { model: { extra_headers: { ...kept, ...decision.headers } } });
}

/** First Hermes release that reads `HERMES_MANAGED_DIR`: 0.17.0 (tag v2026.6.19),
 * where hermes_cli/managed_scope.py arrived (9cbcc0c9c8) and `load_config` merges
 * its overlay (b5ddd6e719). Older builds ignore the overlay without any error. */
export const HERMES_MIN_MANAGED_SCOPE: readonly [number, number, number] = [0, 17, 0];

/** Parse the `hermes --version` banner ("Hermes Agent v0.21.3 (2026.9.14)"). */
export function parseHermesVersion(banner: string): [number, number, number] | null {
  const m = /Hermes Agent v(\d+)\.(\d+)\.(\d+)/i.exec(banner) ?? /(?:^|\s)v(\d+)\.(\d+)\.(\d+)(?!\d)/.exec(banner);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Shown when a Hermes too old for the managed-scope overlay is picked for a Flux tier. */
export const HERMES_FLUX_UPDATE_COPY = "This Hermes is older than 0.17, so it cannot run a Flux Router tier here. Update Hermes (hermes update), then send again.";

let unknownVersionLogged = false;
/** Test hook: lets the once-per-process unknown-version log fire again. */
export function resetHermesUnknownVersionLog(): void { unknownVersionLogged = false; }

/** A turn whose Flux Memory headers say "off" rides only the managed-scope
 * overlay. On a Hermes older than the first managed-scope build, or one whose
 * version is unknown, that overlay would be ignored and the turn would go out
 * without its "off" headers, so the turn is refused.
 *
 * The Flux tier rides the same overlay on Murage's shared Flux home (not on a
 * provider-connection home, which is per turn and names its own model), so a
 * Hermes KNOWN to predate it is refused for every tier: it would ignore the
 * overlay and run without the tier the bot picked. An unknown version runs
 * (the turn path fails open on a version it could not read), and the overlay
 * still carries the tier for any Hermes that reads it. */
export function hermesFluxHeaderGate(cliVersion: string, decision: FluxMemoryDecision, ctx?: { providerRoute?: boolean }): string | null {
  const v = parseHermesVersion(cliVersion);
  const managed = v ? (() => {
    const [a, b, c] = v;
    const [x, y, z] = HERMES_MIN_MANAGED_SCOPE;
    return a !== x ? a > x : b !== y ? b > y : c >= z;
  })() : null;
  if (decision.capture === "off" || decision.inject === "off") return managed === true ? null : FLUX_HEADER_REFUSAL;
  if (!ctx?.providerRoute && managed === false) return HERMES_FLUX_UPDATE_COPY;
  if (!ctx?.providerRoute && managed === null && !unknownVersionLogged) {
    // The turn runs, but a Hermes that ignores the overlay would answer on some
    // other model; say so once, with the version text only, so it can be diagnosed.
    unknownVersionLogged = true;
    console.warn(`[acp] hermes version not readable (${JSON.stringify(cliVersion.trim().slice(0, 80))}); running the Flux tier on the managed-scope overlay unverified`);
  }
  return null;
}

/** The managed config Hermes would have applied on its own: `HERMES_MANAGED_DIR`
 * from the parent env, else /etc/hermes. Malformed or absent is `{}`, as in Hermes. */
function adminManagedConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  const own = hermesOverlayRoot(env);
  const named = (env.HERMES_MANAGED_DIR ?? "").trim();
  if (named && resolve(named).startsWith(resolve(own))) return {}; // already one of ours
  const dir = named || (process.platform === "win32" ? "" : HERMES_DEFAULT_MANAGED_DIR);
  if (!dir) return {};
  try {
    const parsed: unknown = parseYaml(readFileSync(join(dir, "config.yaml"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function quoteYaml(value: string): string {
  if (/^[\w./:+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function upsertHermesProvider(text: string, hostId: string, baseUrl: string, apiKey: string): string {
  const block = [`  ${hostId}:`, `    base_url: ${quoteYaml(baseUrl)}`, `    api_key: ${quoteYaml(apiKey)}`, ""].join(
    "\n",
  );
  if (/^providers:\s*$/m.test(text)) {
    const replaced = replaceHermesHostBlock(text, hostId, block);
    if (replaced !== null) return replaced;
    return text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}\nproviders:\n${block}`;
}

/** Replace `  hostId:` through the next sibling 2-space key or a top-level key. */
function replaceHermesHostBlock(text: string, hostId: string, block: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${hostId}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (/^  \S/.test(line) || /^\S/.test(line)) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
}

/** Spec A3: drop the `providers.<host>` block Murage wrote for a removed server. */
export function removeHermesLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const path = join(hermesHome(env), "config.yaml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    throw new NativeConfigRefusal(displayConfigPath(path, env.HOME || env.USERPROFILE || homedir()), "unreadable", code);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${host.id}:`);
  if (start < 0) return "absent";
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]!) && !/^\S/.test(lines[end]!)) end++;
  writeFileSync(path, [...lines.slice(0, start), ...lines.slice(end)].join("\n"));
  return "removed";
}

/** Register an OpenAI-compatible host so ACP can `session/set_model custom:host:model`.
 *
 * Only in the `default` profile. A named profile's config.yaml belongs to that
 * profile (design Q3): Murage does not write into it, and says so. */
export function ensureHermesInjectProvider(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
  profile: string = DEFAULT_HERMES_PROFILE,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;
  if (profile !== DEFAULT_HERMES_PROFILE) {
    throw new Error(
      `This bot runs the Hermes profile "${profile}". Murage does not change that profile's settings, so add ${host.id} to it in Hermes (hermes -p ${profile} model), then pick the profile's model here.`,
    );
  }

  const dir = hermesHome(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.yaml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const next = upsertHermesProvider(text, inject.host, host.baseUrl, hostApiKey(host, env));
  if (next !== text) writeFileSync(path, next, { mode: 0o600 });
  // The file now holds the local server's bearer key: keep the folder and the file owner-only
  // even when they already existed with a wider mode. Windows ignores POSIX modes.
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
      chmodSync(path, 0o600);
    } catch {
      /* best effort: a read-only home must not stop the turn */
    }
  }
  return hermesAcpModelId(modelId) ?? modelId;
}

/** ACP session/set_model id. Hermes parse_model_input treats `custom:name:model`. */
export function hermesAcpModelId(modelId: string | null | undefined): string | null {
  const inject = decodeInjectId(modelId);
  if (inject) return `custom:${inject.host}:${inject.model}`;
  // Hermes' own ACP ids are `<provider>:<model>` (`openrouter:qwen/qwen3.8-max`).
  // They are not inject ids and must be forwarded untouched; returning null here
  // is what limited the picker to locally injected hosts.
  const native = typeof modelId === "string" ? modelId.trim() : "";
  if (native && !native.includes(INJECT_SEP) && /^[a-z0-9_-]+:[\w./:-]+$/i.test(native)) return native;
  return null;
}

/** The id used when Hermes should run on the provider its own config names.
 *
 * Deliberately not an inject id: `hermesAcpModelId` returns null for it, so
 * `configureSession` sends no `session/set_model` and Hermes falls through to
 * the model in its own `config.yaml`. `spawnArgs` passes no `-m` either (ACP
 * ignores it), so nothing overrides that choice.
 */
export const HERMES_CONFIG_MODEL_ID = "hermes-default";

function nonEmptyDotenvValue(text: string, name: string): string | null {
  const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, "m").exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw.startsWith("#")) return null;
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const closing = raw.indexOf(quote, 1);
    if (closing < 0) return null;
    const trailing = raw.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith("#")) return null;
    return raw.slice(1, closing).trim() || null;
  }
  return raw.replace(/[ \t]+#.*$/, "").trim() || null;
}

const HERMES_HOSTED_PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
] as const;

const HERMES_LOCAL_CONFIG_PROVIDERS = new Set(["custom", "lmstudio", "ollama", "vllm", "llamacpp"]);

/** Detect whether Hermes has a hosted provider configured.
 *
 * Hermes supports multiple auth methods:
 * - OpenRouter API key in `~/.hermes/.env` (OPENROUTER_API_KEY)
 * - Nous Portal OAuth (tokens stored in `~/.hermes/` — the default for
 *   `hermes setup` / `hermes login`)
 * - Z.AI / GLM keys in `~/.hermes/.env`
 *
 * Previously only OPENROUTER_API_KEY was checked, so a Nous Portal user
 * — logged in via OAuth, no OpenRouter key — saw "No local models found"
 * despite Hermes being installed, authenticated, and serving 100+ models.
 *
 * Read-only on purpose. `ensureHermesInjectProvider` writes `config.yaml`,
 * and doing that from a catalog probe would rewrite the user's real Hermes
 * config as a side effect of opening a menu.
 *
 * Returns null when no hosted provider is configured, which leaves the
 * catalog exactly as it was for local-only setups.
 */
export function hermesConfiguredModel(
  env: Record<string, string | undefined> = process.env,
  profile: string = DEFAULT_HERMES_PROFILE,
): { id: string; label: string; custom: true } | null {
  const dir = hermesHome(env, profile);
  let secrets = "";
  try {
    secrets = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    /* .env may not exist — check OAuth below */
  }

  const hasHostedProviderKey = HERMES_HOSTED_PROVIDER_KEYS.some((name) => nonEmptyDotenvValue(secrets, name));

  // `hermes login` / `hermes setup` records the selected default in
  // config.yaml while the OAuth token lives in Hermes' auth store. An explicit
  // local/custom provider must not trigger the hosted catalog probe.
  let configuredDefault: { model: string; provider: string } | null = null;
  try {
    configuredDefault = hermesConfigDefault(readFileSync(join(dir, "config.yaml"), "utf8"));
  } catch {
    /* config may not exist or may be unreadable */
  }

  // A named profile's own config.yaml model IS the bot's model: Murage injects
  // nothing into a profile, so there is no local catalog to defer to.
  if (profile !== DEFAULT_HERMES_PROFILE && configuredDefault) {
    return { id: HERMES_CONFIG_MODEL_ID, label: `${configuredDefault.model} (Hermes profile ${profile})`, custom: true as const };
  }

  const configuredProvider = configuredDefault?.provider.toLowerCase() ?? "";
  // The model/provider selected in config.yaml is the user's explicit routing
  // choice. A stale hosted key must not override an explicitly local setup.
  const configIsLocal =
    HERMES_LOCAL_CONFIG_PROVIDERS.has(configuredProvider) || configuredProvider.startsWith("custom:");
  if (configuredDefault && configIsLocal) return null;

  const configIsHosted = configuredDefault !== null;
  if (!hasHostedProviderKey && !configIsHosted) return null;

  const model = configuredDefault?.model ?? "";
  // `custom: true` is not cosmetic. ModelPicker renders a custom-only agent's
  // *custom* pane exclusively, and that pane lists only options carrying this
  // flag; anything without it lands in the "official" bucket the pane never
  // shows. Omitting it puts the option in the API response while leaving the
  // picker saying "No local models found" — present, but unselectable.
  return {
    id: HERMES_CONFIG_MODEL_ID,
    label: model ? `${model} (Hermes config)` : "Hermes default (config)",
    custom: true as const,
  };
}

/** Ask a short-lived `hermes acp` session what models it can actually run.
 *
 * Hermes advertises its full catalog on `session/new` — every model its
 * configured providers expose, ids shaped `openrouter:qwen/qwen3.8-max`. There
 * is no `hermes models` subcommand, so a throwaway session is the only way to
 * read it, and it is worth the spawn: without it the picker can only offer
 * locally injected hosts, which is a fraction of what the user is paying for.
 *
 * Failure is non-fatal and returns [] — a catalog probe must never be the
 * reason an agent becomes unselectable.
 */
export async function fetchHermesAcpModels(
  cli: string,
  env: Record<string, string | undefined>,
  profile: string,
): Promise<{ id: string; label: string; custom: true }[]> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      // The probe asks the same profile the turns will run, or the picker
      // would list another agent's catalog. It goes through the shared
      // launcher like a turn (Rule 74c): no controlling terminal, stdin a pipe.
      child = spawnCli(cli, ["-p", profile, "acp"], { stdio: ["pipe", "pipe", "ignore"], env: env as NodeJS.ProcessEnv });
    } catch {
      return resolve([]);
    }
    // THIS PROBE ENDED THE OWNER'S SERVER ON 2026-09-22 AT 05:43:42Z.
    //
    // It was then the one place in the drivers that spawned raw instead of
    // going through `spawnCli`, where the stdin guard lives (server/procs.ts).
    // It goes through `spawnCli` now, and quietChildPipes stays as a second
    // listener on every pipe.
    //
    // `send` below writes to this child's stdin from inside the stdout
    // handler, chaining initialize → authenticate → session/new. If the CLI
    // goes away mid-chain the write gets EPIPE, the pipe emits `'error'` with
    // nobody listening, and the harness exits — taking every bot, the
    // browser, memory, tools and the phone with it, over a MODEL CATALOGUE
    // PROBE that nothing was waiting on. The owner was not even using this
    // engine; the probe runs on a timer.
    //
    // The `writable` check and the write callback further down do not prevent
    // it and never could. See child-pipe-quiet.mjs.
    quietChildPipes(child);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (out: { id: string; label: string; custom: true }[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // The probe is in a session and process group of its own: stop the
      // whole tree (SIGTERM, then SIGKILL past the grace), not just the root.
      try {
        killCliTree(child);
      } catch {
        /* already gone */
      }
      resolve(out);
    };
    timer = setTimeout(() => done([]), 5_000);
    child.once("error", () => done([]));
    child.once("close", () => done([]));

    let buf = "";
    let id = 0;
    const send = (method: string, params: unknown) => {
      id += 1;
      try {
        if (!child.stdin?.writable) {
          done([]);
          return 0;
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) done([]);
        });
      } catch {
        done([]);
        return 0;
      }
      return id;
    };
    let initId = 0;
    let sessionId = 0;
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === initId) {
          if (!msg.result) return done([]);
          sessionId = send("session/new", { cwd: env.HOME || env.USERPROFILE || homedir(), mcpServers: [] });
        } else if (sessionId && msg?.id === sessionId) {
          const list = Array.isArray(msg.result?.models?.availableModels)
            ? msg.result.models.availableModels
            : [];
          done(
            list
              .filter((m: any) => typeof m?.modelId === "string" && m.modelId)
              .map((m: any) => ({
                id: m.modelId as string,
                // Hermes labels these "OpenRouter · <model>"; keep its wording.
                label: (typeof m.name === "string" && m.name.trim()) || (m.modelId as string),
                custom: true as const,
              })),
          );
        }
      }
    });
    initId = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config?: { cli?: string; profile?: string; profileOrigin?: "sticky" },
): Promise<ModelCatalog> {
  const profile = hermesProfileOf(config);
  // Local hosts are written into `default`'s config.yaml only (design Q3), so
  // a named profile is not offered them.
  const catalog = profile === DEFAULT_HERMES_PROFILE ? await mergeLocalInject(EMPTY, env) : EMPTY;
  const configured = hermesConfiguredModel(env, profile);
  // Only probe when a hosted provider is configured; a local-only install has
  // nothing to gain from the spawn.
  const remote = configured ? await fetchHermesAcpModels(config?.cli || "hermes", env, profile) : [];
  const seen = new Set<string>();
  const options = [...(configured ? [configured] : []), ...remote, ...catalog.options].filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
  // `custom: true` on the Flux rows is mandatory here, not decorative: Hermes
  // is an `access: "custom"` engine, so ModelPicker pins it to the Custom pane
  // (ModelPicker.tsx:166) with no way back (:208), and that pane renders only
  // options carrying the flag. Without it the rows would be in the API
  // response and absent from the UI — the exact failure hermesConfiguredModel
  // documents at :240-244.
  //
  // Deliberately AFTER the default is settled, so an existing Hermes install
  // keeps its own configured default and only a Hermes with nothing at all
  // falls through to flux-auto.
  // A profile that owns its identity refuses Flux (applyHermesFluxHome), so
  // it is not offered Flux rows it could never run.
  if (hermesProfileOwnsIdentity(config)) return { default: options[0]?.id ?? "", options };
  return mergeFluxCatalog({ default: options[0]?.id ?? "", options }, DRIVER_KIND, process.env, { custom: true });
}

async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(`Hermes rejected ${what} via ${method}: ${(e as Error).message}`);
  }
}

const support: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "Hermes",
  access: "custom",
  models: EMPTY,
  resolveModels: (env: Record<string, string | undefined>, config: any) => resolveModels(env, config),
  /**
   * Flux on Hermes is a SCOPED HOME, materialised lazily per spawn.
   *
   * `resolveTurnModel` rather than `applyTurnEnv` because this hook is the one
   * that both receives the child env (which it mutates in place — core.ts:311
   * builds it, :322 passes it here, and the same object is handed to `spawn`)
   * and settles the id argv/`configureSession` will use. Splitting the write
   * from the HERMES_HOME that makes it findable would let the two disagree.
   *
   * The returned id is the bare `flux-*` alias on purpose: `hermesAcpModelId`
   * returns null for it (no colon, not an inject id), so `configureSession`
   * sends no `session/set_model` and hermes takes `model.default` out of this
   * turn's own managed-scope overlay (never the shared config.yaml, which every
   * Flux Hermes bot reads). `spawnArgs` passes no `-m` either — hermes' ACP
   * mode ignores it — so nothing can override that choice.
   */
  decodeExtra: (raw) => ({
    ...(isHermesProfileName(raw.profile) ? { profile: raw.profile } : {}),
    ...(raw.profileOrigin === "sticky" ? { profileOrigin: "sticky" as const } : {}),
  }),
  boundProfile: (config) => (hermesProfileOwnsIdentity(config) ? hermesProfileOf(config) : null),
  resolveTurnModel: (model, env, config) => {
    // Never inherit a broad or stale compatibility grant from the parent.
    // Only this Murage driver binds one concrete local model; Hermes still
    // requires the exact read-only screenshot MCP tool before activation.
    bindHermesScreenshotCompat(env, model);
    if (!model) return model;
    const routed = applyHermesFluxHome(env, model, fluxKey(), config);
    if (routed) return routed;
    // A Flux id with no key degrades to native. It must still not reach
    // `ensureHermesInjectProvider`, which writes the user's real config.yaml.
    if (fluxModelId(model)) return model;
    ensureHermesInjectProvider(model, env, hermesProfileOf(config));
    return model;
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  loginNote: "Hermes CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
    signInCommand: "hermes setup",
  },
  // The ask hook (applyHermesAskHook) runs Murage's `computer` mount without Hermes asking, on a host-computer
  // turn only (localComputer.scope === "local-computer", as core.ts controlsHost); Murage's computer service asks per
  // action instead. A Local VM or VPS computer carries no scope, so its tools stay on the ask hook and get a card.
  hostComputerAskedByMurage: true,
  spawnArgs: (config, turn, ctx) => {
    if (ctx?.env) applyHermesAskHook(ctx.env, { hostComputer: turn?.integrations?.localComputer?.scope === "local-computer", phoneJobs: Boolean(turn?.integrations?.phoneJobs), emailMode: turn?.integrations?.agents?.env?.[EMAIL_TOOLS_ENV] });
    return hermesSpawnArgs(config, ctx?.env);
  },
  /**
   * Flux Memory headers. Hermes (0.21.3 source, agent/auxiliary_client.py
   * `_apply_user_default_headers`) merges `model.extra_headers` from the
   * config onto the OpenAI client for the main and the auxiliary calls. The
   * block rides a per-turn managed-scope overlay (applyHermesFluxMemory); the
   * home itself is never edited for a turn. If the home is not Murage's own
   * and the headers must say "off", the turn is refused rather than sent
   * without them.
   */
  applyFluxMemory: (env, { decision }) => applyHermesFluxMemory(env, decision),
  // Every Flux turn: the tier rides the overlay too, not only "off" headers.
  fluxGateEveryTurn: true,
  fluxHeaderGate: hermesFluxHeaderGate,
  transformEnv: (env) => {
    // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter and
    // send no Authorization header. ACP also reloads ~/.hermes/.env, so the
    // named custom provider + session/set_model is the real route.
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  async configureSession({ request, sessionId, turn }) {
    // Decode only — resolveTurnModel already wrote the named provider using
    // the instance HOME. Calling ensure* again here would hit process.env
    // and rewrite the user's real ~/.hermes/config.yaml.
    const native = hermesAcpModelId(turn.model);
    if (!native) return;
    await applySetting(
      request,
      "session/set_model",
      { sessionId, modelId: native },
      `model "${native}"`,
    );
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const hermesAcpSupport: AcpSupport = support;
export const HermesAgentDriver = createAcpDriver(support);
