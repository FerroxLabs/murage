// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Front-matter fallback for Sentinel (1.0.9, GAP-SENTINEL-109 sections 4.1, 4.2 and 5: S09). The Claude isolation scan
// switches a personal agent or skill off by its file name when its front matter gives no usable name; that is normal and
// is only counted, by fixed code. One `isolation` fact per scan says it completed and how many fallbacks it used, under
// one launch token per engine for the producer process. Nothing here reads a file, keeps a file name or exports one.
import { randomUUID } from "node:crypto";
import type { EngineKind, FrontMatterFallbackCode } from "../../shared/health-protocol.mjs";
import { deriveToken, recordCounter, recordFact } from "./counters.ts";

let fallbacks = 0;
/** One launch identity per engine for this producer process: every isolation scan of a run (auth probe, review,
 *  learning call) reports under it, so S09 follows one launch instead of opening and retiring an issue per call. */
const launches = new Map<EngineKind, string>();
const launchOf = (engineKind: EngineKind): string => {
  let raw = launches.get(engineKind);
  if (raw === undefined) { raw = randomUUID(); launches.set(engineKind, raw); }
  return raw;
};

/** One fallback to the file name, by fixed code. */
export function noteFrontMatterFallback(code: FrontMatterFallbackCode, engineKind: EngineKind = "claude"): void {
  fallbacks++;
  recordCounter("isolation-noise", code, engineKind);
}

/** Wraps one launch's isolation scan: the fallbacks counted while it ran become that launch's fact. A scan that throws is
 *  reported as not completed and the error goes on unchanged. */
export function observeIsolationScan<T>(engineKind: EngineKind, scan: () => T): T {
  const before = fallbacks;
  let completed = false;
  try {
    const result = scan();
    completed = true;
    return result;
  } finally {
    try {
      if (completed) recordCounter("isolation-noise", "scan-completed", engineKind);
      recordFact({ kind: "isolation", engineKind, launchToken: deriveToken("launch", launchOf(engineKind)), completedScan: completed, fallbackDelta: Math.max(0, fallbacks - before) });
    } catch { /* telemetry never changes the operation it observes */ }
  }
}
