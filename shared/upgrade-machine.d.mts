// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpgradeState, Tri, OnOff, StoredMode, StorageState } from "./upgrade-contract.mjs";
export const DONE_SHOWN_MS: number;
export const NEUTRAL_AFTER_MS: number;
export const ETA_MIN_PHASE_MS: number;
export const ETA_MIN_FRACTION: number;
export const POLL_VISIBLE_MS: number;
export const POLL_HIDDEN_MS: number;
export const POLL_UNSETTLED_MS: number;
export type MachineMode = "unknown" | "blocking" | "working" | "held" | "finishing" | "idle" | "reclaim";
export interface MachineContext {
  family: "window" | "app"; mode: MachineMode; modeBeforeHold: MachineMode | null; now: number; lastEventAt: number | null; lastGoodAt: number | null;
  launch: string | null; retired: string[]; seq: number; ignored: number; missed: number; legacy: boolean;
  overallHigh: number; overallSeen: boolean; resumeAbove: number; legacyWorking: boolean; runAwakeMs: number; stage: string; phase: string; step: UpgradeState["step"]; counts: UpgradeState["counts"]; copy: { done: number; total: number } | null;
  gate: import("./upgrade-wait.mjs").EtaGateState; etaMinutes: number | null; slow: boolean; advance: { signature: string | null; movedAt: number | null };
  keepOpen: boolean; held: Tri; holdKey: string | null; capture: OnOff; recall: OnOff; storedMode: StoredMode; storage: StorageState; complete: Tri; checking: Tri;
  doneAt: number | null; ready: boolean; pollNow: boolean; suspendedAt: number | null;
}
export type MachineEvent =
  | { type: "READING"; at: number; state: UpgradeState; copy?: { done: number; total: number } | null }
  | { type: "MALFORMED"; at: number; reason: string; pending?: boolean }
  | { type: "READ_FAILED" | "TICK" | "SUSPEND" | "RESUME" | "RECONNECT" | "VISIBLE" | "TURN"; at: number }
  | { type: "LISTEN"; at: number; ready?: boolean }
  | { type: "LIFECYCLE"; at: number; state?: string }
  | { type: "POLL_STARTED" };
export function initialContext(family?: "window" | "app"): MachineContext;
export function reduce(ctx: MachineContext, event: MachineEvent): MachineContext;
export interface Counter { unit: "messages" | "conversations" | "bytes" | "sets" | "open"; done: number; total?: number }
export interface WindowView { mode: "counting" | "blocking" | "slow" | "finishing"; percent: number | null; indeterminate: boolean; keepOpen: boolean; counts: { exact: true; messages: number; conversations: number; memoryRecords: number; firstMessageAt: number | null } | null; counter: Counter | null; phaseId: string; elapsedMs: number | null; etaMinutes: number | null; slow: boolean; late: boolean; longSlow: boolean; neutral: boolean }
export interface StripSelection { kind: "working" | "done" | "hold"; role: "status" | "alert"; holdKey: string | null; percent: number | null; phaseId: string | null; left: number | null; counter: Counter | null; elapsedMs?: number | null; slow: boolean; neutral: boolean }
export function selectPoll(ctx: MachineContext, options?: { hidden?: boolean }): { active: boolean; intervalMs: number; now: boolean };
export function selectWindow(ctx: MachineContext): WindowView | null;
export function selectStrip(ctx: MachineContext): StripSelection | null;
export function selectDetail(ctx: MachineContext): StripSelection | null;
export type SettingsKey = "held" | "off" | "paused" | "pausedNoted" | "capture" | "active" | "on";
export function selectSettingsDescription(ctx: MachineContext, endpoint?: { mode?: string; held?: boolean; capture?: string; recall?: string } | null): SettingsKey;
export function selectReclaim(ctx: MachineContext): { storage: StorageState; converting: boolean; offer: boolean; waiting: boolean };
