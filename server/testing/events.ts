// Event recorder for adapter tests: collect every canonical event and
// await predicates instead of sleeping (a test that needs a timeout to
// pass is wrong — it should wait on the event that proves the behavior).
import type { ProviderAdapter, RuntimeEvent } from "../contracts.ts";

export interface EventRecorder {
  events: RuntimeEvent[];
  /** Resolves with the first event matching `pred` (including already-seen
   * ones). Rejects after `timeoutMs` (30 s: a ceiling for a loaded runner, never a delay
   * on a passing run) with the transcript so far. */
  until(pred: (e: RuntimeEvent) => boolean, timeoutMs?: number): Promise<RuntimeEvent>;
  stop(): void;
}

/** What a failed tool call or a runtime error said (bounded), so a timeout shows why a turn went another way. */
function failureDetail(events: RuntimeEvent[]): string {
  const notes: string[] = [];
  for (const e of events as unknown as Array<Record<string, unknown>>) {
    const said = e.type === "runtime.error" ? e.message : e.type === "item.completed" && e.itemType === "tool" && e.ok === false ? (e.detail ?? e.result) : undefined;
    if (said !== undefined) notes.push(`${String(e.type)}: ${(typeof said === "string" ? said : JSON.stringify(said) ?? "").slice(0, 200)}`);
  }
  return notes.length ? `; details: ${notes.slice(0, 4).join(" | ")}` : "";
}

export function recordEvents(adapter: ProviderAdapter): EventRecorder {
  const events: RuntimeEvent[] = [];
  const waiters: Array<{ pred: (e: RuntimeEvent) => boolean; resolve: (e: RuntimeEvent) => void }> = [];
  const unsubscribe = adapter.onEvent((event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(event)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(event);
      }
    }
  });
  return {
    events,
    until(pred, timeoutMs = 30_000) {
      const seen = events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve: (e: RuntimeEvent) => (clearTimeout(timer), resolve(e)) };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `no matching event within ${timeoutMs}ms; saw: ${events.map((e) => e.type).join(", ") || "(none)"}${failureDetail(events)}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    stop: unsubscribe,
  };
}
