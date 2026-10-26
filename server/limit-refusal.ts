// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I1: is this refusal an engine's usage limit, and when does it
// reset? Read from the refusal the engine already reported (its text and,
// where there is one, its HTTP status). No credential and no usage page is
// ever read. A refusal counts only when the engine did nothing in the turn
// yet; the caller checks that (a later refusal fails the turn as before).

export type EngineFamily = "claude" | "codex" | "gateway" | "opencode-go" | "acp" | "openai-chat" | "other";

export function engineFamilyOf(driverKind: string, viaGateway = false): EngineFamily {
  if (viaGateway) return "gateway";
  if (driverKind === "claudeAgent") return "claude";
  if (driverKind === "codex") return "codex";
  if (driverKind === "opencodeGo") return "opencode-go";
  if (/Agent$/.test(driverKind)) return "acp";
  return "openai-chat";
}

/** The base wording (drivers/cli-memory-learning.ts LIMIT), shared by every family. */
const LIMIT = /(?:usage|rate|quota|plan|message|credit)s?[ _-]?(?:limit|cap|exceeded|exhausted|reached)|\b429\b|too many requests|out of (?:credits|usage)|limit (?:reached|resets)|at (?:its|your) limit|hit your (?:usage )?limit/i;
const STATUS_LIMIT = new Set([429, 402]);

export interface LimitRefusal { resetsAt?: number }

function fromJson(text: string, now: number): number | undefined {
  const at = /"resets_at"\s*:\s*(\d{9,13})/.exec(text);
  if (at) { const value = Number(at[1]); return value < 1e12 ? value * 1000 : value; }
  const inSeconds = /"resets_in_seconds"\s*:\s*(\d+)/.exec(text);
  if (inSeconds) return now + Number(inSeconds[1]) * 1000;
  return undefined;
}

function fromDuration(text: string, now: number): number | undefined {
  const match = /try again in ((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[,\s]*(?:and\s+)?)+)/i.exec(text);
  if (!match) return undefined;
  let ms = 0;
  for (const part of match[1].matchAll(/(\d+)\s*(day|hour|min|sec)/gi)) {
    const n = Number(part[1]), unit = part[2].toLowerCase();
    ms += n * (unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : unit === "min" ? 60_000 : 1000);
  }
  return ms > 0 ? now + ms : undefined;
}

/** "resets 3pm", "resets at 7:30 am": the next such local time after now. */
function fromClockTime(text: string, now: number): number | undefined {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!match) return undefined;
  let hour = Number(match[1]) % 12; if (match[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(match[2] ?? 0);
  const at = new Date(now); at.setHours(hour, minute, 0, 0);
  let value = at.getTime(); if (value <= now) value += 86_400_000;
  return value;
}

function fromRetryAfter(text: string, now: number): number | undefined {
  const match = /retry[- ]after[":\s]+(\d+)/i.exec(text);
  return match ? now + Number(match[1]) * 1000 : undefined;
}

/** Structured limit kinds an ACP engine reports beside its prose (Fuigo's error.data.error_kind). */
const LIMIT_KIND = /^(?:rate_limited|rate_limit|quota_exceeded|usage_limit(?:_reached)?|plan_limit(?:_reached)?|insufficient_quota|too_many_requests)$/;

export function limitRefusal(family: EngineFamily, refusal: { status?: number; text?: string | null; kind?: string; code?: string; resetsAt?: number }, now = Date.now()): LimitRefusal | null {
  const text = refusal.text ?? "";
  const byStatus = refusal.status !== undefined && STATUS_LIMIT.has(refusal.status);
  const byCode = family === "opencode-go" && (refusal.code === "QUOTA_EXCEEDED" || /QUOTA_EXCEEDED/.test(text));
  const byKind = refusal.kind !== undefined && LIMIT_KIND.test(refusal.kind);
  if (!byStatus && !byCode && !byKind && !LIMIT.test(text)) return null;
  // a reset time the driver reported as data beats one read from prose
  if (refusal.resetsAt !== undefined && Number.isFinite(refusal.resetsAt)) return { resetsAt: refusal.resetsAt };
  let resetsAt: number | undefined;
  switch (family) {
    case "claude": {
      // "Claude AI usage limit reached|1760000000", or "5-hour limit reached ∙ resets 3pm"
      const pipe = /limit reached\|(\d{9,13})/i.exec(text);
      resetsAt = pipe ? (Number(pipe[1]) < 1e12 ? Number(pipe[1]) * 1000 : Number(pipe[1])) : fromClockTime(text, now);
      break;
    }
    case "codex": resetsAt = fromJson(text, now) ?? fromDuration(text, now) ?? fromClockTime(text, now); break;
    case "gateway": resetsAt = fromJson(text, now) ?? fromRetryAfter(text, now); break;
    case "openai-chat": resetsAt = fromRetryAfter(text, now) ?? fromJson(text, now); break;
    default: resetsAt = fromJson(text, now) ?? fromDuration(text, now) ?? fromClockTime(text, now);
  }
  return resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {};
}
