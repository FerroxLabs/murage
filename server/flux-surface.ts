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
import { FLUX_SURFACE, type FluxSurfaceKind, fluxMechanismFor } from "./flux-routing.ts";
import { openCodeFluxRouted } from "./opencode-config.ts";

/** Which Flux wire surface an engine speaks.
 *
 *  There used to be a SECOND copy of this table in flux-routing.ts, kept in
 *  sync by hand. Two tables that must agree are one table with a bug in it, so
 *  this now re-exports the one in flux-routing.ts, which also owns the two
 *  axes this file used to conflate with it:
 *
 *    FLUX_CAPABILITY  env | setup | vendor  — what the USER must do first
 *    FLUX_MECHANISM   env | scopedHome | configWrite  — how the child is aimed
 *
 *  Presence in `FLUX_SURFACE` is still the "we know the wire protocol" flag,
 *  but it is no longer sufficient for routing: a `configWrite` engine is not
 *  routable until its connector has actually written the file — see
 *  `routableEngine`. That is the whole reason an engine like opencode, which
 *  needs a FILE rather than a VARIABLE, can now be in the table at all.
 *
 *  Corrections to what the old comment here asserted: `opencode` is NOT
 *  vendor-locked (it is setup-class, and Wayland ships a working connector for
 *  it), and `qoder` does not "route through its own login" — nothing in
 *  Wayland says that; qoder was simply never attempted. Details and citations
 *  in flux-routing.ts, next to the table. */
export type FluxSurface = FluxSurfaceKind;

export { FLUX_SURFACE };
export type { FluxCapability, FluxMechanism } from "./flux-routing.ts";
export { FLUX_CAPABILITY, FLUX_MECHANISM, fluxCapabilityFor, fluxMechanismFor } from "./flux-routing.ts";

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

/**
 * Has the deliberate, user-initiated config write for this engine actually
 * happened, and is the block still ours?
 *
 * Only `configWrite` engines reach here. `openCodeFluxStatus` re-derives the
 * answer from disk every time rather than caching, because the failure mode
 * that matters is the user editing the file behind us: a cached "routed" would
 * keep offering rows for a provider block that is no longer there.
 *
 * Fails closed on `absent`, `unconfigured` and `drifted` alike. Offering a
 * Flux row that the CLI cannot resolve is exactly Kimi finding D in a new
 * costume — the id would reach opencode, fail to match any provider, and burn
 * the turn.
 */
function connectorRouted(driverKind: DriverKind, env: NodeJS.ProcessEnv): boolean {
  if (driverKind === "opencodeGo") return openCodeFluxRouted(env as Record<string, string | undefined>);
  // A configWrite engine with no connector implemented is not routable, and
  // saying so here is what keeps the table from over-promising.
  return false;
}

function routableEngine(driverKind: DriverKind, env: NodeJS.ProcessEnv): boolean {
  if (fluxSurfaceFor(driverKind) === null || !fluxConfigured(env)) return false;
  if (fluxMechanismFor(driverKind) !== "configWrite") return true;
  return connectorRouted(driverKind, env);
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
  options: { custom?: boolean } = {},
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

  // `custom: true` is not cosmetic on a custom-access engine (hermes, qwen).
  // ModelPicker pins such an engine to its Custom pane (ModelPicker.tsx:166)
  // and offers no way back (`canReturnToOfficial`, :208), and that pane lists
  // only options carrying this flag — so a Flux row without it is present in
  // the API response and invisible in the UI. Same trap hermes.ts:240-244
  // documents for its own config row.
  const rows = routable
    ? FLUX_TIERS.map((tier) => ({
        id: fluxCatalogId(driverKind, tier.id),
        label: tier.label,
        ...(options.custom ? { custom: true } : {}),
      }))
    : [];
  const merged = [...rows, ...own, ...pinned];

  let nextDefault = catalog.default;
  // a Flux default whose row just went away would select nothing
  if (isFluxModel(nextDefault) && !merged.some((option) => option.id === nextDefault)) nextDefault = "";
  // an engine with no catalog of its own (qwen with no local host) would
  // otherwise have a default of "" while offering rows
  if (!nextDefault) nextDefault = merged[0]?.id ?? "";
  return { default: nextDefault, options: merged };
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
  // A setup-class engine is routable in principle and unrouted in fact. The
  // distinction is worth its own sentence: "cannot route" would be a lie the
  // user acts on by changing engines, when the fix is one deliberate write.
  if (fluxMechanismFor(driverKind) === "configWrite" && !connectorRouted(driverKind, env)) {
    return "Flux Router is not set up for this engine yet — run Flux setup for it (that writes a \"flux\" provider into the CLI's own config), or choose another model";
  }
  if (!fluxIdIsRoutable(model, driverKind)) {
    return `"${model}" is not a Flux Router model this engine can route — re-pick the model in settings`;
  }
  return null;
}
