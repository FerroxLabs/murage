// Fuigo — Ferrox Labs' own engine, `fuigo agent stdio` over ACP.
//
// THE ONE THING THAT MAKES THIS DRIVER DIFFERENT FROM EVERY OTHER FLUX PATH.
// Fuigo is a NATIVE FluxRouter client. It does not have to be dragged onto
// Flux the way qwen/kimi/droid do with an OPENAI_BASE_URL overlay:
//   fuigo-shell/src/agent/config.rs:62
//     FUIGO_API_BASE_URL_DEFAULT = "https://api.fluxrouter.ai/v1"
//   fuigo-shell/src/agent/key_discovery.rs:60-70
//     provider table leads with { id: "fluxrouter", env_vars:
//     ["FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY"], … }
// so `applyFluxSurface` is deliberately NOT called here. Handing the child a
// single `FUIGO_API_KEY` is the whole of the routing, and OPENAI_BASE_URL /
// OPENAI_MODEL would be a lie in the env that a routing badge would repeat.
//
// Proven live against the staged 1.0.2 binary on 2026-09-03, on a temp HOME
// with no ~/.fuigo at all and FUIGO_API_KEY as the only credential in the
// env: initialize → session/new → session/prompt returned a real answer off
// api.fluxrouter.ai (`_meta.modelId: "flux-auto"`, 11894 in / 59 out).
//
// ARGV ORDER IS A TRAP, AND FUIGO INHERITS IT FROM GROK BUILD. `-m` placed
// before the `agent` subcommand is silently ACCEPTED and then IGNORED — see
// the note on `spawnArgs`, which carries the live transcript.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { ModelCatalog, ModelRefreshOptions, ProviderErrorCode } from "../../contracts.ts";
import { resolveFuigoCli } from "../../env-path.ts";
import { DATA_DIR, deleteEnvNames } from "../../config.ts";
import { headlessTextOnlyTurn } from "../headless-text-only.ts";
import { fluxKey } from "../../flux-config.ts";
import { fuigoConfigOverlay } from "../../flux-memory-headers.ts";
import { catalogFetchAllowed, noteCatalogResult } from "../../flux-key-health.ts";
import { isFluxKeyShape } from "../../../electron/provider-connections.mjs";
import { FLUX_TIERS, mergeFluxCatalog } from "../../flux-surface.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { fuigoToolResultDirs, sessionFolders } from "../../own-tool-results.ts";
import {
  cachedLocalTestFor,
  decodeInjectId,
  hostApiKey,
  localContextWindow,
  localHost,
  mergeLocalInject,
  type LocalHost,
} from "../local-inject.ts";
import { quoteToml } from "./kimi.ts";
import { FUIGO_LOCAL_PREFIX, fuigoLocalModelDir } from "./fuigo-permission.ts";
import { scopeFuigoHome } from "./fuigo-scope.ts";
import { scopedCliHomeRoot } from "../scoped-cli-home.ts";
import { forceHookGatesOff } from "./hook-gates.ts";

/** CONTRACT with the wiring in flux-routing.ts / builtIn.ts / the picker's
 *  defaultSelection. Renaming this renames the engine everywhere. */
const DRIVER_KIND = "fuigoAgent";

/**
 * The credential names Fuigo itself reads, in its own precedence order
 * (key_discovery.rs:60-70). `FUIGO_API_KEY` is the one this driver writes;
 * the other two are listed so an AMBIENT copy of somebody else's key cannot
 * outrank the workspace key we just injected.
 */
const FUIGO_KEY_ENV = ["FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY"] as const;

function isFuigoKeyName(name: string, platform: NodeJS.Platform): boolean {
  // Windows env names are case-insensitive: `Fuigo_Api_Key` IS FUIGO_API_KEY
  // to the child, so a case-sensitive delete left it riding next to ours.
  return platform === "win32"
    ? FUIGO_KEY_ENV.some((key) => key === name.toUpperCase())
    : (FUIGO_KEY_ENV as readonly string[]).includes(name);
}

/**
 * Put exactly one credential in front of Fuigo, and only a Flux key.
 *
 * Fuigo sends whatever `FUIGO_API_KEY` holds to api.fluxrouter.ai, unchecked
 * (fuigo-shell auth_method.rs read_fuigo_api_key_env), and an EMPTY value
 * still counts as set and goes out as `Bearer ` with nothing after it. On
 * 2026-10-01 Flux saw a base URL, a short non-sk value, an empty bearer and
 * another provider's key arrive that way. So:
 *   - with Murage's Flux key: every casing of every Fuigo key name goes, and
 *     the key is set under FUIGO_API_KEY;
 *   - without one: a user's own ambient value survives only if it is shaped
 *     like a Flux key. Anything else would be sent to Flux and refused.
 * A `fuigo login` (auth.json) install is not touched here.
 */
export function scrubFuigoCredentialEnv(
  env: Record<string, string | undefined>,
  key: string | null,
  platform: NodeJS.Platform = process.platform,
): void {
  if (key) {
    deleteEnvNames(env, FUIGO_KEY_ENV, platform);
    env.FUIGO_API_KEY = key;
    return;
  }
  for (const name of Object.keys(env)) {
    if (isFuigoKeyName(name, platform) && !isFluxKeyShape(env[name] ?? "")) delete env[name];
  }
}

/**
 * Provider key names Fuigo reads for itself, other than its own three
 * (fuigo-secrets child_env.rs `provider_key_env_vars`, 1.0.32). From 1.0.32
 * the engine asks every provider whose key it finds in its env for that
 * provider's model list, once a day at startup, with no switch to turn it off
 * (fuigo-shell auth/key_models.rs `refresh_stale`), and lists what each key
 * reaches as extra model rows. A Murage turn runs on Murage's Flux key
 * (FUIGO_API_KEY), a model connection's MURAGE_PROVIDER_API_KEY or a local
 * server's MURAGE_LOCAL_*_API_KEY, never on one of these, so none of them
 * reaches the engine: the only provider the engine talks to is the one the
 * owner picked, and the picker shows exactly that provider's models.
 * 1.0.31 never read most of these; withholding them changes nothing there.
 */
export const FUIGO_WITHHELD_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "GROK_API_KEY",
  "GROQ_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "LC_ANTHROPIC_AUTH_TOKEN",
] as const;

/** 1.0.32's daily ChatGPT and Grok subscription model refresh (fuigo-shell
 *  auth/subscription/catalog.rs `spawn_startup_refresh`): any non-empty value
 *  other than "0" turns it off. Murage owns the catalog it shows, so a bot
 *  turn never starts one. Unknown to 1.0.31, which ignores it. */
export const FUIGO_MODEL_REFRESH_OFF = { FUIGO_DISABLE_MODEL_REFRESH: "1" } as const;

/**
 * Fuigo's own subagents off for every bot turn, whatever the owner's env says.
 * A subagent definition (`.fuigo/agents/*.md` or `.claude/agents/*.md` in the
 * workspace, or `~/.fuigo/agents`) may name its own `permissionMode`, and on
 * the `agent stdio` path the parent's `--permission-mode default` is not
 * handed down (fuigo-pager acp/mod.rs; agent/config.rs
 * `resolve_subagent_permission_mode` keeps the child's mode under `default`).
 * From 1.0.32 a child in `acceptEdits` approves workspace edits itself, and
 * one in `bypassPermissions` approves everything, so its calls never reach
 * Murage as a permission request. Murage delegates through its own teammates,
 * so the bot keeps every approval Murage shows. Read by 1.0.31 too.
 */
export const FUIGO_SUBAGENTS_OFF = { FUIGO_SUBAGENTS: "0" } as const;

/**
 * The other ways 1.0.32 starts an agent of its own, which FUIGO_SUBAGENTS=0
 * does not reach (traced by Fuigo's maintainers in 1.0.32): a workflow run, a
 * background scheduler loop and a goal run each spawn `general-purpose`, and a
 * workspace `.fuigo/agents/general-purpose.md` in a trusted folder replaces
 * that definition, `permissionMode: bypassPermissions` included. All three
 * stay off for every bot turn, so no agent runs outside Murage's approvals.
 */
export const FUIGO_AGENT_SPAWNS_OFF = { FUIGO_WORKFLOWS: "0", FUIGO_SCHEDULER_BACKGROUND_LOOPS: "0", FUIGO_GOAL: "0" } as const;

/** Every name Murage pins on a Fuigo bot turn's env, last, over any inherited value. */
export const FUIGO_TURN_PINS = { ...FUIGO_MODEL_REFRESH_OFF, ...FUIGO_SUBAGENTS_OFF, ...FUIGO_AGENT_SPAWNS_OFF } as const;

/**
 * Names a Fuigo bot turn never inherits, in any casing. `FUIGO_AGENT` starts
 * the session as a named agent, which a workspace `.fuigo/agents/<name>.md`
 * defines with its own permissionMode. `FUIGO_WORKSPACE_REWIND_GIT` turns on
 * Fuigo's own git calls for workspace rewind, which run unhardened in the
 * owner's folder. Murage sets neither; an owner's shell value is dropped
 * rather than pinned empty, so no reading of "" can turn either on.
 */
export const FUIGO_UNSET_ENV = ["FUIGO_AGENT", "FUIGO_WORKSPACE_REWIND_GIT"] as const;

/** Withhold every other provider's key and the names above, switch the startup
 *  model refresh and every agent Fuigo starts on its own off (in place). */
export function withholdFuigoProviderEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): void {
  deleteEnvNames(env, FUIGO_WITHHELD_PROVIDER_ENV, platform);
  deleteEnvNames(env, FUIGO_UNSET_ENV, platform);
  deleteEnvNames(env, Object.keys(FUIGO_TURN_PINS), platform);
  Object.assign(env, FUIGO_TURN_PINS);
}

/**
 * The same rule for the owner's captured shell map the engine is handed
 * (core.ts handedEngineEnv). That map can hold names this process never had
 * (a Finder launch), so the child-env strip above never saw them. Every other
 * provider's key goes, the refresh stays off, and a Fuigo key name survives
 * only with the exact value the credential scrub left in the child env: the
 * decision `scrubFuigoCredentialEnv` made is the one the engine sees.
 */
export function scrubFuigoHandedEnv(
  map: Record<string, string | undefined>,
  child: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): void {
  withholdFuigoProviderEnv(map, platform);
  for (const name of Object.keys(map)) {
    if (!isFuigoKeyName(name, platform)) continue;
    const kept = Object.entries(child).find(([childName]) => (platform === "win32" ? childName.toUpperCase() === name.toUpperCase() : childName === name));
    if (!kept || kept[1] !== map[name]) delete map[name];
  }
  // FUIGO-SCOPE-1010 A3: the login pointer and the home are the scope's decision (fuigo-scope.ts setFuigoAuthPath), never the
  // owner's shell: a Flux-key turn whose captured shell exports FUIGO_AUTH_PATH would otherwise bill the owner's login. Every
  // spelling of either name goes, and the child's own value (if any) is the one handed on.
  for (const name of FUIGO_SCOPE_DECIDED_ENV) {
    const kept = Object.entries(child).find(([childName]) => (platform === "win32" ? childName.toUpperCase() === name : childName === name));
    deleteEnvNames(map, [name], platform);
    if (kept && typeof kept[1] === "string") map[name] = kept[1];
  }
}

/** Names the bot's scope decides for the turn (FUIGO-SCOPE-1010): the handed map carries the child's value or none. */
export const FUIGO_SCOPE_DECIDED_ENV = ["FUIGO_AUTH_PATH", "FUIGO_HOME"] as const;

/** The Flux key the child will present, after the scrub, or null. */
function presentedFuigoKey(env: Record<string, string | undefined>): string | null {
  for (const wanted of FUIGO_KEY_ENV) {
    for (const [name, value] of Object.entries(env)) {
      if (isFuigoKeyName(name, process.platform) && name.toUpperCase() === wanted && value && isFluxKeyShape(value)) return value.trim();
    }
  }
  return null;
}

/**
 * Static fallback catalog — the four Flux tiers, built FROM `FLUX_TIERS` so
 * there is exactly one place their ids and labels are spelled. Used until
 * `resolveModels` gets a live answer out of `fuigo models`, and kept when it
 * cannot (offline, or an install with no credential at all).
 */
export const STATIC_FUIGO_MODELS: ModelCatalog = {
  default: FLUX_TIERS[0]!.id,
  options: FLUX_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
};

/** Fuigo's own home. `FUIGO_HOME` is honoured by the shipped binary — proven
 *  live: with `FUIGO_HOME=<dir>` set, 1.0.2 wrote config.toml/sessions/logs
 *  into that dir and left `$HOME` completely untouched. A driver that only
 *  looked at HOME would report "not signed in" for a scoped install. */
function fuigoHome(env: Record<string, string | undefined>): string {
  if (env.FUIGO_HOME) return env.FUIGO_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".fuigo");
}

/**
 * Make the SHIPPED engine spawnable, without taking it away from a user who
 * installed their own.
 *
 * `AcpSupport` has no hook for "which binary" — `createAcpDriver` freezes
 * `defaultCli` into `decodeAcpConfig` at module load (core.ts:157-163) and
 * `spawnArgs` only returns arguments — so the resolved path cannot be handed
 * to the spawn directly. The env is the lever that IS available, and it is
 * the same lever `augmentedPath()` already pulls for every other engine: the
 * core assigns `env.PATH = augmentedPath()` (core.ts:196) and libuv resolves
 * a bare command name against the PATH in the env it is given. That is not an
 * assumption — it is the load-bearing premise of env-path.ts itself, whose
 * whole reason to exist is that a GUI-launched Electron process inherits a
 * minimal PATH and every engine here is nonetheless found in `~/.local/bin`,
 * `~/.grok/bin` and friends.
 *
 * `resolveFuigoCli` (env-path.ts:394) makes the precedence decision, not this
 * function: it checks the augmented PATH FIRST and only falls back to
 * `MURAGE_FUIGO_DIR`. So `source === "bundled"` means "there is no fuigo on
 * PATH", and only then is the shipped directory prepended. A user's own
 * `fuigo` keeps winning, which is the documented intent — the app agreeing
 * with the user's terminal.
 *
 * It THROWS when neither answers, and that is caught here on purpose. This
 * runs on the catalog refresh and the snapshot as well as the turn, and the
 * snapshot classifies the failed probe (including a declared bundle repair)
 * without a rejected `create()` downgrading the whole instance to a shadow.
 */
export function reachBundledFuigo(env: Record<string, string | undefined>): void {
  let resolved;
  try {
    resolved = resolveFuigoCli(env as NodeJS.ProcessEnv);
  } catch {
    return; // snapshot retains the declared bundle's resolution diagnostic
  }
  // Windows: a PATH copy is launched by its absolute path (fuigoLaunchFile), so npm's `fuigo.cmd` shim earlier on PATH
  // never wins, and its folder is not put in front of the child's PATH: whatever else sits beside that fuigo.exe (a
  // user's npm prefix, ~/.fuigo/bin) never shadows the commands the engine itself runs.
  if (resolved.source !== "bundled") return;
  const folder = dirname(resolved.command);
  if ((env.PATH ?? "").split(delimiter)[0] === folder) return;
  env.PATH = [folder, env.PATH].filter(Boolean).join(delimiter);
}

/**
 * The file a Fuigo turn, its `--version` probe and its `fuigo models` call run.
 *
 * Windows: exactly the fuigo.exe resolveFuigoCli chose and version-checked. The bare name would be looked up again with
 * PATHEXT, which tries `.COM` before `.EXE` (and a custom PATHEXT may put `.CMD` first), so a fuigo.com or fuigo.cmd beside
 * that exe would start instead of it. A custom `cli` is the user's own and runs as configured. When resolveFuigoCli finds
 * nothing (no fuigo.exe on PATH and no bundle), the bare name is kept, so an npm-only install still reaches its shim and a
 * missing engine is the spawn's own ENOENT. macOS and Linux keep the bare name: reachBundledFuigo's PATH already finds the
 * chosen file there, and there is no PATHEXT.
 */
export function fuigoLaunchFile(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): string {
  if (process.platform !== "win32" || config.cli !== "fuigo") return config.cli;
  try {
    return resolveFuigoCli(env as NodeJS.ProcessEnv).command;
  } catch {
    return config.cli;
  }
}

/**
 * Model ids `fuigo models` lists that cannot run a coding turn.
 *
 * Fuigo's catalog is FluxRouter's whole catalog, image and speech models
 * included (`flux-image-nano-banana-pro`, `flux-voice-fast`, `gpt-image-med`,
 * `nano-banana-pro-4k`). Selecting one in the engine picker would spawn a
 * turn that cannot answer, so they are dropped at the source rather than
 * left for the user to discover. Prefix-matched, not an exhaustive id list:
 * Flux adds image rows faster than this file can be edited.
 */
const NON_CHAT_PREFIXES = ["flux-image-", "flux-voice-", "gpt-image-", "nano-banana"] as const;

function isChatModel(id: string): boolean {
  return !NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Parse `fuigo models` stdout.
 *
 * The shape, verbatim from 1.0.2:
 *
 *     You are using FUIGO_API_KEY.
 *
 *     Default model: flux-auto
 *
 *     Available models:
 *       * flux-auto (default)
 *       - claude-opus-5
 *
 * An UNAUTHENTICATED install prints "You are not authenticated." and then a
 * four-row placeholder (`flux-auto`, `claude-opus`, `gpt-5`, `gemini-pro`)
 * whose last three ids do NOT appear in the real catalog. Offering those
 * would be offering models the CLI will reject, so that banner is treated as
 * "no catalog" and the parse returns nothing — which `resolveModels` turns
 * into the static fallback.
 */
export function parseFuigoModels(stdout: string): ModelCatalog {
  if (/^\s*You are not authenticated\.?\s*$/m.test(stdout)) return { default: "", options: [] };
  let fallbackDefault = "";
  let taggedDefault = "";
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^\s*Default model:\s*(\S+)\s*$/.exec(line);
    if (header) {
      fallbackDefault = header[1]!;
      continue;
    }
    const row = /^\s*[-*]\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!row) continue;
    const id = row[1]!;
    if (row[2]) taggedDefault = id;
    if (!isChatModel(id) || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: id });
  }
  if (!options.length) return { default: "", options: [] };
  // The `(default)` tag wins over the header line only because it is proof
  // the id survived the non-chat filter above; a `Default model:` naming an
  // image model would otherwise select a row that is not in the list.
  const preferred = [taggedDefault, fallbackDefault].find((id) => id && seen.has(id));
  return { default: preferred ?? options[0]!.id, options };
}

/**
 * Ask the very binary this instance spawns for its catalog.
 *
 * `config.cli`, never the bare name: an instance may be pointed at a custom
 * path, and answering from whatever `fuigo` happens to be on PATH would show
 * a catalog the spawn never uses. `env` is the instance child env, so the
 * `FUIGO_API_KEY` `transformEnv` just injected is present — without it the
 * CLI answers with the unauthenticated placeholder above.
 *
 * Timeout is deliberate and short. This runs inside `create()` (core.ts:220),
 * so every second here is a second the engine list is missing in the UI; the
 * live call measured 1.1-1.5s against api.fluxrouter.ai, warm or cold (there
 * is no local cache short-circuit — `~/.fuigo/models_cache.json` exists but
 * 1.0.2 still makes the round trip). A refusal is not an error: core keeps
 * the last usable catalog when this returns no options.
 */
/** The scope the catalog call runs in: one Murage-owned Fuigo home per owner home, never a bot's. */
export const FUIGO_CATALOG_SCOPE = "murage-catalog";

/**
 * FUIGO-SCOPE-1010 P2-catalog (MurageMain ruling): `fuigo models` initialises and rewrites the home it runs in (rig, 1.0.32:
 * a `[marketplace]` key added to config.toml), so it never runs in the owner's ~/.fuigo. It runs in a Murage-owned home
 * built by the same scope code as a bot's (filtered owner config, so endpoints and custom models stay; Murage's rules;
 * the organisation copies). Null when that home cannot be made: then there is no live catalog, never an unscoped call.
 */
export function fuigoCatalogEnv(env: Record<string, string | undefined>): Record<string, string | undefined> | null {
  const scoped = { ...env };
  try { scopeFuigoHome(scoped, FUIGO_CATALOG_SCOPE); } catch { return null; }
  if (process.env.MURAGE_CLOUD_ROLE === "home") return scoped; // the Cloud launcher's own home, read-only for the turn
  return scoped.FUIGO_HOME && scoped.FUIGO_HOME.startsWith(scopedCliHomeRoot("fuigo")) ? scoped : null;
}

function fetchFuigoModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
): Promise<{ catalog: ModelCatalog; text: string }> {
  const scoped = fuigoCatalogEnv(env);
  if (!scoped) return Promise.resolve({ catalog: { default: "", options: [] }, text: "the catalog home could not be set up" });
  return new Promise((resolve) => {
    execCli(fuigoLaunchFile(scoped, config), ["models"], { timeout: 10_000, env: scoped }, (err, stdout, stderr) => {
      const text = `${err?.message ?? ""}\n${stderr ?? ""}\n${stdout ?? ""}`;
      resolve({ catalog: err ? { default: "", options: [] } : parseFuigoModels(stdout), text });
    });
  });
}

/**
 * The live catalog, asked for only when it can be answered.
 *
 * Each `fuigo models` run is a GET /v1/api-key and a GET /v1/models at Flux.
 * So it runs only with a Flux key in the child env (an unkeyed run is a
 * request with no key, or with whatever a `fuigo login` file holds), and not
 * again for a key Flux refused or one that keeps failing
 * (flux-key-health.ts). A login-only install keeps the static tiers.
 */
async function liveFuigoModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
  options: ModelRefreshOptions = {},
): Promise<ModelCatalog> {
  const key = presentedFuigoKey(env);
  if (!key || !catalogFetchAllowed(key, Date.now(), options)) return { default: "", options: [] };
  const { catalog } = await fetchFuigoModels(env, config);
  // Only "ok" or "failed": Fuigo answers a refused key with its bundled models
  // and exit 0, so a refusal cannot be read here. It comes from Murage's own
  // Flux catalog call (flux-key-health.ts).
  noteCatalogResult(key, catalog.options.length ? "ok" : "failed");
  return catalog;
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
  options: ModelRefreshOptions = {},
): Promise<ModelCatalog> {
  const live = await liveFuigoModels(env, config, options);
  const catalog = live.options.length ? live : STATIC_FUIGO_MODELS;
  // Through `mergeFluxCatalog` on purpose, and this is the whole reason the
  // shell-out is safe to combine with the Flux tables. `fuigo models` prints
  // the tier ids BARE (`flux-auto`) and the pinned ids bare too, which is
  // exactly the id shape the rest of this app already routes. The merge is
  // therefore a normalisation, not a second list: it lifts the four tiers out
  // of `own`, rebuilds them at the top with the app's canonical labels
  // ("Flux Auto"), sorts `flux-pinned-*` to the end, and — via `filterFluxRows`
  // sharing the same gate at registry.describe() — guarantees the picker
  // cannot show a Flux row on an unkeyed install. Skipping it would produce
  // two differently-labelled copies of the same four tiers.
  //
  // No `env` argument, deliberately, exactly as qwen.ts:117 calls it: the
  // authoritative key lives in config/`process.env`, and the child env handed
  // to this function has had `FLUX_API_KEY` deleted by the strip
  // (core.ts:204-205). Passing it would gate the catalog on a variable that is
  // guaranteed absent and drop every Flux row on a keyed install.
  // Local models sit alongside the cloud catalog (spec E1): live rows from the
  // detected and user-added servers are appended after the Flux tiers, which
  // keep leading the list and keep the default.
  return mergeFluxCatalog(await mergeLocalInject(catalog, env), DRIVER_KIND);
}


/** Stable, bare-safe table name for one server+model. The digest keeps two
 *  model ids that sanitize to the same text apart. */
export function fuigoLocalSlug(host: LocalHost, model: string): string {
  const readable = model
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "model";
  const digest = createHash("sha256").update(`${host.id} ${model}`).digest("hex").slice(0, 8);
  return `${FUIGO_LOCAL_PREFIX}${host.id}-${readable}-${digest}`;
}

/** Env var the child reads the server key from — the key never lands in the file. */
export function fuigoLocalKeyEnv(host: LocalHost): string {
  return `MURAGE_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Chat completions unless the Local models test showed only another surface
 *  works (fuigo-sampling-types ApiBackend: chat_completions|responses|messages). */
function fuigoApiBackend(host: LocalHost, model: string): "chat_completions" | "responses" | "messages" {
  const test = cachedLocalTestFor(host.id, model);
  if (!test || test.surfaces.chat) return "chat_completions";
  if (test.surfaces.responses) return "responses";
  if (test.surfaces.messages) return "messages";
  return "chat_completions";
}

/**
 * Spec E1: write a `[model."murage-local-…"]` entry (model, base_url, name,
 * env_key, api_backend, context_window when known) into Murage's own folder
 * (fuigoLocalModelDir, one file per slug) and hand back that name for `-m`.
 * FUIGO-SCOPE-1010 V4: the bot's scoped config.toml appends every file of that
 * folder (fuigo-scope.ts); the owner's ~/.fuigo/config.toml is never written.
 * resolveTurnModel runs before applyMountEnv, so the file is there before the
 * scope is built, and it is a rebuild dependency of the scope.
 * Fuigo reads base_url / env_key / api_backend straight off a `[model.*]`
 * override (fuigo-shell config.rs ConfigModelOverride; README "Custom Models"),
 * so no `[model_providers]` table and no default change is needed — Flux
 * routing stays exactly as it was. Idempotent: an identical table is not
 * rewritten; a changed one is replaced in place of the old one.
 *
 * The server key goes into the child env under `env_key`, never into the file.
 */
export function ensureFuigoLocalModel(modelId: string, env: Record<string, string | undefined> = process.env): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;
  const slug = fuigoLocalSlug(host, inject.model);
  const keyEnv = fuigoLocalKeyEnv(host);
  const window = localContextWindow(host.id, inject.model);
  const block = [
    `[model.${quoteToml(slug)}]`,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `env_key = ${quoteToml(keyEnv)}`,
    `api_backend = "${fuigoApiBackend(host, inject.model)}"`,
    ...(window ? [`context_window = ${window}`] : []),
    "",
  ].join("\n");
  const dir = fuigoLocalModelDir();
  const path = join(dir, `${slug}.toml`);
  let current: string | null = null;
  try { current = readFileSync(path, "utf8"); } catch { /* not written yet */ }
  if (current !== block) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A2: a temporary file renamed over the name, so a link planted at that name is replaced, never written through.
    const temporary = `${path}.murage-tmp-${process.pid}`;
    rmSync(temporary, { force: true });
    try { writeFileSync(temporary, block, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }
  env[keyEnv] = hostApiKey(host, env);
  return slug;
}

/** Spec A3: drop every `[model."murage-local-<server>-…"]` table for a removed server: its files in Murage's own
 *  folder, so the next scope rebuild carries none of them (rule 6). Tables earlier versions wrote into the owner's
 *  ~/.fuigo/config.toml are left there (Murage never writes that file) and are filtered out of every bot's copy. */
export function removeFuigoLocalHost(
  host: LocalHost,
  _env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const dir = fuigoLocalModelDir();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return "absent"; }
  const mine = names.filter((name) => name.startsWith(`${FUIGO_LOCAL_PREFIX}${host.id}-`) && name.endsWith(".toml"));
  for (const name of mine) rmSync(join(dir, name), { force: true });
  return mine.length ? "removed" : "absent";
}

/**
 * A Murage bot must load ONLY Murage's own MCP mounts (agents, memory,
 * composio, browser, computer), never the owner's global Claude Code or
 * Cursor servers. Found from a real turn: the engine mounted ~21 servers,
 * 5 of them Murage's, the rest imported from the owner's machine; most failed
 * their handshake, one crash-looped on every turn, and the core held the
 * first prompt for the full MCP_READY_WAIT_MS (15 s) waiting on them.
 *
 * MECHANISM (fuigo-shell util/config/mcp.rs, verified on the 1.0.18 binary
 * with a poisoned HOME): the engine reads `$HOME/.claude.json` and
 * `$HOME/.cursor/mcp.json` through `fuigo_dirs::home_dir()` and merges them
 * under its own `config.toml` servers, each source behind a compat cell
 * (`compat.claude.mcps`, `compat.cursor.mcps`). A cell resolves env first,
 * so `FUIGO_CLAUDE_MCPS_ENABLED=0` / `FUIGO_CURSOR_MCPS_ENABLED=0` drops the
 * import for this process only, without moving HOME (which would take the
 * bot's git, ssh and toolchain config away) and without touching the owner's
 * ~/.fuigo, so sign-in and Murage's own `mcpServers` are unaffected.
 *
 * The same env-first cells exist for skills, rules, agents, hooks and sessions
 * (fuigo-tools types/compat.rs COMPAT_CELLS), so all 19 cells are closed together:
 * the owner's Claude Code, Cursor and Codex (~/.codex) surfaces plus the shared
 * ~/.agents skills directory. The env value takes precedence over config.toml.
 *
 * An explicit value already in the environment wins, so an owner who WANTS
 * the import can set the variable to 1 on the engine's environment.
 *
 * NOT covered here, by design of the engine: Claude Code PLUGINS
 * (`~/.claude/plugins`, installed_plugins.json) are discovered outside the
 * compat cells and their `[plugins] auto_discover` switch is config.toml-only
 * (the FUIGO_CONFIG overlay allowlist drops `plugins`), so no env can turn it
 * off without relocating HOME or FUIGO_HOME. That needs an engine change.
 */
export const FUIGO_EXTERNAL_MCP_GATES = [
  "FUIGO_CLAUDE_SKILLS_ENABLED", "FUIGO_CLAUDE_RULES_ENABLED", "FUIGO_CLAUDE_AGENTS_ENABLED",
  "FUIGO_CLAUDE_MCPS_ENABLED", "FUIGO_CLAUDE_HOOKS_ENABLED", "FUIGO_CLAUDE_SESSIONS_ENABLED",
  "FUIGO_CURSOR_SKILLS_ENABLED", "FUIGO_CURSOR_RULES_ENABLED", "FUIGO_CURSOR_AGENTS_ENABLED",
  "FUIGO_CURSOR_MCPS_ENABLED", "FUIGO_CURSOR_HOOKS_ENABLED", "FUIGO_CURSOR_SESSIONS_ENABLED",
  "FUIGO_CODEX_SKILLS_ENABLED", "FUIGO_CODEX_RULES_ENABLED", "FUIGO_CODEX_AGENTS_ENABLED",
  "FUIGO_CODEX_MCPS_ENABLED", "FUIGO_CODEX_HOOKS_ENABLED", "FUIGO_CODEX_SESSIONS_ENABLED",
  "FUIGO_AGENTS_SKILLS_ENABLED",
] as const;

export function isolateFuigoFromExternalMcp(env: Record<string, string | undefined>): void {
  const present = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  for (const name of FUIGO_EXTERNAL_MCP_GATES) {
    if (!present.has(name)) env[name] = "0";
  }
  // Hooks are the exception to the opt-in rule above: the owner's hooks never run in a bot turn, even when
  // the owner set the gate to 1 (Fuigo 1.0.32 runs them on every run, headless included). See hook-gates.ts.
  // Fuigo's own ~/.fuigo/hooks have no env gate: a bot turn runs in its own FUIGO_HOME (fuigo-scope.ts,
  // FUIGO-SCOPE-1010), so the owner's hooks, MCP servers, plugins and session grants are not in it at all.
  forceHookGatesOff(env, "FUIGO");
}

const support: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "Fuigo",
  // A cut MCP result is saved in this session's own `mcp/` folder; reading it
  // back is the bot reading its own output (server/own-tool-results.ts).
  toolResultDirs: ({ env, cwd, sessionId }) => fuigoToolResultDirs(fuigoHome(env), sessionFolders(cwd), sessionId),

  // Bundled 1.0.13 accepts inline ACP images despite omitting the handshake
  // flag. Murage resolves authorized bytes; the transport fixture pins them.
  images: true,

  // `_fuigo/interject` answers `{ status: "queued" }` and echoes `_fuigo/session/interjection`.
  interjection: {
    method: "_fuigo/interject",
    echoes: ["_fuigo/session/interjection", "fuigo/session/interjection"],
    queueChanged: ["_fuigo/queue/changed", "fuigo/queue/changed"],
  },

  models: STATIC_FUIGO_MODELS,
  resolveModels,
  // A local pick (`host::model`) becomes Murage's own `[model.*]` entry and
  // `-m` names that entry (spec E1). Settled here, not in applyTurnEnv,
  // because argv is built from this return value; the env key is set on the
  // same child env object the spawn uses. Every other id is passed through.
  resolveTurnModel: (model, env) => (model && decodeInjectId(model) ? ensureFuigoLocalModel(model, env) : model),

  // FUIGO-SCOPE-1010: a bot's Fuigo runs in its own FUIGO_HOME, whose config.toml carries Murage's ask rules, so
  // every read, search, edit and command reaches Murage's key guard (fuigo-scope.ts). After resolveTurnModel (the
  // local-model file is written first) and after a provider route (whose own home is never scoped again).
  scopeKind: "fuigo",
  applyMountEnv: (env, { botId }) => scopeFuigoHome(env, botId),
  scopeRoot: (env) => env.FUIGO_HOME,

  // `-m <model>` in argv is NOT applied to a session opened with
  // `session/load`: a loaded session keeps the model it had. The engine's own
  // answer is `session/set_model` with the same id `-m` carried, sent after
  // session/load (and harmless after session/new). `turn.model` here is the
  // post-resolveTurnModel id, i.e. exactly what spawnArgs passed to `-m`.
  // Any failure fails the turn: running the previous model while the picker
  // shows the new one is worse than an error. No pick, nothing sent.
  async configureSession({ request, sessionId, turn, currentModelId }) {
    if (!turn.model) return;
    // A set_model to the model already in force is not silent in the engine
    // (model-changed, summary and config-options notifications), so skip it.
    // No reported current model: send anyway, which fails closed.
    if (currentModelId && currentModelId === turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).replaceAll("\u2014", ", ");
      throw new Error(
        `Fuigo could not switch to the model "${turn.model}" for this conversation (${detail}). ` +
          `The turn was not sent, so no other model answered. Try again, or pick a different model.`,
      );
    }
  },

  // Fuigo's own enum: None | Minimal | Low | Medium | High | Xhigh | Max
  // (fuigo-sampling-types/src/types.rs:750-759). Murage's EFFORT_LEVELS
  // (contracts.ts:34) has no "minimal", so this is the full intersection.
  // Validation is LAZY, exactly like grok: `--reasoning-effort` is a plain
  // String that `parse_canonical_effort_token` (types.rs:832) turns into
  // `None` on an unknown token, which silently drops the override rather
  // than failing the launch — so an id that is not on this list is a bug
  // nothing will report.
  effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],

  defaultCli: "fuigo",
  launchExecutable: fuigoLaunchFile,
  versionFailure: (env, config, detail) => {
    // A custom CLI owns its own installation; bundle repair cannot fix it.
    if (config.cli !== "fuigo" || !env.MURAGE_FUIGO_DIR?.trim()) return;
    const repair = "Repair or reinstall Murage's bundled Fuigo engine. Node/npm is not required.";
    try {
      const resolved = resolveFuigoCli(env);
      if (resolved.source === "bundled") return { reason: `Bundled Fuigo at ${resolved.command} ${detail}. ${repair}`, setupAction: "repair" };
    } catch (error) {
      // resolveFuigoCli's messages contain only our checked resource path.
      return { reason: `${error instanceof Error ? error.message : "Bundled Fuigo is unavailable"}. ${repair}`, setupAction: "repair" };
    }
  },
  nativeSource: "fuigo.acp",
  loginNote: "Fuigo has no credential: add a Flux Router key in App Settings, or run `fuigo login` in a terminal",

  // Murage SHIPS this engine (scripts/prepare-fuigo.mjs stages it into
  // Resources and MURAGE_FUIGO_DIR points at it), so this block only matters
  // on a development checkout with nothing staged. npm is the only published
  // route: the `fuigo` entry point is a Node launcher whose postinstall
  // decompresses the real executable into ~/.fuigo/bin, which augmentedPath()
  // already scans (env-path.ts:38).
  install: {
    command: {
      darwin: "npm install -g fuigo",
      linux: "npm install -g fuigo",
      win32: "npm install -g fuigo",
    },
    needsNode: true,
    // The npm package page, because it is the only URL that provably exists:
    // the registry serves `fuigo@1.0.4` with NO `homepage` and no
    // `repository`, and the Fuigo repo's own README still carries Grok
    // Build's x.ai links from before the fork. Pointing at an invented
    // fuigo.ai would be worse than pointing at npm. Replace this the day
    // Ferrox Labs publishes a docs site.
    docsUrl: "https://www.npmjs.com/package/fuigo",
    signInCommand: "fuigo login",
  },

  /**
   * ARGV ORDER. Two families of flag, and putting one in the other's place
   * fails SILENTLY — this is the Grok Build bug, inherited intact by the
   * fork. Proven against the staged 1.0.2 binary, same prompt, same HOME:
   *
   *   fuigo -m claude-haiku-4-5 agent stdio
   *     → init.modelState.currentModelId = flux-auto
   *     → session/new  currentModelId    = flux-auto
   *     → prompt result _meta.modelId    = flux-auto      ← IGNORED
   *
   *   fuigo agent -m claude-haiku-4-5 stdio
   *     → init.modelState.currentModelId = claude-haiku-4-5
   *     → session/new  currentModelId    = claude-haiku-4-5
   *     → prompt result _meta.modelId    = claude-haiku-4-5 ← honoured
   *
   * So `-m` and `--reasoning-effort` MUST sit after `agent` and before
   * `stdio`. `--permission-mode` is the other way round: it is a top-level
   * option that main.rs:2132 threads into the agent path by hand
   * (`run_agent_command(agent_args, args.permission_mode_flag.clone(), …)`),
   * and it is NOT accepted after `agent`. The combined form below was run
   * live and honoured the model.
   *
   * `--permission-mode default` ALWAYS, at every level, never bypassPermissions
   * (FUIGO-SCOPE-1010): under bypass Fuigo does not prompt for its ask rules on
   * reads, edits and searches, and in default the bot scope's ask rules
   * (fuigo-permission.ts) send every shell command, read, edit and search to
   * Murage, whose key guard holds at every level, No limits included, and whose
   * levels answer the ordinary ones (core.ts answers a fullAuto turn's asks
   * itself, allow_once only). Explicit, so a mode a user set for their own
   * terminal cannot switch it inside Murage.
   *
   * Long form `--reasoning-effort` on purpose, same as grok: `--effort` is
   * declared as a `visible_alias` (fuigo-pager/src/app/cli.rs:273) and an
   * alias is the part a CLI is free to rename.
   */
  spawnArgs: (_config, turn, ctx) => [
    "--permission-mode",
    "default",
    // Folder trust (1.0.13, FUIGOTRUST1): `--trust` is a top-level flag like
    // --permission-mode (fuigo-pager/src/app/cli.rs `trust`, hidden alias
    // `--trust-folder`) that grants the PROCESS CWD — the same folder the
    // session/new below names, and persists the grant in the bot's own
    // scoped trusted_folders.toml (FUIGO-SCOPE-1010; the owner's standalone
    // Fuigo keeps its own list). It is passed ONLY when Murage's own record
    // says the human trusted this folder (the card, or the folder picker);
    // never from a config default, never in Auto mode on its own. Without
    // it the engine keeps the folder's instructions, MCP servers, skills and
    // hooks out, and the core's answer to its `fuigo/folder_trust/request`
    // repeats the same decision.
    ...(ctx?.folderTrusted ? ["--trust"] : []),
    // Murage owns persistent memory. Override ambient Fuigo config without
    // changing the user's standalone memory policy or touching their store.
    "--no-memory",
    "agent",
    // `[cli] use_leader = true` in the user's own ~/.fuigo/config.toml makes
    // `fuigo agent` ATTACH to a running leader on ~/.fuigo/leader.sock instead
    // of starting its own. That leader's permission mode, model and credential
    // are whatever started it — reopening by a different door the exact hole
    // the explicit --permission-mode above exists to close, and billing the
    // turn to an identity that is not the FUIGO_API_KEY we just injected.
    // Unconditional and free: Murage always wants its own backend.
    "--no-leader",
    ...(turn.model ? ["-m", turn.model] : []),
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  /** Fuigo 1.0.13 gates repo-local sources per folder; the core decides
   *  trust before the spawn from Murage's record or a card (see `spawnArgs`
   *  and core.ts FUIGOTRUST1). */
  folderTrust: true,

  /** 1.0.19/1.0.20 answer session/new before the `mcpServers` are connected
   *  and emit `_fuigo/mcp_initialized {sessionId, mcpToolCount, elapsedMs}`
   *  once every server (the user's imported ones too) has settled. The core
   *  holds the first prompt for it, bounded (core.ts MCP_READY_WAIT_MS). */
  mcpReadyNotification: "_fuigo/mcp_initialized",
  mcpProgressNotification: "_fuigo/mcp/init_progress",
  /** Per-server status (fuigo-shell extensions/mcp.rs `fuigo/mcp/list`, sent
   *  with the ACP `_` prefix): read before the prompt for Murage's required servers. */
  mcpListMethod: "_fuigo/mcp/list",

  /** One process per thread between turns (upstream #1575, core.ts pool
   *  notes). Safe here because `load_session` on a session already resident
   *  in the process re-applies the `mcpServers` it is handed, restarting only
   *  the servers whose config changed (fuigo-shell mvp_agent/session_setup.rs
   *  `UpdateMcpServers`), and announces them again with
   *  `_fuigo/mcp_initialized`; so the per-turn capability tokens reach a
   *  reused process. `_meta.noReplay` skips re-sending the transcript. */
  pooledSessions: true,

  /**
   * `transformEnv`, NOT `applyTurnEnv` — and that is the opposite of every
   * other Flux-routed driver in this tree, on purpose.
   *
   * qwen/kimi/droid use `applyTurnEnv` (core.ts:323) because their OPENAI_*
   * overlay is a PER-TURN decision: it must appear on a Flux turn and vanish
   * on a native one, and it must not be visible to the catalog refresh or the
   * snapshot, which share `transformEnv` (core.ts:213). Fuigo has no such
   * split. Its credential is not a routing overlay, it is the CLI's identity:
   * the same key is correct for every model, and the two spawns that ONLY see
   * `transformEnv` are exactly the two that break without it —
   *   • `fuigo models` (resolveModels, via core.ts:220) answers with a
   *     four-row unauthenticated placeholder when the key is absent, and
   *   • `isAuthenticated` (snapshot, core.ts:751) would report a working
   *     install as signed out.
   * Putting this in `applyTurnEnv` would leave both of those unkeyed.
   *
   * THE KEY COMES FROM `fluxKey()`, NEVER OFF `env`. `FLUX_API_KEY` is a
   * workspace credential (config.ts:551) that the core's allowlist loop
   * (core.ts:204-205) has already deleted from this object by the time this
   * runs. `fluxKey()` reads config/`process.env` instead (flux-config.ts:16).
   *
   * `credentialEnv` IS DELIBERATELY EMPTY, and the reasoning here differs
   * from qwen's only in the details. Allowlisting `FLUX_API_KEY` would leave
   * the RAW workspace key in the child under its workspace name, inherited by
   * every process fuigo spawns — its plugins, its MCP servers, its shell
   * tools. The brief's hypothesis was that the catalog spawn needs the
   * allowlist to see a key at all; it does not, because `transformEnv` runs
   * for the catalog spawn too and hands it `FUIGO_API_KEY`. So the child gets
   * the value under exactly one harness-owned name and nothing more.
   *
   * NO KEY ⇒ NO WRITE. An install signed in with `fuigo login`
   * (~/.fuigo/auth.json) or carrying the user's own ambient Flux-shaped
   * `FUIGO_API_KEY` is a working install, and half-writing an env over it
   * would break it. An ambient value that is not a Flux key is removed
   * (`scrubFuigoCredentialEnv`): Fuigo would only send it to Flux.
   * Same "degrade to native rather than 401" rule `applyFluxSurface` follows
   * (flux-routing.ts:334).
   */
  /**
   * Flux Memory headers (PROPOSAL-v2 5.4). Fuigo has no FUIGO_EXTRA_HEADERS
   * and needs none: its config loader merges an inline `FUIGO_CONFIG` JSON
   * overlay, the overlay allowlist keeps the whole `[models]` table, and
   * `[models].extra_headers` is a global default folded into every model
   * (fuigo-shell agent/config.rs apply_global_extra_headers; the sampler
   * applies them verbatim to the request, fuigo-sampler client.rs). Set per
   * turn, after the route is settled, so it lands in the pooled-process
   * contract digest. A Flux-shaped FUIGO_API_KEY is the only credential, so
   * the headers go to Flux and nowhere else.
   */
  // A bare cloud-model id still goes out on the Flux key Fuigo was handed, so it takes the memory opt-outs
  // like a flux-* pick. A local `host::model` pick talks to the user's own server and never reaches Flux.
  reachesFlux: (model, env) => !decodeInjectId(model) && presentedFuigoKey(env) !== null,
  applyFluxMemory: (env, { decision }) => {
    env.FUIGO_CONFIG = fuigoConfigOverlay(decision.headers, env.FUIGO_CONFIG);
  },
  transformEnv: (env) => {
    reachBundledFuigo(env);
    isolateFuigoFromExternalMcp(env);
    // Ambient siblings go first: `FUIGO_CODE_API_KEY` is read by the same
    // provider row (key_discovery.rs:60-70) and a stale one in the user's
    // shell would put the child on an account the app never chose.
    // `FLUX_API_KEY` is already gone via the strip; deleting it again is free
    // and keeps this correct if a caller ever lands before the strip.
    // `fluxKey()` is null for anything not shaped like a Flux key.
    scrubFuigoCredentialEnv(env, fluxKey());
    // 1.0.32: no other provider's key, no startup model refresh, no agent Fuigo starts on its own.
    withholdFuigoProviderEnv(env);
  },
  scrubHandedEnv: (map, child) => scrubFuigoHandedEnv(map, child),

  /**
   * Bind the API-key method when the agent advertises it.
   *
   * Live, 1.0.2: WITH a key, `initialize` answers
   *   authMethods: [{ id: "fuigo.api_key", description: "FUIGO_API_KEY or
   *                   api_key/env_key in config.toml" }]
   *   _meta.defaultAuthMethodId: "fuigo.api_key"
   * and `authenticate {methodId:"fuigo.api_key"}` returns `{}`.
   * WITHOUT a key, `authMethods` is EMPTY and both `authenticate` and
   * `session/new` fail -32000 "Authentication required".
   *
   * The fallback to `methods[0]` is not padding. `fuigo login` writes an OIDC
   * credential to ~/.fuigo/auth.json, and this driver cannot test what method
   * id that install advertises without signing in as the user. Hard-coding
   * only `fuigo.api_key` and pairing it with `authFailure: "fail"` would kill
   * every turn on a working login install; taking whatever is offered cannot.
   */
  pickAuthMethod: (methods) => {
    const ids = methods.map((method) => method.id).filter((id): id is string => Boolean(id));
    return ids.find((id) => id === "fuigo.api_key") ?? ids[0] ?? null;
  },

  /**
   * "continue", with `requireAuthenticationBeforeSpawn` doing the real gating
   * below. "fail" here would abort the turn whenever `pickAuthMethod` came
   * back null — which is precisely the unverifiable `fuigo login` case above.
   * When there really is no credential, fuigo's own `session/new` refuses
   * with a better message than this file could write, and `classifyError`
   * turns it into a setup prompt rather than a retry.
   */
  authFailure: "continue",

  /**
   * Both halves matter, and the file check alone is the bug the brief warned
   * about: on a fresh machine with a Flux key and no `fuigo login`, there is
   * no ~/.fuigo/auth.json at all and a file-only check reports "not signed
   * in" for the exact user Murage is built for. Proven live — a temp HOME
   * with no ~/.fuigo ran a full turn on `FUIGO_API_KEY` alone.
   *
   * `env` has already been through `transformEnv`, so the injected
   * `FUIGO_API_KEY` is visible here; the other two names cover a user's own
   * ambient credential on an install where Murage has no key of its own.
   */
  isAuthenticated: (env) => {
    if (FUIGO_KEY_ENV.some((name) => (env[name] ?? "").trim())) return true;
    return existsSync(join(fuigoHome(env), "auth.json"));
  },

  /** Refuse before spawning when neither a key nor a login exists — a 165MB
   *  binary start, a network round trip and a -32000 are a slow way to say
   *  "sign in". `loginNote` names both fixes. */
  requireAuthenticationBeforeSpawn: true,

  /** -32000 "Authentication required" is what fuigo returns from
   *  `authenticate` AND from `session/new` on an uncredentialed install
   *  (verified live). Classifying it marks the runtime error `setup: true`
   *  (core.ts:729-733) so the UI offers sign-in instead of a retry that is
   *  guaranteed to fail identically. */
  classifyError: (error): ProviderErrorCode | undefined => {
    const message = error instanceof Error ? error.message : String(error);
    if (/authentication required/i.test(message)) return "invalid_credentials";
    return undefined;
  },

  /** `--rules` and `--system-prompt-override` are TOP-LEVEL TUI flags — they
   *  are not on `fuigo agent --help` at all — so there is no argv route to
   *  the agent-stdio system prompt. The persona is prepended, codex/grok
   *  style. Same text the core default produces; stated here so the reason it
   *  is not a flag stays with the code. */
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  /** Fuigo cuts a prompt over 25,000 bytes to its head and tail and tells
   *  the model to read the rest from a file under ~/.fuigo/sessions, outside
   *  the bot's folder (fuigo-shell prompt_build.rs). The persona rides in the
   *  same text block, so a long routine instruction reached the bot cut off,
   *  and a No limits bot went reading session files to find the rest
   *  (0.1.60 Windows pass D6). `verbatim` sends Murage's bytes as they are. */
  promptMeta: { verbatim: true },
  // Fuigo 1.0.32: set_mode resolves any mode id through the workspace's .fuigo/agents/<id>.md first
  // (session_mode.rs, discovery.rs), and an allow-always answer leaves a Bash grant in the engine
  // that answers later requests without Murage (manager mod.rs). Neither is ever sent.
  noSessionModes: true,
  allowOnceOnly: true,
  // PIP reflection: a dedicated headless spawn (never the ACP stdio path), credential = the Flux key.
  textOnlyExecutable: config => config.cli === "fuigo" ? resolveFuigoCli(process.env).command : config.cli,
  textOnlyTurn: (turn, config) => {
    let cli = config.cli;
    if (cli === "fuigo") { try { cli = resolveFuigoCli(process.env).command; } catch { /* the spawn reports a missing binary */ } }
    const key = fluxKey();
    return headlessTextOnlyTurn(turn, { engine: "fuigo", cli, tmpBase: join(DATA_DIR, "pip-tmp"), ...(key ? { fluxKey: key } : {}) });
  },
};

export const FuigoAgentDriver = createAcpDriver(support);
