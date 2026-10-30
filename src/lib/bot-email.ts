// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email in the app (BOT-EMAIL-MURAGE-109 2.0, 2.5, 2.6, 3.3, 3.5, 6, 8). Everything is hidden unless the server's status route answers
// enabled: true; a 404 is "not available" and shows nothing, except the section 8 Flux line, which the server sends only to an install
// that once had email on. A change made on the phone is signed with a fresh device proof over the exact act (the same card the server
// digests, shared/email-copy.ts emailOwnerActionCard).
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { respondWithFreshAuth } from "./fresh-auth";
import { emailOwnerActionCard, emailOwnerActionRequestId, type EmailBotView, type EmailOwnerAction, type EmailStatusView } from "../../shared/email-copy.ts";
import { EMAIL_STATUS_EVENT } from "./email-status-event";

export type Api = (path: string, init?: RequestInit) => Promise<unknown>;
/** What the status route said: on (with the view), checking (a key is saved and Flux has not given a definitive answer yet, never off; after
 *  a read with no definitive answer it carries a plain note in place of the word),
 *  off (show nothing), or off with the section 8 Flux line. */
export type EmailStatusState = { kind: "loading" } | { kind: "checking"; note?: string } | { kind: "off" } | { kind: "flux-off"; line: string } | { kind: "on"; view: EmailStatusView };

/** EMAIL-CAPS-CACHE-1011: the last status the server gave in this app session. A read that fails (a 500, a 502, a malformed body, no
 *  answer) keeps it, so a failed read never turns email off or hides it; only the server's own answer changes it. */
let held: EmailStatusState | null = null;
export function heldEmailStatus(): EmailStatusState | null { return held; }
export function resetHeldEmailStatus(): void { held = null; }

export async function readEmailStatus(call: Api = api, refresh = false): Promise<EmailStatusState> {
  let next: EmailStatusState;
  try {
    const view = await call(`/api/email/status${refresh ? "?refresh=1" : ""}`) as (EmailStatusView & { checking?: unknown; note?: unknown }) | null;
    if (view && typeof view === "object" && view.enabled === true) next = { kind: "on", view };
    else if (view && typeof view === "object" && view.checking === true) next = typeof view.note === "string" && view.note ? { kind: "checking", note: view.note } : { kind: "checking" };
    else if (view && typeof view === "object" && (view as { enabled?: unknown }).enabled === false) next = { kind: "off" };
    else return held ?? { kind: "checking" };
  } catch (error) {
    const failure = error as { status?: unknown; body?: { fluxOff?: unknown } };
    // only the route's own 404 means off (with the section 8 line when the server sends it); anything else keeps the last status
    if (failure?.status !== 404) return held ?? { kind: "checking" };
    next = typeof failure.body?.fluxOff === "string" ? { kind: "flux-off", line: failure.body.fluxOff } : { kind: "off" };
  }
  held = next;
  return next;
}

/** The status, read once per mount (Settings open re-reads the capability, 2.0) and again whenever the server says a read landed. */
export function useEmailStatus(refresh = false): EmailStatusState {
  const [state, setState] = useState<EmailStatusState>(() => held ?? { kind: "loading" });
  useEffect(() => {
    let live = true;
    const read = (fresh: boolean) => { void readEmailStatus(api, fresh).then(next => { if (live) setState(next); }); };
    read(refresh);
    const again = () => read(false);
    window.addEventListener(EMAIL_STATUS_EVENT, again);
    return () => { live = false; window.removeEventListener(EMAIL_STATUS_EVENT, again); };
  }, [refresh]);
  return state;
}

/** Is a bot settings section offered? `email` while the status says on, or checking (no definitive answer yet is never off). */
export function emailSectionOffered(status: EmailStatusState): boolean { return status.kind === "on" || status.kind === "checking"; }

export const OWNER_ROUTE: Record<EmailOwnerAction, string> = {
  setup: "setup", retry: "retry", pause: "pause", resume: "resume", remove: "remove", keep: "keep", reconnect: "reconnect", policy: "policy",
  trust_add: "trusted-add", trust_remove: "trusted-remove", block_add: "blocked-add", block_remove: "blocked-remove",
};

/** One owner act on a bot's email. On the phone the server answers a fresh_auth challenge; the proof signs the same card it digests. */
export async function emailOwnerAct(botId: string, threadId: string, action: EmailOwnerAction, body: Record<string, unknown>, call: Api = api): Promise<EmailBotView> {
  const post = (extra?: Record<string, unknown>) => call(`/api/email/bots/${encodeURIComponent(botId)}/${OWNER_ROUTE[action]}`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) }) as Promise<EmailBotView>;
  const card = emailOwnerActionCard(action, botId, body);
  return respondWithFreshAuth(post, { threadId, requestId: emailOwnerActionRequestId(action, botId), decision: "allow", card, reason: card.title });
}

export async function readBotEmail(botId: string, call: Api = api): Promise<EmailBotView | null> {
  try { return await call(`/api/email/bots/${encodeURIComponent(botId)}`) as EmailBotView; } catch { return null; }
}

/** Account on/off (desktop only). Off is sent only with the owner's confirm of the 2.0 line. */
export async function setEmailAccount(on: boolean, options: { confirm?: boolean; acceptTermsVersion?: string } = {}, call: Api = api): Promise<unknown> {
  return call("/api/email/account", { method: "POST", body: JSON.stringify({ on, ...(options.confirm ? { confirm: true } : {}), ...(options.acceptTermsVersion ? { acceptTermsVersion: options.acceptTermsVersion } : {}) }) });
}

/** The price line shows only on the desktop, never inside the phone apps (2.0). */
/** 2.6: Remove for an address from another setup (desktop only); answers the fresh status view. */
export async function removeOtherSetup(inboxId: string, call: Api = api): Promise<EmailStatusView> {
  return await call(`/api/email/other-setups/${encodeURIComponent(inboxId)}/remove`, { method: "POST", body: JSON.stringify({ confirm: true }) }) as EmailStatusView;
}

export function priceLine(view: EmailStatusView, nativeShell: boolean): string | null {
  return !nativeShell && typeof view.priceNote === "string" && view.priceNote.trim() ? view.priceNote : null;
}

/** Which buttons a bot's email section offers in its state (2.5, 2.6, section 6). */
export function emailSectionActions(view: Pick<EmailBotView, "state"> & Partial<Pick<EmailBotView, "keyRejected">>): Array<"give" | "retry" | "remove" | "pause" | "resume" | "reconnect" | "keep"> {
  // 2.3 / G15: Flux refused the saved email key: Reconnect gives the bot a new one
  if (view.keyRejected && view.state && ["active", "paused", "billing_hold", "grace", "closing"].includes(view.state)) return ["reconnect", "remove"];
  switch (view.state) {
    case null: return ["give"];
    case "active": case "billing_hold": case "grace": return ["pause", "remove"];
    case "paused": return ["resume", "remove"];
    case "failed": return ["retry", "remove"];
    case "restored_unverified": return ["reconnect", "remove"];
    // r2.5 closing (design 3.2 "Removing: undo until [date]"): Keep address brings it back with the same address
    case "remove_requested": case "closing": return ["keep"];
    default: return [];
  }
}

/** 2.4: the owner act of turning email on (or signing in again) obtains the email:owner token in the desktop shell. Resolves null when
 *  signed in, the refusal line otherwise; without the desktop shell there is nothing to run (null, and the route answers for itself). */
export async function signInEmailOwner(bridge = typeof window !== "undefined" ? window.muragebox?.emailOwnerSignin : undefined): Promise<string | null> {
  if (!bridge) return null;
  const result = await bridge.start();
  return result.ok ? null : result.message;
}
