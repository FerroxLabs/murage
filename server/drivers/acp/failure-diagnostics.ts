/** Display facts only: these enums never drive retry, auth or provider policy. */
import { diagnosticFailureKind, type DiagnosticFailureKind } from "../../../shared/error-diagnostic.ts";
export const failureKind=diagnosticFailureKind;

/** Fuigo stamps events with its own process clock. Two processes' Date.now()
 * can disagree by up to a system tick (15.6 ms on Windows), so a stamp is
 * judged against the prompt start and against now with that much slack. */
const CROSS_PROCESS_CLOCK_SKEW_MS = 20;

export function createFuigoFailureObservations() {
  const seen = new Set<string>();
  let latestTimestamp = 0;
  let detail: string | undefined;
  let observedKind: DiagnosticFailureKind | undefined;
  return {
    observe(msg: any, context: {
      source: string; sessionId: string | null; promptStartedAt: number | null;
      pendingPrompts: number; promptSent: boolean; settled: boolean; cancelRequested: boolean;
    }) {
      if (context.source !== "fuigo.acp" || !context.sessionId || !context.promptSent
        || context.promptStartedAt === null || context.pendingPrompts !== 1
        || context.settled || context.cancelRequested || (msg?.method !== "_fuigo/session_notification" && msg?.method !== "_fuigo/session/update")) return;
      const p = msg.params;
      if (!p || Array.isArray(p) || p.sessionId !== context.sessionId || p._meta?.isReplay === true) return;
      // A small diagnostic envelope is enough; never retain raw vendor text.
      if (JSON.stringify(p).length > 8192) return;
      const meta = p._meta;
      const timestamp = meta?.agentTimestampMs;
      if (typeof meta?.eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(meta.eventId)
        || !Number.isSafeInteger(timestamp) || timestamp < context.promptStartedAt - CROSS_PROCESS_CLOCK_SKEW_MS
        || timestamp > Date.now() + CROSS_PROCESS_CLOCK_SKEW_MS || timestamp < latestTimestamp
        || seen.has(meta.eventId) || seen.size >= 64) return;
      const u = p.update;
      if (!u || Array.isArray(u) || u.sessionUpdate !== "retry_state" || u.type !== "failed") return;
      seen.add(meta.eventId);
      latestTimestamp = timestamp;
      const kind = failureKind(u.error_type);
      observedKind=kind;
      detail = kind
        ? `Fuigo failure category observed during request: ${kind}\nFuigo retry state observed during request: failed`
        : undefined;
    },
    details() { return detail; },
    kind() { return observedKind; },
  };
}
