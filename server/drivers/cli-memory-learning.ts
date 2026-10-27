// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Learning for a person signed in only to a CLI or ACP engine (Claude Code, Codex, other ACP engines; design r2.10 and r3.7).
// `withCliMemoryLearning` gives such an instance BOTH `extractMemory` and `groundMemory`, with the prompt and output contracts of
// openai-compat (memory/extract.ts: memoryExtractionMessages, memoryGroundingMessages), and routes `dispatch.purpose` to the
// inference contract the way requestMemoryInference does (same output caps). Each call is one background session of the signed-in
// engine: JSON out, an empty working directory, no MCP mounts, a bounded answer.
//
// Pacing (the engine spends the person's own subscription): one extraction session at a time per engine; it starts only while the
// engine has no interactive turn, and waits otherwise; a limit or refusal reaches the caller as an error carrying `status`
// (429 and `limit` for a limit, 401 for a sign-in the engine refused), which extractor-connections.ts turns into a pause with a
// plain status line ("Learning waits while <engine> is at its limit").
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import {
  CONTINUITY_OUTPUT_CAP, CONTINUITY_REQUEST_TIMEOUT_MS, memoryExtractionMessages, memoryGroundingMessages,
  type MemoryExtractionDispatch, type MemoryGroundingInput,
} from "../memory/extract.ts";
import { safeWipe } from "../testing/safe-wipe.mjs";

/** Read through the registry's proxies: this instance learns on the person's own CLI or ACP login (ranked after Flux and API connections). */
export const CLI_LEARNING = Symbol.for("murage.cli-memory-learning");
export const isCliLearningInstance = (instance: unknown): boolean => Boolean(instance && (instance as Record<symbol, unknown>)[CLI_LEARNING] === true);

/** Thread ids of the hidden sessions below; the server ignores their events like the Chief proposal's (index.ts shouldIgnoreProviderEvent). */
export const MEMORY_LEARNING_THREAD_PREFIX = "memory-learning-";
export const isMemoryLearningThread = (threadId: string): boolean => threadId.startsWith(MEMORY_LEARNING_THREAD_PREFIX);

const MAX_SOURCE_BYTES = 65_536;
const MAX_ANSWER_BYTES = 65_536;
const LIMIT = /(?:usage|rate|quota|plan|message|credit)s?[ _-]?(?:limit|cap|exceeded|exhausted|reached)|\b429\b|too many requests|out of (?:credits|usage)|limit (?:reached|resets)|at (?:its|your) limit/i;
const SIGNED_OUT = /not (?:logged|signed) in|log ?in required|sign ?in required|unauthori[sz]ed|invalid.{0,20}(?:credential|api key)|authentication|\b40[13]\b/i;

/** The error a limit or a refused sign-in becomes. `status` 429 + `limit` is a pause for a while; 401 is the existing refusal. */
export function engineFailure(message: string, detail = ""): Error {
  const words = `${message} ${detail}`;
  if (LIMIT.test(words)) return Object.assign(new Error("MEMORY_ENGINE_LIMIT"), { status: 429, limit: true });
  if (SIGNED_OUT.test(words)) return Object.assign(new Error("MEMORY_ENGINE_REFUSED"), { status: 401 });
  return new Error("MEMORY_EXTRACTION_REQUEST_FAILED");
}

/** One background session: the whole prompt in, the engine's answer text out. */
export type MemorySessionRunner = (prompt: string, signal: AbortSignal, limits: { maxBytes: number }) => Promise<string>;

export interface CliMemoryLearningOptions {
  /** How one session runs. Default: a hidden tool-free turn on the instance's adapter in an empty folder. */
  run?: (instance: ProviderInstance) => MemorySessionRunner;
}

type Message = Readonly<{ role: string; content: string }>;
export const flattenMemoryMessages = (messages: ReadonlyArray<Message>): string =>
  [...messages.map(m => `[${m.role}]\n${m.content}`),
    "[reply]\nAnswer with the JSON the instructions ask for and nothing else: no commentary, no code fences, no tools."].join("\n\n");

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/** Attach extractMemory and groundMemory to a CLI or ACP instance (mutates and returns it). */
export function withCliMemoryLearning<T extends ProviderInstance>(live: T, options: CliMemoryLearningOptions = {}): T {
  const adapter = live.adapter;
  const interactive = new Set<string>();
  const idle: Array<() => void> = [];
  const wake = () => { if (interactive.size === 0) for (const resume of idle.splice(0)) resume(); };
  const unsubscribe = adapter.onEvent((event: RuntimeEvent) => {
    if (isMemoryLearningThread(event.threadId)) return;
    if (event.type === "turn.started") interactive.add(event.threadId);
    else if (event.type === "turn.completed" || event.type === "session.exited") { interactive.delete(event.threadId); wake(); }
  });
  const runner = (options.run ?? hiddenTurnRunner)(live);

  const untilIdle = async (signal: AbortSignal): Promise<void> => {
    while (interactive.size > 0) {
      if (signal.aborted) throw new Error("MEMORY_EXTRACTION_ABORTED");
      await new Promise<void>(resolve => {
        const done = () => { signal.removeEventListener("abort", done); resolve(); };
        idle.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  };
  // One session at a time on this engine.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <R>(work: () => Promise<R>): Promise<R> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  const session = (text: string, maximumOutputTokens: number, signal: AbortSignal, messages: ReadonlyArray<Message>, cap: number): Promise<string> => {
    if (!text.trim() || Buffer.byteLength(text) > MAX_SOURCE_BYTES || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1 || maximumOutputTokens > cap)
      return Promise.reject(new Error("MEMORY_EXTRACTION_LIMIT"));
    const maxBytes = Math.min(MAX_ANSWER_BYTES, Math.max(4_096, maximumOutputTokens * 8));
    return exclusive(async () => {
      await untilIdle(signal);
      if (signal.aborted) throw new Error("MEMORY_EXTRACTION_ABORTED");
      const answer = stripFence(await runner(flattenMemoryMessages(messages), signal, { maxBytes }));
      if (!answer || Buffer.byteLength(answer) > maxBytes) throw new Error(answer ? "MEMORY_EXTRACTION_RESPONSE_LIMIT" : "MEMORY_EXTRACTION_EMPTY_REPLY");
      return answer;
    });
  };

  live.extractMemory = (text, maximumOutputTokens, signal, dispatch?: MemoryExtractionDispatch) => {
    if (!dispatch?.purpose) return session(text, maximumOutputTokens, signal, dispatch?.messages ?? memoryExtractionMessages(text), 2000);
    // the inference contract: the host's own messages, the purpose's output cap (extract.ts requestMemoryInference)
    const cap = dispatch.purpose === "reflection" ? 8000 : dispatch.purpose === "continuity" ? CONTINUITY_OUTPUT_CAP : 2000;
    return session(text, maximumOutputTokens, signal, dispatch.messages, cap);
  };
  live.groundMemory = (input: MemoryGroundingInput, maximumOutputTokens, signal) =>
    session(JSON.stringify(input), maximumOutputTokens, signal, memoryGroundingMessages(input), 2000);
  Object.defineProperty(live, CLI_LEARNING, { value: true, enumerable: false });

  const dispose = live.dispose.bind(live);
  live.dispose = async () => { unsubscribe(); for (const resume of idle.splice(0)) resume(); await dispose(); };
  return live;
}

const ANSWER_TEXT_LIMIT = MAX_ANSWER_BYTES * 2;

/** The default session for engines that only offer a turn (Codex, ACP): one hidden turn on a thread that exists nowhere else, in an
 * empty temporary folder, with no integrations mounted, the most restrictive mode the engine offers, every ask denied, and the
 * engine's retained session for the thread retired when it ends. */
export const hiddenTurnRunner = (live: ProviderInstance): MemorySessionRunner => async (prompt, signal, { maxBytes }) => {
  const adapter = live.adapter;
  const threadId = `${MEMORY_LEARNING_THREAD_PREFIX}${randomUUID()}`;
  const cwd = mkdtempSync(join(tmpdir(), "murage-learning-"));
  const items: string[] = [];
  let pending = "", size = 0;
  const state: { failure: Error | null } = { failure: null };
  let finish: () => void = () => {};
  const finished = new Promise<void>(resolve => { finish = () => resolve(); });
  const unsubscribe = adapter.onEvent((event: RuntimeEvent) => {
    if (event.threadId !== threadId) return;
    if (event.type === "request.opened" && event.requestId) void adapter.respondToRequest(threadId, event.requestId, { behavior: "deny" }).catch(() => undefined);
    else if (event.type === "content.delta" && event.streamKind === "assistant_text") { if (size + pending.length <= ANSWER_TEXT_LIMIT) pending += event.delta; }
    else if (event.type === "item.completed" && event.itemType === "assistant_text") { pending = ""; if (size <= ANSWER_TEXT_LIMIT) { items.push(event.text); size += event.text.length; } }
    else if (event.type === "runtime.error") state.failure ??= engineFailure(event.message, event.details ?? "");
    else if (event.type === "turn.completed") { if (!event.ok) state.failure ??= new Error("MEMORY_EXTRACTION_REQUEST_FAILED"); finish(); }
    else if (event.type === "session.exited") { if (!items.length && !pending) state.failure ??= new Error("MEMORY_EXTRACTION_REQUEST_FAILED"); finish(); }
  });
  const onAbort = () => finish();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { state.failure ??= new Error("MEMORY_EXTRACTION_TIMEOUT"); finish(); }, CONTINUITY_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    if (signal.aborted) throw new Error("MEMORY_EXTRACTION_ABORTED");
    const sending = adapter.sendTurn({ threadId, text: prompt, sessionReset: true, cwd, stopLine: true, proposalOnly: true, background: true });
    // sendTurn may stay pending until the turn ends: the wait is on the turn's own end, never on it.
    sending.catch(error => { state.failure ??= engineFailure(error instanceof Error ? error.message : String(error)); finish(); });
    await finished;
    if (signal.aborted) throw new Error("MEMORY_EXTRACTION_ABORTED");
    const text = [...items, ...(pending ? [pending] : [])].join("\n");
    if (state.failure) throw state.failure;
    if (Buffer.byteLength(text) > maxBytes) throw new Error("MEMORY_EXTRACTION_RESPONSE_LIMIT");
    return text;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    void Promise.resolve().then(() => adapter.interruptTurn(threadId)).catch(() => undefined)
      .then(() => adapter.resetSession?.(threadId)).catch(() => undefined)
      // The guarded delete: the session folder is admitted only as an OS temp path, never a home or data directory.
      // A refusal leaves the empty folder in the temp dir rather than deleting anything it cannot vouch for.
      .finally(() => safeWipe(cwd).catch(() => undefined));
  }
};
