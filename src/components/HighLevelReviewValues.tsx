// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The values a HighLevel change would send, shown on its open card on this computer (HL-S2-WRITES (a)). They are read live
// from the open review (GET /api/highlevel/reviews/:actionId) and never stored in the conversation, so they disappear once
// the change is settled, stopped or expired. Mounted in both decision surfaces: the composer panel and the inline card.
//
// Allow waits on this view: it is offered only once the GET has answered 200 AND these exact values are on screen, and
// it carries the review's digest back (highlevelAllowDigest). Any other surface (a phone, a browser) is refused the
// values and reads one line instead; it can Deny, never Allow.
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";


export const HIGHLEVEL_CARD_PREFIX = "highlevel-";

/** The review id behind a HighLevel card's request id, or undefined for any other card. */
export function highlevelReviewId(requestId: string | undefined): string | undefined {
  if (!requestId?.startsWith(HIGHLEVEL_CARD_PREFIX)) return undefined;
  const id = requestId.slice(HIGHLEVEL_CARD_PREFIX.length);
  return /^hla_(?:[0-9a-f-]{36}|[0-9a-f]{64})$/u.test(id) ? id : undefined;
}

/** Every value in full, as Allow approves it: unredacted, untruncated. */
export function highlevelValuesText(values: unknown): string {
  return JSON.stringify(values, null, 2) ?? "";
}

export type HighLevelReviewState =
  | { phase: "loading" }
  | { phase: "failed" }
  /** this surface may not see the values (ownerAppSurface refused it) */
  | { phase: "refused" }
  | { phase: "loaded"; text: string; reviewDigest: string; rendered: boolean; expiresAt?: number; operation?: string; completionKind?: 'private_generated_password_v1' };

const states = new Map<string, HighLevelReviewState>();
const requests = new Map<string, AbortController>();
const mounted = new Map<string, number>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const LOADING: HighLevelReviewState = { phase: "loading" };

/** The one writer of a review's state (the loader, and tests). */
export function setHighLevelReviewState(reviewId: string, state: HighLevelReviewState): void {
  if (!states.has(reviewId) && states.size >= 200) forgetHighLevelReview(states.keys().next().value!);
  states.set(reviewId, state);
  for (const listener of listeners) listener();
}

/** Starts the one read of a review (both surfaces share it). A failed read is tried again on the next mount. */
export function loadHighLevelReview(reviewId: string): void {
  const now = states.get(reviewId);
  if (now && now.phase !== "failed") return;
  setHighLevelReviewState(reviewId, LOADING);
  const request = new AbortController(); requests.set(reviewId, request);
  api(`/api/highlevel/reviews/${reviewId}`, { cache: "no-store", signal: request.signal }).then((body: { values?: unknown; reviewDigest?: unknown; expiresAt?: number; operation?: string; completionKind?: 'private_generated_password_v1' }) => {
    if (requests.get(reviewId) !== request) return;
    if (typeof body?.reviewDigest !== "string" || !("values" in (body ?? {}))) { setHighLevelReviewState(reviewId, { phase: "failed" }); return; }
    if (typeof body.expiresAt === "number") {
      if (body.expiresAt <= Date.now()) { forgetHighLevelReview(reviewId); return; }
      clearTimeout(expiry.get(reviewId));
      expiry.set(reviewId, setTimeout(() => forgetHighLevelReview(reviewId), Math.min(body.expiresAt - Date.now(), 600_000)));
    }
    setHighLevelReviewState(reviewId, { phase: "loaded", text: highlevelValuesText(body.values), reviewDigest: body.reviewDigest, rendered: false, expiresAt: body.expiresAt,
      ...(body.operation ? { operation: body.operation } : {}), ...(body.completionKind ? { completionKind: body.completionKind } : {}) });
  }).catch((error: { status?: number }) => {
    if (requests.get(reviewId) !== request) return;
    setHighLevelReviewState(reviewId, { phase: error?.status === 403 ? "refused" : "failed" });
  });
}

/** The view has put these exact values on screen. */
export function markHighLevelReviewRendered(reviewId: string, text: string): void {
  const now = states.get(reviewId);
  if (now?.phase === "loaded" && now.text === text && !now.rendered) setHighLevelReviewState(reviewId, { ...now, rendered: true });
}

/** Tests and a settled card: forget a review. */
export function forgetHighLevelReview(reviewId?: string): void {
  if (reviewId) { states.delete(reviewId); requests.get(reviewId)?.abort(); requests.delete(reviewId); clearTimeout(expiry.get(reviewId)); expiry.delete(reviewId); }
  else { states.clear(); for (const request of requests.values()) request.abort(); requests.clear(); for (const timer of expiry.values()) clearTimeout(timer); expiry.clear(); }
  for (const listener of listeners) listener();
}

export function highLevelReviewState(reviewId: string): HighLevelReviewState {
  return states.get(reviewId) ?? LOADING;
}

export function useHighLevelReview(reviewId: string | undefined): HighLevelReviewState | undefined {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (reviewId ? highLevelReviewState(reviewId) : undefined),
    () => (reviewId ? highLevelReviewState(reviewId) : undefined),
  );
}

/** The digest Allow must carry, only once the values answered 200 and are on screen; undefined keeps Allow disabled. */
export function highlevelAllowDigest(state: HighLevelReviewState | undefined): string | undefined {
  return state?.phase === "loaded" && state.rendered && (state.operation === 'users.create' ? state.completionKind === 'private_generated_password_v1' : !state.completionKind) ? state.reviewDigest : undefined;
}

export function userCreateReviewWording(state: HighLevelReviewState): string | undefined {
  if (state.phase !== 'loaded' || state.operation !== 'users.create' || state.completionKind !== 'private_generated_password_v1') return;
  try {
    const values = JSON.parse(state.text);
    return `Add ${values.firstName} ${values.lastName} to ${values.locationIds[0]} as a user? ${values.firstName} will set a password in HighLevel before signing in.`;
  } catch { return; }
}

export function HighLevelReviewValues({ reviewId }: { reviewId: string }) {
  const state = useHighLevelReview(reviewId) ?? LOADING;
  const shown = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    mounted.set(reviewId, (mounted.get(reviewId) ?? 0) + 1);
    loadHighLevelReview(reviewId);
    return () => {
      const remaining = (mounted.get(reviewId) ?? 1) - 1;
      if (remaining > 0) mounted.set(reviewId, remaining);
      else { mounted.delete(reviewId); forgetHighLevelReview(reviewId); }
    };
  }, [reviewId]);
  // Rendered means the values are in the document as text, every byte of them.
  useLayoutEffect(() => {
    if (state.phase === "loaded" && shown.current?.textContent === state.text) markHighLevelReviewRendered(reviewId, state.text);
  }, [reviewId, state]);
  return (
    <div className="mt-2 rounded-lg border border-hairline bg-card px-3 py-2 text-[12.5px] text-ink" data-highlevel-values={state.phase}>
      {userCreateReviewWording(state) && <p>{userCreateReviewWording(state)}<br />The password is never displayed or intentionally persisted.</p>}
      {state.phase === "refused" ? <span className="text-ink-secondary">{t("highlevel.onComputer")}</span>
        : state.phase === "failed" ? <span className="text-warning">{t("highlevel.valuesFailed")}</span>
        : state.phase === "loading" ? <span className="text-ink-secondary">{t("highlevel.valuesLoading")}</span>
        : <pre ref={shown} data-highlevel-values-text className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono">{state.text}</pre>}
    </div>
  );
}
