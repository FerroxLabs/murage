// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Sentinel detector registry (GAP-SENTINEL-109 section 5): S01..S10 in class order, each with its version. The
// scanner core calls runDetectors() once per scan with the persisted per-detector state, and commits every returned
// nextState together with the issue changes in its single commit.
import { DETECTOR_CLASS } from "../../../shared/health-protocol.mjs";
import { DETECTOR_STATE_MAX_BYTES, type Detector, type DetectorId, type DetectorInput, type DetectorResult, type DetectorState, type Subsystem } from "../types.ts";
import { backupDetector } from "./backup.ts";
import { coverageDetector } from "./coverage.ts";
import { deletionDetector } from "./deletion.ts";
import { dispatchDetector } from "./dispatch.ts";
import { engineHoldsDetector } from "./engine-holds.ts";
import { extractionDetector } from "./extraction.ts";
import { ioPressureDetector } from "./io-pressure.ts";
import { isolationNoiseDetector } from "./isolation-noise.ts";
import { resetsDetector } from "./resets.ts";
import { sendFenceDetector } from "./send-fence.ts";

/** Every detector, in class order S01..S10. */
export const DETECTORS: readonly Detector[] = Object.freeze([
  backupDetector, ioPressureDetector, extractionDetector, engineHoldsDetector, deletionDetector,
  sendFenceDetector, dispatchDetector, resetsDetector, isolationNoiseDetector, coverageDetector,
] as Detector[]);

/** Version per detector id. A version change means the scanner core discards that detector's persisted state. */
export const DETECTOR_VERSIONS: Readonly<Record<DetectorId, number>> = Object.freeze(Object.fromEntries(DETECTORS.map(d => [d.id, d.version])) as Record<DetectorId, number>);

/** The subsystem each detector reports under. */
export const DETECTOR_SUBSYSTEM: Readonly<Record<DetectorId, Subsystem>> = Object.freeze({
  backup: "backup", "io-pressure": "storage", extraction: "memory", "engine-holds": "engine", deletion: "deletion",
  "send-fence": "engine", "dispatch-exhausted": "dispatch", resets: "engine", "isolation-noise": "engine", coverage: "monitoring",
});

export const detectorById = (id: DetectorId): Detector | undefined => DETECTORS.find(d => d.id === id);
export const detectorClass = (id: DetectorId): string => DETECTOR_CLASS[id];

/** Persisted detector state as the store keeps it: version-stamped so a detector upgrade starts clean. */
export interface PersistedDetectorState { version: number; state: DetectorState }

export interface DetectorRun {
  id: DetectorId;
  version: number;
  results: readonly DetectorResult[];
  /** The state to persist, or null when it would exceed DETECTOR_STATE_MAX_BYTES (the store then keeps the prior state
   * and the run reports `oversize`). */
  nextState: PersistedDetectorState | null;
  oversize: boolean;
  /** The detector threw: its results are empty and its prior state is kept. Coverage for it is unavailable. */
  failed: boolean;
}

const stateBytes = (state: DetectorState) => Buffer.byteLength(JSON.stringify(state), "utf8");

/** Runs every detector once. Pure apart from catching a detector failure, which never stops the others. A prior state
 * from another detector version is discarded. */
export function runDetectors(input: DetectorInput, prior: Readonly<Partial<Record<DetectorId, PersistedDetectorState>>>): DetectorRun[] {
  const runs: DetectorRun[] = [];
  for (const detector of DETECTORS) {
    const stored = prior[detector.id];
    const previous = stored && stored.version === detector.version ? stored.state : null;
    try {
      const out = detector.evaluate(input, previous);
      const oversize = stateBytes(out.nextState) > DETECTOR_STATE_MAX_BYTES;
      runs.push({ id: detector.id, version: detector.version, results: out.results, nextState: oversize ? null : { version: detector.version, state: out.nextState }, oversize, failed: false });
    } catch {
      runs.push({ id: detector.id, version: detector.version, results: [], nextState: null, oversize: false, failed: true });
    }
  }
  return runs;
}
