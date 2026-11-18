// Boot tolerance G1 (docs/designs/boot-tolerance/ACCEPTANCE.md): a send or a settings write refused by a read-only start (503, retryable:false, the owner's words)
// is not repeated for the life of the process, and a fresh client does not post it again by itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./store.tsx";
import { createOutbox, createSendDelivery, isBusyRefusal, isDatabaseBusyAnswer, isDefinitiveFailure, type OutboxEntry } from "./send-delivery";

const OWNER_COPY = "Your disk is almost full. Chats are read-only. Free some space, then restart Murage.";
const REFUSAL = { error: OWNER_COPY, code: "DATABASE_BUSY", reason: "read-only-start", retryable: false };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
const entry = (sendId: string): OutboxEntry => ({ sendId, kind: "bot", botId: "b1", threadId: "t1", text: "words", at: 1_000, attempts: 0 });
const refusal = () => Object.assign(new Error(OWNER_COPY), { status: 503, body: REFUSAL });

function renderer(storage: ReturnType<typeof fakeStorage>, post: (e: OutboxEntry) => Promise<unknown>) {
  const log = { recovered: [] as Array<{ id: string; message: string }>, timers: [] as Array<{ fn: () => void; ms: number }>, failed: [] as string[] };
  const delivery = createSendDelivery({
    outbox: createOutbox(storage), post, now: () => 2_000,
    setTimer: (fn, ms) => { log.timers.push({ fn, ms }); return 0; },
    showSending: () => {}, settleSending: () => {}, receipt: () => {},
    recover: (e, error) => log.recovered.push({ id: e.sendId, message: (error as Error).message }),
  });
  return { delivery, log };
}

describe("a read-only refusal is not retried", () => {
  it("classifies it: not busy, not a database-busy answer, a definitive failure", () => {
    expect(isBusyRefusal(refusal())).toBe(false);
    expect(isDatabaseBusyAnswer(refusal())).toBe(false);
    expect(isDefinitiveFailure(refusal())).toBe(true);
    // the ordinary busy answer is still repeated (the contrast that keeps the rule narrow)
    const busy = Object.assign(new Error("Busy for a moment, try again"), { status: 503, body: { code: "DATABASE_BUSY", retryable: true, retryAfterSeconds: 1 } });
    expect(isBusyRefusal(busy)).toBe(true);
    expect(isDatabaseBusyAnswer(busy)).toBe(true);
    expect(isDefinitiveFailure(busy)).toBe(false);
  });

  it("a send is failed with the owner copy after its first refusal, never re-posted within 30 s, and a fresh client does not post it", async () => {
    const storage = fakeStorage();
    const posts: string[] = [];
    const first = renderer(storage, async (e) => { posts.push(e.sendId); throw refusal(); });
    await first.delivery.submit(entry("s1"));
    expect(posts).toEqual(["s1"]);
    expect(first.log.recovered).toEqual([{ id: "s1", message: OWNER_COPY }]);
    expect(first.log.timers.filter(timer => timer.ms <= 30_000)).toEqual([]);
    expect(createOutbox(storage).list()).toEqual([]);
    // after a restart: a new client over the same storage has nothing to post
    const second = renderer(storage, async (e) => { posts.push(e.sendId); return { ok: true }; });
    second.delivery.reconcile({ messageSendIds: new Set(), pendingSendIds: new Set() });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts).toEqual(["s1"]);
  });

  it("a settings write shows the owner copy and is posted once", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/desktop-secret")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      calls++;
      return new Response(JSON.stringify(REFUSAL), { status: 503, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    vi.useFakeTimers();
    const outcome = api("/api/settings/example", { method: "PATCH", body: "{}" }).then(() => null, (cause: unknown) => cause as Error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    expect(error?.message).toBe(OWNER_COPY);
    expect(calls).toBe(1);
  });
});
