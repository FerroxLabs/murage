// SPDX-License-Identifier: AGPL-3.0-or-later
// Private review producer (server) and renderer consumer owner: skill-switch lane.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { isSkillSwitchAction, skillPreviewMatchesHash, type SkillRequestCardData } from "../../shared/skill-request";

type Review = { phase: "loading" } | { phase: "failed"; reason: "access" | "changed" | "unavailable"; status?: number } | { phase: "loaded"; request: SkillRequestCardData; rendered: boolean };
const LOADING: Review = { phase: "loading" };
const states = new Map<string, Review>();
const listeners = new Set<() => void>();
const mounted = new Map<string, number>();
const requests = new Map<string, AbortController>();
const keyFor = (request: SkillRequestCardData, messageId?: string) => isSkillSwitchAction(request.action) && !request.preview && request.sha256 && messageId ? `${request.threadId}/${messageId}/${request.sha256}/${request.verdictHash ?? "legacy"}` : undefined;
const publish = (key: string, state: Review) => { states.set(key, state); for (const listener of listeners) listener(); };
export function privateSkillReviewRequest(request: SkillRequestCardData, messageId?: string): SkillRequestCardData | undefined {
  const key = keyFor(request, messageId), state = key ? states.get(key) : undefined;
  return state?.phase === "loaded" && state.rendered && state.request.sha256 === request.sha256 && state.request.verdictHash === request.verdictHash ? state.request : undefined;
}
export function privateSkillReviewDigest(request: SkillRequestCardData, messageId?: string): string | undefined {
  return privateSkillReviewRequest(request, messageId)?.sha256;
}
export function privateSkillReviewVerdict(request: SkillRequestCardData, messageId?: string): string | undefined {
  return privateSkillReviewRequest(request,messageId)?.verdictHash;
}
export function markPrivateSkillReviewRendered(request: SkillRequestCardData, messageId: string | undefined, text: string): void {
  const key = keyFor(request, messageId), state = key ? states.get(key) : undefined;
  if (key && state?.phase === "loaded" && !state.rendered && state.request.preview === text) publish(key, { ...state, rendered: true });
}
function loadPrivateSkillReview(key: string, request: SkillRequestCardData, messageId: string): void {
  requests.get(key)?.abort();
  const controller = new AbortController(); requests.set(key, controller);
  publish(key, LOADING);
  api(`/api/threads/${encodeURIComponent(request.threadId)}/skill-switch-review/${encodeURIComponent(messageId)}`, { cache: "no-store", signal: controller.signal })
    .then(async (body: { request?: SkillRequestCardData }) => {
      if (requests.get(key) !== controller) return;
      const shown = body.request;
      if (!shown || shown.sha256 !== request.sha256 || shown.verdictHash !== request.verdictHash || !shown.verdictHash || !Array.isArray(shown.findings) || shown.action !== request.action || shown.name !== request.name || !(await skillPreviewMatchesHash({ skillRequest: shown }))) throw { reason: "changed" };
      if (requests.get(key) === controller) publish(key, { phase: "loaded", request: shown, rendered: false });
    }).catch((error: unknown) => {
      if (requests.get(key) !== controller) return;
      const failure = error as { status?: number; reason?: string } | undefined;
      const status = failure?.status;
      const reason = status === 401 || status === 403 || status === 404 ? "access"
        : status === 409 || status === 422 || failure?.reason === "changed" ? "changed" : "unavailable";
      publish(key, { phase: "failed", reason, ...(typeof status === "number" ? { status } : {}) });
    });
}
export function retryPrivateSkillReview(request: SkillRequestCardData, messageId?: string): void {
  const key = keyFor(request, messageId);
  if (key && mounted.has(key) && states.get(key)?.phase === "failed") loadPrivateSkillReview(key, request, messageId!);
}
export function useSkillSwitchReview(request: SkillRequestCardData | undefined, messageId?: string): Review | undefined {
  const key = request ? keyFor(request, messageId) : undefined;
  const state = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => key ? states.get(key) ?? LOADING : undefined, () => undefined);
  useEffect(() => {
    if (!key || !request) return;
    mounted.set(key, (mounted.get(key) ?? 0) + 1);
    if (!states.has(key)) loadPrivateSkillReview(key, request, messageId!);
    return () => {
      const remaining = (mounted.get(key) ?? 1) - 1;
      if (remaining > 0) mounted.set(key, remaining);
      else { mounted.delete(key); requests.get(key)?.abort(); requests.delete(key); states.delete(key); for (const listener of listeners) listener(); }
    };
  }, [key, request?.sha256, request?.verdictHash, messageId]);
  return state;
}
