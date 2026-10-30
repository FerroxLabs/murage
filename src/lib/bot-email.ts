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

export type Api = (path: string, init?: RequestInit) => Promise<unknown>;
/** What the status route said: on (with the view), off (a 404: not on here), off with the section 8 Flux line, or a read that failed
 *  (network, 5xx) and says nothing about whether email is on. */
export type EmailStatusState = { kind: "loading" } | { kind: "off" } | { kind: "flux-off"; line: string } | { kind: "flux-refused"; line: string }
  | { kind: "flux-sign-in"; line: string } | { kind: "flux-line"; line: string } | { kind: "error" } | { kind: "on"; view: EmailStatusView };

export async function readEmailStatus(call: Api = api, refresh = false): Promise<EmailStatusState> {
  try {
    const view = await call(`/api/email/status${refresh ? "?refresh=1" : ""}`) as EmailStatusView;
    return view && view.enabled === true ? { kind: "on", view } : { kind: "off" };
  } catch (error) {
    const { status, body } = error as { status?: unknown; body?: { fluxOff?: unknown; fluxRefused?: unknown; fluxSignIn?: unknown; fluxLine?: unknown } };
    if (typeof body?.fluxOff === "string") return { kind: "flux-off", line: body.fluxOff };
    // 1.0.11: Flux answered 401 on the saved key; the stub offers Sign in with Flux instead of hiding the card
    if (typeof body?.fluxRefused === "string") return { kind: "flux-refused", line: body.fluxRefused };
    // 1.0.11: the saved key has no email scope (403 email_scope_required); signing in mints the email:owner key
    if (typeof body?.fluxSignIn === "string") return { kind: "flux-sign-in", line: body.fluxSignIn };
    // a 200 with eligible: false (or a 403 account state): Flux's reason as one owner line
    if (typeof body?.fluxLine === "string") return { kind: "flux-line", line: body.fluxLine };
    // only a 404 means "not available here"; any other failure is a read that did not happen
    return status === 404 ? { kind: "off" } : { kind: "error" };
  }
}

/** The status, read once per mount (Settings open re-reads the capability, 2.0). */
export function useEmailStatus(refresh = false): EmailStatusState {
  const [state, setState] = useState<EmailStatusState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    void readEmailStatus(api, refresh).then(next => { if (live) setState(next); });
    return () => { live = false; };
  }, [refresh]);
  return state;
}

/** Is a bot settings section offered? `email` only while the status says on. */
export function emailSectionOffered(status: EmailStatusState): boolean { return status.kind === "on"; }

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
type FluxSigninBridge = { start(input: { action: "connect" | "replace"; revision: string }): Promise<{ ok: true; status?: { configured: boolean } } | { ok: false; message: string }> };
/** 1.0.11: the Bot email stub's "Sign in with Flux" after Flux answered 401 on the saved key. The same desktop flow as Models & engines
 *  (flux-signin:start), replacing the saved key at its current revision. Null when it worked, else the line to show. */
export async function signInFluxAgain(bridge: FluxSigninBridge | undefined = typeof window !== "undefined" ? window.muragebox?.fluxSignin : undefined, call: Api = api,
  onConnected?: (status: { configured: boolean }) => void): Promise<string | null> {
  if (!bridge) return null;
  const flux = await call("/api/flux-connection") as { configured?: unknown; revision?: unknown } | null;
  const revision = typeof flux?.revision === "string" ? flux.revision : "";
  const result = await bridge.start({ action: flux?.configured === true ? "replace" : "connect", revision });
  if (!result.ok) return result.message;
  // as Models & engines does: the saved-key state and the connection list follow the new key at once
  if (result.status) onConnected?.(result.status);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("murage:provider-connections-changed"));
  return null;
}

export async function signInEmailOwner(bridge = typeof window !== "undefined" ? window.muragebox?.emailOwnerSignin : undefined): Promise<string | null> {
  if (!bridge) return null;
  const result = await bridge.start();
  return result.ok ? null : result.message;
}
