import { connectionStatusFailureSentence, normalizeAccountAlias } from "./composio.ts";
import { NEEDS_OWN_SIGN_IN, type CatalogApp } from "./app-catalog.ts";
import { turnAudienceIsOwner, type TurnAudience } from "./owner-audience.ts";

export interface ConnectorRequest {
  slug: string;
  alias?: string;
}

export function connectorRequestKey(request: ConnectorRequest): string {
  return JSON.stringify([request.slug.trim().toLowerCase(), request.alias?.trim().toLowerCase() ?? ""]);
}

/** Structured requests take precedence; legacy callers can still send slugs. */
export function parseConnectorRequests(body: { items?: unknown; slugs?: unknown }): ConnectorRequest[] {
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.slugs) ? body.slugs : [];
  const items: ConnectorRequest[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const row = typeof raw === "string" ? { slug: raw } : raw;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown };
    const rawSlug = value.slug ?? value.toolkit;
    if (typeof rawSlug !== "string") continue;
    const slug = rawSlug.trim().toLowerCase();
    // A leading underscore is Composio's own spelling for a toolkit whose name
    // starts with a digit (`_1password`), not noise (upstream #1602).
    if (!/^[a-z0-9_][a-z0-9_-]{0,80}$/.test(slug)) continue;
    const alias = normalizeAccountAlias((value.alias ?? value.account) as string | null | undefined);
    const item = { slug, ...(alias ? { alias } : {}) };
    const key = connectorRequestKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

/** How long a sign-in link lives before the provider ends it. The provider
 * does not say; ten minutes is what the polling budget covers. */
export const CONNECTOR_LINK_LIFETIME_MS = 10 * 60_000;

type ServiceAccount = { alias?: string; status: string; statusReason?: string; createdAt?: string };
type ServiceState = {
  connected?: boolean;
  pending?: boolean;
  status?: string;
  statusReason?: string;
  createdAt?: string;
  accounts?: ServiceAccount[];
};

/** Toolkit readiness never proves readiness of a specifically requested account.
 * The provider's reason and creation time ride along so a failed link can be
 * told apart: expired, refused, or something else. */
export function connectorRequestStatus(
  service: ServiceState | undefined,
  alias?: string,
): { connected: boolean; pending: boolean; status: string; reason?: string; createdAt?: string } {
  if (!alias) {
    return {
      connected: service?.connected === true,
      pending: service?.pending === true,
      status: service?.status ?? "not_connected",
      ...(service?.statusReason ? { reason: service.statusReason } : {}),
      ...(service?.createdAt ? { createdAt: service.createdAt } : {}),
    };
  }
  const account = bestAccount((service?.accounts ?? []).filter((item) => item.alias?.trim().toLowerCase() === alias.trim().toLowerCase()));
  const status = account?.status ?? "not_connected";
  return {
    connected: /^active$/i.test(status),
    pending: /^(initiated|initializing|pending)$/i.test(status),
    status,
    ...(account?.statusReason ? { reason: account.statusReason } : {}),
    ...(account?.createdAt ? { createdAt: account.createdAt } : {}),
  };
}

/** Of the accounts that carry one label: the active one, else a pending one,
 * else the newest. A dead attempt must not shadow a live account, and an old
 * dead attempt must not shadow a new one. */
function bestAccount(accounts: ServiceAccount[]): ServiceAccount | undefined {
  const rank = (account: ServiceAccount) => /^active$/i.test(account.status) ? 0 : /^(initiated|initializing|pending)$/i.test(account.status) ? 1 : 2;
  const stamp = (account: ServiceAccount) => { const t = Date.parse(account.createdAt ?? ""); return Number.isFinite(t) ? t : 0; };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || stamp(b) - stamp(a))[0];
}

export type ConnectorFailureKind = "timed-out" | "denied" | "failed";

/** What the card says when a sign-in link ran out, whether the provider said
 * so (EXPIRED) or the card's own polling ended. */
export function connectorTimedOutSentence(): string {
  return "The sign-in link expired before it was finished. Try again.";
}

const FAILING_STATUS = /failed|expired|revoked|error|timed[_ -]?out/i;
const EXPIRED_REASON = /expir|timed?[_ -]?out|too long|no longer valid/i;
const REFUSED_REASON = /den(?:y|ied)|cancel|refus|reject|declin|not authori[sz]ed|access[_ ]?denied/i;

/**
 * One plain sentence for a sign-in that ended without connecting, or null when
 * it has not ended badly. The provider's own word ("EXPIRED", "FAILED") is
 * never shown: it names the state, it does not tell a person what to do.
 * `since` is when the link began (the account's creation, else the card's own
 * start): a link older than its life is an expired one whatever it is called.
 */
export function connectorFailure(input: {
  status?: string;
  reason?: string;
  since?: number | string;
  now?: number;
  label: string;
}): { kind: ConnectorFailureKind; sentence: string } | null {
  const status = input.status ?? "";
  if (!FAILING_STATUS.test(status)) return null;
  const now = input.now ?? Date.now();
  const began = typeof input.since === "string" ? Date.parse(input.since) : input.since;
  const aged = typeof began === "number" && Number.isFinite(began) && now - began > CONNECTOR_LINK_LIFETIME_MS;
  if (/expired/i.test(status) || (input.reason && EXPIRED_REASON.test(input.reason)) || aged) {
    return { kind: "timed-out", sentence: connectorTimedOutSentence() };
  }
  if (input.reason && REFUSED_REASON.test(input.reason)) {
    return { kind: "denied", sentence: `${input.label} sign-in was cancelled or refused. Try again.` };
  }
  return { kind: "failed", sentence: `Couldn't finish connecting ${input.label}. Try again.` };
}

/** A sign-in the provider still calls pending long after its link ran out:
 * nobody is coming back to it. Run by the status route, so the card ends on
 * the next desktop status read. (A card seen only on the phone ends locally,
 * through `endConnectorWait`, once its tries run out; the phone cannot call the
 * desktop-only status or timeout verbs, and this is what reconciles the saved
 * card afterwards.) */
export function abandonedLinkFailure(input: { authorizedAt?: number; now?: number }): { kind: ConnectorFailureKind; sentence: string } | null {
  if (typeof input.authorizedAt !== "number") return null;
  const now = input.now ?? Date.now();
  if (now - input.authorizedAt <= CONNECTOR_LINK_LIFETIME_MS + 60_000) return null;
  return { kind: "timed-out", sentence: connectorTimedOutSentence() };
}

/** What the panel's authorize route throws: a sentence, with the status kept.
 * The alias prompts (400 and 409) are already sentences the panel acts on and
 * pass through untouched. */
export function panelAuthorizeError(error: unknown, label: string): Error {
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined;
  if (error instanceof Error && (status === 400 || status === 409)) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const timeout = name === "TimeoutError" || name === "AbortError";
  return Object.assign(new Error(authorizeFailureSentence(error, label)), { status: timeout ? 504 : status ?? 502 });
}

/** What the card says when starting the sign-in itself failed. A slow service
 * is called slow, a service error becomes a status sentence, and an alias
 * clash (already a sentence) is kept; the runtime's exception text never
 * reaches a person. */
export function authorizeFailureSentence(error: unknown, label: string): string {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") return "Connected apps took too long to answer. Try again.";
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  const message = error instanceof Error ? error.message : "";
  if (status === 409 && /^Account alias "/.test(message)) return message;
  if (status === 502 || status === 503 || status === 504) return connectionStatusFailureSentence(500);
  if (status === 401 || status === 403 || status === 429) return connectionStatusFailureSentence(status);
  return `Couldn't start the ${label} sign-in. Try again.`;
}

/** What a chat connect card says for one app. An app with no hosted sign-in
 * of its own says so first: the connect page asks for the person's own
 * details (0.1.61 long tail). */
export function connectorCardText(toolkit: Pick<CatalogApp, "label" | "blurb" | "signIn">, alias?: string): { label: string; description: string } {
  const label = alias ? `${toolkit.label} (${alias})` : toolkit.label;
  if (toolkit.signIn === "own") {
    const blurb = toolkit.blurb.replace(/[.\s]+$/, "");
    return { label, description: blurb ? `${blurb}. ${NEEDS_OWN_SIGN_IN}` : NEEDS_OWN_SIGN_IN };
  }
  return { label, description: toolkit.blurb || `Connect ${toolkit.label} so the bot can continue` };
}

/** The model reads this as the tool's answer in a turn that is not the owner's. */
export const CONNECTED_APPS_OWNER_ONLY =
  "Connected apps belong to the owner, so this conversation cannot list or use the owner's accounts.";

/**
 * The owner's connected accounts are an owner-audience surface (plan 4.1):
 * listing them, searching them, or asking to add one, all go through the one
 * predicate on the CONSUMING turn. A contact's thread, and a delegated or
 * asked turn that a contact's thread started (its task thread is bound to the
 * same person, human-principals.ts humanTask), gets this refusal instead.
 * internal-route-authority.ts refuses the same routes for a channel person;
 * this is the registered surface check, so a change there cannot open it.
 */
export function connectedAppsAudienceRefusal(
  threadId: string,
  audience: TurnAudience = {},
  isOwner: (threadId: string, audience: TurnAudience) => boolean = turnAudienceIsOwner,
): string | null {
  // An audience that cannot be read is not the owner's.
  try {
    return isOwner(threadId, audience) ? null : CONNECTED_APPS_OWNER_ONLY;
  } catch {
    return CONNECTED_APPS_OWNER_ONLY;
  }
}
