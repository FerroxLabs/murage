// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The handler-level gates for the owner's remembered browser on a Cloud home (DESIGN section 3.5 and 4). The route table
// (browser-owner-policy.ts) decides what a path and a body can say; these decide what only the handler can: a card that is
// high risk, a folder the owner is asked to trust, a site taken down, a skill switched on, a computer connection.
//
// Every helper is false or null off a home and for any request that is not an owner browser, so desktop, phone and a
// non-Cloud harness never read this file's answers.

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { cloudIdentity, isOwnerBrowser } from "./cloud-request-identity.ts";
import type { CloudOwnerAct } from "./cloud-request-auth.ts";
import type { OwnerCodeLabel } from "./browser-owner-policy.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
import { FRESH_AUTH_COPY } from "./approval-fresh-auth.ts";
import { browserEffectiveReason, browserHighRisk, type BrowserRiskCard, type BrowserRiskKnown, type BrowserRiskLive } from "./mobile-push-risk.ts";
import { cardActDigest } from "./cloud-home/owner-code.ts";

/** True for a Cloud home's owner browser (a live remembered-owner factor), the one caller these gates apply to. */
export const onOwnerBrowser = (headers: IncomingHttpHeaders): boolean =>
  process.env.MURAGE_CLOUD_ROLE === "home" && isOwnerBrowser(cloudIdentity(headers));

let service: CloudOwnerAct | undefined;
/** index.ts hands over the one service the auth layer uses, so the handlers mint and verify with the same keys. */
export const setBrowserOwnerAct = (next: CloudOwnerAct | undefined): void => { service = next; };

export interface GateRefusal { status: number; body: Record<string, unknown> }

const proven = new WeakMap<object, Set<string>>();
/** A code that verified for this request's act stays proven for the rest of the same request, because the proof itself is spent. */
function remember(headers: object, act: string): void {
  const set = proven.get(headers) ?? new Set<string>();
  set.add(act);
  proven.set(headers, set);
}
/** Records that a code verified for a card in this request, for the later checks of the same request. */
export const markOwnerProven = (headers: object, key: string): void => remember(headers, key);
export const ownerProvenFor = (headers: object, act: string): boolean => proven.get(headers)?.has(act) === true;

/** Null when the request carries a valid emailed code for exactly `act`; otherwise the 403 the page answers with its code dialog.
 *  A proof that is present but is for another act (the card changed, or it ran out) gives "fresh_auth_changed". Fails closed:
 *  with no code service the answer is the "try again" refusal. Never used off a home or for another caller. */
export async function ownerCodeGate(req: IncomingMessage, act: string, label: OwnerCodeLabel, labelArg?: string): Promise<GateRefusal | null> {
  if (ownerProvenFor(req.headers, act)) return null;
  const device = cloudIdentity(req.headers);
  if (!device || !onOwnerBrowser(req.headers)) return { status: 403, body: { error: cloudHomeCopy.pairedDeviceRequired } };
  if (service && req.headers["x-murage-owner-proof"] !== undefined) {
    let ok = false;
    try { ok = await service.verifyProof(req, device, act); } catch { ok = false; }
    if (ok) { remember(req.headers, act); return null; }
    return { status: 403, body: { error: FRESH_AUTH_COPY.changed, code: "fresh_auth_changed", label } };
  }
  let actToken: string | undefined;
  try { actToken = service && device.accessHash ? service.token({ deviceId: device.id, accessHash: device.accessHash, act, label, ...(labelArg ? { labelArg } : {}) }) : undefined; } catch { actToken = undefined; }
  return { status: 403, body: actToken
    ? { error: cloudHomeCopy.ownerCodeNeeded, code: "email_code", actToken, label, ...(labelArg ? { labelArg } : {}) }
    : { error: cloudHomeCopy.ownerCodeUnavailable, code: "email_code", label } };
}

/** The answer for a standing computer grant: never, whatever is proven. */
export const BROWSER_NO_COMPUTER = "Murage in the cloud has no computer of yours to give access to.";
export const browserNoComputer = (): GateRefusal => ({ status: 403, body: { error: BROWSER_NO_COMPUTER, code: "no_computer" } });

/** What no code opens, even for the owner's browser: a standing grant of a computer the customer does not have, and the settings that
 *  set the stop line aside (No limits). The route table refuses the same markers; this is the second layer, in the handlers that write them. */
export function browserStandingRefusal(headers: IncomingHttpHeaders, body: unknown): GateRefusal | null {
  if (!onOwnerBrowser(headers) || body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const refused = b.noLimits === true || b.acknowledgeNoLimits === true || b.permissionMode === "unlimited" || b.computer === "local"
    || b.hostComputerConsent === "allowed" || b.acknowledgeLocalAuto === true || Object.hasOwn(b, "alwaysAllow");
  return refused ? browserNoComputer() : null;
}

/** The fields /api/config adds on a Cloud home (DESIGN section 9). Undefined off a home, so the answer there is unchanged.
 *  `surface` is "desktop" only for a caller that really acts as the owner (an owner browser, the phone, the desktop app): a chat-only
 *  browser reads settings through the same branch, and must not be told it is the desktop. `owner` is true for an owner-factor browser only. */
export function homeConfigView(headers: IncomingHttpHeaders, surface: string, factorUntil: (deviceId: string) => number | undefined):
  { surface: string; owner: boolean; ownerUntil?: number; computer: false; cloudOwnerBrowser: true } | undefined {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return undefined;
  const device = cloudIdentity(headers);
  const owner = isOwnerBrowser(device);
  const chatOnlyBrowser = device?.scope === "browser" && !owner;
  const until = owner && device ? factorUntil(device.id) : undefined;
  return { surface: chatOnlyBrowser ? "remote" : surface, owner, ...(typeof until === "number" ? { ownerUntil: until } : {}), computer: false, cloudOwnerBrowser: true };
}

export interface BrowserCardGateInput {
  threadId: string; requestId: string; behavior: "allow" | "answer"; allowForTask?: boolean;
  /** The live card, or undefined when it is gone. */
  card: (BrowserRiskCard & Record<string, unknown>) | undefined;
  live?: BrowserRiskLive; known?: BrowserRiskKnown;
  /** The approval digest of the live card (approvalDigestSync); it never changes, phones sign it. */
  digest: (card: BrowserRiskCard & Record<string, unknown>) => string;
}
/** DESIGN section 4: null when the owner's browser may answer this card, otherwise the 403 (a fresh code bound to the card, the decision
 *  and the risk reason) or 409 (the card is gone). A card that is not high risk needs nothing. */
export async function browserCardGate(req: IncomingMessage, input: BrowserCardGateInput): Promise<GateRefusal | null> {
  const high = browserHighRisk(input.card, input.live, input.known);
  if (!high) return null;
  if (!input.card) return { status: 409, body: { error: "This request is no longer waiting.", code: "fresh_auth_gone" } };
  const reason = browserEffectiveReason(input.card, input.live);
  const decision = input.behavior === "answer" ? "answer" : input.allowForTask === true ? "allow-task" : "allow";
  const act = cardActDigest({ threadId: input.threadId, requestId: input.requestId, decision, approvalDigest: input.digest(input.card), riskReason: reason ?? "unstamped" });
  const refused = await ownerCodeGate(req, act, input.requestId.startsWith("publish-") ? "publish_allow" : "allow_request");
  if (refused) return refused;
  markOwnerProven(req.headers, `card:${input.threadId}:${input.requestId}`);
  return null;
}
