// SPDX-License-Identifier: AGPL-3.0-or-later
// Which Flux models the workspace key may call. A key on the Flux free plan (never paid) may call flux-fast and flux-auto only; any
// flux-pinned-* id answers 403 "key not allowed to access model" (the Flux router's model access refusal handler, FREE_KEY_MODELS). Murage
// asks for a pinned id in two places: memory learning (memory/extractor-connections.ts) and the browser action checker
// (browser-action-checker-connection.ts). Both ask here first. Memory sends the pin only on "yes", so a free key never sends it; the
// checker moves to the bot's own engine on "no" or a missing catalog when one can check (with no engine, it keeps its pinned ids
// and a refusal is remembered). A paid key with a catalog listing the pins keeps them.
import { createHash } from "node:crypto";

/** What a free-plan key may call (mirrors flux-router FREE_KEY_MODELS). */
export const FLUX_FREE_PLAN_MODELS: readonly string[] = Object.freeze(["flux-auto", "flux-fast"]);
/** How long a key Flux refused a model for is not asked for that model again. A key that pays meanwhile gets it back after this. */
export const FLUX_MODEL_REFUSAL_MS = 6 * 60 * 60_000;

/** The model ids the key's own Flux catalog lists, or null when no catalog for this key has been fetched. Flux's /v1/models lists
 *  a key's allowlist, so a free key's catalog holds flux-fast and flux-auto and no flux-pinned-* id. Wired in index.ts. */
type CatalogReader = (key: string) => readonly string[] | null;
let readCatalog: CatalogReader = () => null;
export function setFluxKeyCatalog(reader: CatalogReader | null): void { readCatalog = reader ?? (() => null); }

const REFUSAL_MEMORY = 256;
const refused = new Map<string, number>();
let clock = () => Date.now();
const fingerprint = (key: string, model: string) => createHash("sha256").update(key).update("\0").update(model).digest("hex");
export function resetFluxKeyModelsForTests(now: (() => number) | null = null): void { refused.clear(); readCatalog = () => null; clock = now ?? (() => Date.now()); }

/** Flux refused this key the model (a 403 model refusal). Kept per key and model, never the key itself. */
export function noteFluxModelRefused(key: string, model: string): void {
  const id = fingerprint(key, model);
  refused.delete(id);
  if (refused.size >= REFUSAL_MEMORY) refused.delete(refused.keys().next().value!);
  refused.set(id, clock() + FLUX_MODEL_REFUSAL_MS);
}

/** "yes": the key's catalog lists the model and Flux has not refused it lately. "no": a fetched catalog leaves it out, or Flux
 *  refused it lately. "unknown": no catalog yet. Free-plan models are always "yes". */
export function fluxKeyMayCall(key: string, model: string): "yes" | "no" | "unknown" {
  if (FLUX_FREE_PLAN_MODELS.includes(model)) return "yes";
  const until = refused.get(fingerprint(key, model));
  if (until !== undefined && until > clock()) return "no";
  let ids: readonly string[] | null;
  try { ids = readCatalog(key); } catch { ids = null; }
  if (!ids || ids.length === 0) return "unknown";
  return ids.includes(model) ? "yes" : "no";
}
