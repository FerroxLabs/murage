// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const CONTRACT_V: 2;
export type Tri = true | false | "unknown";
export type OnOff = "on" | "off" | "unknown";
export type UpgradeSource = "note" | "responder" | "health";
export type UpgradeStage = "starting" | "background" | "blocked" | "idle" | "unknown";
export type UpgradePhaseId = "checking" | "copying" | "migrating" | "search-index" | "output-index" | "references" | "shapes" | "learning" | "lineage" | "writetime" | "marker" | "storage" | "message-index" | "masking" | "settling";
export type CountedUnit = "messages" | "conversations" | "bytes" | "sets" | "open";
export type StoredMode = "off" | "capture" | "active" | "paused" | "unknown";
export type StorageState = "converting" | "reclaim-available" | "waiting-for-disk" | "idle" | "unknown";
export type UpgradeCounts = { exact: true; messages: number; conversations: number; memoryRecords: number; firstMessageAt: number | null } | { exact: false };
export type UpgradeStep = { awakeElapsedMs: number; unit: "none" } | { awakeElapsedMs: number; unit: "open"; done: number } | { awakeElapsedMs: number; unit: Exclude<CountedUnit, "open">; done: number; total: number };
export interface UpgradeState {
  v: 2;
  /** SHA-256 of the server launch's boot nonce, or "unknown". */
  launch: string;
  /** Never goes down within a launch. */
  seq: number;
  source: UpgradeSource;
  stage: UpgradeStage;
  phase: UpgradePhaseId | "none" | "unknown";
  /** 0 to 1 over the whole launch, durable and never lower than shown before; "unknown" when the producer does not know. */
  overall: number | "unknown";
  complete: Tri;
  held: Tri;
  /** A key of the screens' own words, never prose; non-null exactly when held is true. */
  holdKey: string | null;
  capture: OnOff;
  recall: OnOff;
  storedMode: StoredMode;
  counts: UpgradeCounts;
  keepOpen: Tri;
  step: UpgradeStep;
  eta: { stable: true; ms: number } | { stable: false };
  storage: StorageState;
  heartbeatAt: number | null;
  progressAt: number | null;
  blocked: { code: string } | null;
  /** Earlier memory is being checked in the background outside the upgrade's own jobs (a large set's proof in this process): the owner is told so. */
  checking: Tri;
}
export type ParsedUpgradeState = { ok: true; state: UpgradeState } | { ok: false; reason: string };
export const SOURCES: readonly UpgradeSource[];
export const STAGES: readonly UpgradeStage[];
export const PHASE_IDS: readonly UpgradePhaseId[];
export const CONTRACT_KEYS: readonly string[];
export const COUNTED_UNITS: Readonly<Record<string, CountedUnit>>;
export const AWAKE_GAP_CAP_MS: number;
export function buildUpgradeState(input: unknown): UpgradeState;
export function parseUpgradeState(raw: unknown): ParsedUpgradeState;
export function restampUpgradeState(state: UpgradeState, patch: Partial<UpgradeState>): UpgradeState;
export function unknownUpgradeState(overrides?: Partial<UpgradeState>): UpgradeState;
export function createAwakeMeter(cap: number, now?: () => number): { tick(): number; total(): number; reset(): void };
export const UPGRADE_CONTRACT_SOURCE: string;
export function sampleState(over?: Partial<UpgradeState>): UpgradeState;
export function contractFixtures(): Array<{ name: string; kind: string; raw: unknown; valid: boolean; legacy?: boolean }>;
