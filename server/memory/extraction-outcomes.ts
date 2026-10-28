/** Only these host-owned labels may reach extraction diagnostics. Never log errors or replies. */
export const EXTRACTION_FAILURE_REASONS = ["empty-reply", "not-json", "schema-mismatch", "cut-off", "refusal", "transport-error"] as const;
export type ExtractionFailureReason = typeof EXTRACTION_FAILURE_REASONS[number];
export class ExtractionReplyError extends Error {
  readonly reason: ExtractionFailureReason;
  constructor(code: string, reason: ExtractionFailureReason) { super(code); this.reason = reason; }
}
export const EXTRACTION_SUMMARY_MS = 60 * 60_000;
const MAX_IDENTITIES = 128;
const counts = () => Object.fromEntries(EXTRACTION_FAILURE_REASONS.map(reason => [reason, 0])) as Record<ExtractionFailureReason, number>;
interface Outcomes {
  extractor: string; model: string; completed: number; deferred: number;
  unusable: Record<ExtractionFailureReason, number>; consecutive: number;
  backoffMs: number; retryAt: number; touched: number; dirty: boolean;
}
// Values are configuration identifiers only. Bound them and prevent forged multi-line logs.
const label = (value: string) => value.slice(0, 160).replace(/[^a-zA-Z0-9@/_.:+-]/g, "_");

/** Process-local pacing survives resolver closures being recreated; no source text is retained.
 * One unref'd timer reports active pairs even if learning stops calling after a failure.
 * Idle identities expire after a day; the LRU bound also limits timers/counter storage under churn. */
export class ExtractionOutcomes {
  private states = new Map<string, Outcomes>();
  private anonymous = new WeakMap<object, string>();
  private nextAnonymous = 0;
  private timer?: ReturnType<typeof setInterval>;

  forExtractor(extractor: { learningConnection?: string; learningModel?: () => string | undefined }): Outcomes {
    let model = "unknown";
    try { model = extractor.learningModel?.() || model; } catch { /* unavailable metadata */ }
    let id = extractor.learningConnection;
    if (!id) {
      id = this.anonymous.get(extractor);
      if (!id) { id = `anonymous-${++this.nextAnonymous}`; this.anonymous.set(extractor, id); }
    }
    const key = JSON.stringify([id, model]);
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= MAX_IDENTITIES) this.states.delete(this.states.keys().next().value!);
      state = { extractor: label(id), model: label(model), completed: 0, deferred: 0, unusable: counts(), consecutive: 0, backoffMs: 0, retryAt: 0, touched: Date.now(), dirty: false };
    }
    this.states.delete(key); this.states.set(key, state);
    state.touched = Date.now();
    if (!this.timer) {
      this.timer = setInterval(() => this.summarize(), EXTRACTION_SUMMARY_MS);
      this.timer.unref();
    }
    return state;
  }

  deferred(state: Outcomes) { state.deferred++; state.dirty = true; }
  completed(state: Outcomes) {
    state.completed++; state.consecutive = 0; state.backoffMs = 0; state.retryAt = 0; state.dirty = true;
  }
  unusable(state: Outcomes, reason: ExtractionFailureReason) {
    state.unusable[reason]++; state.dirty = true;
    // A failed transport produced no reply. Report it, but do not start or extend reply backoff.
    if (reason === "transport-error") return;
    state.consecutive++;
    if (state.consecutive >= 5) {
      state.backoffMs = Math.min(EXTRACTION_SUMMARY_MS, 60_000 * 2 ** Math.min(6, state.consecutive - 5));
      state.retryAt = Date.now() + state.backoffMs;
    }
  }
  private summarize() {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (state.dirty) {
        const unusable = Object.values(state.unusable).reduce((sum, n) => sum + n, 0);
        try {
          console.info(`[memory] extraction outcomes completed=${state.completed} deferred=${state.deferred} unusable=${unusable} ${EXTRACTION_FAILURE_REASONS.map(reason => `${reason}=${state.unusable[reason]}`).join(" ")} extractor=${state.extractor} model=${state.model} consecutive=${state.consecutive} backoff_ms=${state.backoffMs} retry_in_ms=${Math.max(0, state.retryAt - now)}`);
        } catch { /* logging is best effort */ }
        state.completed = 0; state.deferred = 0; state.unusable = counts(); state.dirty = false;
      }
      if (now - state.touched >= 24 * EXTRACTION_SUMMARY_MS) this.states.delete(key);
    }
    if (!this.states.size) this.clear();
  }
  clear() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.states.clear(); this.anonymous = new WeakMap(); this.nextAnonymous = 0;
  }
}
export const extractionOutcomes = new ExtractionOutcomes();
