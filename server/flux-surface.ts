// Which engines Flux Router can actually be routed through — ONE table, and
// every consumer of it.
//
// Kimi finding D: a `flux-auto` row offered on an engine with no implemented
// Flux surface never reaches Flux. It is posted to that engine's OWN host —
// for codex, `decodeCodexSelection` (codex-catalog.ts:39-52) maps any bare id
// matching MODEL_ID onto OFFICIAL_CODEX_PROVIDER, so `flux-auto` goes to
// api.openai.com and comes back 400.
//
// A picker-side filter cannot be the gate. `checkedModelSelection`
// (index.ts:729-743) deliberately does not validate a model id against the
// catalog unless `requireAvailableModel` is set, so a persisted, cloned or
// MCP-set selection reaches the spawn untouched. Hence the same table is read
// by all of:
//   1. catalog build     — mergeFluxCatalog(), from each driver's own
//      resolveModels/refreshModels where driverKind is a compile-time constant
//   2. registry backstop — filterFluxRows(), harness/registry.ts describe()
//   3. spawn refusal     — fluxSelectionRefusal(), server/index.ts
// and by the injectors when they land, so picker and router cannot disagree.
import type { DriverKind, ModelCatalog } from "./contracts.ts";
import { fluxConfigured } from "./flux-config.ts";

/** Which Flux wire surface an engine speaks. Presence in this table IS the
 *  "surface is implemented" flag — an engine absent from it is not routable,
 *  gets no rows, and is refused at spawn. Sourced from
 *  docs/plans/flux-router-spec.md §4.1-4.4: claude on Anthropic Messages,
 *  qwen on OpenAI chat-completions, codex on Responses. `opencode`, `qoder`,
 *  `droid`, `auggie`, `copilot`, `kiro` and `vibe` have no surface (§4.4) and
 *  must stay out. */
export type FluxSurface = "anthropic" | "openai" | "responses";

export const FLUX_SURFACE: Readonly<Partial<Record<DriverKind, FluxSurface>>> = {
  claudeAgent: "anthropic",
  qwenAgent: "openai",
  codex: "responses",
};

export const FLUX_MODEL_PREFIX = "flux-";
/** Flux's pinned-backend aliases (`flux-pinned-claude-opus-5`, …). They sort
 *  after the user's own rows — see mergeFluxCatalog. */
export const FLUX_PINNED_PREFIX = "flux-pinned-";
/** Codex `model_providers.<id>` this app configures for Flux. */
export const FLUX_PROVIDER_ID = "flux";

const SEP = "::";

/** Picker order: Auto leads, then the tiers. Everything else follows. */
export const FLUX_TIERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "flux-auto", label: "Flux Auto" },
  { id: "flux-reasoning", label: "Flux Reasoning" },
  { id: "flux-standard", label: "Flux Standard" },
  { id: "flux-fast", label: "Flux Fast" },
];

/** Engines whose picker ids carry the provider. codex is the only one, and it
 *  is not a style choice: a bare id decodes to the ChatGPT provider, so
 *  `flux::flux-auto` is what makes finding D structurally impossible even if
 *  every other gate here failed. */
const PROVIDER_QUALIFIED: ReadonlySet<DriverKind> = new Set<DriverKind>(["codex"]);

export function fluxSurfaceFor(driverKind: DriverKind): FluxSurface | null {
  return FLUX_SURFACE[driverKind] ?? null;
}

/** The picker id this engine must carry for a given Flux model. */
export function fluxCatalogId(driverKind: DriverKind, model: string): string {
  return PROVIDER_QUALIFIED.has(driverKind) ? `${FLUX_PROVIDER_ID}${SEP}${model}` : model;
}

/** The bare Flux model behind a picker id, or null when the id is not ours.
 *  `ollama::flux-auto` is a local Ollama model that happens to be named
 *  flux-auto — not Flux Router — so only the `flux::` provider qualifies. */
export function fluxModelId(id: string | null | undefined): string | null {
  if (!id) return null;
  const sep = id.indexOf(SEP);
  if (sep === -1) return id.startsWith(FLUX_MODEL_PREFIX) ? id : null;
  if (id.slice(0, sep) !== FLUX_PROVIDER_ID) return null;
  const model = id.slice(sep + SEP.length);
  return model.startsWith(FLUX_MODEL_PREFIX) ? model : null;
}

export function isFluxModel(id: string | null | undefined): boolean {
  return fluxModelId(id) !== null;
}

/** True only when the id is a Flux id in the exact shape this engine routes.
 *  A bare `flux-auto` on codex is NOT routable — that is finding D itself. */
export function fluxIdIsRoutable(id: string | null | undefined, driverKind: DriverKind): boolean {
  const model = fluxModelId(id);
  return model !== null && id === fluxCatalogId(driverKind, model);
}

function routableEngine(driverKind: DriverKind, env: NodeJS.ProcessEnv): boolean {
  return fluxSurfaceFor(driverKind) !== null && fluxConfigured(env);
}

/**
 * Add the Flux rows to one engine's catalog, gated on that engine's surface
 * and on a configured key. Returns the catalog with every Flux row removed
 * when either is missing.
 *
 * Order out: Flux Auto, Reasoning, Standard, Fast — then the engine's own
 * rows in their existing order — then any `flux-pinned-*` rows.
 *
 * `driverKind` is required, which is what makes the gate unskippable at the
 * type level: there is no way to append Flux rows without naming the engine.
 * `env` is a fallback only — the authoritative key lives in config/process.env
 * (flux-config.ts), never in a driver's frozen catalog env, so callers pass
 * nothing and a key saved mid-session takes effect on the next refresh.
 */
export function mergeFluxCatalog(
  catalog: ModelCatalog,
  driverKind: DriverKind,
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalog {
  const routable = routableEngine(driverKind, env);
  const own: ModelCatalog["options"] = [];
  const pinned: ModelCatalog["options"] = [];
  for (const option of catalog.options) {
    const model = fluxModelId(option.id);
    if (model === null) {
      own.push({ ...option });
      continue;
    }
    // Not routable: every Flux row goes, including one an engine's own config
    // file happened to name. A tier row is dropped either way — it is rebuilt
    // below in the canonical id shape, label and position.
    if (!routable || FLUX_TIERS.some((tier) => tier.id === model)) continue;
    (model.startsWith(FLUX_PINNED_PREFIX) ? pinned : own).push({ ...option });
  }

  const rows = routable
    ? FLUX_TIERS.map((tier) => ({ id: fluxCatalogId(driverKind, tier.id), label: tier.label }))
    : [];
  const options = [...rows, ...own, ...pinned];

  let nextDefault = catalog.default;
  // a Flux default whose row just went away would select nothing
  if (isFluxModel(nextDefault) && !options.some((option) => option.id === nextDefault)) nextDefault = "";
  // an engine with no catalog of its own (qwen with no local host) would
  // otherwise have a default of "" while offering rows
  if (!nextDefault) nextDefault = options[0]?.id ?? "";
  return { default: nextDefault, options };
}

/**
 * Backstop for the catalog build. `registry.describe()` passes `models`
 * straight through and is the one choke point every catalog crosses on its way
 * to the UI, so a driver that forgets `mergeFluxCatalog` — or gains a Flux row
 * from a user's own config file — still cannot leak one.
 */
export function filterFluxRows(
  catalog: ModelCatalog,
  driverKind: DriverKind,
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalog {
  const routable = routableEngine(driverKind, env);
  const options = catalog.options.filter(
    (option) => !isFluxModel(option.id) || (routable && fluxIdIsRoutable(option.id, driverKind)),
  );
  if (options.length === catalog.options.length) return catalog;
  const kept = options.some((option) => option.id === catalog.default);
  return { default: kept ? catalog.default : (options[0]?.id ?? ""), options };
}

/**
 * Spawn-side enforcement. Returns the user-facing refusal, or null when the
 * selection is fine. A client filter cannot cover this: a selection can be
 * persisted while its engine is offline, cloned from another bot
 * (store.tsx clone), imported, or set over MCP, and none of those paths
 * revalidate against the catalog.
 */
export function fluxSelectionRefusal(
  model: string | null | undefined,
  driverKind: DriverKind,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isFluxModel(model)) return null;
  if (fluxSurfaceFor(driverKind) === null) {
    return "this bot's engine cannot route Flux Router — choose another model in settings";
  }
  if (!fluxConfigured(env)) {
    return "Flux Router has no API key — add one in App Settings, or choose another model";
  }
  if (!fluxIdIsRoutable(model, driverKind)) {
    return `"${model}" is not a Flux Router model this engine can route — re-pick the model in settings`;
  }
  return null;
}
