// The bundled models.dev snapshot, and the rule for deciding which row it is
// allowed to describe.
//
// WHY. `priceBand()` has always been able to turn `pricing.outputPerMillion`
// into "$"/"$$"/"$$$"; the number was what never arrived. Only the openrouter
// preset's live catalog carries prices (server/provider-connections.ts:68), so
// every engine row — Claude Opus 5 on the Claude engine, every Codex and
// Gemini row — reached the picker with no pricing and rendered "Price
// unavailable". The same is true of vision/tools/reasoning and the context
// window, which an engine driver states only when it happens to know them.
//
// The snapshot is bundled, never fetched (Sean, 2026-09-18): Vite inlines this
// import into the renderer bundle, `dist` already ships as the packaged `ui`
// resource, and so there is no runtime read and nothing to add to
// electron-builder.yml. See scripts/build-model-metadata.mjs.
//
// THE MATCHING RULE, and why it is this conservative: a wrong price is worse
// than no price. A row is described only when the id resolves to exactly one
// answer.
//
//   1. EXACT      the id is a key in the snapshot, verbatim (case-insensitive).
//   2. NORMALISED the id with an engine qualifier (`flux::`, `llamacpp::`), a
//                 known vendor path segment (`openai/`), or the
//                 `flux-pinned-` route prefix removed; then, failing that,
//                 with one trailing reasoning-effort suffix removed
//                 (`-high`, `-low`, `-medium`, `-minimal`, `-thinking`) — an
//                 effort setting changes the tokens spent, never the per-token
//                 price, which is why models.dev lists one entry for all of
//                 them.
//   3. REFUSE     anything else. No prefix, substring or fuzzy matching.
//
// Flux ids are handled by `fluxModelId`, the routing code's own parser, and
// only ONE shape survives: `flux-pinned-<model>`, which names a concrete model
// and is matched on the remainder (`flux-pinned-claude-opus-5` →
// `claude-opus-5` → anthropic → $25/M → `$$$$`). Everything else Flux serves is
// refused outright — the four picker tiers are routes (see FLUX_TIER_BANDS),
// and `flux-voice` and `flux-image` are not chat models at all and must never
// be force-matched onto something that is.
//
// Every form above is then subject to the same ambiguity gate. One id can
// exist under several providers (`openai/gpt-oss-20b` is $0.30/M at groq and
// $0.13/M at openrouter). In order:
//   a. a `hint` — the connection preset, or the upstream provider the engine
//      reported — wins outright. Every connection row has one.
//   b. otherwise the candidates must AGREE on price and context window.
//   c. otherwise the VENDOR's own published rate wins (VENDOR_PROVIDERS): when
//      forty resellers quote `claude-opus-5` differently, Anthropic's number is
//      the canonical one, not an average and not a coin flip.
//   d. otherwise the lookup refuses, and the row reads as unknown.
//
// Measured on the shipped snapshot: of 3,572 distinct ids, 1,033 appear under
// more than one provider; 278 agree, 217 are settled by the vendor rule, and
// 538 are refused — almost all of them sold only by gateways Murage has no
// route to (302ai, nano-gpt, qiniu-ai, jiekou), at genuinely different prices.
//
// FAILURE MODE, stated plainly: this cannot detect a provider that serves
// something different under a well-known id — a quantised, re-hosted or
// discounted copy of `llama-3.3-70b-versatile`, say. If models.dev lists only
// the upstream entry there is nothing to disagree with, and the row will show
// the upstream band. That is why `pricing.source` is set to the snapshot's own
// URL rather than the provider's: the origin is visible in the row's tooltip,
// and a live provider catalog is never overwritten (fillModelMetadata only
// fills what is absent).
// `with { type: "json" }` is required, not decorative: server/provider-picker.test.ts
// imports provider-model-picker.ts, which pulls this module into the NodeNext
// program compiled by tsconfig.server.json, and NodeNext rejects a bare JSON
// import (TS1543). Vite, esbuild and Node all honour the attribute.
// An ambient `declare module` cannot be pulled in by an ESM import, and a
// triple-slash reference is the only way to make tsconfig.server.json resolve
// the `?raw` specifier below: it compiles with `types: ["node"]`, so it has no
// `vite/client`, and it DOES see this file — transitively, via
// server/provider-picker.test.ts. Remove the reference and `tsc -p
// tsconfig.server.json` fails.
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="./raw-modules.d.ts" />
// `?raw`, not a JSON import: this hands the module a 1.6 MB STRING LITERAL,
// which module evaluation pays nothing for, instead of a 7,842-entry object
// graph that V8 must construct on every cold start of the app. The parse
// happens on first use, inside loadModelMetadata() below.
import snapshotText from "../data/model-metadata.json?raw";
// The routing helpers, not a second copy of their prefix parsing: these are
// load-bearing for the spawn-side guards (server/flux-routing.ts:248-274) and
// two implementations that disagree would send a turn to the wrong host. The
// module's only other import is a `type`, so nothing server-side follows it
// into the renderer bundle.
import { fluxModelId, isFluxPickerModel } from "../../server/flux-routing.ts";
import { resolveModelLabel } from "../../shared/model-label.ts";
import type { ProviderModel } from "../../shared/provider-connections.ts";

export interface ModelMetadata {
  name: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  contextWindow?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}
export interface ModelMetadataMatch {
  metadata: ModelMetadata;
  provider: string;
  modelId: string;
  /** How it was found. Reported so a test — and a future audit — can tell an
   *  exact hit from a normalised one without re-deriving the rule. */
  tier: "exact" | "normalised";
}

interface Snapshot {
  format: string;
  version: number;
  source: { url: string; repository: string; license: string; fetchedAt: string; etag?: string };
  digest: string;
  providers: Record<string, { name: string; models: Record<string, ModelMetadata> }>;
}
/** Where the numbers came from, shown verbatim in the picker row's tooltip.
 *  A genuine constant — it is the URL the build script fetches — so it stays a
 *  plain export and costs nothing at load. A test pins it to the snapshot's
 *  own `source.url` so the two cannot drift. */
export const MODEL_METADATA_SOURCE = "https://models.dev/api.json";

/** What the module falls back to if the snapshot cannot be parsed at all. An
 *  empty catalog, not a throw: see loadModelMetadata below. `fetchedAt: ""`
 *  makes `modelMetadataUpdatedAt()` NaN, which `priceBandNote` already renders
 *  as its undated form. */
const EMPTY: Snapshot = {
  format: "murage.model-metadata",
  version: 1,
  source: { url: MODEL_METADATA_SOURCE, repository: "", license: "MIT", fetchedAt: "" },
  digest: "",
  providers: {},
};

/** Providers that are a model's ORIGINATING vendor rather than a reseller.
 *  Consulted only when candidates disagree and there is no hint: the vendor
 *  publishes the rate everyone else marks up or discounts, so it is the one
 *  defensible answer. Ordered; the first present wins. A gateway
 *  (openrouter, vercel, kilo, nano-gpt, …) is deliberately absent — it is a
 *  price for ITS route, correct only when the row came from a connection to
 *  it, which is the (a) hint case. */
export const VENDOR_PROVIDERS: readonly string[] = [
  "anthropic", "openai", "google", "google-vertex", "xai", "deepseek", "mistral",
  "meta", "llama", "alibaba", "minimax", "moonshotai", "zai", "cohere", "ai21",
  "inception", "upstage", "perplexity",
];

/** Murage's connection presets → the models.dev provider that sells them.
 *  `flux` is absent on purpose: fluxrouter.ai resells several vendors, so a
 *  Flux connection is exactly the case with no trustworthy hint. */
export const PRESET_PROVIDER_HINTS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  deepseek: "deepseek",
  mistral: "mistral",
  groq: "groq",
  xai: "xai",
});

/** The one Flux id shape that names a concrete model. Documented at
 *  server/flux-routing.ts:259 alongside `flux-voice` and `flux-image`. */
const FLUX_PINNED_PREFIX = "flux-pinned-";

/** The band each fixed Flux tier sits in.
 *
 *  READ THIS BEFORE TRUSTING IT. Unlike every other number in this file, these
 *  four are NOT derived from a published rate. `GET https://api.fluxrouter.ai/v1/models`
 *  returns rows shaped `{ id, capability: "chat" }` — no cost, no candidate
 *  model list, no tier composition (verified 2026-09-18 against
 *  server/provider-connections.ts:normalizeProviderModels and its fixtures).
 *  fluxrouter.ai is not in models.dev either. So there is nothing in this
 *  repository, or reachable from it, that knows what a Flux tier costs.
 *
 *  These are Sean's own statement of his own product's positioning
 *  (2026-09-18: "Flux Fast - $ / Flux Standard - $$ / Flux Reasoning - $$$").
 *  That is a legitimate source for a product's own bands — he sets the prices
 *  — but it is a different KIND of claim from the rest, so it is labelled
 *  here rather than blended in, and `pricing` is still never fabricated for
 *  these ids: no figure appears in the tooltip, because we have no figure.
 *
 *  DELETE THIS TABLE the moment the Flux catalog carries `cost`. The ask filed
 *  with the Flux side is: per-id `cost: {input, output}` for the three fixed
 *  tiers, and for `flux-auto` either a `cost_range: {output_min, output_max}`
 *  or the candidate model ids it dispatches across. */
export const FLUX_TIER_BANDS: Readonly<Record<string, string>> = Object.freeze({
  "flux-fast": "$",
  "flux-standard": "$$",
  "flux-reasoning": "$$$",
});
/** What a routing alias's price cell says.
 *
 *  `flux-auto` dispatches across the three fixed tiers — Sean: "it can be
 *  anywhere from cheap to reasoning. That's the whole point." — so it reads as
 *  the span of those tiers rather than a single band, which would be a
 *  fabrication, or "Price unavailable", which would be a different untruth. */
export const FLUX_AUTO_PRICE_LABEL = `${FLUX_TIER_BANDS["flux-fast"]}–${FLUX_TIER_BANDS["flux-reasoning"]}`;
/** The fallback for a routing alias with no band of its own. */
export const ROUTING_ALIAS_PRICE_LABEL = "Price varies by route";

/** The price cell for one of Murage's Flux routes, or "" when the id is not
 *  one. Kept here, beside the table it reads, so the picker holds no copy. */
export function fluxRoutePriceLabel(id: string): string {
  if (!isRoutingAlias(id)) return "";
  const bare = (id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id).toLowerCase();
  if (bare === "flux-auto") return FLUX_AUTO_PRICE_LABEL;
  return FLUX_TIER_BANDS[bare] ?? ROUTING_ALIAS_PRICE_LABEL;
}
const EFFORT_SUFFIX = /-(?:high|low|medium|minimal|thinking)$/;

function buildModelIndex(data: Snapshot): Map<string, ModelMetadataMatch[]> {
  const byId = new Map<string, ModelMetadataMatch[]>();
  for (const [provider, entry] of Object.entries(data.providers)) {
    for (const [modelId, metadata] of Object.entries(entry.models)) {
      const key = modelId.toLowerCase();
      const bucket = byId.get(key);
      const row: ModelMetadataMatch = { metadata, provider, modelId, tier: "exact" };
      if (bucket) bucket.push(row);
      else byId.set(key, [row]);
    }
  }
  return byId;
}

interface LoadedMetadata { data: Snapshot; index: Map<string, ModelMetadataMatch[]> }
let loaded: LoadedMetadata | null = null;
let loads = 0;

/** How many times the snapshot has actually been parsed. Exported for the test
 *  that pins the memo: neither "it was not parsed at import" nor "it was not
 *  reparsed on the five-hundredth lookup" is observable from lookup results,
 *  and a memo nothing can catch losing is not a memo. */
export function modelMetadataLoads(): number {
  return loads;
}

/** The parsed snapshot and its id index, built ONCE per session, on first use.
 *
 *  Synchronous on purpose. `pickerModels` runs inside a `useMemo` during
 *  render, so an async load would give first paint no capabilities and no
 *  pricing — every row would draw "Price unavailable", which is not merely
 *  empty but FALSE, and would then flip to a real band a frame later. That
 *  would need a third "not loaded yet" state distinct from both a band and the
 *  honest unknown, and would render the dated note undated under the reader.
 *  A memoized synchronous getter avoids all of it: no consumer changes, no
 *  render-time async, and the work lands on the first picker open — a click,
 *  where it is imperceptible — instead of on every launch.
 *
 *  There is no in-flight window and therefore no concurrency case to test:
 *  the build cannot yield, so a second caller can only arrive after `loaded`
 *  is already assigned. That is strictly stronger than a shared promise, which
 *  does have a window between the check and the assignment.
 *
 *  A failure is memoized as an EMPTY catalog rather than retried or rethrown.
 *  Retrying would repeat the cost on every picker open forever; throwing would
 *  take the picker down over a price column. Empty degrades to exactly the
 *  state this lane already renders honestly — every row keeps its label and
 *  reads "Price unavailable", which `isPriceUnknown` draws as an absence and
 *  never as `$`.
 *
 *  `parse` is a seam for the failure test only; production always uses the
 *  default. */
export function loadModelMetadata(parse: (text: string) => Snapshot = (text) => JSON.parse(text) as Snapshot): LoadedMetadata {
  if (loaded) return loaded;
  loads += 1;
  try {
    const data = parse(snapshotText);
    loaded = { data, index: buildModelIndex(data) };
  } catch {
    loaded = { data: EMPTY, index: new Map() };
  }
  return loaded;
}

/** The day the committed snapshot was taken. Prices move; this is the honest
 *  `updatedAt` for everything derived from it, and the tooltip renders it.
 *  A function rather than a const because the snapshot is parsed lazily. */
export function modelMetadataUpdatedAt(): number {
  return Date.parse(`${loadModelMetadata().data.source.fetchedAt}T00:00:00Z`);
}

/** Every id form worth trying, strongest first — or null when the id is one
 *  this rule refuses to look up at all. */
function candidates(id: string): string[] | null {
  const lower = id.toLowerCase();
  // A Flux id goes through the routing code's own parser. Only a pinned route
  // names a model; a tier is a route, and flux-voice / flux-image are not chat
  // models, so both are refused rather than normalised into something else.
  const flux = fluxModelId(id);
  if (flux !== null) {
    if (!flux.startsWith(FLUX_PINNED_PREFIX)) return null;
    const pinned = flux.slice(FLUX_PINNED_PREFIX.length).toLowerCase();
    return pinned ? [pinned, ...(EFFORT_SUFFIX.test(pinned) ? [pinned.replace(EFFORT_SUFFIX, "")] : [])] : null;
  }
  const forms = [lower];
  let normalised = lower;
  const qualified = normalised.lastIndexOf("::");
  if (qualified >= 0) normalised = normalised.slice(qualified + 2);
  const slash = normalised.indexOf("/");
  // Only a segment that names a provider the snapshot knows is a vendor path;
  // `meta-llama/llama-3.3-70b-instruct` keeps its prefix because openrouter
  // lists it that way, and stripping it would find nothing.
  if (slash > 0 && Object.hasOwn(loadModelMetadata().data.providers, normalised.slice(0, slash))) normalised = normalised.slice(slash + 1);
  if (normalised !== lower) forms.push(normalised);
  if (EFFORT_SUFFIX.test(normalised)) forms.push(normalised.replace(EFFORT_SUFFIX, ""));
  return forms;
}

function agree(rows: readonly ModelMetadataMatch[]): ModelMetadataMatch | null {
  const first = rows[0]!;
  return rows.every(
    (row) =>
      row.metadata.inputPerMillion === first.metadata.inputPerMillion &&
      row.metadata.outputPerMillion === first.metadata.outputPerMillion &&
      row.metadata.contextWindow === first.metadata.contextWindow,
  )
    ? first
    : null;
}

/** Is this id one of Murage's own four Flux routes rather than a model?
 *  Delegates to the routing code's own predicate so the two cannot disagree. */
export function isRoutingAlias(id: string): boolean {
  return isFluxPickerModel(id);
}

/** The snapshot's entry for one model id, or null when it cannot be resolved
 *  to exactly one answer. `hint` is a models.dev provider id. */
export function lookupModelMetadata(id: string, hint?: string | null): ModelMetadataMatch | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const forms = candidates(id);
  if (!forms) return null;
  for (let position = 0; position < forms.length; position += 1) {
    const rows = loadModelMetadata().index.get(forms[position]!);
    if (!rows?.length) continue;
    // A pinned Flux route is never an "exact" hit: the id in the catalog is
    // not the id in the snapshot.
    const tier = position === 0 && forms[position] === id.toLowerCase() ? "exact" : "normalised";
    if (hint) {
      const hinted = rows.find((row) => row.provider === hint);
      if (hinted) return { ...hinted, tier };
    }
    const agreed = agree(rows);
    if (agreed) return { ...agreed, tier };
    const vendor = VENDOR_PROVIDERS.find((provider) => rows.some((row) => row.provider === provider));
    const canonical = vendor ? rows.find((row) => row.provider === vendor) : undefined;
    // An ambiguous hit STOPS the search. Falling through to a looser form
    // after finding the id itself under forty different prices would be
    // guessing with extra steps.
    return canonical ? { ...canonical, tier } : null;
  }
  return null;
}

/** The models.dev provider hint for a picker row, if any is trustworthy. */
export function providerHint(preset?: string | null, reported?: string | null): string | undefined {
  if (reported && Object.hasOwn(loadModelMetadata().data.providers, reported)) return reported;
  return preset ? PRESET_PROVIDER_HINTS[preset] : undefined;
}

export interface FillableModelRow {
  label: string;
  contextWindow?: number;
  pricing?: ProviderModel["pricing"];
  capabilities?: { vision?: boolean; tools?: boolean; reasoning?: boolean };
}

/** Fill what is missing on one row, and ONLY what is missing.
 *
 *  A live provider catalog is authoritative: if openrouter said this model
 *  costs $3/M, the snapshot does not get to disagree, even when it is newer.
 *  The snapshot is a fallback for rows that arrived with nothing, which is
 *  every engine row in the app. */
export function fillModelMetadata<T extends FillableModelRow>(
  row: T,
  id: string,
  hint?: string | null,
): T & FillableModelRow {
  const match = lookupModelMetadata(id, hint);
  if (!match) return row;
  const { metadata } = match;
  const pricing =
    row.pricing ??
    (metadata.inputPerMillion === undefined && metadata.outputPerMillion === undefined
      ? undefined
      : {
          ...(metadata.inputPerMillion === undefined ? {} : { inputPerMillion: metadata.inputPerMillion }),
          ...(metadata.outputPerMillion === undefined ? {} : { outputPerMillion: metadata.outputPerMillion }),
          source: MODEL_METADATA_SOURCE,
          updatedAt: modelMetadataUpdatedAt(),
        });
  const capabilities = {
    vision: row.capabilities?.vision ?? metadata.vision,
    tools: row.capabilities?.tools ?? metadata.tools,
    reasoning: row.capabilities?.reasoning ?? metadata.reasoning,
  };
  return {
    ...row,
    label: resolveModelLabel(id, { catalogLabel: row.label, metadataName: metadata.name }),
    ...(row.contextWindow === undefined && metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
    ...(pricing === undefined ? {} : { pricing }),
    ...(capabilities.vision === undefined && capabilities.tools === undefined && capabilities.reasoning === undefined
      ? {}
      : {
          capabilities: {
            ...(capabilities.vision === undefined ? {} : { vision: capabilities.vision }),
            ...(capabilities.tools === undefined ? {} : { tools: capabilities.tools }),
            ...(capabilities.reasoning === undefined ? {} : { reasoning: capabilities.reasoning }),
          },
        }),
  };
}
