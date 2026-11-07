// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The monthly meter's only source (UX-L2C, 1.0.18): what Flux itself reports
// from GET /v1/key/limits (handoffs/FLUX-LIMITS-CONTRACT-1104.md). Murage keeps
// no money of its own: no spend file, no ledger, no month math. A figure we
// cannot read from Flux is "pending", never a number we made up and never $0.
//
// Pull only (1.0.19, designs/UX-L2C-METER-PULL-1019.md): the desktop asks with
// GET /api/spend and gets the figure plus the fingerprint of the key it was read
// with. It shows the figure only when that fingerprint equals the one in its
// current config read, so an old key's figure can never match. No push frame and
// no client copy of a figure. The key never leaves this process.
import { createHash } from "node:crypto";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";

export const FLUX_KEY_LIMITS_URL = "https://api.fluxrouter.ai/v1/key/limits";
/** A reading is fresh this long; opening Today or Usage after it asks again. */
export const SPEND_CACHE_MS = 60_000;

/** One key's answer. `pending` covers 404 (route dark or fence off), 503, a network error and anything malformed. */
export type FluxLimitsReading =
  | { state: "ok"; spentUsd: number; asOf: string; resetsAt: string; keyBudgetUsd: number | null; bot?: { botId: string; spentUsd: number } }
  | { state: "pending" };

const PENDING: FluxLimitsReading = { state: "pending" };

const money = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const stamp = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value)) ? value : null);

/** Strict parse of the 200 body. A missing, negative or non-finite figure, or a missing as_of/resets_at, is pending. */
export function parseFluxLimits(body: unknown): FluxLimitsReading {
  if (!body || typeof body !== "object" || Array.isArray(body)) return PENDING;
  const raw = body as Record<string, unknown>;
  const spentUsd = money(raw.spent_usd_this_month);
  const asOf = stamp(raw.as_of);
  const resetsAt = stamp(raw.resets_at);
  if (spentUsd === null || asOf === null || resetsAt === null) return PENDING;
  // Only Flux's billed figure is money we show; any other basis is not this meter's.
  if (raw.spend_basis !== "billed_sale") return PENDING;
  const budget = raw.key_monthly_budget_usd;
  if (budget !== undefined && budget !== null && money(budget) === null) return PENDING;
  const reading: FluxLimitsReading = { state: "ok", spentUsd, asOf, resetsAt, keyBudgetUsd: money(budget) };
  // The bot counter carries over key rotation by bot_id (contract), so it is the per-bot figure as Flux reports it.
  if (raw.bot_id !== undefined || raw.bot_spent_usd_this_month !== undefined) {
    const botSpent = money(raw.bot_spent_usd_this_month);
    if (typeof raw.bot_id !== "string" || raw.bot_id.trim() === "" || botSpent === null) return PENDING;
    reading.bot = { botId: raw.bot_id, spentUsd: botSpent };
  }
  return reading;
}

/** One read of one key. `retryAfterMs` is Flux's Retry-After on a 503, honoured by the reader. */
export async function fetchFluxLimits(key: string, fetchImpl: typeof fetch = fetch): Promise<{ reading: FluxLimitsReading; retryAfterMs?: number }> {
  try {
    const response = await fetchImpl(FLUX_KEY_LIMITS_URL, {
      headers: { authorization: `Bearer ${key.trim()}`, accept: "application/json", ...fluxUsageHeaders({ feature: "other" }) },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const seconds = Number(response.headers.get("retry-after"));
      return response.status === 503 && Number.isFinite(seconds) && seconds > 0
        ? { reading: PENDING, retryAfterMs: Math.min(seconds, 3600) * 1000 }
        : { reading: PENDING };
    }
    return { reading: parseFluxLimits(await response.json().catch(() => null)) };
  } catch {
    return { reading: PENDING };
  }
}

/** The Today total. `multiKey`: Flux answered, but the key's figure is not honestly the account's (a rotated key below
 *  its bot's carried-over figure). The desktop says "Account total arrives with the next Flux update". */
export type SpendTotal =
  | { state: "ok"; spentUsd: number; asOf: string; resetsAt: string }
  | { state: "pending" }
  | { state: "multiKey" };

/**
 * THE seam for the Today total. Today: the one saved key's own spent_usd_this_month. When Flux's account endpoint lands
 * (~11-16) this is the one function that switches to it. After a rotation the key counter restarts at $0 while the bot
 * counter carries over, so a bot above the key means the key is no longer the account's month: no total, no heads-up.
 */
export function accountTotal(reading: FluxLimitsReading): SpendTotal {
  if (reading.state !== "ok") return { state: "pending" };
  if (reading.bot && reading.bot.spentUsd > reading.spentUsd) return { state: "multiKey" };
  return { state: "ok", spentUsd: reading.spentUsd, asOf: reading.asOf, resetsAt: reading.resetsAt };
}

/** The key's fingerprint: a short hash of the save epoch and the key, never the key. No key, no fingerprint. Every Flux
 *  key save, rotate or remove bumps the epoch (config.ts fluxKeyEpoch), and the key itself is in the hash, so an
 *  answer read under an older key can never carry the current fingerprint. */
export function fluxKeyFingerprint(key: string | null | undefined, epoch: number): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(`murage-flux-meter\0${epoch}\0${trimmed}`).digest("hex").slice(0, 16);
}

/** What GET /api/spend answers: the total and the fingerprint it belongs to. Figures and dates only, never a key. */
export interface SpendAnswer { fingerprint: string | null; total: SpendTotal }

const PENDING_TOTAL: SpendTotal = { state: "pending" };

/**
 * The reader: one read in flight per fingerprint, a reading cached SPEND_CACHE_MS for that fingerprint only, a settled
 * turn marks it stale (a flag; nothing is pushed), a 503's Retry-After holds the next read off. The key and its
 * fingerprint are taken together when a read starts; if the fingerprint has moved by the time Flux answers, the answer
 * is pending under the current fingerprint. Per-turn work is one flag; nothing grows.
 */
export function createFluxSpendReader(options: {
  key: () => string | null;
  epoch: () => number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const current = () => { const key = options.key()?.trim() || null; return { key, fingerprint: fluxKeyFingerprint(key, options.epoch()) }; };
  let cache: { fingerprint: string; total: SpendTotal; readAt: number } | null = null;
  let stale = false;
  let hold: { fingerprint: string; until: number } | null = null;
  let inFlight: { fingerprint: string; promise: Promise<SpendTotal> } | null = null;
  const start = (key: string, fingerprint: string): Promise<SpendTotal> => {
    stale = false;
    const promise = (async () => {
      const result = await fetchFluxLimits(key, options.fetchImpl);
      const total = accountTotal(result.reading);
      if (current().fingerprint === fingerprint) {
        cache = { fingerprint, total, readAt: now() };
        if (result.retryAfterMs) hold = { fingerprint, until: now() + result.retryAfterMs };
      }
      return total;
    })().finally(() => { if (inFlight?.promise === promise) inFlight = null; });
    inFlight = { fingerprint, promise };
    return promise;
  };
  return {
    /** The current key's fingerprint, for the desktop config. */
    fingerprint: (): string | null => current().fingerprint,
    /** GET /api/spend: the total for the current key, tagged with the fingerprint it was read under. */
    read: async (): Promise<SpendAnswer> => {
      const { key, fingerprint } = current();
      if (!key || !fingerprint) return { fingerprint: null, total: PENDING_TOTAL };
      const cached = cache?.fingerprint === fingerprint ? cache : null;
      let total: SpendTotal;
      if (cached && !stale && now() - cached.readAt < SPEND_CACHE_MS) total = cached.total;
      else if (hold?.fingerprint === fingerprint && now() < hold.until) total = cached?.total ?? PENDING_TOTAL;
      else total = await (inFlight?.fingerprint === fingerprint ? inFlight.promise : start(key, fingerprint));
      // A key saved, rotated or removed while Flux was answering: never hand out the old key's figure.
      const after = current().fingerprint;
      return after === fingerprint ? { fingerprint, total } : { fingerprint: after, total: PENDING_TOTAL };
    },
    /** A turn settled: the next GET reads Flux again. */
    markStale: (): void => { stale = true; },
  };
}
