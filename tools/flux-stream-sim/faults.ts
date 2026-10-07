// tools/flux-stream-sim/faults.ts
// Fault injection (spec D). Query form: sim_fault=latency_ms=200,reject=402
export interface Faults {
  latencyMs?: number;
  beginDelayMs?: number;
  reject?: 401 | 402 | 403 | 404 | 429 | 503;
  closeAfter?: { ms: number; code: number };
  /** Fires this long after the session's next speech.started (armed on open sessions). */
  closeAfterSpeech?: { ms: number; code: number };
  dropAfterMs?: number;
  idleTimeoutS?: number;
  partialDropPct?: number;
  maxSessionS?: number;
  /** Floods the client with non-droppable finals, for the slow-consumer rule. */
  flood?: boolean;
  /** Floods the client with 4 KiB partials, for partial coalescing (P04). */
  floodPartials?: boolean;
}

function codeSpec(value: string, fallback: number): { ms: number; code: number } {
  const [ms, code] = value.split(":").map(Number);
  return { ms, code: code || fallback };
}

export function parseFaults(spec: string | null): Faults {
  const faults: Faults = {};
  if (!spec) return faults;
  for (const part of spec.split(",")) {
    const [name, value = ""] = part.split("=");
    const n = Number(value);
    if (name === "latency_ms") faults.latencyMs = n;
    else if (name === "begin_delay_ms") faults.beginDelayMs = n;
    else if (name === "reject" && [401, 402, 403, 404, 429, 503].includes(n)) faults.reject = n as Faults["reject"];
    else if (name === "close_after_ms") faults.closeAfter = codeSpec(value, 4502);
    else if (name === "close_after_speech_ms") faults.closeAfterSpeech = codeSpec(value, 4502);
    else if (name === "drop_after_ms") faults.dropAfterMs = n;
    else if (name === "idle_timeout_s") faults.idleTimeoutS = n;
    else if (name === "partial_drop_pct") faults.partialDropPct = n;
    else if (name === "max_session_s") faults.maxSessionS = n;
    else if (name === "flood") faults.flood = true;
    else if (name === "flood_partials") faults.floodPartials = true;
  }
  return faults;
}

export function merge(global: Faults, session: Faults): Faults {
  return { ...global, ...session };
}

/** The error code a rejected connect reports, per status. */
export const REJECT_CODE: Record<number, string> = {
  401: "unauthorized",
  402: "premium_locked",
  403: "forbidden",
  404: "not_found",
  429: "rate_limit_error",
};
