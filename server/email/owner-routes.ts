// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's bot email routes (BOT-EMAIL-MURAGE-109 2.0, 2.4 to 2.6, 3.3, 3.5, section 6): `/api/email/*`, answered on the server only. Every
// Flux call made here uses the email:owner token, which never reaches an engine. Who may call:
//   - a request carrying a bot or engine credential (an internal turn capability) never reaches a route (F18): 403 before anything else;
//   - otherwise only the owner's own surfaces: the desktop app, or the paired phone; a phone change carries a fresh device proof over the
//     exact act (emailOwnerActionCard), and the account switch is desktop only.
// Dark launch: until the capability probe says enabled: true, every route answers one not-available refusal and nothing else (the status
// route adds the section 8 Flux line only for an install that once had email on and has lost its Flux key).
import type { BindingRow } from "./email-store.ts";
import { LIVE_BINDING_STATES, OPEN_SEND_STATES, TERMINAL_SEND_STATES, type SendState } from "./email-store.ts";
import type { EmailRuntime } from "./runtime.ts";
import { emailRef } from "./canonical.ts";
import { filteredReason, isFilteredMail } from "./inbound.ts";
import { addrSpec } from "./tools.ts";
import {
  activityLine, bindingFailureLine, EMAIL_OWNER_COPY, EMAIL_POLICY_COPY, EMAIL_SETUP_COPY, emailOwnerActionCard, emailOwnerActionRequestId, headerChip,
  ownerRouteLine, type EmailBotView, type EmailOwnerAction, type EmailStatusView, type EmailTrustEntry,
} from "../../shared/email-copy.ts";

export type OwnerRouteAnswer = { status: number; body: Record<string, unknown> };
export interface OwnerRouteRequest {
  method: string; path: string; query: URLSearchParams; body: unknown;
  /** desktop = the desktop app; phone = the paired phone acting as the owner; null = neither (a script, a browser tab, a bot's shell). */
  surface: "desktop" | "phone" | null;
  /** The request carried a bot or engine credential (an internal capability). */
  botCredential: boolean;
}
export interface OwnerRouteDeps {
  runtime: Pick<EmailRuntime, "enabled" | "services" | "probe" | "client" | "everEnabled"> & { secrets?: Pick<EmailRuntime["secrets"], "owner"> }
    & Partial<Pick<EmailRuntime, "keyRejected" | "ownerKeyLine" | "botKeyLine">>;
  bot: (botId: string) => { id: string; name: string; threadId: string; installedPackage?: { emailIntent?: "was-on" } } | undefined;
  fluxKeyPresent: () => boolean;
  /** Phone acts: the fresh device proof over this card; null = go on. */
  freshProof: (threadId: string, requestId: string, card: { tool: string; title: string; subtitle: string }, body: Record<string, unknown>) => Promise<OwnerRouteAnswer | null>;
  now?: () => number;
}

export const EMAIL_OWNER_PREFIX = "/api/email/";
const ACTIONS: Record<string, EmailOwnerAction> = {
  setup: "setup", retry: "retry", pause: "pause", resume: "resume", remove: "remove", keep: "keep", reconnect: "reconnect", policy: "policy",
  "trusted-add": "trust_add", "trusted-remove": "trust_remove", "blocked-add": "block_add", "blocked-remove": "block_remove",
};
const USERNAME = /^[a-z0-9][a-z0-9.-]{1,63}$/i;
const ADDRESS = /^[^\s@<>(),;:"[\]\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/i;
const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,63}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ALL_STATES: SendState[] = [...OPEN_SEND_STATES, ...TERMINAL_SEND_STATES];

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): OwnerRouteAnswer => ({ status, body: { error, ...extra } });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const exactAddress = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text.length <= 254 && ADDRESS.test(text) ? text : null;
};
const blockEntry = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return exactAddress(text) ?? (text.length <= 253 && DOMAIN.test(text) ? text : null);
};

/** Null when the path is not an email owner route; otherwise its answer. Never throws. */
export async function emailOwnerRoute(deps: OwnerRouteDeps, request: OwnerRouteRequest): Promise<OwnerRouteAnswer | null> {
  if (!request.path.startsWith(EMAIL_OWNER_PREFIX)) return null;
  // F18: a bot or engine credential never reaches an owner route, on or off
  if (request.botCredential || request.surface === null) return refuse(403, EMAIL_OWNER_COPY.ownerOnly);
  try {
    if (request.path === "/api/email/status" && request.method === "GET" && request.query.get("refresh") === "1" && deps.fluxKeyPresent()) {
      try { await deps.runtime.probe.refresh(); } catch { /* the last answer stands */ }
    }
    if (!deps.runtime.enabled()) {
      // section 8: the Flux line only for an install that had email on and has lost its key; never for one that never had it (dark wins)
      const fluxOff = request.path === "/api/email/status" && !deps.fluxKeyPresent() && deps.runtime.everEnabled();
      // a saved account key Flux answered 401 (revoked or unknown): say so and offer sign-in, never hide the card (1.0.11)
      const fluxRefused = request.path === "/api/email/status" && deps.fluxKeyPresent() && deps.runtime.probe.accountKeyRefused();
      return refuse(404, EMAIL_OWNER_COPY.notAvailable, fluxOff ? { fluxOff: EMAIL_SETUP_COPY.fluxOff } : fluxRefused ? { fluxRefused: EMAIL_SETUP_COPY.fluxKeyRefused } : {});
    }
    return await enabledRoute(deps, request);
  } catch {
    return refuse(500, EMAIL_OWNER_COPY.actionFailed);
  }
}

async function enabledRoute(deps: OwnerRouteDeps, request: OwnerRouteRequest): Promise<OwnerRouteAnswer> {
  const services = deps.runtime.services();
  if (!services) return refuse(404, EMAIL_OWNER_COPY.notAvailable);
  const { method, path } = request;
  if (path === "/api/email/status" && method === "GET") return { status: 200, body: await statusView(deps, request.surface === "desktop") as unknown as Record<string, unknown> };
  const other = path.match(/^\/api\/email\/other-setups\/([\w-]{1,160})\/remove$/);
  if (other && method === "POST") return removeOtherSetup(deps, request, other[1]!);
  if (path === "/api/email/account" && method === "POST") return account(deps, request);
  const read = path.match(/^\/api\/email\/bots\/([\w-]{1,160})$/);
  if (read && method === "GET") {
    const bot = deps.bot(read[1]!);
    if (!bot) return refuse(404, "No such bot.");
    return { status: 200, body: await botView(deps, bot) as unknown as Record<string, unknown> };
  }
  const act = path.match(/^\/api\/email\/bots\/([\w-]{1,160})\/([a-z-]+)$/);
  const action = act ? ACTIONS[act[2]!] : undefined;
  if (!act || !action || method !== "POST") return refuse(404, "No such route.");
  const bot = deps.bot(act[1]!);
  if (!bot) return refuse(404, "No such bot.");
  const body = record(request.body);
  if (request.surface === "phone") {
    const refused = await deps.freshProof(bot.threadId, emailOwnerActionRequestId(action, bot.id), emailOwnerActionCard(action, bot.id, body), body);
    if (refused) return refused;
  }
  return botAct(deps, bot, action, body);
}

/** 2.6 data folder lost: an inbox of this account whose bot is not on this install, listed under "Email addresses from another setup". */
async function otherSetups(deps: OwnerRouteDeps): Promise<EmailStatusView["otherSetups"]> {
  const store = deps.runtime.services()!.store;
  const listed = await deps.runtime.client.listInboxes({ kind: "owner" });
  if (listed.kind !== "ok") return undefined;
  const known = new Set([...store.bindings().map(row => row.inboxId), ...store.tombstones().map(tomb => tomb.inboxId)].filter(Boolean));
  return (listed.body.data ?? [])
    .filter(item => typeof item.id === "string" && item.state !== "deleted" && item.state !== "closing" && !known.has(item.id) && !(typeof item.bot_id === "string" && deps.bot(item.bot_id)))
    .map(item => ({ inboxId: item.id, address: typeof item.address === "string" ? item.address : null }));
}

/** Remove for an address from another setup (desktop only): DELETE #7 with the owner token; a 202 is enough for this list. */
async function removeOtherSetup(deps: OwnerRouteDeps, request: OwnerRouteRequest, inboxId: string): Promise<OwnerRouteAnswer> {
  if (request.surface !== "desktop") return refuse(403, EMAIL_OWNER_COPY.computerOnly);
  if (record(request.body).confirm !== true) return refuse(400, "Confirm to remove this address.", { code: "confirm_required" });
  const listed = await otherSetups(deps);
  if (!listed?.some(item => item.inboxId === inboxId)) return refuse(404, "That address is not from another setup.");
  const answer = await deps.runtime.client.deleteInbox(inboxId);
  if (answer.kind === "ok" || answer.kind === "held" || (answer.kind === "refused" && answer.status === 404)) return { status: 200, body: await statusView(deps, true) as unknown as Record<string, unknown> };
  return refuse(answer.kind === "refused" ? answer.status : 503, ownerRouteLine(answer.kind === "refused" ? answer.code : null));
}

async function statusView(deps: OwnerRouteDeps, desktop: boolean): Promise<EmailStatusView> {
  const caps = deps.runtime.probe.current() ?? {};
  const price = deps.runtime.probe.priceNote();
  const limits: Record<string, number> = {};
  for (const [key, value] of Object.entries(caps.limits ?? {})) if (typeof value === "number" && Number.isFinite(value)) limits[key] = value;
  const store = deps.runtime.services()!.store;
  // 2.6: an owner removal, and a deleted bot's committed intent, show "Removing [address]" until Flux confirms
  const removing = store.bindings().filter(row => row.state === "removing" || row.state === "remove_requested").map(row => ({ botId: row.botId, address: row.address }));
  let accountSends: EmailStatusView["accountSends"];
  let others: EmailStatusView["otherSetups"];
  if (deps.runtime.secrets?.owner()) {
    try {
      const settings = await deps.runtime.client.getSettings();
      const lim = settings.kind === "ok" ? settings.body.limits ?? {} : {};
      if (typeof lim.account_sends_today === "number" && typeof lim.account_sends_per_day === "number") accountSends = { today: lim.account_sends_today, perDay: lim.account_sends_per_day };
    } catch { /* the line waits for the next read */ }
    try { others = await otherSetups(deps); } catch { /* listed on the next open */ }
  }
  return {
    enabled: true, accountState: typeof caps.account_state === "string" ? caps.account_state : "active", termsVersion: typeof caps.terms_version === "string" ? caps.terms_version : null,
    // 2.0: the one price line, desktop only and only where Flux lets it show
    ...(desktop && price && (price.surfaces.length === 0 || price.surfaces.includes("desktop")) ? { priceNote: price.note } : {}),
    limits, removing,
    ...(accountSends ? { accountSends } : {}),
    ...(others?.length ? { otherSetups: others } : {}),
    // 2.4, section 8: whether owner acts can run, and the owner token's health
    ownerSignedIn: Boolean(deps.runtime.secrets?.owner()), ownerKeyLine: deps.runtime.ownerKeyLine?.() ?? null,
  };
}

async function account(deps: OwnerRouteDeps, request: OwnerRouteRequest): Promise<OwnerRouteAnswer> {
  if (request.surface !== "desktop") return refuse(403, EMAIL_OWNER_COPY.computerOnly);
  const body = record(request.body);
  const services = deps.runtime.services()!;
  if (body.on === true) {
    const terms = typeof body.acceptTermsVersion === "string" ? body.acceptTermsVersion : deps.runtime.probe.current()?.terms_version;
    if (!terms) return refuse(400, ownerRouteLine("terms_not_accepted"), { code: "terms_not_accepted" });
    const answer = await deps.runtime.client.enable(terms);
    if (answer.kind !== "ok") return failed(answer);
    services.bindings.accountState(true);
  } else if (body.on === false) {
    // 2.0: Off only after the owner confirmed the exact line
    if (body.confirm !== true) return refuse(400, EMAIL_SETUP_COPY.accountOffConfirm, { code: "confirm_required" });
    const answer = await deps.runtime.client.disable(EMAIL_SETUP_COPY.accountOffConfirm);
    if (answer.kind !== "ok") return failed(answer);
    services.bindings.accountState(false);
  } else return refuse(400, "Say on or off.");
  try { await deps.runtime.probe.refresh(); } catch { /* the last answer stands */ }
  if (!deps.runtime.enabled()) return { status: 200, body: { enabled: false } };
  return { status: 200, body: await statusView(deps, true) as unknown as Record<string, unknown> };
}

function failed(answer: { kind: string; code?: string; status?: number; reason?: string }): OwnerRouteAnswer {
  const code = answer.kind === "refused" ? answer.code ?? "unavailable" : answer.kind === "uncertain" && answer.reason === "no_credential" ? "owner_required" : "unavailable";
  const status = answer.kind === "refused" ? (answer.status && answer.status >= 400 && answer.status < 500 ? answer.status : 502) : code === "owner_required" ? 403 : 503;
  return refuse(status, ownerRouteLine(code), { code });
}

async function botAct(deps: OwnerRouteDeps, bot: { id: string; name: string; threadId: string }, action: EmailOwnerAction, body: Record<string, unknown>): Promise<OwnerRouteAnswer> {
  const services = deps.runtime.services()!;
  const { store, bindings } = services;
  const now = (deps.now ?? Date.now)();
  const binding = store.getBinding(bot.id);
  const view = async (): Promise<OwnerRouteAnswer> => ({ status: 200, body: await botView(deps, bot) as unknown as Record<string, unknown> });
  // r2.5: Flux's bot key switch is off, so setup left nothing behind; the owner sees the same dark answer as every other route
  const dark = (): OwnerRouteAnswer => refuse(404, EMAIL_OWNER_COPY.notAvailable, { code: "email_dark" });
  const live = (row: BindingRow | null): row is BindingRow => Boolean(row?.inboxId) && (row!.state === "active" || row!.state === "paused" || row!.state === "grace" || row!.state === "billing_hold");
  switch (action) {
    case "setup": {
      if (binding && binding.state !== "failed") return refuse(409, "This bot already has an email address.");
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (!USERNAME.test(username)) return refuse(400, EMAIL_OWNER_COPY.invalidUsername);
      if (!displayName || displayName.length > 64 || CONTROL.test(displayName)) return refuse(400, "Give the address a display name of up to 64 characters.");
      await bindings.enable(bot.id, { username, displayName });
      return store.getBinding(bot.id) ? view() : dark();
    }
    case "retry":
      if (binding?.state !== "failed") return refuse(409, "There is nothing to retry.");
      await bindings.enable(bot.id, {});
      return store.getBinding(bot.id) ? view() : dark();
    case "pause": case "resume": case "reconnect": {
      if (action === "resume") {
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (!note || note.length > 500) return refuse(400, EMAIL_OWNER_COPY.resumeNoteNeeded);
      }
      // 2.3: Reconnect on a live binding whose key Flux refused gives the bot a new email key (mint, check #5, save, revoke the old one)
      if (action === "reconnect" && binding && LIVE_BINDING_STATES.has(binding.state) && deps.runtime.keyRejected?.(bot.id)) {
        const rotated = await bindings.rotateKey(bot.id, botId => services.send.canRotate(botId));
        if (!rotated.ok) return refuse(rotated.code === "sends_in_flight" ? 409 : rotated.code === "email_dark" ? 404 : 503, ownerRouteLine(rotated.code), { code: rotated.code });
        return view();
      }
      const result = action === "pause" ? await bindings.pause(bot.id) : action === "resume" ? await bindings.resume(bot.id) : await bindings.reconnect(bot.id);
      if (!result.ok) return refuse(result.status, ownerRouteLine(result.code), { code: result.code });
      return view();
    }
    case "remove":
      if (body.confirm !== true) return refuse(400, EMAIL_SETUP_COPY.removeConfirm(binding?.address ?? "this address", bot.name), { code: "confirm_required" });
      if (!binding) return refuse(404, "This bot has no email address.");
      await bindings.remove(bot.id);
      return view();
    case "keep": {
      // design 3.2: "Removing: undo until [date]" with Keep address (#37); also a closing inbox Flux closed (billing, account)
      const result = await bindings.keep(bot.id);
      if (!result.ok) return refuse(result.status, ownerRouteLine(result.code), { code: result.code });
      return view();
    }
    case "policy": {
      const policy = body.policy === "ask" || body.policy === "auto" ? body.policy : null;
      if (!policy) return refuse(400, "Choose who the bot can email without asking.");
      if (!binding) return refuse(404, "This bot has no email address.");
      await bindings.setPolicy(bot.id, policy);
      return view();
    }
    case "trust_add": case "trust_remove": case "block_add": case "block_remove": {
      if (!live(binding)) return refuse(409, "Give this bot an address first.");
      const allow = action === "trust_add" || action === "trust_remove";
      // trusted: exact addresses only (contract r2.3); Never email: an address or a whole domain
      const entry = allow ? exactAddress(body.entry) : blockEntry(body.entry);
      if (!entry) return refuse(400, allow ? EMAIL_OWNER_COPY.invalidAddress : EMAIL_OWNER_COPY.invalidEntry);
      if (action === "trust_add" || action === "block_add") {
        const answer = await deps.runtime.client.addRecipient(binding.inboxId!, entry, allow ? "allow" : "block");
        if (answer.kind === "refused" && answer.code === "domain_allow_not_available") return refuse(400, EMAIL_POLICY_COPY.domainAllowNotAvailable(bot.name), { code: answer.code });
        if (answer.kind !== "ok") return failed(answer);
        store.addTrusted(bot.id, entry, allow ? "allow" : "block", "owner", now);
      } else {
        const kept = store.trustedEntries(bot.id).find(item => item.entry === entry && item.rule === (allow ? "allow" : "block"));
        const answer = await deps.runtime.client.removeRecipient(binding.inboxId!, entry);
        if (answer.kind !== "ok" && !(answer.kind === "refused" && answer.status === 404)) return failed(answer);
        if (kept) store.removeTrusted(bot.id, entry);
      }
      return view();
    }
  }
}

/** The bot's Email section (section 6 states, 3.3 row, 3.5 lists and Activity). Reads #5 for a live binding. */
export async function botView(deps: Pick<OwnerRouteDeps, "runtime">, bot: { id: string; name: string; installedPackage?: { emailIntent?: "was-on" } }): Promise<EmailBotView> {
  const services = deps.runtime.services()!;
  const { store, bindings } = services;
  let row = store.getBinding(bot.id);
  let pause: { reason?: string; resumable_by?: string } | null = null;
  let sendsToday: number | undefined, dailyCap: number | undefined;
  if (row && LIVE_BINDING_STATES.has(row.state)) {
    try { const fresh = await bindings.refresh(bot.id); row = fresh.row; pause = fresh.pause; sendsToday = fresh.sendsToday; dailyCap = fresh.dailyCap; } catch { /* the stored state stands */ }
  }
  const sends = store.sendsOfBot(bot.id, ALL_STATES);
  const waiting = sends.filter(send => send.state === "awaiting_owner" || send.state === "held").length;
  const state = row?.state ?? null;
  const supportOnly = pause?.resumable_by !== undefined && pause.resumable_by !== "owner";
  const panelLine = state === "active" ? (typeof sendsToday === "number" && typeof dailyCap === "number" ? EMAIL_OWNER_COPY.sentToday(sendsToday, dailyCap) : null)
    : state === "paused" ? (supportOnly ? EMAIL_OWNER_COPY.supportPausedLine : EMAIL_OWNER_COPY.pausedLine(bot.name))
    : state === "billing_hold" ? EMAIL_OWNER_COPY.holdLine(bot.name)
    : state === "grace" ? EMAIL_OWNER_COPY.graceLine(bot.name)
    : state === "closing" ? EMAIL_OWNER_COPY.closingLine(row?.closingUntil ?? null)
    : state === "account_off" ? EMAIL_SETUP_COPY.accountOff
    : state === "failed" ? bindingFailureLine(row?.failure)
    : state === "provisioning" ? EMAIL_SETUP_COPY.provisioning
    : state === "removing" || state === "remove_requested" ? EMAIL_OWNER_COPY.removingLine(row?.address ?? "this address", state === "remove_requested" ? row?.closingUntil ?? null : null)
    : state === "restored_unverified" ? EMAIL_SETUP_COPY.reconnect : null;
  const label = (source: string) => EMAIL_POLICY_COPY.sources[source] ?? EMAIL_POLICY_COPY.sources.owner!;
  const entries = store.trustedEntries(bot.id);
  const trusted: EmailTrustEntry[] = entries.filter(item => item.rule === "allow").map(item => ({ entry: item.entry, source: item.source, sourceLabel: label(item.source) }));
  const blocked: EmailTrustEntry[] = entries.filter(item => item.rule === "block").map(item => ({ entry: item.entry, source: item.source, sourceLabel: label(item.source) }));
  const activity = sends.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).flatMap(send => {
    const address = send.kind === "reply" && send.summary.replySource ? send.summary.replySource.from : send.summary.to[0];
    const line = activityLine(send.state, send.why, send.code, address);
    return line ? [{ ref: emailRef(send.sendId), line, at: send.createdAt }] : [];
  });
  return {
    botId: bot.id, botName: bot.name, state, address: row?.address ?? null, chip: headerChip(state, waiting, row?.address ?? null), panelLine,
    failure: state === "failed" ? bindingFailureLine(row?.failure) : null,
    policy: row?.policy ?? "auto", policyPending: store.getPolicySync(bot.id)?.state === "pending",
    trusted, blocked, activity, waiting, pauseReason: state === "paused" ? (pause?.reason ?? null) : null,
    // 5.2: the bot never sees these; the owner does, from the envelope cache (no subject, no text)
    filtered: row?.inboxId ? store.receivedEvents(row.inboxId, 100).filter(event => isFilteredMail(event.data)).slice(0, 50).flatMap(event => {
      const from = addrSpec(event.data.from);
      return from ? [{ id: event.eventId, from, reason: filteredReason(event.data), at: event.receivedAt }] : [];
    }) : [],
    // section 8 / G15: the bot's own key health; Reconnect rotates a refused key (2.3)
    keyLine: row && LIVE_BINDING_STATES.has(row.state) ? deps.runtime.botKeyLine?.(bot.id) ?? null : null,
    keyRejected: Boolean(row && LIVE_BINDING_STATES.has(row.state) && deps.runtime.keyRejected?.(bot.id)),
    // section 7: an imported bot that had an address where it came from (email always starts off after import)
    importOffer: !row && bot.installedPackage?.emailIntent === "was-on" ? EMAIL_SETUP_COPY.importOffer : null,
  };
}
