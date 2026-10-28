// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S01, backups never completing (GAP-SENTINEL-109 section 5, class 1). Reads only the backup status manifest.
// Due dates use UTC `now`. Off is an intentional policy state, never a fault; disabling backups retires open issues
// as policy-ended, never as recovered. Only "no current verified backup" can page.
import type { BackupStatus } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult } from "../types.ts";
import { HOUR, MINUTE, makeResult, toCoverage, tupleOf, worseCoverage } from "./common.ts";

export const BACKUP_VERSION = 2;
/** No current-binding verified receipt this long after backups were configured: High, page. */
export const BACKUP_FIRST_VERIFY_MS = 24 * HOUR;
/** A due occurrence still unverified this long after it fell due: High (strictly after). */
export const BACKUP_DUE_GRACE_MS = 6 * HOUR;
/** Latest verification older than this: High (strictly older). */
export const BACKUP_MAX_AGE_MS = 48 * HOUR;
/** A capture this far past its published deadline: High (at or past). */
export const BACKUP_CAPTURE_OVERRUN_MS = 5 * MINUTE;

export const BACKUP_CLASSES = ["not-protected", "overdue", "capture-stalled"] as const;
export type BackupClass = (typeof BACKUP_CLASSES)[number];

export type BackupState = {
  /** Occurrence keys already counted, per class, so a failure counts once per policy revision and job. */
  counted: { readonly [cls: string]: string };
  /** verifiedAt when overdue last triggered: recovery needs a newer verification. */
  overdueBase: number | null;
  /** Deadline of the capture that stalled: recovery needs a verification after it. */
  stalledDeadline: number | null;
  /** Newest receipt time (any binding) when not-protected last triggered: recovery needs a current receipt newer than it,
   * so a binding that comes back never turns an old receipt into a recovery. */
  protectedBase: number | null;
  /** The published next occurrence once it fell due unverified, kept while its policy holds: a manifest that stops
   * updating can never hide an obligation that came due after it was written. */
  keptDue: { policyRevision: number; at: number } | null;
};

const EMPTY: BackupState = { counted: {}, overdueBase: null, stalledDeadline: null, protectedBase: null, keptDue: null };

/** A verified receipt under a binding the producer checked and found current. Unknown (null) is never current. */
function hasCurrent(status: BackupStatus): boolean {
  return status.lastVerified !== null && status.currentBindingMatches === true;
}

export const backupDetector: Detector<BackupState> = {
  id: "backup",
  version: BACKUP_VERSION,
  evaluate(input: DetectorInput, prior: BackupState | null) {
    const state: BackupState = { ...EMPTY, ...(prior ?? {}) };
    const counted: Record<string, string> = { ...state.counted };
    let { overdueBase, stalledDeadline, protectedBase, keptDue } = state;
    const now = input.now;
    const raw = input.backupStatus;
    const status = raw !== null && raw.installationId === input.installationId ? raw : null;
    const coverage: Coverage = status === null ? "unavailable" : toCoverage(status.coverage) === "not-applicable" ? "complete" : toCoverage(status.coverage);
    const tuple = (cls: BackupClass) => tupleOf(input.installationId, "backup", "backup", null, null, cls);
    const evidence = status === null ? [] : [{ sourceRole: "backup" as const, generation: status.revision, observedAt: status.at }];
    const window = { startAt: status?.configuredAt ?? now, endAt: now };
    const baseMetrics = (): Record<string, number> => {
      const m: Record<string, number> = {};
      if (status?.lastVerified) m.verifiedAgeMin = Math.max(0, Math.floor((now - status.lastVerified.verifiedAt) / MINUTE));
      if (status) m.waitingOwner = status.phase === "waiting-owner" ? 1 : 0;
      return m;
    };
    const results: DetectorResult[] = [];
    const occurrence = (cls: BackupClass, key: string) => {
      if (counted[cls] === key) return 0;
      counted[cls] = key;
      return 1;
    };

    // Unknown input: no trigger, no recovery, every class reports its coverage.
    if (status === null || coverage === "unavailable") {
      for (const cls of BACKUP_CLASSES) {
        results.push(makeResult({ tuple: tuple(cls), triggered: null, occurrences: 0, positive: false, complete: false, coverage: "unavailable", titleKey: `health.backup.${cls}`, window, metrics: {}, evidence }));
      }
      return { results, nextState: { counted, overdueBase, stalledDeadline, protectedBase, keptDue } };
    }

    // Policy off: retire as policy-ended. Never shown as recovered.
    if (!status.enabled) {
      for (const cls of BACKUP_CLASSES) {
        results.push(makeResult({ tuple: tuple(cls), triggered: null, occurrences: 0, positive: false, complete: false, coverage, retired: "policy-ended", titleKey: `health.backup.${cls}`, window, metrics: baseMetrics(), evidence }));
      }
      return { results, nextState: { ...EMPTY } };
    }

    const current = hasCurrent(status);
    const verifiedAt = current ? status.lastVerified!.verifiedAt : null;
    // The receipt the age and due checks measure: any receipt whose binding is not known to have changed (an unknown
    // binding still ages; a changed one is the not-protected class's to report).
    const receiptAt = status.lastVerified !== null && status.currentBindingMatches !== false ? status.lastVerified.verifiedAt : null;
    const bindingUnknown = status.lastVerified !== null && status.currentBindingMatches === null;
    const canRecover = coverage === "complete";

    // The obligation the overdue rule measures: the published dueAt, or the published next occurrence once it has come
    // due unverified (also when the manifest stopped updating), kept until verified or until its policy changes.
    if (keptDue !== null && (keptDue.policyRevision !== status.policyRevision || (receiptAt !== null && receiptAt >= keptDue.at))) keptDue = null;
    if (status.nextDueAt !== null && status.nextDueAt <= now && !(receiptAt !== null && receiptAt >= status.nextDueAt) && (keptDue === null || status.nextDueAt < keptDue.at)) {
      keptDue = { policyRevision: status.policyRevision, at: status.nextDueAt };
    }
    const dueCandidates = [status.dueAt, keptDue?.at ?? null].filter((v): v is number => v !== null);
    const dueAt = dueCandidates.length ? Math.min(...dueCandidates) : null;

    // Not protected: no current-binding verified receipt, and an explicit capture failure or 24 h since configuring.
    // A receipt whose binding could not be checked is not current protection, but its 24 h rule waits for the check.
    {
      const explicitFailure = status.failureCode !== undefined && status.failureAt !== undefined;
      const elapsed = status.configuredAt !== null && now >= status.configuredAt + BACKUP_FIRST_VERIFY_MS;
      const triggered = !current && (explicitFailure || (elapsed && !bindingUnknown));
      let occurrences = 0;
      if (triggered) {
        occurrences = occurrence("not-protected", explicitFailure ? `${status.policyRevision}:f:${status.failureAt}` : `${status.policyRevision}:elapsed`);
        protectedBase = Math.max(protectedBase ?? 0, status.lastVerified?.verifiedAt ?? 0);
      }
      const recovered = !triggered && current && canRecover && (protectedBase === null || verifiedAt! > protectedBase);
      const metrics = baseMetrics();
      if (status.configuredAt !== null) metrics.sinceConfiguredMin = Math.max(0, Math.floor((now - status.configuredAt) / MINUTE));
      metrics.explicitFailure = explicitFailure ? 1 : 0;
      if (bindingUnknown) metrics.bindingUnknown = 1;
      results.push(makeResult({
        tuple: tuple("not-protected"), triggered: triggered ? "high" : null, occurrences, positive: recovered, complete: recovered,
        coverage: bindingUnknown ? worseCoverage(coverage, "partial") : coverage, pageEligible: triggered, titleKey: "health.backup.not-protected", window, metrics, evidence,
      }));
      if (recovered) protectedBase = null;
    }

    // Overdue: a prior matching receipt exists, but the due occurrence is unverified 6 h on, or the receipt is over 48 h old.
    {
      const verifiedAt = receiptAt;
      const dueMissed = verifiedAt !== null && dueAt !== null && now > dueAt + BACKUP_DUE_GRACE_MS && verifiedAt < dueAt;
      const tooOld = verifiedAt !== null && now - verifiedAt > BACKUP_MAX_AGE_MS;
      const triggered = dueMissed || tooOld;
      let occurrences = 0;
      if (triggered) {
        occurrences = occurrence("overdue", dueMissed ? `${status.policyRevision}:due:${dueAt}` : `${status.policyRevision}:age:${verifiedAt}`);
        overdueBase = verifiedAt;
      }
      const recovered = !triggered && current && verifiedAt !== null && (overdueBase === null || verifiedAt > overdueBase) && canRecover;
      const metrics = baseMetrics();
      if (dueAt !== null) metrics.pastDueMin = Math.max(0, Math.floor((now - dueAt) / MINUTE));
      results.push(makeResult({
        tuple: tuple("overdue"), triggered: triggered ? "high" : null, occurrences, positive: recovered, complete: recovered,
        coverage, titleKey: "health.backup.overdue", window: { startAt: dueAt ?? window.startAt, endAt: now }, metrics, evidence,
      }));
      if (recovered) overdueBase = null;
    }

    // Capture stalled: still capturing 5 min or more past its published deadline.
    {
      const deadline = status.captureDeadlineAt;
      const running = status.phase === "capturing" || status.phase === "verifying";
      const triggered = running && deadline !== undefined && now >= deadline + BACKUP_CAPTURE_OVERRUN_MS;
      let occurrences = 0;
      if (triggered) {
        occurrences = occurrence("capture-stalled", `${status.policyRevision}:d:${deadline}`);
        stalledDeadline = deadline!;
      }
      const recovered = !triggered && verifiedAt !== null && stalledDeadline !== null && verifiedAt > stalledDeadline && canRecover;
      const metrics = baseMetrics();
      if (deadline !== undefined) metrics.pastDeadlineMin = Math.max(0, Math.floor((now - deadline) / MINUTE));
      results.push(makeResult({
        tuple: tuple("capture-stalled"), triggered: triggered ? "high" : null, occurrences, positive: recovered, complete: recovered,
        coverage, titleKey: "health.backup.capture-stalled", window: { startAt: deadline ?? window.startAt, endAt: now }, metrics, evidence,
      }));
      if (recovered) stalledDeadline = null;
    }

    return { results, nextState: { counted, overdueBase, stalledDeadline, protectedBase, keptDue } };
  },
};
