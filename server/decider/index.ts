// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-app decision client: ask a hosted fast decision model (Flux Router
// /v1/decide) one typed question and get a typed, validated answer, or a
// reason none came. FAIL-OPEN everywhere: every failure is `{ ok: false }`
// and the caller keeps today's rule. Gated OFF by default: a master switch
// and one switch per job. Never throws.
import { loadConfig } from "../config.ts";
import { fluxKey } from "../flux-config.ts";
import { fluxBackend, isLoopbackUrl } from "./flux.ts";
import { appendDeciderLog, hashState } from "./log.ts";
import { DEFAULT_DECIDER_SETTINGS, readDecisionModelSettings, type DecisionModelSettings } from "./settings.ts";
import type {
  AskOptions, BackendResult, ChoiceAnswer, ChoiceQuestion, DeciderAnswer, DeciderFailure, DeciderQuestion, DeciderResult, DeciderSeam,
} from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 1_500;

export interface DeciderDeps {
  /** The current settings; read on every call so a change applies at once. */
  settings?: () => DecisionModelSettings;
  /** The Flux credential; defaults to the server's one reader. */
  credential?: () => string | null;
  fetch?: typeof fetch;
  dataDir?: string;
}

export interface Decider {
  choose(seam: DeciderSeam, state: unknown, question: Omit<ChoiceQuestion, "type">, options?: AskOptions): Promise<DeciderResult<ChoiceAnswer>>;
  ask(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>, options?: AskOptions): Promise<DeciderResult<Record<string, DeciderAnswer>>>;
}

function gate(settings: DecisionModelSettings, seam: DeciderSeam): "disabled" | "job_off" | null {
  if (!settings.enabled) return "disabled";
  if (seam !== "keyCheck" && !settings.jobs[seam]) return "job_off";
  return null;
}

/** Own key wins. The Flux key goes only to Flux's own base, or to this
 * machine for a test double; a custom remote base needs its own key. */
function resolveKey(settings: DecisionModelSettings, credential: () => string | null): string | null {
  if (settings.byoKey) return settings.byoKey;
  if (settings.baseUrl && !isLoopbackUrl(settings.baseUrl)) return null;
  try {
    return credential();
  } catch {
    return null;
  }
}

export function createDecider(deps: DeciderDeps = {}): Decider {
  const readSettings = deps.settings ?? (() => {
    try {
      return readDecisionModelSettings((loadConfig() as { decider?: unknown }).decider as never);
    } catch {
      return DEFAULT_DECIDER_SETTINGS;
    }
  });
  const credential = deps.credential ?? (() => fluxKey());
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function run(
    seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>, options: AskOptions,
  ): Promise<DeciderResult<Record<string, DeciderAnswer>>> {
    let settings: DecisionModelSettings;
    try {
      settings = readSettings();
    } catch {
      return { ok: false, reason: "disabled" };
    }
    const closed = gate(settings, seam);
    if (closed) return { ok: false, reason: closed };
    const key = resolveKey(settings, credential);
    if (!key) return { ok: false, reason: "no_key" };
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onCaller = () => { cancelled = true; controller.abort(); };
    options.signal?.addEventListener("abort", onCaller, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const aborted = new Promise<BackendResult>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ ok: false, reason: "unreachable" }), { once: true });
    });
    let result: BackendResult;
    try {
      // Raced so a body that stalls after its headers still ends at the budget.
      result = await Promise.race([
        fluxBackend.decide({ key, ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}), state, questions, signal: controller.signal, fetch: doFetch }),
        aborted,
      ]);
    } catch {
      result = { ok: false, reason: "unreachable" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCaller);
    }
    const latencyMs = Date.now() - started;
    let final: DeciderResult<Record<string, DeciderAnswer>>;
    if (result.ok) {
      final = { ok: true, provider: "flux", answers: result.answers, latencyMs, ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}), ...(result.model ? { model: result.model } : {}) };
    } else {
      const reason: DeciderFailure = result.reason === "unreachable" && cancelled ? "cancelled" : result.reason === "unreachable" && timedOut ? "timeout" : result.reason;
      final = { ok: false, provider: "flux", reason, ...(result.status !== undefined ? { status: result.status } : {}), latencyMs };
    }
    logCall(seam, state, final);
    return final;
  }

  function logCall(seam: DeciderSeam, state: unknown, result: DeciderResult<Record<string, DeciderAnswer>>) {
    try {
      const first = result.ok ? Object.values(result.answers)[0] : undefined;
      const top = first && first.type === "choice" ? first : undefined;
      appendDeciderLog({
        at: new Date().toISOString(), seam, provider: "flux", ok: result.ok,
        ...(!result.ok ? { reason: result.reason, ...(result.status !== undefined ? { status: result.status } : {}) } : {}),
        choice: top?.choice ?? null, pTop: top?.pTop ?? null, margin: top?.margin ?? null,
        latencyMs: result.latencyMs ?? 0, inputTokens: result.ok ? result.inputTokens ?? null : null,
        stateHash: hashState(state),
      }, deps.dataDir);
    } catch {
      // logging never changes a decision
    }
  }

  const self: Decider = {
    async ask(seam, state, questions, options = {}) {
      try {
        return await run(seam, state, questions, options);
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
    async choose(seam, state, question, options = {}) {
      const result = await self.ask(seam, state, { answer: { type: "choice", ...question } }, options);
      if (!result.ok) return result;
      const answer = result.answers.answer;
      if (!answer || answer.type !== "choice") return { ok: false, provider: "flux", reason: "malformed", latencyMs: result.latencyMs };
      return { ...result, answers: answer };
    },
  };
  return self;
}

let shared: Decider | undefined;
/** The process-wide decider, reading the live config on every call. */
export function appDecider(): Decider {
  return (shared ??= createDecider());
}
