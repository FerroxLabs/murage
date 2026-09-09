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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { resolveFuigoCli } from "../../env-path.ts";
import { fluxKey } from "../../flux-config.ts";
import { FLUX_TIERS, mergeFluxCatalog } from "../../flux-surface.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

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
function reachBundledFuigo(env: Record<string, string | undefined>): void {
  let resolved;
  try {
    resolved = resolveFuigoCli(env as NodeJS.ProcessEnv);
  } catch {
    return; // snapshot retains the declared bundle's resolution diagnostic
  }
  if (resolved.source !== "bundled") return;
  env.PATH = [dirname(resolved.command), env.PATH].filter(Boolean).join(delimiter);
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
function fetchFuigoModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
): Promise<ModelCatalog> {
  return new Promise((resolve) => {
    execCli(config.cli, ["models"], { timeout: 10_000, env }, (err, stdout) => {
      resolve(err ? { default: "", options: [] } : parseFuigoModels(stdout));
    });
  });
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
): Promise<ModelCatalog> {
  const live = await fetchFuigoModels(env, config);
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
  return mergeFluxCatalog(catalog, DRIVER_KIND);
}

const support: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "Fuigo",

  // `initialize` answers `promptCapabilities.image: false` (verified live,
  // 1.0.2), so a referenced image would be dropped silently rather than read.
  images: false,

  models: STATIC_FUIGO_MODELS,
  resolveModels,

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
  loginNote: "Fuigo has no credential — add a Flux Router key in App Settings, or run `fuigo login` in a terminal",

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
   * Passing `--permission-mode default` explicitly, rather than omitting it,
   * is deliberate: it pins the non-fullAuto spawn to ASK, so a
   * `[permissions] mode` a user set in ~/.fuigo/config.toml for their own
   * terminal cannot silently auto-approve tool calls inside Murage. Murage's
   * ACP core answers `session/request_permission` itself, fail-closed, and
   * that only works if the CLI actually asks.
   *
   * Long form `--reasoning-effort` on purpose, same as grok: `--effort` is
   * declared as a `visible_alias` (fuigo-pager/src/app/cli.rs:273) and an
   * alias is the part a CLI is free to rename.
   */
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
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
   * (~/.fuigo/auth.json) or carrying the user's own ambient `FUIGO_API_KEY`
   * is a working install, and half-writing an env over it would break it.
   * Same "degrade to native rather than 401" rule `applyFluxSurface` follows
   * (flux-routing.ts:334).
   */
  transformEnv: (env) => {
    reachBundledFuigo(env);
    const key = fluxKey();
    if (!key) return;
    // Ambient siblings go first: `FUIGO_CODE_API_KEY` is read by the same
    // provider row (key_discovery.rs:60-70) and a stale one in the user's
    // shell would put the child on an account the app never chose.
    // `FLUX_API_KEY` is already gone via the strip; deleting it again is free
    // and keeps this correct if a caller ever lands before the strip.
    for (const name of FUIGO_KEY_ENV) delete env[name];
    env.FUIGO_API_KEY = key;
  },

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
};

export const FuigoAgentDriver = createAcpDriver(support);
