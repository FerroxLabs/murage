// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether a model can see a picture, when the connection's own catalog does
// not say. A provider catalog that declares image input (or not) always wins;
// this table fills only the gap, from the bundled models.dev snapshot
// (scripts/build-model-metadata.mjs writes it next to this file).
//
// 0.1.61 (backlog G11): a Flux catalog row for deepseek-v4-pro carried no
// image fact, so Murage sent the picture and the provider answered 400. Every
// listing of that model is text only, so the answer here is a plain "no".
// An id the listings disagree on, or one nobody lists, stays unknown.
import table from "./model-vision.json" with { type: "json" };

const VISION = new Set<string>(table.vision);
const TEXT_ONLY = new Set<string>(table.textOnly);

/** The table's key for an id as an engine or catalog spells it: lower case,
 * without a `provider::` qualifier, a vendor path or a Flux pinned route. */
export function modelVisionKey(id: string): string {
  const bare = id.toLowerCase().split("::").pop()!.split("/").pop()!;
  return bare.startsWith("flux-pinned-") ? bare.slice("flux-pinned-".length) : bare;
}

/** true or false when every listing of the model agrees; undefined otherwise. */
export function knownModelVision(id: string | null | undefined): boolean | undefined {
  if (!id) return undefined;
  const key = modelVisionKey(id);
  return VISION.has(key) ? true : TEXT_ONLY.has(key) ? false : undefined;
}

/** The vision fact a turn goes by. A catalog row that declares image input
 * (or its absence) wins. A row that is silent falls back to the table and,
 * failing that, to "no", as it always has: a BYOK connection that lists a
 * model without the fact is not evidence the model sees. With no catalog row
 * at all (an engine-managed model, which is every Flux turn through Fuigo)
 * the table is the only fact Murage has, and "don't know" stays undefined. */
export function turnModelVision(row: { capabilities: { vision?: boolean } } | undefined, modelId: string | null | undefined): boolean | undefined {
  if (row) return typeof row.capabilities.vision === "boolean" ? row.capabilities.vision : knownModelVision(modelId) ?? false;
  return knownModelVision(modelId);
}
