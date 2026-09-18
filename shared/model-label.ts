// One rule for turning a model id into something a person can read.
//
// WHY. Sean's screenshot (2026-09-18) showed the SAME model twice in the
// picker: once as "Flux Auto" and once as the literal string `flux-auto`.
// server/flux-routing.ts:227 has carried `{ id: "flux-auto", label: "Flux
// Auto" }` since Flux shipped, and server/flux-surface.ts rebuilds the engine
// catalog's tier rows from it — but the Flux Router PROVIDER CONNECTION takes a
// different path. Its catalog comes from `GET /v1/models`, which returns rows
// with no `name` and no `display_name`, and
// server/provider-connections.ts:normalizeProviderModels ends its label
// fallback chain at `row.id`. So the connection's copy of every Flux row
// reached the UI wearing its raw id.
//
// The fix is a single ordered rule rather than another special case, because
// the same gap exists for every provider whose catalog omits names — the same
// `label: … : row.id` fallback serves all eight presets.
//
// Order, most authoritative first:
//   1. the provider's own label (`name` / `display_name` from its catalog)
//   2. the Flux tier table, for Murage's own routing aliases
//   3. the bundled models.dev name (renderer only — see src/lib/model-metadata.ts)
//   4. a title-cased id
//
// A candidate that is only the id in disguise does not count as a label, which
// is what lets step 1 fail open into the rest of the chain instead of pinning
// the raw id at the top.
//
// This file deliberately holds no imports. server/flux-routing.ts owns
// FLUX_MODELS and the server may import from shared/, never the reverse, so
// the tier table is mirrored here and shared/model-label.test.ts asserts the
// two agree — a drift is a failing test, not a wrong label.

/** Murage's own routing aliases, id → label. Mirrors FLUX_MODELS in
 *  server/flux-routing.ts; the test in this directory pins them together. */
export const FLUX_TIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "flux-auto": "Flux Auto",
  "flux-reasoning": "Flux Reasoning",
  "flux-standard": "Flux Standard",
  "flux-fast": "Flux Fast",
});

/** codex encodes a Flux pick as `flux::flux-auto` (server/flux-routing.ts),
 *  and local engines encode a host as `llamacpp::model`. Both are separators
 *  between a route and a model id, never part of the name. */
const QUALIFIER = "::";

/** The bare model id behind any qualifier an engine wrapped it in. */
export function bareModelId(id: string): string {
  const qualified = id.lastIndexOf(QUALIFIER);
  const withoutQualifier = qualified >= 0 ? id.slice(qualified + QUALIFIER.length) : id;
  const slash = withoutQualifier.lastIndexOf("/");
  return slash >= 0 ? withoutQualifier.slice(slash + 1) : withoutQualifier;
}

/** "flux-pinned-deepseek-flash-max" → "Flux Pinned Deepseek Flash Max".
 *
 *  A word that is already mixed- or upper-case is left alone: "MiniMax-M3"
 *  must not become "Minimax M3". Only an all-lowercase word is capitalised,
 *  and a word starting with a digit is untouched, so "3.3" stays "3.3". */
export function titleCaseModelId(id: string): string {
  return bareModelId(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^[a-z]/.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Is this "label" just the id wearing a hat? A catalog that omits names hands
 *  back the id verbatim; a previous pass through this very chain may have
 *  handed back the title-cased id. Neither is a name anybody chose, so neither
 *  may block a better candidate later in the chain.
 *
 *  The comparison is case-SENSITIVE, and that is the whole point of it:
 *  "GPT-4o" differs from the id `gpt-4o` only in case, and it is precisely the
 *  name a provider went to the trouble of writing. Folding case here would
 *  have thrown away every correctly-capitalised name in every catalog. */
export function isDerivedLabel(id: string, label: string | null | undefined): boolean {
  if (typeof label !== "string") return true;
  const trimmed = label.trim();
  if (!trimmed) return true;
  return trimmed === id || trimmed === bareModelId(id) || trimmed === titleCaseModelId(id);
}

/** The Flux tier label for a routing alias, or "" for anything else.
 *
 *  Exact ids only. `flux-pinned-*` is deliberately NOT handled here: a pinned
 *  route names a concrete model and belongs to the title-case rule, which is
 *  what produces Sean's "Flux Pinned Deepseek Flash Max". */
export function fluxTierLabel(id: string): string {
  return FLUX_TIER_LABELS[bareModelId(id)] ?? "";
}

/** The display name for one model id. `catalogLabel` is whatever the provider
 *  supplied, `metadataName` the bundled models.dev name when the caller has
 *  one (the renderer does; the server does not bundle the snapshot). */
export function resolveModelLabel(
  id: string,
  { catalogLabel, metadataName }: { catalogLabel?: string | null; metadataName?: string | null } = {},
): string {
  if (!isDerivedLabel(id, catalogLabel)) return catalogLabel!.trim();
  const tier = fluxTierLabel(id);
  if (tier) return tier;
  if (!isDerivedLabel(id, metadataName)) return metadataName!.trim();
  return titleCaseModelId(id) || id;
}
