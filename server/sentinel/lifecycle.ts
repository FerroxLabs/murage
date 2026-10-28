// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The issue state machine (GAP-SENTINEL-109 section 6.2) and the page policy (section 8.2). Pure functions over a
// persisted record and one detector result; the scanner core persists what they return in its single commit.
//
//   absent/resolved + trigger           -> open, episode + 1, first seen kept, resolution cleared
//   open + trigger                      -> open, count + new occurrences, severity only rises
//   open + first positive recovery      -> recovering (recovery start saved; still visible)
//   recovering + trigger                -> open in the same episode, recovery cleared, no extra page
//   recovering + recovery complete      -> resolved, observed-recovery
//   any unresolved + incomplete coverage, sleep, clock jump or crashed window -> state and severity kept, recovery frozen
//   any unresolved + explicit retirement -> resolved, policy-ended or source-retired (never "Recovered")
//
// Page policy: only a page-eligible result (S01, S02) can page; one page decision per fingerprint and episode; a
// reopened episode waits 24 h after this fingerprint's last page; at most 3 page attempts per installation in any
// rolling 24 h; everything else, and every overflow, goes to the digest.
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { fingerprint, type Delivery, type DetectorResult, type Issue, type IssueCoverage, type Severity } from "./types.ts";

export const PAGE_COOLDOWN_MS = 24 * 60 * 60_000;
export const PAGE_CAP = 3;
export const PAGE_CAP_WINDOW_MS = 24 * 60 * 60_000;

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** The persisted record around an issue: the issue plus recovery and page bookkeeping. */
export interface IssueRecord {
  issue: Issue;
  /** When the current recovery window started (UTC ms), or null when not recovering. */
  recoveryStartedAt: number | null;
  /** Highest episode a page decision was made for (paged or sent to the digest instead), 0 when none. */
  pageDecidedEpisode: number;
  /** When this fingerprint last paged (UTC ms), or null. */
  lastPagedAt: number | null;
  /** How the current episode is delivered. */
  delivery: Delivery;
}

/** Installation-wide page attempts inside the rolling cap window (UTC ms, oldest first, at most PAGE_CAP). */
export interface PageLedger { attempts: readonly number[] }
export const EMPTY_LEDGER: PageLedger = Object.freeze({ attempts: Object.freeze([]) as readonly number[] });

export type Transition = "none" | "opened" | "updated" | "recovering" | "reopened" | "resolved" | "retired" | "frozen";

export interface StepContext {
  now: number;
  detectorVersion: number;
  /** A suspend, resume or clock jump since the previous scan (DetectorInput.awake.discontinuity), or a crashed window. */
  discontinuity: boolean;
  /** Per-source coverage for the issue's coverage block; defaults to none listed. */
  sources?: IssueCoverage["sources"];
}

export interface StepOutput { record: IssueRecord | null; transition: Transition }

const unresolved = (record: IssueRecord | null): boolean => record !== null && record.issue.state !== "resolved";
const related = (result: DetectorResult) => (result.relatedFingerprints ?? []).slice(0, HEALTH_LIMITS.relatedPerIssue);
const evidence = (result: DetectorResult) => result.evidence.slice(Math.max(0, result.evidence.length - HEALTH_LIMITS.evidencePerIssue));

/** Applies one detector result to the persisted record for its fingerprint (section 6.2). */
export function applyResult(prior: IssueRecord | null, result: DetectorResult, ctx: StepContext): StepOutput {
  const { now } = ctx;
  const coverage: IssueCoverage = { overall: result.coverage, sources: ctx.sources ?? [] };
  const frozen = ctx.discontinuity || result.coverage !== "complete";

  // Explicit retirement ends an unresolved issue without any claim of repair.
  if (result.retired !== undefined && result.triggered === null) {
    if (prior === null || !unresolved(prior)) return { record: prior, transition: "none" };
    const issue: Issue = { ...prior.issue, state: "resolved", resolution: result.retired, resolvedAt: now, coverage };
    return { record: { ...prior, issue, recoveryStartedAt: null }, transition: "retired" };
  }

  if (result.triggered !== null) {
    const occurrences = Math.max(0, result.occurrences);
    if (prior === null || !unresolved(prior)) {
      // Absent or resolved -> open: a new episode.
      const before = prior?.issue;
      const issue: Issue = {
        schemaVersion: 1,
        fingerprint: fingerprint(result.tuple),
        detectorVersion: ctx.detectorVersion,
        detectorId: result.tuple.detectorId,
        installationId: result.tuple.installationId,
        subsystem: result.tuple.subsystem,
        ...(result.tuple.engineKind !== null ? { engineKind: result.tuple.engineKind } : {}),
        ...(result.tuple.sourceKey !== null ? { sourceKey: result.tuple.sourceKey } : {}),
        code: result.tuple.errorClass,
        severity: result.triggered,
        state: "open",
        episode: (before?.episode ?? 0) + 1,
        titleKey: result.titleKey,
        firstSeenAt: before?.firstSeenAt ?? now,
        lastSeenAt: now,
        openedAt: now,
        count: (before?.count ?? 0) + Math.max(1, occurrences),
        ...(result.affectedTurns !== undefined ? { affectedTurns: result.affectedTurns } : {}),
        window: result.window,
        metrics: result.metrics,
        evidence: evidence(result),
        coverage,
        relatedFingerprints: related(result),
        ...(result.presentedBy !== undefined ? { presentedBy: result.presentedBy } : {}),
      };
      const record: IssueRecord = { issue, recoveryStartedAt: null, pageDecidedEpisode: prior?.pageDecidedEpisode ?? 0, lastPagedAt: prior?.lastPagedAt ?? null, delivery: "digest" };
      return { record, transition: "opened" };
    }
    // Open or recovering + trigger: same episode. Count only new occurrences; lastSeenAt moves only with new evidence.
    const old = prior.issue;
    const rest: Issue = { ...old };
    delete rest.presentedBy;
    const issue: Issue = {
      ...rest,
      state: "open",
      severity: RANK[result.triggered] > RANK[old.severity] ? result.triggered : old.severity,
      count: old.count + occurrences,
      lastSeenAt: occurrences > 0 ? now : old.lastSeenAt,
      detectorVersion: ctx.detectorVersion,
      window: result.window,
      metrics: result.metrics,
      evidence: occurrences > 0 && result.evidence.length ? evidence(result) : old.evidence,
      coverage,
      relatedFingerprints: related(result).length ? related(result) : old.relatedFingerprints,
      ...(result.affectedTurns !== undefined ? { affectedTurns: result.affectedTurns } : old.affectedTurns !== undefined ? { affectedTurns: old.affectedTurns } : {}),
      ...(result.presentedBy !== undefined ? { presentedBy: result.presentedBy } : {}),
    };
    return { record: { ...prior, issue, recoveryStartedAt: null }, transition: old.state === "recovering" ? "reopened" : "updated" };
  }

  // No trigger.
  if (prior === null || !unresolved(prior)) return { record: prior, transition: "none" };
  const old = prior.issue;
  // Occurrences without a trigger still count while the issue is unresolved (new matching evidence).
  const occurrences = Math.max(0, result.occurrences);
  const base: Issue = { ...old, coverage, count: old.count + occurrences, lastSeenAt: occurrences > 0 && old.state === "open" ? now : old.lastSeenAt };
  if (frozen) return { record: { ...prior, issue: base }, transition: "frozen" };
  if (result.recovery.complete && (old.state === "recovering" || result.recovery.positive)) {
    const issue: Issue = { ...base, state: "resolved", resolution: "observed-recovery", resolvedAt: now };
    return { record: { ...prior, issue, recoveryStartedAt: null }, transition: "resolved" };
  }
  if (old.state === "open" && result.recovery.positive) {
    return { record: { ...prior, issue: { ...base, state: "recovering" }, recoveryStartedAt: now }, transition: "recovering" };
  }
  return { record: { ...prior, issue: base }, transition: "none" };
}

export interface PageDecision {
  record: IssueRecord;
  ledger: PageLedger;
  /** The delivery intent to commit, or null when no new decision was due. */
  intent: { delivery: Delivery; reason: "page" | "cooldown" | "cap" } | null;
}

/** Attempts still inside the rolling window (now - 24 h, now]. */
export function liveAttempts(ledger: PageLedger, now: number): number[] {
  return ledger.attempts.filter(at => at > now - PAGE_CAP_WINDOW_MS && at <= now).slice(-PAGE_CAP);
}

/** Section 8.2: decides page versus digest for an unresolved record after applyResult. */
export function decidePage(record: IssueRecord, result: DetectorResult, ledger: PageLedger, now: number): PageDecision {
  const attempts = liveAttempts(ledger, now);
  const kept: PageLedger = { attempts };
  const issue = record.issue;
  if (issue.state === "resolved") return { record, ledger: kept, intent: null };
  if (!result.pageEligible || result.triggered === null) return { record, ledger: kept, intent: null };
  if (record.pageDecidedEpisode >= issue.episode) return { record, ledger: kept, intent: null };
  const decided = (delivery: Delivery, reason: NonNullable<PageDecision["intent"]>["reason"], next: PageLedger, pagedAt: number | null): PageDecision => ({
    record: { ...record, pageDecidedEpisode: issue.episode, delivery, lastPagedAt: pagedAt ?? record.lastPagedAt },
    ledger: next,
    intent: { delivery, reason },
  });
  if (issue.episode > 1 && record.lastPagedAt !== null && now - record.lastPagedAt < PAGE_COOLDOWN_MS) return decided("digest", "cooldown", kept, null);
  if (attempts.length >= PAGE_CAP) return decided("digest", "cap", kept, null);
  return decided("page", "page", { attempts: [...attempts, now] }, now);
}

/** applyResult followed by decidePage: the one call the scanner core makes per result. */
export function step(prior: IssueRecord | null, result: DetectorResult, ledger: PageLedger, ctx: StepContext): StepOutput & { ledger: PageLedger; intent: PageDecision["intent"] } {
  const applied = applyResult(prior, result, ctx);
  if (applied.record === null || applied.record.issue.state === "resolved") return { ...applied, ledger: { attempts: liveAttempts(ledger, ctx.now) }, intent: null };
  const decision = decidePage(applied.record, result, ledger, ctx.now);
  return { record: decision.record, transition: applied.transition, ledger: decision.ledger, intent: decision.intent };
}
