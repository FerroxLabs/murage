// Flux Router — the three routing tables and the env appliers.
//
// One host, three wire protocols, three mechanisms, three capability classes.
// Which surface an engine gets is not a detail the caller may choose: a CLI
// pointed at the wrong one 4xx's on every turn, so the mapping lives here,
// next to the appliers, and the picker gate and the spawn gate both read it.
// They cannot disagree about which engines are routable because there is only
// one table — `flux-surface.ts` re-exports these rather than keeping a second
// copy, which is what the two tables used to be (spec §5.1).
//
// THE CREDENTIAL RULE (Kimi finding C, docs/plans/flux-router-integration.md:172).
// `FLUX_API_KEY` is in WORKSPACE_CREDENTIAL_ENV (config.ts:551), so by the time
// any of these appliers runs, `stripWorkspaceCredentialEnv` (config.ts:565) —
// or the ACP allowlist loop at acp/core.ts:204 — has already deleted it from
// the env object being mutated. Reading the key back off that env is guaranteed
// to find nothing and produces a 401 that looks like a bad key.
//
// So `applyFluxSurface` takes the key as an ARGUMENT. Callers get it from
// `fluxKey()` (flux-config.ts:16), which reads config/`process.env` — never the
// child env — and every call site must sit AFTER the strip, never before.
import type { DriverKind } from "./contracts.ts";

/** The three verified wire surfaces. Endpoints confirmed live against
 *  api.fluxrouter.ai (docs/plans/flux-router-spec.md §1.1):
 *    openai     POST https://api.fluxrouter.ai/v1/chat/completions
 *    anthropic  POST https://api.fluxrouter.ai/anthropic/v1/messages
 *    responses  POST https://api.fluxrouter.ai/v1/responses          */
export type FluxSurfaceKind = "openai" | "anthropic" | "responses";

/** OpenAI-compatible base. The CLI appends `/chat/completions`. */
export const FLUX_OPENAI_BASE = "https://api.fluxrouter.ai/v1";

/** Responses base. Codex appends `/responses` when `wire_api = "responses"`. */
export const FLUX_RESPONSES_BASE = "https://api.fluxrouter.ai/v1";

/**
 * Anthropic base — `/anthropic`, NOT the bare host.
 *
 * Claude Code appends `/v1/messages` to ANTHROPIC_BASE_URL; that is why
 * `anthropicBaseUrl` (local-inject.ts:105-107) strips the trailing `/v1` off a
 * local host's OpenAI base. The verified Flux endpoint is
 * `/anthropic/v1/messages`, so the base has to carry `/anthropic` for the
 * append to land on it.
 *
 * The spec's §4 sketch (flux-router-spec.md:214) instead reads
 * `https://api.fluxrouter.ai`, which resolves to `/v1/messages`. Probed live
 * 2026-09-01 with the same body on both: `/anthropic/v1/messages` → 200 and
 * `/v1/messages` → 200, so the bare host is an undocumented alias rather than
 * a bug. We take `/anthropic` because it is the route the spec's own §1.1
 * verification table names and the one Wayland ships
 * (~/dev/wayland/app/src/common/config/flux.ts:35); the alias is not in the
 * verified set and could be withdrawn without notice.
 */
export const FLUX_ANTHROPIC_BASE = "https://api.fluxrouter.ai/anthropic";

/**
 * Which WIRE SURFACE an engine speaks. This answers "what does the HTTP look
 * like", and nothing else — see `FLUX_MECHANISM` for how the engine is pointed
 * at it, and `FLUX_CAPABILITY` for whether a user has to do anything first.
 *
 * Splitting those three apart is the change that made this table growable.
 * While surface, mechanism and capability were one map, adding an engine that
 * needs a FILE written rather than a VARIABLE set was impossible without
 * changing the type — which is why this map sat at three engines while the
 * drivers for two more were already in the tree. Wayland keeps the same two
 * axes apart (`fluxCompat` in acpTypes.ts vs the four dispatch sets in
 * fluxRouting.ts) and routes six CLIs off them.
 *
 * Keys are real `driverKind` values in this repo: claude.ts:98, qwen.ts:89,
 * codex.ts:37, hermes.ts:395, opencode-go.ts:346.
 *
 * Deliberately absent, each for a checked reason:
 *  - `gooseAgent` — there is NO goose driver in this codebase (`grep -rin
 *    goose server/ src/` matches only "mongoose" in project-scout.ts:156). A
 *    key here that no driver can ever present would be dead weight in the gate
 *    and would read as a promise the picker never keeps. Add it in the same
 *    change that adds the driver. The recipe is known if it lands: the shared
 *    OpenAI env PLUS `GOOSE_PROVIDER=openai` and `GOOSE_MODEL=flux-auto`,
 *    without which goose never reads OPENAI_BASE_URL at all
 *    (~/dev/wayland/app/src/process/task/fluxRouting.ts:27-28, 51).
 *  - `geminiAgent` — Wayland routes its own IN-PROCESS gemini, not gemini-cli
 *    over ACP, so there is no proven recipe to copy. Unverified, not refused.
 *  - `droidAgent` / `cursorAgent` / `grok` / `grokAgent` — classified `vendor`
 *    below. Note that classification is asserted, not probed, in Wayland too
 *    (SESSION-HANDOFF-2026-06-05-FLUX-PHASE1-REMEDIATION.md:14: "it is
 *    unproven that any given CLI honors OPENAI_BASE_URL/OPENAI_MODEL").
 *  - `kimiAgent`, `piAgent`, `minimax`, `openai-compat`, `customAcp`,
 *    `boxAgent`, `antigravityAgent` — unclassified. No evidence either way,
 *    and an unclassified engine is not routable, so this fails closed.
 *
 * TWO CORRECTIONS to what this comment used to say, both wrong on the facts:
 *  - it claimed `opencodeGo` is vendor-locked. It is not. OpenCode is
 *    `setup`-class: it cannot be pointed at Flux by env alone (it defaults to
 *    a non-openai provider), but Wayland ships a working connector for it
 *    (src/process/connectors/opencode.ts:147-253) and so does this app now —
 *    `server/opencode-config.ts`, behind the safety envelope Kimi finding B
 *    (integration.md:161) asked for and Wayland built but never wired.
 *  - it claimed `qoder` "routes through its own login". No Wayland doc or code
 *    says that. Qoder was never ATTEMPTED — Wayland classifies it
 *    routable-with-setup (acpTypes.ts:472) and simply never wrote the
 *    connector. It is absent here because this app has no qoder driver, which
 *    is a different and true reason.
 */
export const FLUX_SURFACE: Partial<Record<DriverKind, FluxSurfaceKind>> = {
  claudeAgent: "anthropic",
  qwenAgent: "openai",
  codex: "responses",
  hermesAgent: "openai",
  opencodeGo: "openai",
};

/**
 * CAPABILITY — what a user must do before this engine can reach Flux. Drives
 * the picker copy and the refusal message; deliberately independent of which
 * HTTP surface the engine speaks.
 *
 *  - `env`    — routable right now, with nothing for the user to do. Includes
 *               the scoped-HOME engines: a disposable app-private config dir
 *               is not "setup", it is an implementation detail of the spawn.
 *               (Wayland labels hermes `setup` at acpTypes.ts:517; its own
 *               router makes that stale, since hermesConfig.ts materialises
 *               the home automatically. We follow the router, not the label.)
 *  - `setup`  — routable only AFTER a deliberate, user-initiated write into
 *               the CLI's own config file.
 *  - `vendor` — locked to its own service. Never routable.
 *
 * Absent ⇒ unclassified ⇒ not routable, same as `vendor` in effect but honest
 * about the difference: `vendor` is a claim, absence is the lack of one.
 */
export type FluxCapability = "env" | "setup" | "vendor";

export const FLUX_CAPABILITY: Partial<Record<DriverKind, FluxCapability>> = {
  claudeAgent: "env",
  qwenAgent: "env",
  codex: "env",
  hermesAgent: "env",
  opencodeGo: "setup",
  grok: "vendor",
  grokAgent: "vendor",
  droidAgent: "vendor",
  cursorAgent: "vendor",
};

export function fluxCapabilityFor(engine: DriverKind): FluxCapability | null {
  return FLUX_CAPABILITY[engine] ?? null;
}

/**
 * MECHANISM — how the child is actually pointed at the surface. This is the
 * dispatch `applyFluxSurface` and the drivers read; it is not the same axis as
 * the wire surface (hermes and opencode both speak `openai` and are reached
 * two completely different ways).
 *
 *  - `env`         — variables on the child env, nothing on disk.
 *                    claude / qwen / codex.
 *  - `scopedHome`  — an app-private config dir regenerated per spawn plus one
 *                    env var pointing at it. The user's own config is never
 *                    read or written. hermes (`HERMES_HOME`).
 *  - `configWrite` — a write into the CLI's OWN config file. The only
 *                    mechanism that can damage something the user owns, hence
 *                    the whole of `flux-connector.ts`, and the only one that
 *                    is never triggered by a spawn. opencode.
 */
export type FluxMechanism = "env" | "scopedHome" | "configWrite";

export const FLUX_MECHANISM: Partial<Record<DriverKind, FluxMechanism>> = {
  claudeAgent: "env",
  qwenAgent: "env",
  codex: "env",
  hermesAgent: "scopedHome",
  opencodeGo: "configWrite",
};

export function fluxMechanismFor(engine: DriverKind): FluxMechanism | null {
  return FLUX_MECHANISM[engine] ?? null;
}

/** Every `flux-*` alias the gateway serves shares this prefix. */
export const FLUX_MODEL_PREFIX = "flux-";

/** The alias to fall back on when routing is on but no tier was picked. */
export const FLUX_AUTO_MODEL = "flux-auto";

/**
 * Codex provider id. Every Flux row offered to codex MUST be encoded
 * `encodeCodexSelection("flux", "flux-auto")` → `flux::flux-auto`. A bare
 * `flux-auto` matches codex-catalog.ts:31's MODEL_ID regex, so
 * `decodeCodexSelection` (codex-catalog.ts:51) hands it
 * `modelProvider: "openai"` and the turn POSTs to api.openai.com → 400.
 */
export const FLUX_CODEX_PROVIDER = "flux";

const CODEX_SEP = "::";

/**
 * Harness-owned name the codex child reads its bearer from. Present in NEITHER
 * strip list on purpose — that is what lets it survive `childEnv()` — and it is
 * the *name*, not the value, that reaches argv. Same indirection
 * `codexLocalProviderArgs` uses at local-inject.ts:138-141, and it matches
 * `isSecretName` (redact.ts:16 "api_key") so it is masked in the native log.
 */
export const FLUX_CODEX_ENV_KEY = "MURAGE_FLUX_API_KEY";

/** The four selectable tiers, in picker order — Auto first (spec, plan §3). */
export const FLUX_MODELS = [
  { id: "flux-auto", label: "Flux Auto" },
  { id: "flux-reasoning", label: "Flux Reasoning" },
  { id: "flux-standard", label: "Flux Standard" },
  { id: "flux-fast", label: "Flux Fast" },
] as const;

export type FluxModelId = (typeof FLUX_MODELS)[number]["id"];

export const FLUX_MODEL_IDS: readonly FluxModelId[] = FLUX_MODELS.map((row) => row.id);

const PICKER_IDS = new Set<string>(FLUX_MODEL_IDS);

/**
 * The bare `flux-*` alias behind a picker id, or null when the id is not Flux.
 *
 * Accepts codex's provider-qualified form too (`flux::flux-auto`), because the
 * same id reaches the spawn gate and the model-resolution guards after codex's
 * catalog has encoded it. Conservative on purpose: `flux::gpt-4o` is NOT Flux
 * and returns null.
 */
export function fluxModelId(id: string | null | undefined): string | null {
  if (!id) return null;
  const bare = id.startsWith(`${FLUX_CODEX_PROVIDER}${CODEX_SEP}`) ? id.slice(FLUX_CODEX_PROVIDER.length + CODEX_SEP.length) : id;
  return bare.startsWith(FLUX_MODEL_PREFIX) && bare.length > FLUX_MODEL_PREFIX.length ? bare : null;
}

/**
 * Is this id routed at Flux? Prefix-based, per spec §4's definition — NOT
 * membership of `FLUX_MODELS`.
 *
 * The difference is load-bearing. `GET /v1/models` also serves `flux-voice`,
 * `flux-image` and `flux-pinned-*`, and this predicate is what the guards use
 * to answer "must this turn NOT go native?" — claude's `resolveClaudeTurnModel`
 * early-return (claude.ts:123, else every Flux turn pays a five-host loopback
 * probe and can be rewritten into a `host::model` inject id by `resolveInjectId`
 * at local-inject.ts:103-105) and the spawn-side 409 (spec §5.4). An exact-set
 * test there would let `flux-pinned-claude-opus-5` fall through to native and
 * 400. Use `isFluxPickerModel` for "may this row appear in the picker?".
 */
export function isFluxModel(id: string | null | undefined): boolean {
  return fluxModelId(id) !== null;
}

/** One of the four rows this app offers. Narrower than `isFluxModel`. */
export function isFluxPickerModel(id: string | null | undefined): boolean {
  const bare = fluxModelId(id);
  return bare !== null && PICKER_IDS.has(bare);
}

/** The surface an engine can be routed on, or null when it cannot be. */
export function fluxSurfaceFor(engine: DriverKind): FluxSurfaceKind | null {
  return FLUX_SURFACE[engine] ?? null;
}

export interface FluxSurfaceResult {
  /** The surface applied, or null when nothing was applied. */
  surface: FluxSurfaceKind | null;
  /** Exactly what was written onto `env`. Empty when nothing was. */
  env: Record<string, string>;
  /** Names deleted from `env` for mutual exclusivity. Empty when nothing was. */
  stripped: string[];
  /** Extra codex `-c` argv. Empty on every other surface. */
  args: string[];
  /** The model id the CLI should run — the bare alias, qualifier removed. */
  model: string | null;
  applied: boolean;
}

const NOT_APPLIED: FluxSurfaceResult = Object.freeze({
  surface: null,
  env: Object.freeze({}) as Record<string, string>,
  stripped: Object.freeze([]) as unknown as string[],
  args: Object.freeze([]) as unknown as string[],
  model: null,
  applied: false,
});

/**
 * Native credentials dropped before the anthropic surface is applied, so a
 * Flux-routed claude spawn never also carries the user's own Anthropic identity.
 * `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL` are in ROUTING_ENV (config.ts:615)
 * and already gone by now; re-deleting is free and keeps this correct if a
 * caller ever lands before the strip. `ANTHROPIC_API_KEY` is NOT in ROUTING_ENV
 * — claude.ts deletes it itself only on the non-injected path — so this is the
 * one that actually does work here.
 */
const NATIVE_ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"] as const;

/** Same idea for the two OpenAI-shaped surfaces. */
const NATIVE_OPENAI_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;

/** codex's own alternative bearer, which would outrank the provider table. */
const NATIVE_CODEX_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/**
 * Point one engine's child env at Flux, in place, and report what changed.
 *
 * @param engine    the driver's `driverKind` — the gate. Not routable ⇒ no-op.
 * @param env       the child env, ALREADY stripped. Mutated in place.
 * @param modelId   the picked id, bare (`flux-auto`) or codex-qualified
 *                  (`flux::flux-auto`). Not a Flux id ⇒ no-op, so this is safe
 *                  to call unconditionally on a routable engine's every spawn.
 * @param key       the Flux key from `fluxKey()` (flux-config.ts). NEVER read
 *                  it off `env` — see the credential rule at the top of this
 *                  file. Absent ⇒ no-op, so a missing key degrades to native
 *                  routing instead of a half-written env that 401s.
 *
 * Returns the additions rather than only mutating so a caller can log the
 * shape, assert mutual exclusivity, or build a routing badge without
 * re-deriving the table.
 */
export function applyFluxSurface(
  engine: DriverKind,
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
  key: string | null | undefined,
): FluxSurfaceResult {
  const surface = fluxSurfaceFor(engine);
  if (!surface) return NOT_APPLIED;
  // Env is one of THREE mechanisms now. A scoped-home engine (hermes) reads
  // nothing off the env, and a config-write engine (opencode) carries its
  // credential in its own file; writing OPENAI_* for either would be a lie in
  // the returned `env` map that a routing badge or a log would repeat, and on
  // opencode it would actively fight `stripForeignProviderKeys`.
  if (fluxMechanismFor(engine) !== "env") return NOT_APPLIED;
  const model = fluxModelId(modelId);
  if (!model) return NOT_APPLIED;
  const bearer = key?.trim();
  if (!bearer) return NOT_APPLIED;

  const stripped: string[] = [];
  const drop = (names: readonly string[]) => {
    for (const name of names) {
      if (name in env) {
        delete env[name];
        if (!stripped.includes(name)) stripped.push(name);
      }
    }
  };

  if (surface === "anthropic") {
    drop(NATIVE_ANTHROPIC_ENV);
    // Auth is permissive — x-api-key and Bearer both returned 200, alone or
    // together (spec §4.1). Setting BOTH is what keeps claude.ts:88's
    // `if (!injected) delete env.ANTHROPIC_API_KEY` from half-routing the env,
    // and stops a cc-switch-style native key from winning on the x-api-key
    // header the bundled binary prefers.
    const additions = {
      ANTHROPIC_BASE_URL: FLUX_ANTHROPIC_BASE,
      ANTHROPIC_AUTH_TOKEN: bearer,
      ANTHROPIC_API_KEY: bearer,
      ANTHROPIC_MODEL: model,
    };
    Object.assign(env, additions);
    return { surface, env: additions, stripped, args: [], model, applied: true };
  }

  if (surface === "openai") {
    drop(NATIVE_OPENAI_ENV);
    // OPENAI_MODEL is defensive: it has no reader or writer in this repo
    // (spec §3.1, §9) but an OpenAI-compatible CLI may honour it, and it is
    // already in ROUTING_ENV so setting it cannot leak past this spawn.
    // argv still wins where a CLI takes `-m` (qwen.ts:106) — the model id has
    // to be settled in `resolveTurnModel` (core.ts:322), one step before
    // `applyTurnEnv` (core.ts:323), because applyTurnEnv cannot change argv.
    const additions = {
      OPENAI_BASE_URL: FLUX_OPENAI_BASE,
      OPENAI_API_KEY: bearer,
      OPENAI_MODEL: model,
    };
    Object.assign(env, additions);
    return { surface, env: additions, stripped, args: [], model, applied: true };
  }

  // responses — codex. The secret rides under FLUX_CODEX_ENV_KEY and only the
  // NAME reaches argv, because argv is world-readable in `ps`. Modelled on
  // codexLocalProviderArgs (local-inject.ts:130-145).
  drop(NATIVE_CODEX_ENV);
  const additions = { [FLUX_CODEX_ENV_KEY]: bearer };
  Object.assign(env, additions);
  // Declares the provider TABLE only. Deliberately no `-c model_provider=flux`,
  // unlike the spec's §4.2 sketch: codex selects the provider per thread from
  // the decoded picker id at `thread/start` (codex.ts:540-544,
  // `modelProvider: selection.modelProvider`), so a global default here would
  // be redundant for a Flux turn and would hijack a native turn on the same
  // app-server. codexLocalProviderArgs makes the same choice for local hosts.
  const args = [
    "-c",
    `model_providers.${FLUX_CODEX_PROVIDER}.name=${JSON.stringify("Flux Router")}`,
    "-c",
    `model_providers.${FLUX_CODEX_PROVIDER}.base_url=${JSON.stringify(FLUX_RESPONSES_BASE)}`,
    "-c",
    `model_providers.${FLUX_CODEX_PROVIDER}.wire_api=${JSON.stringify("responses")}`,
    "-c",
    `model_providers.${FLUX_CODEX_PROVIDER}.env_key=${JSON.stringify(FLUX_CODEX_ENV_KEY)}`,
  ];
  return { surface, env: additions, stripped, args, model, applied: true };
}
