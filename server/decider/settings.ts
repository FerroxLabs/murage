// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The decision model's settings: the config.ts `decider` block, read with
// With nothing saved the decision model follows the credential: ON when this
// workspace has a Flux key (or its own key), OFF otherwise. A switch the owner
// saved, either way, always wins. Nothing here holds the Flux key; it is
// resolved at call time from flux-config.ts. `byoKey` is an advanced override
// and write-only.
import type { DeciderJob } from "./types.ts";

export interface DecisionModelSettings {
  enabled: boolean;
  provider: "flux";
  jobs: Record<DeciderJob, boolean>;
  byoKey?: string;
  baseUrl?: string;
}

export const DEFAULT_DECIDER_SETTINGS: DecisionModelSettings = Object.freeze({
  enabled: false,
  provider: "flux",
  jobs: Object.freeze({ roomRouting: false }) as Record<DeciderJob, boolean>,
}) as DecisionModelSettings;

type Stored = { enabled?: unknown; provider?: unknown; jobs?: { roomRouting?: unknown } | null; byoKey?: unknown; baseUrl?: unknown } | null | undefined;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

/** Merge a stored `decider` block over the defaults. An explicit `true` or
 * `false` is the owner's and wins; anything else follows `defaultOn` (a Flux
 * key or an own key is present). An unknown provider reads as off. Never throws. */
export function readDecisionModelSettings(stored: Stored, context: { defaultOn?: boolean } = {}): DecisionModelSettings {
  const block = stored && typeof stored === "object" ? stored : {};
  const byoKey = text(block.byoKey);
  const baseUrl = text(block.baseUrl);
  const defaultOn = context.defaultOn === true;
  const explicitEnabled = typeof block.enabled === "boolean";
  const explicitRouting = typeof block.jobs?.roomRouting === "boolean";
  const providerOk = block.provider === undefined || block.provider === "flux";
  const enabled = providerOk && (explicitEnabled ? block.enabled === true : defaultOn);
  const roomRouting = explicitRouting ? block.jobs?.roomRouting === true : defaultOn;
  return {
    enabled,
    provider: "flux",
    jobs: { roomRouting },
    ...(byoKey ? { byoKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** What GET /api/config may show: switches and presence flags, never a key. */
export function describeDecisionModelSettings(settings: DecisionModelSettings, availability: { available?: boolean } = {}) {
  return {
    /** False while this key's plan cannot use the decision model (Auto is hidden). */
    available: availability.available !== false,
    enabled: settings.enabled,
    provider: settings.provider,
    jobs: { ...settings.jobs },
    byoKeyConfigured: Boolean(settings.byoKey),
    baseUrl: settings.baseUrl ?? "",
  };
}
