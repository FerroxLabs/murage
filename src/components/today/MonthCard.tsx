// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's "This month" line and the monthly limit heads-up (UX-L2C, 1.0.18).
// Pull only: each view asks GET /api/spend and shows a figure only for
// the key fingerprint in the current config. The figure is Flux's own: the key's month to date,
// as of Flux's time, for Flux's month. Not reported yet reads "Spending will
// show here once Flux reports it", never $0. The heads-up at 80% and at the
// limit is a notice only: nothing here holds or refuses work.
import { Suspense, useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { formatDollars, matchedSpend, spendState, type SpendState, type SpendTotal } from "@/lib/spend-meter";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import type { MonthCardProps, NeedsSummaryRow, TodayTag } from "@/components/shell/shell-contract";

/** While a meter is open it asks again this often (and on window focus), so a window that missed a key change re-learns it. */
const SPEND_REVALIDATE_MS = 60_000;

interface MonthReading { show: boolean; total: SpendTotal; state: SpendState }

/** Whether the meter shows at all: config only, no figure. Only the owner's desktop has `spend` (scopedConfig drops it). */
export function useMonthShow(): boolean {
  const { state } = useStore();
  const spend = state.config?.spend;
  return Boolean(spend) && (Boolean(state.config?.flux?.configured) || (typeof spend?.monthlyLimitUsd === "number" && spend.monthlyLimitUsd > 0));
}

/** What the hook holds: the body of the latest answer and the config fingerprint it was applied under. */
export interface HeldAnswer { asked: string; body: unknown }
/** One GET, numbered: `asked` is the config fingerprint when it was sent; `configSeq`/`configFp` the latest config response before it. */
export interface MeterTicket { n: number; asked: string | null; configSeq: number; configFp: string | null }
export interface MeterGate { issue(): MeterTicket; voidAll(): void; settle(ticket: MeterTicket, body?: unknown): void }

// Shared by every mounted meter (designs/UX-L2C-METER-PULL-1019.md, r3 ordering). A retired fingerprint never shows a figure.
let retiredFingerprint: string | null = null;
let retiredAt = 0;
let configSeq = 0;
let configFp: string | null = null;
let observedFingerprint: string | null = null;
const gates = new Set<MeterGate>();

/** A GET /api/config answer arrived with this fingerprint. Only a spend read issued after it can bring a retired fingerprint back. */
export function noteConfigResponse(fingerprint: string | null | undefined): void { configSeq += 1; configFp = fingerprint ?? null; }
/** Config movement voids every meter's tickets, even without a retirement or while another meter's render lags. */
export function noteConfigFingerprint(fingerprint: string | null): void {
  const moved = fingerprint !== observedFingerprint;
  observedFingerprint = fingerprint;
  if (retiredFingerprint !== null && fingerprint && fingerprint !== retiredFingerprint) clearRetirement();
  else if (moved) for (const gate of [...gates]) gate.voidAll();
}
export function isRetired(fingerprint: string | null): boolean { return fingerprint !== null && fingerprint === retiredFingerprint; }
/** A meter joins retirement notices while mounted; returns the leave. */
export function joinRetirement(gate: MeterGate): () => void { gates.add(gate); return () => { gates.delete(gate); }; }
/** Tests only: forget the shared state. */
export function resetMeterGatesForTest(): void { retiredFingerprint = null; retiredAt = 0; configSeq = 0; configFp = null; observedFingerprint = null; gates.clear(); }

function clearRetirement(): void {
  // Reads issued while retired must stay void after recovery, including in a
  // second meter whose config render/effect has not caught up yet.
  for (const gate of [...gates]) gate.voidAll();
  retiredFingerprint = null;
}

function retire(fingerprint: string): void {
  retiredFingerprint = fingerprint;
  retiredAt = configSeq;
  for (const gate of [...gates]) gate.voidAll();
}

/**
 * The meter's single writer. `settle` is the only caller of `show`: an answer is applied only if it is the latest
 * ticket and its fingerprint equals the config fingerprint read on arrival. Every config change voids what is in flight.
 */
export function createMeterGate(deps: { fingerprint(): string | null; show(answer: HeldAnswer | null): void; reread(): void }): MeterGate {
  let counter = 0;
  const ticket = (): MeterTicket => ({ n: ++counter, asked: deps.fingerprint(), configSeq, configFp });
  const gate: MeterGate = {
    issue: ticket,
    voidAll() { gate.settle(ticket()); },
    settle(t, body) {
      if (t.n !== counter) return; // superseded: does nothing
      const current = deps.fingerprint();
      // The ref can change before the effect voids tickets. Even a matching
      // response must have been requested under the current configuration.
      if (t.asked !== current) { deps.show(null); return; }
      const raw = body && typeof body === "object" ? (body as { fingerprint?: unknown }).fingerprint : undefined;
      // A failed or malformed read, or no config fingerprint: the message, never $0.
      if (!current || (typeof raw !== "string" && raw !== null)) { deps.show(null); return; }
      if (raw !== current) {
        deps.show(null);
        // The server's key moved and this window's config has not heard since asking: retire it everywhere, read the config again.
        // If the config moved since asking, the answer is just dropped; the new fingerprint asks again.
        if (t.asked === current) { retire(current); deps.reread(); }
        return;
      }
      if (current === retiredFingerprint) {
        // Back only on a read issued after a config response that itself carried this fingerprint (a server restart, same key).
        // Still retired: ask for the config again (a failed re-read never leaves it hidden for good).
        if (!(t.configSeq > retiredAt && t.configFp === current)) { deps.show(null); deps.reread(); return; }
        clearRetirement();
      }
      deps.show({ asked: current, body });
    },
  };
  return gate;
}

/**
 * One GET /api/spend when the caller opens, when `refresh` changes, whenever the config's key fingerprint changes, every
 * minute and on focus. Every write goes through the meter gate. The figure shows only while the held answer was applied
 * under the current config fingerprint and that fingerprint is not retired (matchedSpend).
 */
export function useMonthReading(refresh?: unknown): MonthReading {
  const { state, dispatch } = useStore();
  const spend = state.config?.spend;
  const show = useMonthShow();
  const fingerprint = spend?.keyFingerprint ?? null;
  const configured = Boolean(state.config?.flux?.configured);
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const [answer, setAnswer] = useState<HeldAnswer | null>(null);
  const [reread] = useState(() => () => {
    void api("/api/config").then((config: ConfigStatus) => {
      noteConfigResponse(config?.spend?.keyFingerprint);
      dispatchRef.current({ type: "configStatus", config });
    }).catch(() => {});
  });
  const [gate] = useState(() => createMeterGate({ fingerprint: () => fingerprintRef.current, show: setAnswer, reread }));
  useEffect(() => joinRetirement(gate), [gate]);
  useEffect(() => {
    noteConfigFingerprint(fingerprint);
    gate.voidAll();
    if (!show || (!fingerprint && !configured)) return;
    // With a fingerprint: ask for the figure. Without one while Flux is connected (a settings save cleared it and the
    // config re-read or the frame was missed): ask for the config again, so the meter never stops for good.
    const ask = fingerprint
      ? () => { const t = gate.issue(); api("/api/spend").then((body: unknown) => gate.settle(t, body), () => gate.settle(t)); }
      : reread;
    ask();
    const timer = setInterval(ask, SPEND_REVALIDATE_MS);
    window.addEventListener("focus", ask);
    return () => { clearInterval(timer); window.removeEventListener("focus", ask); gate.voidAll(); };
  }, [gate, reread, show, fingerprint, configured, refresh]);
  const total = matchedSpend(answer && answer.asked === fingerprint && !isRetired(fingerprint) ? answer.body : null, fingerprint);
  return { show, total, state: spendState(total, spend) };
}

export function headsUpLine(state: SpendState, limit: number): string {
  return state.headsUp === "limit"
    ? t("ux.l2c.headsUp.limit", { limit: formatDollars(limit) })
    : t("ux.l2c.headsUp.warn", { percent: state.percent ?? 0, limit: formatDollars(limit) });
}

/** The month's line, shared by Today and Usage. */
export function monthLine(total: SpendTotal, state: SpendState): string {
  if (total.state === "multiKey") return t("ux.l2c.month.multiKey");
  if (total.state !== "ok") return t("ux.l2c.month.pending");
  if (state.limitUsd !== null && state.percent !== null) {
    return t("ux.l2c.month.ofLimit", { amount: formatDollars(total.spentUsd), limit: formatDollars(state.limitUsd), percent: state.percent });
  }
  return t("ux.l2c.month.billed", { amount: formatDollars(total.spentUsd) });
}

/** The heads-up as one Needs you row (Today's top rows and the badge count), until the owner leaves it for the month. */
export function useMonthNeedsRow(open: () => void, refresh?: unknown): NeedsSummaryRow | null {
  const { show, state } = useMonthReading(refresh);
  if (!show || !state.headsUp || state.limitUsd === null) return null;
  return { id: `spend:${state.leaveKey}`, line: headsUpLine(state, state.limitUsd), meta: t("ux.l2c.needs.meta"), open };
}

/** Today's status tag at 80% and at the limit only; quiet otherwise. */
export function useMonthTag(): TodayTag | null {
  const { show, total, state } = useMonthReading();
  if (!show || state.limitUsd === null || state.percent === null || (state.level !== "warn" && state.level !== "limit")) return null;
  return { key: "month", tone: state.level === "limit" ? "bad" : "warn", text: monthLine(total, state) };
}

// The card itself loads on first show, so it stays off the first paint (check-bundle-budget).
const Card = retryableLazy(() => import("./MonthCardView").then((module) => ({ default: module.MonthCardView })));

export function MonthCard(props: MonthCardProps) {
  const show = useMonthShow();
  if (!show) return null;
  return <LazyBoundary onRetry={Card.retry}><Suspense fallback={null}><Card.Component {...props} /></Suspense></LazyBoundary>;
}
