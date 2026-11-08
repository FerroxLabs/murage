export class ProviderBudgetReached extends Error {
  constructor() { super("voice_budget_reached"); }
}
/** Optional reply policy. Call callers retain their existing retry and provider choices. */
export interface SpeechPolicy {
  signal?: AbortSignal;
  attempts?: 1;
  /** Local network/body ownership, used to confirm cancellation before replacement. */
  track?: (closed: Promise<void>) => void;
}

/** Caller cancellation remains linked through the entire response body, not just headers. */
export function speechFetch(call: typeof fetch, policy: SpeechPolicy): typeof fetch {
  if (!policy.signal && !policy.track) return call;
  return (async (input, init) => {
    policy.signal?.throwIfAborted();
    const control = new AbortController();
    const signals = [control.signal, init?.signal, policy.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const pending = call(input, { ...init, signal });
    policy.track?.(pending.then(() => {}, () => {}));
    const res = await pending;
    if (signal.aborted) { await res.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!res.body) return res;
    const reader = res.body.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let ended = false, cancelling = false;
    let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void closed.catch(() => {});
    policy.track?.(closed);
    const finish = (failure?: unknown) => {
      if (ended) return;
      ended = true; signal.removeEventListener("abort", aborted);
      try { reader.releaseLock(); } catch { /* cancellation may have already released ownership */ }
      if (failure !== undefined) rejectClosed(failure); else resolveClosed();
    };
    const cancel = (reason?: unknown): Promise<void> => {
      if (ended || cancelling) return closed;
      cancelling = true;
      // Abort the underlying request as well as cancelling its reader.
      control.abort();
      void reader.cancel(reason).then(() => finish(), error => finish(error ?? new Error("cancellation unconfirmed")));
      return closed;
    };
    const aborted = () => {
      if (ended || cancelling) return;
      void cancel();
      controller.error(new DOMException("Speech cancelled", "AbortError"));
    };
    const body = new ReadableStream<Uint8Array>({
      start(out) { controller = out; },
      async pull(out) {
        try {
          const next = await reader.read();
          if (cancelling || ended) return;
          signal.throwIfAborted();
          if (next.done) { finish(); out.close(); }
          else out.enqueue(next.value);
        } catch (error) {
          if (cancelling || ended) return;
          finish(); out.error(error);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
