// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Health as a doctor (designs/HEALTH-DOCTOR.md, Sean 11-02): every problem is one finding with one fix, in a fixed
// order of impact, Flux Router and Fuigo first. Pure: the page reads the engines, the Flux figures and the open checks
// it already has, and this file decides what is a finding, in what order, and what the top line says. Nothing here
// fetches or changes anything.
//
// Product rules applied: an engine no bot uses and that is not the default is never a finding and never red (it sits
// under Other engines with its state word); red only for what stops a turn, a routine, a backup or a sign-in.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { EngineHealthRow, FluxHealthInfo, FluxHealthState } from "@/components/shell/shell-contract";
import type { HealthFold } from "../../../shared/health-levels";
import type { HealthIssue } from "../../../shared/sentinel-view";

/** The one fix a finding offers: a button that does it, a button to the exact place, or a step in words. */
export type FindingFix =
  | { kind: "do"; action: "switch-on"; engineId: string }
  | { kind: "go"; section: "engines" | "models"; step: LocaleKey }
  | { kind: "step"; step: LocaleKey; then?: "flux-recheck" };

export interface HealthFinding {
  key: string;
  level: "act" | "watch";
  /** The order table (section 2): 1 Flux Router and Fuigo, 2 the default engine, 3 other engines bots use. */
  area: number;
  title: string;
  matters: string;
  fix: FindingFix;
  /** Words for the top line: "Start with Flux Router." */
  subject: string;
  /** The question Ask your bot puts in the Chief's chat, not sent. Only where a bot can help. */
  ask?: string;
}

/** One line of the findings column: an engine or Flux finding, or an open check from the background checks. */
export type FindingEntry =
  | { kind: "finding"; finding: HealthFinding }
  | { kind: "check"; fold: HealthFold<HealthIssue>; area: number; subject: string };

/** Where each background check sits in the order table (section 2). Anything not listed sits after memory learning. */
export function checkArea(titleKey: string): number {
  if (titleKey.startsWith("health.dispatch.")) return 3;
  if (titleKey.startsWith("health.backup.")) return 4;
  if (titleKey.startsWith("health.io-pressure.")) return 5;
  if (titleKey.startsWith("health.extraction.")) return 9;
  return 10;
}

const CHECK_SUBJECT: Readonly<Record<number, LocaleKey>> = {
  3: "ux.l2a.health.area.engines",
  4: "ux.l2a.health.area.backups",
  5: "ux.l2a.health.area.storage",
  9: "ux.l2a.health.area.memory",
};

export const FLUX_WATCH_PCT = 80;
export const FLUX_EXPIRY_WATCH_MS = 7 * 86_400_000;

/** A bot uses this engine, or it is the default: then its trouble is a finding. Fuigo's trouble is Flux's to say. */
export const engineInUse = (row: EngineHealthRow, primaryId: string | null): boolean => row.id === primaryId || (row.usedBy ?? 0) > 0;

const botsWord = (n: number): string => (n === 1 ? t("ux.l2a.health.botsOne") : t("ux.l2a.health.botsMany", { n }));

function engineFinding(row: EngineHealthRow, primaryId: string | null): HealthFinding | null {
  if (!engineInUse(row, primaryId)) return null;
  // Fuigo sits with Flux Router at the top, whatever the default is.
  const area = row.fuigo ? 1 : row.id === primaryId ? 2 : 3;
  const used = row.usedBy ?? 0;
  const engine = row.label;
  const matters = (slug: string): string => used > 0
    ? t(`ux.l2b.health.doc.${slug}.matters` as LocaleKey, { engine, bots: botsWord(used) })
    : t(`ux.l2b.health.doc.${slug}.mattersDefault` as LocaleKey, { engine });
  const base = { area, subject: engine };
  switch (row.state) {
    case "off":
      return { ...base, key: `engine-off:${row.id}`, level: "act", title: t("ux.l2b.health.doc.engineOff.title", { engine }), matters: matters("engineOff"), fix: { kind: "do", action: "switch-on", engineId: row.id } };
    // A bundled Fuigo that will not start is its own finding: the bots on it stop, and Engines can set it up again.
    case "missing":
      if (row.fuigo) return { ...base, key: `engine-missing:${row.id}`, level: "act", title: t("ux.l2b.health.doc.fuigoMissing.title", { engine }), matters: t("ux.l2b.health.doc.fluxStops.matters"), fix: { kind: "go", section: "engines", step: "ux.l2b.health.doc.engineMissing.step" } };
      return { ...base, key: `engine-missing:${row.id}`, level: "act", title: t("ux.l2b.health.doc.engineMissing.title", { engine }), matters: matters("engineMissing"), fix: { kind: "go", section: "engines", step: "ux.l2b.health.doc.engineMissing.step" } };
    // Fuigo is never signed out: a missing login is its Flux key, and Flux Router speaks for that.
    case "signed-out":
      if (row.fuigo) return null;
      return { ...base, key: `engine-signed-out:${row.id}`, level: "act", title: t("ux.l2b.health.doc.engineSignedOut.title", { engine }), matters: matters("engineSignedOut"), fix: { kind: "go", section: "engines", step: "ux.l2b.health.doc.engineSignedOut.step" } };
    case "limit":
      return { ...base, key: `engine-limit:${row.id}`, level: "watch", title: t("ux.l2b.health.doc.engineLimit.title", { engine }), matters: matters("engineLimit"), fix: { kind: "step", step: "ux.l2b.health.doc.engineLimit.step" }, ask: t("ux.l2b.health.ask.engineLimit", { engine }) };
    default:
      return null;
  }
}

/** Flux Router findings: the key, the allowance used up, and the two early warnings (80% used, expiring within 7 days). */
export function fluxFindings(flux: FluxHealthState, info: FluxHealthInfo | null | undefined, desktop: boolean, now: number): HealthFinding[] {
  const subject = t("ux.l2a.health.fluxName");
  const base = { area: 1, subject };
  if (flux === "key-problem") {
    return [{ ...base, key: "flux-key", level: "act", title: t("ux.l2b.health.doc.fluxKey.title"), matters: t("ux.l2b.health.doc.fluxStops.matters"), fix: { kind: "go", section: "models", step: "ux.l2b.health.doc.fluxKey.step" } }];
  }
  // The phone names no place to pay (store rule): it says to fix it on the computer.
  const onComputer: LocaleKey = "ux.l2b.health.doc.fluxElsewhere.step";
  if (flux === "allowance-used-up") {
    return [{ ...base, key: "flux-used-up", level: "act", title: t("ux.l2b.health.doc.fluxUsedUp.title"), matters: t("ux.l2b.health.doc.fluxStops.matters"), fix: { kind: "step", step: desktop ? "ux.l2b.health.doc.fluxUsedUp.step" : onComputer, then: "flux-recheck" }, ask: t("ux.l2b.health.ask.fluxUsedUp") }];
  }
  if (flux !== "ok" || !info) return [];
  const out: HealthFinding[] = [];
  if (info.spendPct !== null && info.spendPct >= FLUX_WATCH_PCT) {
    out.push({ ...base, key: "flux-80", level: "watch", title: t("ux.l2b.health.doc.flux80.title", { n: info.spendPct }), matters: t("ux.l2b.health.doc.flux80.matters"), fix: { kind: "step", step: desktop ? "ux.l2b.health.doc.flux80.step" : onComputer, then: "flux-recheck" }, ask: t("ux.l2b.health.ask.flux80") });
  }
  const expires = info.expires ? Date.parse(info.expires) : Number.NaN;
  if (Number.isFinite(expires) && expires - now <= FLUX_EXPIRY_WATCH_MS) {
    const date = new Date(expires).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    out.push({ ...base, key: "flux-expires", level: "watch", title: t(expires <= now ? "ux.l2b.health.doc.fluxExpired.title" : "ux.l2b.health.doc.fluxExpires.title", { date }), matters: t("ux.l2b.health.doc.fluxExpires.matters"), fix: { kind: "step", step: desktop ? "ux.l2b.health.doc.fluxExpires.step" : onComputer, then: "flux-recheck" } });
  }
  return out;
}

export interface FindingInputs {
  engines: readonly EngineHealthRow[];
  primaryId: string | null;
  flux: FluxHealthState;
  fluxInfo?: FluxHealthInfo | null;
  /** The open background checks, folded (shared/health-levels.ts). Notes are not findings: Murage is on them. */
  folds: readonly HealthFold<HealthIssue>[];
  desktop: boolean;
  now: number;
}

const levelRank = (level: string): number => (level === "act" ? 0 : 1);

/** Every finding in the order of impact, then act before watch inside the same place. Stable for equal places. */
export function healthFindings(input: FindingInputs): FindingEntry[] {
  const entries: FindingEntry[] = [];
  for (const finding of fluxFindings(input.flux, input.fluxInfo, input.desktop, input.now)) entries.push({ kind: "finding", finding });
  for (const row of input.engines) {
    const finding = engineFinding(row, input.primaryId);
    if (finding) entries.push({ kind: "finding", finding });
  }
  for (const fold of input.folds) {
    if (fold.level !== "act" && fold.level !== "watch") continue;
    const area = checkArea(fold.titleKey);
    entries.push({ kind: "check", fold, area, subject: CHECK_SUBJECT[area] ? t(CHECK_SUBJECT[area]) : "" });
  }
  const place = (entry: FindingEntry) => (entry.kind === "finding" ? entry.finding.area : entry.area);
  const level = (entry: FindingEntry) => levelRank(entry.kind === "finding" ? entry.finding.level : entry.fold.level);
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => place(a.entry) - place(b.entry) || level(a.entry) - level(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The top line: how many things to fix and where to start. Null when there is nothing to fix: the page then says how
 * far the checks got, never more than they saw. */
export function summaryLine(entries: readonly FindingEntry[], titleOf: (fold: HealthFold<HealthIssue>) => string): string | null {
  if (entries.length === 0) return null;
  const first = entries[0]!;
  const name = first.kind === "finding" ? first.finding.subject : first.subject || titleOf(first.fold);
  return entries.length === 1 ? t("ux.l2a.health.summary.one", { name }) : t("ux.l2a.health.summary.many", { n: entries.length, name });
}

/** Engines no bot uses that are not the default: listed under Other engines with their state word, never a dot. */
export function otherEngines(rows: readonly EngineHealthRow[], primaryId: string | null): EngineHealthRow[] {
  return rows.filter((row) => !row.fuigo && !engineInUse(row, primaryId));
}

/** Engines bots use (or the default), Fuigo left out: it has its own card with Flux Router. */
export function usedEngines(rows: readonly EngineHealthRow[], primaryId: string | null): EngineHealthRow[] {
  return rows.filter((row) => !row.fuigo && engineInUse(row, primaryId));
}

const STATE_WORD: Readonly<Record<EngineHealthRow["state"], LocaleKey>> = {
  ready: "ux.l2a.health.word.ready",
  checking: "ux.l2a.health.word.checking",
  "signed-out": "ux.l2a.health.word.signedOut",
  limit: "ux.l2a.health.word.limit",
  off: "ux.l2a.health.word.off",
  missing: "ux.l2a.health.word.notInstalled",
};
export const engineStateWord = (row: EngineHealthRow): string => t(STATE_WORD[row.state]);

/** The Flux Router line in the What was checked card. "Checking" while no valid figures came in, never a stale number. */
export function fluxPanelLine(flux: FluxHealthState, info: FluxHealthInfo | null | undefined): string {
  if (flux === "none") return t("ux.l2a.health.flux.none");
  if (flux === "key-problem") return t("ux.l2a.health.flux.keyProblem");
  if (flux === "allowance-used-up") return t("ux.l2a.health.flux.usedUp");
  if (!info) return t("ux.l2a.health.flux.checking");
  return info.spendPct === null ? t("ux.l2a.health.flux.working") : t("ux.l2a.health.flux.pct", { n: info.spendPct });
}
