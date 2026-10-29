// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Matching a wanted model against the ids an ACP session advertised. Shared by
// the Cursor and Grok drivers: Cursor needs its argv slugs translated into the
// session's parameterised ids, and Grok needs a model its install does not
// offer yet mapped to the closest one it does.

/** One entry of a session's `models.availableModels`, as the agent sent it. */
export type AdvertisedModel = { modelId?: string; name?: string };

/** Translate an argv `--model` slug into the id this ACP session will accept.
 *
 * Cursor keeps two model namespaces and they do not match. `cursor-agent
 * models` and the `--model` flag speak flat slugs (`auto`, `gpt-5.3-codex`).
 * The ACP session advertises parameterised ids instead
 * (`default[]`, `gpt-5.3-codex[reasoning=medium,fast=false]`), and
 * `session/set_model` accepts *only* those. Sending the argv slug earns
 * `-32602 Invalid params` for every model, not merely unknown ones — which
 * read as "this account cannot use that model" and sent people to check their
 * subscription over a pure id-format mismatch.
 *
 * Matching walks from most to least specific, and `auto` is special-cased
 * because Cursor calls that entry `default[]` while naming it "Auto".
 *
 * Returns null when nothing matches, including when the agent advertised no
 * models at all. The caller then falls back to sending the slug unchanged,
 * which is what older CLIs that ignore the model list still expect.
 */
export function resolveAcpModelId(
  available: Array<{ modelId?: string; name?: string }>,
  wanted: string,
): string | null {
  const want = wanted.trim().toLowerCase();
  if (!want) return null;
  const ids = available.filter((m) => typeof m?.modelId === "string" && m.modelId);
  if (!ids.length) return null;
  const base = (id: string) => id.split("[")[0].trim().toLowerCase();

  const exact = ids.find((m) => m.modelId!.toLowerCase() === want);
  if (exact) return exact.modelId!;

  // A base can be advertised several times with different parameters, e.g.
  // `composer-2.5[fast=false]` and `composer-2.5[fast=true]`. The plain slug
  // means Standard, so prefer the non-fast variant; a `-fast` slug has no base
  // of its own and means the fast=true variant of the base without the suffix.
  const isFast = (id: string) => /[[,]\s*fast\s*=\s*true\s*[\],]/i.test(id);
  const sameBase = ids.filter((m) => base(m.modelId!) === want);
  const byBase = sameBase.find((m) => !isFast(m.modelId!)) ?? sameBase[0];
  if (byBase) return byBase.modelId!;

  if (want.endsWith("-fast")) {
    const stem = want.slice(0, -"-fast".length);
    const fast = ids.find((m) => base(m.modelId!) === stem && isFast(m.modelId!));
    if (fast) return fast.modelId!;
  }

  const byName = ids.find((m) => (m.name ?? "").trim().toLowerCase() === want);
  if (byName) return byName.modelId!;

  if (want === "auto" || want === "default") {
    const dflt = ids.find((m) => base(m.modelId!) === "default");
    if (dflt) return dflt.modelId!;
  }
  return null;
}

/** What a session should run for a wanted model:
 *  - "wanted": the model itself (an exact or resolveAcpModelId match);
 *  - "substitute": the wanted model is not offered, so the closest advertised model of the same family (newest
 *    first), else the session's current model. `modelId` null means the session's current model is not known by
 *    name and the session stays on it;
 *  - "none": the session advertised nothing at all, neither a list nor a current model. */
export type AdvertisedModelPick =
  | { kind: "wanted"; modelId: string }
  | { kind: "substitute"; modelId: string | null }
  | { kind: "none" };

interface FamilyId { prefix: string; version: number[]; rest: string }

/** `grok-4.7` is family "grok", version [4, 7]; `grok-4.7-fast` keeps "-fast" as its variant. Parameters (`[..]`) are ignored. */
function familyOf(id: string): FamilyId | null {
  const m = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d+(?:\.\d+)*)(.*)$/.exec(id.split("[")[0]!.trim().toLowerCase());
  return m ? { prefix: m[1]!, version: m[2]!.split(".").map(Number), rest: m[3]! } : null;
}

function newerFirst(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function pickAdvertisedModel(available: AdvertisedModel[], wanted: string, currentModelId?: string): AdvertisedModelPick {
  const ids = available.filter((m): m is { modelId: string; name?: string } => typeof m?.modelId === "string" && m.modelId.trim() !== "");
  const current = typeof currentModelId === "string" && currentModelId.trim() ? currentModelId : null;
  const direct = resolveAcpModelId(ids, wanted);
  if (direct) return { kind: "wanted", modelId: direct };
  if (current && current.toLowerCase() === wanted.trim().toLowerCase()) return { kind: "wanted", modelId: current };
  if (!ids.length && !current) return { kind: "none" };
  const want = familyOf(wanted);
  if (want) {
    const family = ids
      .map((m) => ({ id: m.modelId, family: familyOf(m.modelId) }))
      .filter((m): m is { id: string; family: FamilyId } => m.family?.prefix === want.prefix)
      .sort((a, b) => Number(b.family.rest === want.rest) - Number(a.family.rest === want.rest) || newerFirst(a.family.version, b.family.version));
    if (family[0]) return { kind: "substitute", modelId: family[0].id };
  }
  return { kind: "substitute", modelId: current };
}

/** A slug as people read it: `grok-4.6-fast` is "Grok 4.6 Fast". */
export function modelLabel(id: string): string {
  return id.split("[")[0]!.trim().split(/[-_\s]+/).filter(Boolean).map((w) => (/^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}
