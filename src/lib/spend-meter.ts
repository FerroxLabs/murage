// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The monthly meter (UX-L2C, 1.0.18). Every figure here is Flux's own, from
// GET /v1/key/limits, read by the server (server/flux-limits.ts). Murage keeps
// no money and does no month math: the month is Flux's (its resets_at), and a
// figure Flux has not reported is "pending", never $0.
//
// The limit is a heads-up and nothing more: at 80% and at the limit Today and
// Needs you say so. Nothing here holds, queues or refuses work.

/** The suggested limit the field is pre-filled with. Never applied until the owner presses Save. */
export const SUGGESTED_MONTHLY_LIMIT_USD = 1000;
/** The heads-up threshold, in percent of the limit. */
export const HEADS_UP_PERCENT = 80;

/** Flux's month to date for the current key (server/flux-limits.ts SpendTotal). */
export type SpendTotal = { state: "ok"; spentUsd: number; asOf: string; resetsAt: string } | { state: "pending" } | { state: "multiKey" };

const PENDING: SpendTotal = { state: "pending" };
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const stamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/**
 * The only way a figure reaches the screen (pull only, designs/UX-L2C-METER-PULL-1019.md): a GET /api/spend answer is
 * shown only when its key fingerprint equals the fingerprint in the current config read. An answer read under an older
 * key, a config copy without a fingerprint, no answer, a route error or anything malformed is pending, never $0.
 */
export function matchedSpend(answer: unknown, configFingerprint: string | null | undefined): SpendTotal {
  if (!configFingerprint || !answer || typeof answer !== "object") return PENDING;
  const raw = answer as { fingerprint?: unknown; total?: Record<string, unknown> };
  if (typeof raw.fingerprint !== "string" || raw.fingerprint !== configFingerprint) return PENDING;
  const t = raw.total;
  if (t?.state === "multiKey") return { state: "multiKey" };
  if (t?.state === "ok" && money(t.spentUsd) && stamp(t.asOf) && stamp(t.resetsAt)) return { state: "ok", spentUsd: t.spentUsd, asOf: t.asOf, resetsAt: t.resetsAt };
  return PENDING;
}

/** A local copy of the config after a Flux key change, until GET /api/config answers: the old key's fingerprint is
 *  cleared, so no figure from the old key can match (a settings save never brings one back). */
export function configAfterFluxKeyChange<T extends { flux?: unknown; spend?: { keyFingerprint: string | null } }>(config: T, configured: boolean): T {
  return { ...config, flux: { configured }, ...(config.spend ? { spend: { ...config.spend, keyFingerprint: null } } : {}) } as T;
}

export type SpendLevel = "none" | "ok" | "warn" | "limit";

export interface SpendState {
  level: SpendLevel;
  limitUsd: number | null;
  /** Whole percent of the limit, floored (81.9% reads 81%); null with no limit or no total. */
  percent: number | null;
  /** The heads-up to show now, or null (no limit, no total, under 80%, or left for this Flux month at this level). */
  headsUp: "warn" | "limit" | null;
  /** What "Leave it" stores: Flux's resets_at and the level, so it rolls over when Flux's month does. */
  leaveKey: string | null;
}

/** A saved limit, or null. Anything that is not a positive finite number is no limit. */
export function savedLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The heads-up reads the account total only. With no total (pending, or more than one key) there is no heads-up:
 *  bot figures are never summed into an account figure. */
export function spendState(total: SpendTotal, config: { monthlyLimitUsd?: number | null; headsUpLeft?: string | null } | undefined): SpendState {
  const limitUsd = savedLimit(config?.monthlyLimitUsd);
  if (limitUsd === null || total.state !== "ok") return { level: "none", limitUsd, percent: null, headsUp: null, leaveKey: null };
  const percent = Math.floor((total.spentUsd / limitUsd) * 100);
  const level: SpendLevel = total.spentUsd >= limitUsd ? "limit" : percent >= HEADS_UP_PERCENT ? "warn" : "ok";
  if (level === "ok") return { level, limitUsd, percent, headsUp: null, leaveKey: null };
  const leaveKey = `${total.resetsAt}@${level === "limit" ? 100 : 80}`;
  return { level, limitUsd, percent, headsUp: config?.headsUpLeft === leaveKey ? null : level, leaveKey };
}

/** Dollars as the owner reads them: "$812", "$12.40", "$0.03". */
export function formatDollars(value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  const whole = v >= 100 && Math.abs(v - Math.round(v)) < 0.005;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(v);
}

/** The limit field's text, parsed: "$1,000" and "1000" are 1000; empty or zero is no limit (null); anything else is undefined (refused). */
export function parseLimitInput(text: string): number | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n > 1_000_000) return undefined;
  return n === 0 ? null : n;
}
