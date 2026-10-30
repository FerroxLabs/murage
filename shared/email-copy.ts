// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-facing bot email words (BOT-EMAIL-MURAGE-109 sections 2.0, 2.6, 3.3, 3.5, 4, 6, 8). Shared by the server (card words, activity
// rows) and the app (Settings, the bot's email section). Copy rules: no em dashes, no prices (the price line comes only from the
// capabilities response), never the words the copy rules forbid.

/** A setup step Flux refused, as one owner line (the failed state of the bot's email section). */
export function bindingFailureLine(code: string | null | undefined): string {
  switch (code) {
    // #3 is owner-only (Flux #516): only the email:owner token may create an inbox
    case "owner_required": return "Only you can give a bot an address, and Murage could not confirm your account for this step. Sign in to Flux again in Settings, then press Retry.";
    // r2.5: #3 names the bot with bot_id; Flux knows a bot once its email key exists
    case "bot_not_found": return "Flux has not linked this bot to your account yet. Press Retry. If this shows again, choose Remove, then give the bot an address again.";
    case "username_unavailable": return "That address is taken. Pick another username and press Retry.";
    case "invalid_request": return "That username or name cannot be used. Use letters, numbers, dots or dashes, then press Retry.";
    case "inbox_limit_reached": return "Your account has reached its number of bot addresses. Remove one, then press Retry.";
    case "premium_locked": return "Bot email is not available on your account yet. Press Retry later.";
    case "email_not_enabled": return "Bot email is off for your account. Turn it on in Settings > Bot email, then press Retry.";
    default: return "Murage could not finish setting up this address. Press Retry, or Remove it.";
  }
}

/** 3.5 activity lines, one per email, from the row's `why` code and state (owner only; never a bot-visible status). */
export function activityLine(state: string, why: string | null, code: string | null, address?: string): string | null {
  if (state === "sent") {
    if (why === "owner_send") return "Sent: you pressed Send";
    if (why === "approved_first_writer") return `Sent: replying to ${address ?? "someone"}, who wrote first and is approved`;
    if (why === "trusted") return `Sent: ${address ?? "the address"} is on the trusted list`;
    return "Sent";
  }
  if (state === "awaiting_owner" || state === "held") {
    switch (why) {
      case "waiting_new_contact": return "Waiting: first reply to someone new";
      case "waiting_attachment": return "Waiting: has an attachment";
      case "waiting_long": return "Waiting: long email";
      case "waiting_many_addresses": return "Waiting: many addresses";
      default: return "Waiting: for your answer";
    }
  }
  if (state === "declined") return "Not sent: you chose Don't send";
  if (state === "withdrawn" && code === "stopped") return "Not sent: stopped";
  if (state === "withdrawn" && code === "edited") return "Not sent: you edited it";
  if (state === "withdrawn" && code === "owner_resent") return "Sent again as a new email";
  if (state === "withdrawn") return "Not sent: withdrawn";
  if (state === "expired") return "Not sent: it ran out waiting";
  if (state === "refused") return "Not sent: Flux did not accept it";
  return null;
}

/** approved_unsent: why the send has not gone out, from the check code Flux gave. */
export function checkLine(code: string | null | undefined): string {
  switch (code) {
    case "daily_send_cap_reached": case "daily_cap": return "the daily email limit is reached";
    case "account_send_cap_reached": return "your bots reached today's email total";
    case "burst": case "rate_limit_error": return "too many emails went out at once";
    case "bot_paused": return "sending is paused for this bot";
    case "recipient_blocked": return "a recipient is blocked";
    case "key_budget_reached": return "this bot's monthly email budget is used up";
    // r2.5: 403 inbox_closing (restorable): the address is kept for 30 days and comes back with Keep address
    case "inbox_closing": return "this address is closing. Choose Keep address in the bot's Email settings to bring it back";
    default: return "Flux could not send it this time";
  }
}

export const EMAIL_CARD_COPY = {
  send: "Send", edit: "Edit", dontSend: "Don't send", retry: "Retry",
  manage: (bot: string) => `Manage who ${bot} can email`,
  checkSent: "Check sent mail",
  stopped: "Stopped. Not sent.",
  expired: (bot: string) => `This request ran out. Ask ${bot} to send it again.`,
  sibling: (bot: string, address: string) => `Waiting for your answer on the other email ${bot} wrote to ${address}.`,
  approvedUnsent: (line: string) => `You said Send. It has not gone out yet: ${line}.`,
  unknownExpired: "Murage could not confirm whether this email went out. Check sent mail before you send it again.",
  sending: "Sending.",
  sent: "Sent.",
  declined: "Not sent: you chose Don't send.",
  edited: "Replaced by your edited email.",
  resent: "You sent this again as a new email.",
  withdrawn: "Not sent.",
  refused: "Not sent: Flux did not accept it.",
  refreshed: "This email changed. Check it again before you answer.",
  restoredWaiting: "This email was waiting before the restore.",
} as const;

/** 3.3 and 3.5 copy, verbatim. */
export const EMAIL_POLICY_COPY = {
  title: (bot: string) => `Who can ${bot} email without asking?`,
  ask: { label: "Nobody. I approve every email", detail: (bot: string) => `${bot} writes each email and waits. Nothing goes out until you tap Send.` },
  auto: { label: "People who've emailed it, after I approve once", detail: (bot: string) => `When someone new emails ${bot}, you approve its first reply. After that, ${bot} can reply to that exact address on its own. Anything long, with attachments or with many addresses still waits for you.` },
  always: "No mass mail, a daily limit, an automatic pause if someone reports spam or mail bounces, a full activity list, and one tap to pause sending.",
  trustedTitle: (bot: string) => `People ${bot} can email without asking`,
  domainAllowNotAvailable: (bot: string) => `Add each person's address. ${bot} can email the addresses on this list without asking.`,
  neverEmail: "Never email",
  sources: { owner: "Added by you", approval: "You approved an email", earned: "Earned in chat" } as Record<string, string>,
} as const;

/** 2.0, 2.6 and 8 copy, verbatim. */
/** Section 8: one line per credential health state (server/email/key-health.ts). The first is the design's own words. */
export const EMAIL_KEY_HEALTH_COPY = {
  rejected: "Email is not reachable: Flux did not accept the saved key.",
  email_off: "Bot email is off for your account. Turn it on in Settings > Bot email.",
  not_eligible: "Bot email is not available on your account yet.",
  paused: "Email is paused.",
  outage: "Email is busy at Flux right now. Murage tries again shortly.",
} as const;

export const EMAIL_SETUP_COPY = {
  importOffer: "This bot had an email address where it came from. Give it one here?",
  signInAction: "Sign in to Flux",
  accountOffConfirm: "Bot email turns off for this account. Your bots' inboxes are paused now and deleted after 30 days.",
  give: "Give this bot an email address",
  provisioning: "Setting up email",
  failed: "Email setup did not finish",
  removing: "Removing email",
  reconnect: "Reconnect email",
  pauseSending: "Pause sending",
  pauseConfirm: (bot: string) => `${bot} keeps its address and its mail, and the inbox is still billed while paused.`,
  removeConfirm: (address: string, bot: string) => `Remove ${address}? ${bot} stops sending and receiving now. Mail is deleted after 30 days and this address can't be used again.`,
  accountOff: "Bot email is off for this account. Turn it on in Settings > Bot email.",
  fluxOff: "Email addresses for bots come with Flux. Connect Flux in Settings to use them.",
} as const;

/** Section 6 header chip for a binding state (and open cards). */
export function headerChip(state: string | null, waiting: number, address: string | null): string | null {
  switch (state) {
    case "active": return waiting > 0 ? `${waiting} ${waiting === 1 ? "email" : "emails"} waiting for you` : address;
    case "paused": return "Email paused";
    case "billing_hold": case "grace": return "Email on hold";
    case "closing": return "Email closing";
    case "account_off": return "Email off";
    case "provisioning": return EMAIL_SETUP_COPY.provisioning;
    case "failed": return EMAIL_SETUP_COPY.failed;
    case "removing": case "remove_requested": return EMAIL_SETUP_COPY.removing;
    case "restored_unverified": return EMAIL_SETUP_COPY.reconnect;
    default: return null;
  }
}

/** The email card payload (server/email/cards.ts builds it; the app renders it). */
export type EmailCardPhase = "open" | "answered" | "settled";
export type EmailCardAction = "send" | "edit" | "dont_send" | "retry";
export interface EmailCardPayload {
  sendId: string; revision: number; payloadHash: string; heldIds: string[]; state: string; phase: EmailCardPhase;
  ref: string; botId: string; note?: string; siblingRequestId?: string; actions: EmailCardAction[];
  /** The frozen draft the Edit box opens with. */
  draft: { to: string[]; cc: string[]; subject: string; text: string };
  links: { manage: string; checkSent?: string };
}

/** The proposal card for earned trust (3.5), built from Murage's own record: "Add [address]" / "Not now". */
export type EmailTrustPhase = "open" | "added" | "declined";
export interface EmailTrustOfferPayload { botId: string; address: string; offeredAt: number; phase: EmailTrustPhase; note?: string }
export const EMAIL_TRUST_COPY = {
  title: (bot: string, address: string) => `${bot} has emailed ${address} with your Send several times. Add ${address} to the people ${bot} can email without asking?`,
  add: (address: string) => `Add ${address}`,
  notNow: "Not now",
  added: (address: string) => `Added ${address}. You can remove it in the bot's Email settings.`,
  declined: (address: string) => `Not now. ${address} stays as it is, and this offer will not come back for 30 days.`,
  failed: "Murage could not add the address this time. Try again shortly.",
  pushBody: (bot: string) => `${bot} suggests a trusted email contact`,
} as const;

/** Owner settings words (2.0, 2.5, 2.6, section 6). */
export const EMAIL_OWNER_COPY = {
  sectionTitle: "Bot email",
  notAvailable: "Bot email is not available.",
  ownerOnly: "Only you can change bot email, from the Murage app or your paired phone.",
  computerOnly: "Bot email for the account is turned on or off on the computer running Murage.",
  accountOn: "Turn on bot email",
  accountOffAction: "Turn off bot email",
  accountOnLine: "Bot email is on for this account.",
  accountOffLine: "Bot email is off for this account.",
  usernameLabel: "Username",
  displayNameLabel: "Display name",
  usernameHint: "Letters, numbers, dots or dashes. The address can't be changed later.",
  invalidUsername: "Use 2 to 64 letters, numbers, dots or dashes, starting with a letter or number.",
  invalidAddress: "Enter one full email address, like name@example.com.",
  invalidEntry: "Enter one full email address or a domain, like example.com.",
  resume: "Resume",
  resumeNote: "What changed? Murage passes this note with the resume.",
  resumeNoteNeeded: "Add a short note about what changed before you resume.",
  retry: "Retry",
  remove: "Remove",
  activityTitle: "Activity",
  activityEmpty: "No emails yet.",
  neverEmailHint: "Addresses or whole domains this bot never emails.",
  removingLine: (address: string, until: string | null = null) => { const day = until ? until.slice(0, 10) : null; return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${address} stays yours until ${day}. Choose Keep address to bring it back.` : `Removing ${address}`; },
  keepAddress: "Keep address",
  otherSetupsTitle: "Email addresses from another setup",
  otherSetupRemoveConfirm: (address: string) => `Remove ${address}? Mail is deleted after 30 days and this address can't be used again.`,
  pausedLine: (bot: string) => `${bot}'s email is paused. Mail still arrives. Resume asks for a short note about what changed.`,
  supportPausedLine: "Email is paused for this account. Contact support to turn it back on.",
  holdLine: (bot: string) => `${bot} can still receive email but cannot send until your Flux account is settled.`,
  sentToday: (n: number, cap: number) => `${n} of ${cap} emails sent today`,
  accountSentToday: (n: number, cap: number) => n >= cap ? `Your bots have sent today's ${cap} emails together.` : `Your bots have sent ${n} of ${cap} emails today.`,
  graceLine: (bot: string) => `${bot} still receives email. It can send again once your Flux credit is topped up.`,
  closingLine: (until: string | null) => { const day = until ? until.slice(0, 10) : null; return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `Email is closing: mail is deleted on ${day}. Top up and choose Keep address to restore it.` : "Email is closing. Top up and choose Keep address to restore it."; },
  actionFailed: "Flux did not take that change this time. Try again shortly.",
  ownerSignIn: "Murage could not confirm your Flux account for this step. Sign in to Flux again in Settings, then try again.",
} as const;

/** Owner-route refusal and outcome lines for a Flux code (owner routes only). */
export function ownerRouteLine(code: string | null | undefined): string {
  switch (code) {
    case "domain_allow_not_available": return "Add each person's address.";
    case "pause_cooloff": return "This pause can be resumed 72 hours after it started.";
    case "bot_pause_requires_support": case "account_email_paused": return EMAIL_OWNER_COPY.supportPausedLine;
    case "not_paused": return "Email is not paused.";
    case "still_paused": return "Flux keeps this pause in place for now. The reason shows above; contact support if it does not clear.";
    case "email_scope_required": return "Flux did not accept the saved email key for this step. Reconnect email in Settings.";
    case "suppression_locked": return "This person asked not to be emailed, so the entry stays.";
    case "owner_required": case "unauthorized": case "key_expired": return EMAIL_OWNER_COPY.ownerSignIn;
    case "terms_not_accepted": return "Accept the email terms to turn bot email on.";
    case "premium_locked": return "Bot email is not available on your account yet.";
    case "sends_in_flight": return "An email is still on its way. Reconnect once it has settled.";
    case "rotation_expired": return "Reconnect took too long to finish. Press Reconnect again.";
    case "revoke_pending": return "The new key is saved. Murage finishes retiring the old one shortly.";
    case "email_dark": return EMAIL_OWNER_COPY.notAvailable;
    // r2.5 closing (activation D3, #37)
    case "inbox_closing": return "This address is closing, so changes wait. Choose Keep address to bring it back first.";
    case "not_closing": return "This address is already open.";
    case "restore_window_passed": return "The 30 days to keep this address have ended. Give the bot a new address.";
    case "inbox_account_mismatch": return "This address belongs to another bot or account, so Murage left it as it is.";
    default: return EMAIL_OWNER_COPY.actionFailed;
  }
}

/** A phone owner act on bot email is signed with a fresh device proof over this card (the same digest on both sides). */
export type EmailOwnerAction = "setup" | "retry" | "pause" | "resume" | "remove" | "keep" | "reconnect" | "policy" | "trust_add" | "trust_remove" | "block_add" | "block_remove";
export function emailOwnerActionRequestId(action: EmailOwnerAction, botId: string): string { return `email-owner-${action}-${botId}`.slice(0, 256); }
/** Every string field of the act's body is bound (sorted by name); anything else (the proof itself) is not. */
export function emailOwnerActionCard(action: EmailOwnerAction, botId: string, body: Record<string, unknown>): { tool: string; title: string; subtitle: string } {
  const keys = Object.keys(body).filter(key => typeof body[key] === "string").sort();
  return { tool: "bot_email", title: `Bot email: ${action.replace(/_/g, " ")}`, subtitle: JSON.stringify([botId, ...keys.map(key => [key, body[key]])]) };
}

/** What GET /api/email/status answers while email is on. */
export interface EmailStatusView {
  enabled: true; accountState: string; termsVersion: string | null;
  /** Desktop only: the capabilities response's price.display_note (absent elsewhere). */
  priceNote?: string;
  limits: Record<string, number>;
  removing: Array<{ botId: string; address: string | null }>;
  /** Flux #519: the whole account's sends today and its daily cap (#1 settings), when Flux answered them. */
  accountSends?: { today: number; perDay: number };
  /** 2.6: inboxes of this Flux account whose bot is not on this install (#4), each with Remove. */
  otherSetups?: Array<{ inboxId: string; address: string | null }>;
  /** 2.4: an email:owner token is saved (owner acts need it). */
  ownerSignedIn?: boolean;
  /** Section 8: the owner token's health line, when Flux refused it, paused or is busy. */
  ownerKeyLine?: string | null;
  /** EMAIL-CAPS-CACHE-1011: the saved key this answer belongs to (a fingerprint, never the key), and when it was read. */
  accountRef?: string;
  readAt?: number;
  /** Rule 5: present (EMAIL_STATUS_COPY.staleNote) while a read after `readAt` gave no definitive answer. */
  staleNote?: string;
}
/** EMAIL-CAPS-CACHE-1011 rule 4: no definitive answer yet for the saved key (never shown as off). `note` replaces the word "Checking" once
 *  a read gave no definitive answer, so the card never waits in silence. */
export interface EmailCheckingView { enabled: false; checking: true; accountRef: string | null; note?: string }
export const EMAIL_STATUS_COPY = {
  checking: "Checking",
  checkingNote: "Flux has not confirmed bot email yet. Murage keeps checking.",
  staleNote: "Can't reach Flux right now. Showing the last status we had.",
  consentOffline: "Can't reach Flux right now. Try again shortly.",
} as const;
export interface EmailTrustEntry { entry: string; source: string; sourceLabel: string }
export interface EmailBotView {
  botId: string; botName: string; state: string | null; address: string | null; chip: string | null; panelLine: string | null; failure: string | null;
  policy: "ask" | "auto"; policyPending: boolean; trusted: EmailTrustEntry[]; blocked: EmailTrustEntry[];
  activity: Array<{ ref: string; line: string; at: number }>; waiting: number; pauseReason: string | null;
  /** 5.2: inbound mail hidden from the bot (spam, blocked, unauthenticated), newest first: the bare sender and Murage's reason only. */
  filtered?: Array<{ id: string; from: string; reason: "spam" | "blocked" | "unauthenticated"; at: number }>;
  /** Section 8: this bot's email key health line (null when fine). */
  keyLine?: string | null;
  /** G15: Flux refused the saved email key; Reconnect gives the bot a new one (2.3 rotation). */
  keyRejected?: boolean;
  /** Section 7: the bot came from a package where it had an address; shown while it has none here. */
  importOffer?: string | null;
}
/** The Filtered list (5.2), owner panel copy. */
export const EMAIL_FILTERED_COPY = {
  title: "Filtered",
  hint: (bot: string) => `Spam, blocked and unverified senders. ${bot} does not see these emails.`,
  reasons: { spam: "Spam", blocked: "Blocked", unauthenticated: "Sender not verified" } as Record<"spam" | "blocked" | "unauthenticated", string>,
} as const;
