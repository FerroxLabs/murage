// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Durable evidence is independent of retained rows and promise settlement. */
export function evidenceLedger({ results, writeResults, setExitCode }) {
  const obligations = new Map();
  let sealed = false;
  const latch = reason => {
    results.legFailed = true;
    results.status = "FAIL";
    results.legFailureReason ??= reason;
    const reasons = results.evidenceFailures ??= [];
    if (!reasons.includes(reason)) reasons.push(reason);
    setExitCode(1);
  };
  const save = () => {
    if (sealed) return false;
    if (results.evidenceFailures?.length) { results.legFailed = true; results.status = "FAIL"; }
    try { writeResults(); return true; }
    catch (error) {
      results.evidencePersistenceFailed = true;
      if (results.phase === "finished") results.phase = "cleanup";
      latch(`failed-turn results save failed: ${errno(error)}`);
      return false;
    }
  };
  const fail = reason => { latch(reason); save(); }; // synchronous, guarded; no scheduled save
  return {
    save, fail, obligations,
    observe(key, due = false) {
      if (sealed) return;
      const row = obligations.get(key) ?? { first: false, enriched: false, due: false };
      row.due ||= due;
      obligations.set(key, row);
    },
    written(key, kind) {
      if (!sealed && obligations.has(key)) obligations.get(key)[kind] = true;
    },
    audit() {
      const missingFirst = [...obligations.values()].filter(row => !row.first).length;
      const missingEnriched = [...obligations.values()].filter(row => row.due && !row.enriched).length;
      if (missingFirst) fail(`failed-turn journal incomplete: ${missingFirst} first records`);
      if (missingEnriched) fail(`failed-turn enrichment incomplete: ${missingEnriched} pending`);
    },
    async finish({ shutdown, drain, complete }) {
      await shutdown(); // producers must have stopped before the final audit/save
      await drain();
      this.audit();
      complete(!results.evidencePersistenceFailed);
      save();
      sealed = true;
      return results.legFailed || results.evidencePersistenceFailed ? 1 : 0;
    },
    // A controlled early exit and an unexpected synchronous exit both retry the
    // latched failure. After finish(), the final save is already the last write.
    beforeExit(code) {
      if (!sealed) { this.audit(); save(); }
      return results.legFailed || results.evidencePersistenceFailed ? (code || 1) : code;
    },
  };
}

const errno = error => typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";

/** Close is part of success, even after a successful fsync. No error escapes SSE. */
export function writeEvidence(record, { serialize = JSON.stringify, open, append, fsync, close, fail }) {
  let fd, failure = null;
  try {
    const line = serialize(record);
    if (typeof line !== "string") throw Error("record did not serialize");
    fd = open();
    append(fd, line + "\n");
    fsync(fd);
  } catch (error) { failure = error; fail(`failed-turn journal write failed: ${errno(error)}`); }
  finally {
    if (fd !== undefined) try { close(fd); }
    catch (error) { failure = error; fail(`failed-turn journal write failed: ${errno(error)}`); }
  }
  return failure === null;
}
