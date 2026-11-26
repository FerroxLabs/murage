// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// Usage rings contract (DESIGN 1021-usage-rings sec 6), frozen by slice C0. Owners: producer side =
// PU, R1, R2, R3; consumer side = R4, RF; allowance producer = the Settings Flux allowance lane. Every
// figure is what an engine or the existing allowance source reported; unknown stays null.

import type { PlanSource } from "./plan-usage";

export interface RingWindow {
  label: "five-hour" | "weekly" | "key-allowance" | "other";
  scope: "account" | "model";
  model: string | null;
  leftPercent: number | null;
  reached: boolean;
  resetsAt: number | null;
  expiresAt: number | null;
  source: PlanSource | "flux-allowance";
  observedAt: number;
}

export type FluxAllowanceWindow = RingWindow & {
  label: "key-allowance";
  scope: "account";
  model: null;
  reached: false;
  source: "flux-allowance";
  resetsAt: null;
};

export type FluxAllowanceSnapshotV1 =
  | { version: 1; state: "ok"; budgetUsd: number; spentUsd: number; remainingUsd: number; observedAt: number; freshUntil: number }
  | { version: 1; state: "unavailable" };

export interface FluxNote {
  kind: "flux";
  allowance: FluxAllowanceSnapshotV1;
  month: { state: "ok"; spentUsd: number } | { state: "checking" | "multi-key" };
  personalLimitUsd: number | null;
}

/** Never null; the personal limit is note-only. */
export interface FluxRingPart {
  windows: FluxAllowanceWindow[];
  note: FluxNote;
}

export type RingNote =
  | { kind: "native"; engine: "codex" | "claude"; observedAt: number }
  | { kind: "refusal"; at: number; resetsAt: number | null }
  | { kind: "claude-waiting" }
  | { kind: "api-key"; tokens: number; more: boolean }
  | FluxNote;

export interface RingAccount {
  who: { kind: "owner" } | { kind: "bot"; name: string };
  /** At most PLAN_WINDOWS_MAX. */
  windows: RingWindow[];
  status: "current" | "stale" | "waiting";
  freshUntil: number | null;
  note: RingNote | null;
}

export interface UsageRing {
  leftPercent: number | null;
  reached: boolean;
  modelMark: boolean;
  stale: boolean;
}

export interface RingModel {
  /** Opaque: sha256(engineKey).slice(0, 12); never a subject key. */
  ringId: string;
  engineKind: string;
  order: number;
  displayName: string;
  billing: "own-subscription" | "own-key" | "flux" | "unknown";
  /** ringOf(owner account). */
  ring: UsageRing | null;
  /** Owner first, then bots; at most PLAN_SUBJECTS_MAX. */
  accounts: RingAccount[];
  subjectsOmitted: number;
  busyUntil: number | null;
  /** From the live hold file; never reached. */
  pausedUntil: number | null;
}

/** GET /api/usage-rings. */
export interface UsageRingsResponse {
  /** At most 32. */
  rings: RingModel[];
  omitted: number;
  pausesOmitted: number;
  pausesUnavailable: boolean;
  serverNow: number;
  rev: number;
}

/** Data-only SSE frame with no "id:" line: no reading, no engine name, no sequence. */
export interface UsageRingsChangedFrame {
  kind: "usageRingsChanged";
  rev: number;
}

export interface UsageRingCardProps {
  model: RingModel;
  serverNow: number;
  threshold: number;
}

/** Server-only: the turn's process. */
export interface PlanSpawnFacts {
  subjectKey: string;
  revision: string;
  generation: number;
  account: number;
}

/** Server-only; never sent or logged. */
export interface PlanProof {
  subjectKey: string;
  revision: string;
  account: number;
  source: number;
}

/** The plan-usage service additions PU implements (type-only freeze). */
export interface PlanUsageRingSource {
  /** At most 4 listeners, called synchronously. */
  onChange(listener: (subjectKey: string) => void): () => void;
  /** Pure: that generation is a registered, current handle, else null. */
  proveRefusal(facts: PlanSpawnFacts): PlanProof | null;
  /** Pure: the ledger exists and its revision, account and source all equal the proof's. */
  proofCurrent(proof: PlanProof): boolean;
}

/** The Flux allowance peek FA implements: no I/O or mutation. */
export type PeekFluxAllowance = (key: string, now: number) => FluxAllowanceSnapshotV1;

export function expireRingAccount(account: RingAccount, now: number): RingAccount {
  const flux = account.note?.kind === "flux" ? account.note : null;
  const fresh = account.freshUntil === null || now < account.freshUntil;
  const fluxFresh = fresh && flux?.allowance.state === "ok" && now < flux.allowance.freshUntil;
  const windows = account.windows.filter(window =>
    (window.expiresAt === null || now < window.expiresAt) && (window.source !== "flux-allowance" || fluxFresh)
  );

  if (flux) {
    const hasAllowance = windows.some(window => window.source === "flux-allowance");
    return {
      ...account,
      windows,
      status: windows.length ? "current" : "waiting",
      note: hasAllowance ? flux : { ...flux, allowance: { version: 1, state: "unavailable" } },
    };
  }
  const status = account.status === "current" && !fresh ? "stale" : account.status;
  return { ...account, windows, status };
}

export function ringOf(account: RingAccount, _threshold: number, now: number): UsageRing | null {
  const { windows, status } = expireRingAccount(account, now);
  let window: RingWindow | undefined;
  for (const candidate of windows) {
    if (candidate.scope !== "account") continue;
    if (!window || tighter(candidate.leftPercent, window.leftPercent)) window = candidate;
  }
  if (!window) return null;
  const { leftPercent } = window;
  const reached = windows.some(candidate => candidate.scope === "account" && candidate.reached);
  return {
    leftPercent,
    reached,
    modelMark: !reached && leftPercent !== null && leftPercent > 0 &&
      windows.some(candidate => candidate.scope === "model" && candidate.reached),
    stale: status === "stale",
  };
}

function tighter(left: number | null, than: number | null): boolean {
  return left != null && (than == null || left < than);
}

export function ringIsWarning(ring: UsageRing | null, threshold: number): boolean {
  const leftPercent = ring?.leftPercent;
  return leftPercent != null && 100 - leftPercent >= threshold;
}
