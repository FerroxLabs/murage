// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-N (179): the loop guard. A bot that runs the same command and gets the same failure five times in one turn is
// told so, once, mid-turn, through the steer path every steer uses (steerBusyDesk: the send fence, the bounded wait,
// "uncertain" never queued). In memory only, per thread: nothing is persisted, a restart starts from none, the turn's
// end settles it. The chip (index.ts, RepeatDetector) is untouched and stays for every engine; this only adds the note
// for engines that can be steered. A refused, uncertain or late steer is never queued and never retried; a key that was
// noted is never noted again in the turn, and a turn gets at most two notes.
//
// Keys (design SL-MN 0b, per engine): name = toolIdentity.name ?? title, never a cut title; args = callArgs(input).
// Claude: title "Bash" + input {command, description}: keyed on the command alone. Codex: "shell" + the command title
// (no input). ACP (fuigo, grok, opencode): the identity + rawInput.command or the canonical rawInput. pi: toolName + args.
import { createHash } from "node:crypto";
import type { RuntimeEvent } from "./contracts.ts";
import { buildPrompt, noneRef, promptPart } from "./memory/prompt-parts.ts";
import { STEER_READY_WAIT_MS, cardSteeringMode, steerBusyDesk } from "./project-card-executor.ts";
import { redactSecretsInText } from "./redact.ts";
import { loopNoticeName } from "../shared/loop-notice.ts";
import { callKey } from "./repeat-detector.ts";

export const LOOP_NUDGE_AT = 5;
export const LOOP_NUDGES_PER_TURN = 2;
export const LOOP_NUDGE_NOTE = "The same command has failed the same way 5 times. Try a different approach, or stop and say what is blocking you.";
export const LOOP_NUDGE_ROW = loopNoticeName("nudged");
const MAX_PER_THREAD = 256;
const MAX_FAILURE_TEXT = 4000;

type SteerAdapter = Parameters<typeof steerBusyDesk>[0];

export interface LoopNudgeDeps {
  /** The watchdog is watching a turn on this thread (turn-watchdog.ts watching). */
  watching(threadId: string): boolean;
  /** The watched turn has a card open for a person (turn-watchdog.ts waitingOnHuman). */
  waitingOnHuman(threadId: string): boolean;
  /** The thread's direct run is being stopped (directRuns phase "stopping"). */
  stopping(threadId: string): boolean;
  /** The thread's bot engine adapter; undefined for a room or an unknown thread. */
  adapter(threadId: string): SteerAdapter;
  /** Record the activity row (LOOP_NUDGE_ROW) once the engine took the note. */
  record(threadId: string): void;
  log?(line: string): void;
  waitMs?: number;
}

type Streak = { callKey: string; count: number; noted: boolean };
type ThreadState = { turnId: string | undefined; calls: Map<string, string>; streaks: Map<string, Streak>; notes: number };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Canonical JSON: keys sorted, strings as given, no whitespace outside strings, no cut. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "";
}

const EMPTY = new Set(["", "{}", "[]", "null", "\"\""]);

/** The call's arguments: a non-empty `command` (the label's own rule, shared/tool-activity.ts); a wrapper's inner input;
 * else the whole input as canonical JSON. With no input, the title only when it reads as a call (whitespace or "/"). */
export function callArgs(input: unknown, title: string | undefined): string | null {
  const record = isRecord(input) ? input : undefined;
  const command = record?.command;
  if (typeof command === "string" && command.trim()) return command;
  const inner = record?.tool_name ?? record?.toolName;
  const value = record && typeof inner === "string" && inner.trim()
    ? record.tool_input ?? record.toolInput ?? record.arguments ?? record.args ?? record.input
    : input;
  const serialised = value === undefined ? "" : canonicalJson(value);
  if (!EMPTY.has(serialised)) return serialised;
  const bare = (title ?? "").trim();
  return /\s|\//.test(bare) ? bare : null;
}

/** The streak key of one started engine tool call, or null when it cannot be told apart from another call. */
export function loopCallKey(event: { title?: string; input?: unknown; toolIdentity?: { name?: string } }): string | null {
  const name = (event.toolIdentity?.name ?? event.title ?? "").trim();
  if (!name) return null;
  const args = callArgs(event.input, event.title);
  return args === null ? null : callKey(name, args);
}

/** The failure text: `detail`, else the text of `result` (Claude: a string or a content array). Undefined when it is
 * absent, empty, or was cut (ACP "\n…", 4,000 and over): unknown text never counts. */
export function loopFailureText(event: { detail?: string; result?: unknown }): string | undefined {
  let text: string | undefined;
  if (event.detail !== undefined) text = event.detail;
  else if (typeof event.result === "string") text = event.result;
  else if (Array.isArray(event.result)) {
    const parts = event.result.flatMap(part => isRecord(part) && typeof part.text === "string" ? [part.text] : []);
    text = parts.length ? parts.join("\n") : undefined;
  } else if (isRecord(event.result) && typeof event.result.exitCode === "number") {
    // Codex (codex.ts:1762): the result is {exitCode}; a zero or fractional code is not a failure we can name
    const code = event.result.exitCode;
    text = Number.isInteger(code) && code !== 0 ? `exit ${code}` : undefined;
  }
  if (typeof text !== "string" || !text.trim() || text.endsWith("\n…") || text.length >= MAX_FAILURE_TEXT) return undefined;
  return text;
}

function bounded<V>(map: Map<string, V>, key: string, value: V) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= MAX_PER_THREAD) map.delete(map.keys().next().value!);
  map.set(key, value);
}

export function createLoopNudge(deps: LoopNudgeDeps) {
  const threads = new Map<string, ThreadState>();
  /** The thread's state for this turn. A different turnId starts a fresh one: nothing carries from a turn that ended. */
  const state = (threadId: string, turnId: string | undefined) => {
    let per = threads.get(threadId);
    if (per && turnId !== undefined && per.turnId !== undefined && per.turnId !== turnId) per = undefined;
    if (!per) threads.set(threadId, (per = { turnId, calls: new Map(), streaks: new Map(), notes: 0 }));
    else if (per.turnId === undefined) per.turnId = turnId;
    return per;
  };
  const staleTurn = (per: ThreadState, turnId: string | undefined) => turnId !== undefined && per.turnId !== undefined && per.turnId !== turnId;

  function delivered(threadId: string, digest: string) {
    deps.record(threadId);
    (deps.log ?? console.log)(`[loop-nudge] nudged after ${LOOP_NUDGE_AT} identical failures (${digest.slice(0, 8)})`);
  }

  function maybeNote(threadId: string, per: ThreadState, streak: Streak, digest: string): Promise<void> | undefined {
    if (streak.count < LOOP_NUDGE_AT || streak.noted || per.notes >= LOOP_NUDGES_PER_TURN) return undefined;
    if (!deps.watching(threadId)) return undefined;
    const adapter = deps.adapter(threadId);
    if (!adapter || cardSteeringMode(adapter) !== "steer") return undefined;
    if (deps.waitingOnHuman(threadId) || deps.stopping(threadId)) return undefined;
    // reserved before the first await: bus subscribers are not awaited, and Fuigo awaits its echo
    streak.noted = true;
    per.notes++;
    const onLate = (late: string) => { if (late === "delivered") delivered(threadId, digest); };
    return steerBusyDesk(adapter, threadId, buildPrompt(undefined, [promptPart(LOOP_NUDGE_NOTE, [noneRef("murage")])]), true, undefined,
      undefined, deps.waitMs ?? STEER_READY_WAIT_MS, onLate)
      .then(outcome => { if (outcome === "steer") delivered(threadId, digest); })
      .catch(() => { /* a refused note is dropped: never queued, never retried */ });
  }

  return {
    /** Feed one bus event. Returns the note's pending send, when one was started (tests await it). */
    observe(event: RuntimeEvent): Promise<void> | undefined {
      if (event.type === "session.exited") { threads.delete(event.threadId); return undefined; }
      if (event.type === "turn.completed") {
        // a stopped turn's late completion must not reset the turn that replaced it
        const current = threads.get(event.threadId);
        if (!current || !staleTurn(current, event.turnId)) threads.delete(event.threadId);
        return undefined;
      }
      if (event.type === "item.started" && event.itemType === "tool" && event.origin === "engine") {
        if (!event.itemId) return undefined;
        const key = loopCallKey(event);
        if (key) bounded(state(event.threadId, event.turnId).calls, event.itemId, key);
        return undefined;
      }
      if (event.type !== "item.completed" || event.itemType !== "tool" || !event.itemId) return undefined;
      const per = threads.get(event.threadId);
      const key = per?.calls.get(event.itemId);
      if (!per || !key || staleTurn(per, event.turnId)) return undefined;
      per.calls.delete(event.itemId);
      if (event.ok) {
        for (const [streakKey, streak] of per.streaks) if (streak.callKey === key) per.streaks.delete(streakKey);
        return undefined;
      }
      const text = loopFailureText(event);
      if (text === undefined) return undefined;
      const digest = createHash("sha256").update(`${key}\n${redactSecretsInText(text)}`).digest("hex");
      const streak = per.streaks.get(digest) ?? { callKey: key, count: 0, noted: false };
      streak.count++;
      bounded(per.streaks, digest, streak);
      return maybeNote(event.threadId, per, streak, digest);
    },
  };
}
