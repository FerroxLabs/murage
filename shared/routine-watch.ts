/** An opaque reference, not a permission grant or a selected source backend. */
export interface RoutineWatchSource {
  adapterId: string;
  sourceId: string;
  scopeId: string;
}

export interface RoutineWatchDefinition {
  id: string;
  source: RoutineWatchSource;
  expiresAt: number;
  maxChecks: number;
}

export type RoutineWatchInput = Omit<RoutineWatchDefinition, "id">;

/** The proposing conversation owns the watch, including cross-bot proposals. */
export interface RoutineWatchBinding {
  ownerBotId: string;
  state: RoutineWatchState;
}

export interface RoutineWatchRun {
  watchId: string;
  ownerBotId: string;
  source: RoutineWatchSource;
  outcome: "pending" | "baseline" | "unchanged" | "changed" | "failed" | "abandoned";
}

export interface RoutineWatchObservation {
  /** SHA-256 of canonical relevant source fields, excluding volatile metadata.
   * Raw source content and credentials must not enter the checkpoint ledger. */
  fingerprint: string;
}

/** Future adapters must revalidate current read authority and exact source scope
 * on every call. They must never invoke writes, sends, spending or delegation.
 * The caller persists admission BEFORE read and persists completion BEFORE
 * publishing. This interface neither implements nor establishes those gates. */
export interface RoutineWatchSourceAdapter {
  read(source: Readonly<RoutineWatchSource>, signal: AbortSignal): Promise<RoutineWatchObservation>;
}

export type RoutineWatchCheck =
  | { id: string; outcome: "pending" | "failed" | "abandoned" }
  | { id: string; outcome: "baseline" | "unchanged" | "changed"; fingerprint: string };

/** Retain admitted identities through expiry; never reset usage on resume.
 * The bounded ledger permits durable wake deduplication when the caller saves it. */
export interface RoutineWatchState {
  version: 1;
  definition: RoutineWatchDefinition;
  paused: boolean;
  updatedAt: number;
  checkpoint?: string;
  checks: RoutineWatchCheck[];
}
