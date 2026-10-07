// The harness's only line to the push relay (cloudflare/push-relay). It sends
// the RelayEvent shape and nothing else, and keeps no response text.
import { TOKEN_PATTERNS, UUID, type RelayEvent } from "../shared/mobile-push.ts";
import type { SendResult } from "./mobile-push-outbox.ts";
import type { PushBinding, PushStore } from "./mobile-push-store.ts";

/** The deployed relay (cloudflare/push-relay on workers.dev), the same origin
 *  the phones build in (RelayClient.swift, RelayClient.java): a host and its
 *  phones must agree by default, or the host cannot redeem the phones' grants.
 *  `push.murage.ai` does not exist (Plan 3b: murage.ai lives in another
 *  Cloudflare account); moving there changes all three together. */
export const DEFAULT_RELAY_ORIGIN = "https://murage-push-relay.sean-874.workers.dev";

/** Decision 9. Unset (or empty) uses the default relay; "off" disables push
 *  on this host; anything that is not a bare https origin disables it too,
 *  rather than guessing. */
export function relayOrigin(env: Record<string, string | undefined>): string | null {
  const raw = env.MURAGE_PUSH_RELAY_URL;
  if (raw === undefined || raw === "") return DEFAULT_RELAY_ORIGIN;
  if (raw === "off") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

export interface RelayClient {
  /** null: the relay refused this grant (spent, lapsed, malformed).
   *  "unavailable": no answer, or one that is not about the grant (429, 5xx,
   *  a 404 from something in between), so the grant may still be good. */
  redeem(grant: string): Promise<{ bindingId: string; publisherToken: string } | null | "unavailable">;
  publish(binding: PushBinding, event: RelayEvent, signal: AbortSignal): Promise<SendResult>;
  /** true once the relay no longer has it (200, or 401: already gone). A 404
   *  is not the relay's answer, so the removal stays owed. */
  remove(binding: Pick<PushBinding, "bindingId" | "publisherToken">): Promise<boolean>;
}

export function createRelayClient(origin: string, fetchImpl: typeof fetch = fetch): RelayClient {
  const call = (path: string, init: RequestInit) =>
    fetchImpl(origin + path, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(10_000) });
  return {
    async redeem(grant) {
      if (!TOKEN_PATTERNS.grant.test(grant)) return null;
      try {
        const res = await call("/v1/publishers/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
        // The relay refuses a grant with 400 (the body) or 403 (grant_unavailable).
        if (res.status === 400 || res.status === 403) return null;
        if (res.status !== 200) return "unavailable";
        const body = (await res.json()) as { bindingId?: unknown; publisherToken?: unknown };
        if (typeof body.bindingId !== "string" || !UUID.test(body.bindingId)) return null;
        if (typeof body.publisherToken !== "string" || !TOKEN_PATTERNS.publisher.test(body.publisherToken)) return null;
        return { bindingId: body.bindingId, publisherToken: body.publisherToken };
      } catch {
        return "unavailable";
      }
    },
    async publish(binding, event, signal) {
      try {
        const res = await call("/v1/events", {
          method: "POST", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${binding.publisherToken}` },
          body: JSON.stringify(event),
        });
        // Decide the outcome from the status before draining: a rejected
        // drain on an otherwise-successful response must not turn into a
        // false "retry" and a duplicate push. Only 401 is "gone": the relay
        // answers an unknown publisher with 401 and never with 404, so a 404
        // came from something in between (a wrong origin, a proxy) and must
        // not un-enrol the phone.
        // Any other 4xx but 404, 408 and 429 is the relay's final word on
        // this event ("rejected"); no answer, 5xx, 429 and 404 are transient.
        const result: SendResult = res.status === 202 ? "accepted" : res.status === 401 ? "gone"
          : res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 408 && res.status !== 429 ? "rejected" : "retry";
        void res.body?.cancel().catch(() => {});
        return result;
      } catch {
        return "retry";
      }
    },
    async remove(binding) {
      try {
        const res = await call(`/v1/bindings/${binding.bindingId}`, { method: "DELETE", headers: { authorization: `Bearer ${binding.publisherToken}` } });
        const result = res.status === 200 || res.status === 401;
        void res.body?.cancel().catch(() => {});
        return result;
      } catch {
        return false;
      }
    },
  };
}

const SWEEP_LIMIT = 20;
/** Works through the relay removals owed (store.dueRelayRemovals), one at a
 *  time. Run on the outbox tick. With push off the rows wait for a relay.
 *  Counts only: the tokens it spends never reach a log or an error. */
export async function sweepRelayRemovals(
  store: Pick<PushStore, "dueRelayRemovals" | "relayRemovalDone" | "relayRemovalFailed">,
  relay: Pick<RelayClient, "remove"> | null,
  now: number,
): Promise<{ removed: number; retrying: number; abandoned: number }> {
  const counts = { removed: 0, retrying: 0, abandoned: 0 };
  if (!relay) return counts;
  for (const row of store.dueRelayRemovals(now, SWEEP_LIMIT)) {
    let removed = false;
    try { removed = await relay.remove({ bindingId: row.bindingId, publisherToken: row.publisherToken }); } catch { /* backs off below */ }
    if (removed) { store.relayRemovalDone(row.bindingId); counts.removed++; continue; }
    const outcome = store.relayRemovalFailed(row.bindingId, now);
    if (outcome === "retry") counts.retrying++;
    else if (outcome === "abandoned") counts.abandoned++;
  }
  return counts;
}

/** The outbox tick's sweep: one at a time (a tick landing mid-sweep joins
 *  the one running), and it never rejects, so a throw cannot stop the timer
 *  or the next sweep. */
export function relayRemovalSweeper(
  store: Pick<PushStore, "dueRelayRemovals" | "relayRemovalDone" | "relayRemovalFailed">,
  relay: Pick<RelayClient, "remove"> | null,
  now: () => number = Date.now,
  /** A content-free trace of a failed sweep; the sweep still settles. */
  onError: (error: unknown) => void = () => {},
): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= Promise.resolve()
      .then(() => sweepRelayRemovals(store, relay, now()))
      .then(() => {}, (error) => { try { onError(error); } catch { /* never rejects */ } })
      .finally(() => { running = null; });
    return running;
  };
}
