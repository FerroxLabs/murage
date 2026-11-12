// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The decision model's config.ts settings. Nothing saved means OFF.
// Only explicit owner switches enable a job. Credentials are resolved at call
// time from flux-config.ts; `byoKey` is a write-only override.
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

/** Merge a stored `decider` block over the OFF defaults. Only the owner's
 * explicit booleans enable the master switch and room routing. */
export function readDecisionModelSettings(stored: Stored): DecisionModelSettings {
  const block = stored && typeof stored === "object" ? stored : {};
  const byoKey = text(block.byoKey);
  const baseUrl = text(block.baseUrl);
  const providerOk = block.provider === undefined || block.provider === "flux";
  const enabled = providerOk && block.enabled === true;
  const roomRouting = block.jobs?.roomRouting === true;
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
