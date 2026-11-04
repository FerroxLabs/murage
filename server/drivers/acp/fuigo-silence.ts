// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-NO-SILENT-HANG (1.0.15, design r5): a silence watch for a Fuigo bot turn, from the prompt write to settle.
// Pure logic with an injected clock; core.ts feeds it frames and asks it, once a tick, whether a rule is due.
//
// - Progress (a model-rail frame, a hook frame, a fallback turn starting, an answer Murage writes to an engine
//   request) resets lastProgress. Retry frames never do, on either rail; a `retry_state` "failed" opens a grace so
//   Fuigo's own typed error lands first.
// - Local work: compaction and memory flush each have their own clock, set by their start frame and cleared ONLY by
//   their own end frame (r5-2: Fuigo's buffered model frames can arrive after a start, so no other frame clears one).
//   While either is open only the compaction deadline can fire.
// - Running tools: the tool rule (20 min) replaces the silence rule (2 min); every progress frame restarts it.
// - Paused (an open card, or an engine request Murage is still answering): every clock slides, so waiting time never
//   counts and the clocks restart from the answer.
// There is no connect rule: the live capture of 1.0.32 (design r4 "M3 RESULT") showed no "connection failed" reason.

import { boundedEnvMs } from "../env-ms.ts";

export type FuigoWatchRule = "silence" | "tool" | "compact";
export interface FuigoWatchLimits {
  /** no frame for this long, no tool running and no local work open */
  silentMs: number;
  /** a tool running and no progress for this long */
  toolMs: number;
  /** a compaction or memory flush open this long, whatever else arrives */
  compactMs: number;
  /** after a `retry_state` "failed", nothing fires for this long */
  failedGraceMs: number;
}

export const FUIGO_SILENT_MS = 120_000;
export const FUIGO_TOOL_SILENT_MS = 20 * 60_000;
export const FUIGO_COMPACT_SILENT_MS = 20 * 60_000;
export const FUIGO_FAILED_GRACE_MS = 10_000;

/** A knob in ms: "0" turns its rule off; anything not a usable positive number keeps the default. */
const knob = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "0") return 0;
  return boundedEnvMs(raw, fallback);
};

/** Read lazily, per turn, so a fixture can shorten them. */
export const fuigoWatchLimits = (): FuigoWatchLimits => ({
  silentMs: knob("MURAGE_FUIGO_SILENT_MS", FUIGO_SILENT_MS),
  toolMs: knob("MURAGE_FUIGO_TOOL_SILENT_MS", FUIGO_TOOL_SILENT_MS),
  compactMs: knob("MURAGE_FUIGO_COMPACT_SILENT_MS", FUIGO_COMPACT_SILENT_MS),
  failedGraceMs: knob("MURAGE_FUIGO_FAILED_GRACE_MS", FUIGO_FAILED_GRACE_MS),
});

/** How often core.ts asks: once a second, sooner when a fixture shortened a limit. */
export const fuigoWatchTickMs = (limits: FuigoWatchLimits): number => {
  const active = [limits.silentMs, limits.toolMs, limits.compactMs].filter((ms) => ms > 0);
  if (active.length === 0) return 1000;
  return Math.max(20, Math.min(1000, Math.floor(Math.min(...active) / 4)));
};

export type FuigoFrame = "progress" | "compact_start" | "compact_end" | "flush_start" | "flush_end" | "failed" | null;

/** Model-rail updates on `session/update` that are progress. */
const SESSION_UPDATE_PROGRESS = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "tool_call_delta_chunk", "plan"]);
/** Updates on `_fuigo/session_notification` that are progress. */
const NOTIFICATION_PROGRESS = new Set([
  "response_started", "response_completed", "subagent_spawned", "subagent_progress", "subagent_finished", "turn_completed",
  "hook_execution", "hook_annotation",
]);

const isRetryStatusThought = (params: any, update: any): boolean =>
  params?._meta?.["fuigo/retryStatus"] !== undefined || update?._meta?.["fuigo/retryStatus"] !== undefined;

/** What one inbound notification means to the watch. Foreign-session and replayed frames mean nothing; so do steer
 *  echoes, retries (other than "failed"), command lists, titles and every other side channel. */
export function classifyFuigoFrame(msg: any, sessionId: string | null): FuigoFrame {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string" || msg.id !== undefined) return null;
  const params = msg.params ?? {};
  if (typeof params.sessionId === "string" && sessionId && params.sessionId !== sessionId) return null;
  if (params._meta?.isReplay === true) return null;
  const update = params.update;
  const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
  if (msg.method === "session/update") {
    if (!kind || !SESSION_UPDATE_PROGRESS.has(kind)) return null;
    if (kind === "agent_thought_chunk" && isRetryStatusThought(params, update)) return null;
    return "progress";
  }
  if (msg.method !== "_fuigo/session_notification") return null;
  switch (kind) {
    case "retry_state": return update.type === "failed" ? "failed" : null;
    case "auto_compact_started": return "compact_start";
    case "auto_compact_completed":
    case "auto_compact_failed":
    case "auto_compact_cancelled": return "compact_end";
    case "memory_flush_started": return "flush_start";
    case "memory_flush_completed": return "flush_end";
    default: return kind && NOTIFICATION_PROGRESS.has(kind) ? "progress" : null;
  }
}

export class FuigoSilenceWatch {
  lastProgress: number;
  compactSince: number | null = null;
  flushSince: number | null = null;
  failedAt: number | null = null;
  private runningPromptId: string | null = null;
  readonly limits: FuigoWatchLimits;
  private readonly now: () => number;

  // plain fields, no parameter properties: the server runs this file through Node's type stripping
  constructor(limits: FuigoWatchLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.lastProgress = now();
  }

  progress(): void { this.lastProgress = this.now(); }

  frame(kind: FuigoFrame): void {
    const now = this.now();
    switch (kind) {
      case "progress": this.lastProgress = now; break;
      // a repeated start of an open operation keeps its first moment: one operation, one clock
      case "compact_start": if (this.compactSince === null) this.compactSince = now; break;
      case "flush_start": if (this.flushSince === null) this.flushSince = now; break;
      // an end is progress for the ordinary rules and clears only its own clock
      case "compact_end": this.compactSince = null; this.lastProgress = now; break;
      case "flush_end": this.flushSince = null; this.lastProgress = now; break;
      case "failed": this.failedAt = now; break;
    }
  }

  /** `_fuigo/queue/changed`: a prompt (a fallback turn among them) starting to run is progress. */
  queueChanged(params: any, sessionId: string | null): void {
    if (!params || typeof params !== "object") return;
    if (typeof params.sessionId === "string" && sessionId && params.sessionId !== sessionId) return;
    if (params._meta?.isReplay === true) return;
    const running = typeof params.runningPromptId === "string" ? params.runningPromptId : null;
    if (running !== null && running !== this.runningPromptId) this.lastProgress = this.now();
    this.runningPromptId = running;
  }

  /** The rule due now, if any. `paused`: a card is open or Murage is still answering an engine request. */
  check(context: { paused: boolean; toolsRunning: boolean }): FuigoWatchRule | null {
    const now = this.now();
    if (context.paused) {
      this.lastProgress = now;
      if (this.compactSince !== null) this.compactSince = now;
      if (this.flushSince !== null) this.flushSince = now;
      return null;
    }
    if (this.failedAt !== null && now - this.failedAt < this.limits.failedGraceMs) return null;
    const localSince = [this.compactSince, this.flushSince].filter((at): at is number => at !== null);
    if (localSince.length > 0) {
      return this.limits.compactMs > 0 && now - Math.min(...localSince) >= this.limits.compactMs ? "compact" : null;
    }
    const silentFor = now - this.lastProgress;
    if (context.toolsRunning) return this.limits.toolMs > 0 && silentFor >= this.limits.toolMs ? "tool" : null;
    return this.limits.silentMs > 0 && silentFor >= this.limits.silentMs ? "silence" : null;
  }
}
