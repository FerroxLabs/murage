// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The set-up check (ENGINE-SIGNIN simple path, Install order 1). `authenticated` can be true while a turn fails, so one short
// real reply decides. It runs on a press only, on the same hidden session Learning uses: no bot, thread or message is touched,
// the prompt is fixed text, and it costs one small reply of the owner's plan. A second press while one runs joins it.
import { ENGINE_REPLY_PROMPT } from "./drivers/cli-memory-learning.ts";
import { CLAUDE_MANAGED_MCP_CONFLICT } from "./drivers/claude-guards.ts";

export type EngineReplyResult = "ready" | "signin" | "limit" | "refused";
export interface EngineReplyCheck { result: EngineReplyResult; line?: string }
export interface ReplyCheckEngine {
  instanceId: string; displayName?: string;
  checkReply?(signal: AbortSignal, cwd?: string): Promise<string>;
  generateText?(prompt: string, botId?: string): Promise<string>;
}

const CHECK_TIMEOUT_MS = 90_000;
const LINE_LIMIT = 300;
const REFUSAL_CODES: ReadonlySet<unknown> = new Set(["update_required", CLAUDE_MANAGED_MCP_CONFLICT]);
const LIMIT_WORDS = /(?:usage|rate|quota|plan|message|credit|session)s?[ _-]?(?:limit|cap|exceeded|exhausted|reached)|\b429\b|too many requests|out of (?:credits|usage)|limit (?:reached|resets)|at (?:its|your) limit|hit (?:your|the)(?: \w+)? limit/i;
/** The words of a lost login. They outrank a status code: a revoked token can come back as a 403. */
const SIGNIN_WORDS = /\/login|not (?:logged|signed) in|(?:log|sign) ?in (?:required|again)|please (?:log|sign) ?in|\b401\b|unauthori[sz]ed|invalid.{0,20}(?:credential|api key)|(?:token|session|credentials?).{0,20}(?:expired|revoked|invalid)/i;
/** A 403 with no such words is a rule, not a login: the owner signing in again would change nothing. */
const POLICY_WORDS = /\b403\b|forbidden|\bpolicy\b|not (?:allowed|permitted)|disabled by|your organi[sz]ation/i;

/** The engine's words, one short line. Colour codes, control characters and secrets-shaped text do not reach the owner. */
export function engineLine(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)\S+/gi, "$1[hidden]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, LINE_LIMIT) : undefined;
}

/** What a failed reply means. A plan limit and a CLI or policy refusal keep the engine's own line; only a lost login is Sign in. */
export function replyCheckFailure(error: unknown, name: string): EngineReplyCheck {
  const failure = (error ?? {}) as { message?: unknown; engineLine?: unknown; code?: unknown; limit?: unknown; status?: unknown; signedOut?: unknown };
  const raw = typeof failure.engineLine === "string" ? failure.engineLine : typeof failure.message === "string" ? failure.message : "";
  const internal = /^MEMORY_(?:EXTRACTION|ENGINE)_/.test(raw);
  const line = internal ? undefined : engineLine(raw);
  if (REFUSAL_CODES.has(failure.code)) return { result: "refused", line: line ?? `${name} refused this request.` };
  if (failure.limit === true || failure.status === 429 || LIMIT_WORDS.test(raw)) return { result: "limit", line: line ?? `${name} is at its plan limit.` };
  if (failure.signedOut === true || SIGNIN_WORDS.test(raw)) return { result: "signin" };
  if (failure.status === 401 && !POLICY_WORDS.test(raw)) return { result: "signin" };
  if (raw === "MEMORY_EXTRACTION_TIMEOUT" || raw === "MEMORY_EXTRACTION_ABORTED") return { result: "refused", line: `${name} did not answer in time. Try again.` };
  return { result: "refused", line: line ?? `${name} did not answer. Try again.` };
}

const running = new Map<string, Promise<EngineReplyCheck>>();

async function reply(engine: ReplyCheckEngine, name: string, timeoutMs: number, cwd?: string): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (engine.checkReply) return engine.checkReply(signal, cwd);
  const generateText = engine.generateText?.bind(engine);
  if (!generateText) throw new Error(`${name} has no quick check. Send it a message in a chat to try it.`);
  return Promise.race([generateText(ENGINE_REPLY_PROMPT), new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("MEMORY_EXTRACTION_TIMEOUT")), { once: true });
  })]);
}

/** One short real reply through this engine. Never throws: every outcome is an answer for the card. */
export function checkEngineReply(engine: ReplyCheckEngine, timeoutMs = CHECK_TIMEOUT_MS, cwd?: string): Promise<EngineReplyCheck> {
  const joined = running.get(engine.instanceId);
  if (joined) return joined;
  const name = engine.displayName || "This engine";
  const check = (async (): Promise<EngineReplyCheck> => {
    try {
      const text = await reply(engine, name, timeoutMs, cwd);
      return text.trim() ? { result: "ready" } : { result: "refused", line: `${name} did not answer. Try again.` };
    } catch (error) { return replyCheckFailure(error, name); }
  })().finally(() => { running.delete(engine.instanceId); });
  running.set(engine.instanceId, check);
  return check;
}
