// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The decision model's settings: the config.ts `decider` block, read with
// every default OFF. Nothing here holds the Flux key; it is resolved at call
// time from flux-config.ts. `byoKey` is an advanced override and write-only.
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

/** Merge a stored `decider` block over the defaults. Anything but `true`
 * reads as off; an unknown provider reads as off. Never throws. */
export function readDecisionModelSettings(stored: Stored): DecisionModelSettings {
  const block = stored && typeof stored === "object" ? stored : {};
  const byoKey = text(block.byoKey);
  const baseUrl = text(block.baseUrl);
  return {
    enabled: block.enabled === true && (block.provider === undefined || block.provider === "flux"),
    provider: "flux",
    jobs: { roomRouting: block.jobs?.roomRouting === true },
    ...(byoKey ? { byoKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** What GET /api/config may show: switches and presence flags, never a key. */
export function describeDecisionModelSettings(settings: DecisionModelSettings) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    jobs: { ...settings.jobs },
    byoKeyConfigured: Boolean(settings.byoKey),
    baseUrl: settings.baseUrl ?? "",
  };
}
