// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness end of the push routes. Every request here came through the
// door, which proved the device (and, for the bearer routes, the binding and
// scope) and stamped the launch proof; without the proof these routes do not
// exist.
import type { IncomingHttpHeaders } from "node:http";
import { EVENT_REF, TOKEN_PATTERNS, UUID } from "../shared/mobile-push.ts";
import type { PushOutbox } from "./mobile-push-outbox.ts";
import type { RelayClient } from "./mobile-push-relay.ts";
import { PUSH_TOKEN_TTL_MS, type PushBinding, type PushEventRow, type PushStore } from "./mobile-push-store.ts";

export interface PushRouteDeps {
  store: PushStore;
  outbox: Pick<PushOutbox, "pending">;
  relay: RelayClient | null;
  authorized(headers: IncomingHttpHeaders): boolean;
  visible(threadId: string): boolean;
  detail(event: PushEventRow): { title: string; body: string };
  respond(input: { deviceId: string; bindingId: string; body: unknown }): Promise<{ status: number; body: unknown }>;
  now?: () => number;
}

const PREFIX = "/api/mobile/push/";
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const NO_ROUTE = { status: 404, body: { error: "no route" } };
const UNAVAILABLE = { status: 404, body: { code: "unavailable", error: "This notification is no longer available. Open Murage to see what is waiting." } };
const SIGN_IN = { status: 401, body: { error: "sign in" } };
const BAD_GRANT = { status: 400, body: { code: "bad_grant", error: "That notification setup has expired. Try again." } };
const header = (h: IncomingHttpHeaders, name: string) => (typeof h[name] === "string" ? (h[name] as string) : "");
const BAD_REQUEST = { status: 400, body: { code: "bad_request", error: "bad request" } };
const PUSH_OFF = { status: 503, body: { code: "push_off", error: "Notifications are turned off on this computer." } };
const RELAY_DOWN = { status: 503, body: { code: "relay_unavailable", error: "Murage could not reach the notification service. Try again later." } };
const NOT_SAVED = { status: 500, body: { error: "Murage could not save the notification setup. Try again." } };
/** The relay never expires a binding on its own, so every binding dropped
 * here is first queued in the store (same transaction as the delete) and
 * the sweeper retries it. This is only the fast path: one attempt now,
 * clearing the queued row when the relay confirms. A failure leaves the row
 * for the sweep, untouched. */
function removeNow(deps: PushRouteDeps, binding: Pick<PushBinding, "bindingId" | "publisherToken">): void {
  if (!deps.relay) return;
  void deps.relay.remove({ bindingId: binding.bindingId, publisherToken: binding.publisherToken })
    .then((removed) => { if (removed) deps.store.relayRemovalDone(binding.bindingId); })
    .catch(() => {});
}

export async function mobilePushRoute(
  req: { method: string; path: string; headers: IncomingHttpHeaders; readBody: () => Promise<unknown> },
  deps: PushRouteDeps,
): Promise<{ status: number; body: unknown } | null> {
  if (!req.path.startsWith(PREFIX)) return null;
  if (!deps.authorized(req.headers)) return NO_ROUTE;
  const device = header(req.headers, "x-murage-push-device");
  if (!DEVICE.test(device)) return NO_ROUTE;
  const now = (deps.now ?? Date.now)();
  const rest = req.path.slice(PREFIX.length);
  const route = `${req.method} ${rest}`;

  if (route === "GET preferences" || route === "POST preferences") {
    // Only the cookie-authenticated door may change consent. Notification
    // bearer tokens do not grant settings access.
    if (header(req.headers, "x-murage-push-scope")) return SIGN_IN;
    const binding = deps.store.bindingForDevice(device);
    if (!binding) return { status: 404, body: { code: "not_enrolled" } };
    if (req.method === "POST") {
      let body: unknown;
      try { body = await req.readBody(); } catch { return BAD_REQUEST; }
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "previewContent"
        || typeof (body as { previewContent?: unknown }).previewContent !== "boolean") return BAD_REQUEST;
      deps.store.setPreviewContent(binding.bindingId, (body as { previewContent: boolean }).previewContent);
    }
    return { status: 200, body: { previewContent: deps.store.binding(binding.bindingId)?.previewContent === true } };
  }

  if (route === "POST enrol") {
    if (!deps.relay) return PUSH_OFF;
    let grant: unknown;
    try { grant = (await req.readBody() as { grant?: unknown } | null)?.grant; } catch { return BAD_GRANT; }
    const redeemed = typeof grant === "string" && TOKEN_PATTERNS.grant.test(grant) ? await deps.relay.redeem(grant) : null;
    if (redeemed === "unavailable") return RELAY_DOWN;
    if (!redeemed) return BAD_GRANT;
    let previous: PushBinding | null;
    try {
      previous = deps.store.putBinding({ bindingId: redeemed.bindingId, deviceId: device, publisherToken: redeemed.publisherToken, createdAt: now });
    } catch {
      // The relay made a binding this harness could not keep: owe its
      // removal. The device's old binding survived the rolled-back write.
      try { deps.store.enqueueRelayRemoval(redeemed, now); } catch { /* the fast path below is all that is left */ }
      removeNow(deps, redeemed);
      return NOT_SAVED;
    }
    // The door mints the token pair right after this answer.
    try { deps.store.setTokenExpiry(redeemed.bindingId, now + PUSH_TOKEN_TTL_MS); } catch { /* no record: the binding keeps publishing */ }
    if (previous) removeNow(deps, previous);
    return { status: 200, body: { bindingId: redeemed.bindingId } };
  }
  if (route === "GET binding") {
    // Push off: the door hands this on for /tokens, so the page stops asking
    // the phone for a binding the host could never use (final review I1).
    if (!deps.relay) return PUSH_OFF;
    const binding = deps.store.bindingForDevice(device);
    // The door asks this only to mint a token pair for the binding, so the
    // pair's expiry is recorded here, from this host's own clock.
    if (binding) try { deps.store.setTokenExpiry(binding.bindingId, now + PUSH_TOKEN_TTL_MS); } catch { /* the earlier record stands */ }
    return binding ? { status: 200, body: { bindingId: binding.bindingId } } : { status: 404, body: { code: "not_enrolled" } };
  }
  if (route === "POST revoke-device") {
    // Answered once the delete and its queued relay removal commit together.
    const removed = deps.store.removeDevice(device, now);
    if (removed) removeNow(deps, removed);
    return { status: 200, body: { ok: true } };
  }

  // The bearer routes, exactly the ones the door forwards. The binding comes
  // only from the header the door set after checking the token, and it must
  // be the one this device holds here; the scope must be the route's own.
  const scope: "detail" | "respond" | null =
    req.method === "GET" && (rest === "pending" || EVENT_REF.test(rest)) ? "detail"
      : route === "POST respond" ? "respond" : null;
  if (!scope) return NO_ROUTE;
  const bindingId = header(req.headers, "x-murage-push-binding");
  if (!UUID.test(bindingId) || header(req.headers, "x-murage-push-scope") !== scope) return SIGN_IN;
  if (deps.store.bindingForDevice(device)?.bindingId !== bindingId) return SIGN_IN;

  if (route === "GET pending") return { status: 200, body: deps.outbox.pending(bindingId) };
  if (route === "POST respond") {
    let body: unknown;
    try { body = await req.readBody(); } catch { return BAD_REQUEST; }
    return deps.respond({ deviceId: device, bindingId, body });
  }
  // Looked up under the proven binding only: another binding's ref is not
  // found here, and answers exactly as a ref that never existed.
  const event = deps.store.event(bindingId, rest);
  if (!event || event.expiresAt <= now || !deps.visible(event.threadId)) return UNAVAILABLE;
  const text = deps.detail(event);
  return { status: 200, body: { title: text.title, body: text.body, target: {
    bindingId, threadId: event.threadId,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    // An approval's request id, so a lock-screen action can answer it; it
    // goes only to this device, over its own tailnet, never to the relay.
    ...(event.requestId && (event.category === "approval" || event.category === "approval-open") ? { requestId: event.requestId } : {}),
  } } };
}
