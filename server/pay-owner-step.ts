// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ownerPayStep: the ONE server rule for "may a pay or terms floor be passed on this step"
// (designs/PAYFULL-DESIGN-1024.md A10). Owners: this module and the Full-access card = q1024-paybuild;
// the No limits lift that calls it (server/browser-floor-lift.ts, fix/1024-paynl) = q1024-paynl;
// rulings = MAIN.
//
// It does not read the level: Full access shows a card when it holds, No limits lifts with no card when it
// holds, and both refuse word for word when it fails. Every miss, doubt or throw is a refusal (`ok: false`).
// The intent words are English in this slice; a message with none of them is a refusal (fails closed).

import { foldText } from './browser-floor-lexicon.ts';
import { ownerNamedBareOrigin } from './browser-extension-service.ts';
import type { FloorResult } from './browser-floor.ts';

/** A3: the closed allow list of floor rules that may become a card (or a No limits lift). */
export const CARDED_RULES: Readonly<Record<'payment' | 'consent', readonly string[]>> = {
  payment: ['pay-name', 'weak-pay', 'weak-in-payment', 'submit-card-form', 'dialog-payment'],
  consent: ['cmp-accept', 'cmp-save-choices', 'cmp-control', 'checkbox-name', 'checkbox-nearby', 'control-name',
    'control-sentence', 'click-to-agree', 'weak-in-consent', 'select-consent', 'dialog-consent'],
};

/** L4: hosted checkouts. Narrower than the protected list on purpose (fails closed). */
const PAY_PROCESSORS = ['stripe.com', 'paypal.com'] as const;

// MAIN-RULING 2026-11-27T02:15:31Z: no phrasing allow list and no word block list on the owner's own direct turn. The
// owner's turn passes in any wording or quantity; the one-tap card (merchant, item, quantity, total) is the guard. What
// stays strict is the edge: a purchase started or steered by outside content (email, page, guest, channel, bot).
// "Started by a page" = the owner's own message of this turn never asked to buy, pay, order, book or subscribe
// (TRUST-MODEL 1.4, MAIN-RULING 2026-11-26T22:44:22Z "never a page alone"). This is the intent fact, read as whole words
// anywhere in the message with their inflections; it is not a phrasing list (any sentence around the word passes).
const PAY_INTENT = new Set(['buy', 'buys', 'buying', 'purchase', 'purchases', 'purchasing', 'pay', 'pays',
  'paying', 'donate', 'donating', 'reserve', 'reserving', 'order', 'ordering', 'book', 'booking', 'renew',
  'renewing', 'subscribe', 'subscribing', 'rent', 'renting', 'reorder', 'preorder', 'upgrade', 'extend',
  // Astra 4413013938: everyday acquisition words ("get me the cable", "I want the black one") are the owner asking too.
  'get', 'getting', 'grab', 'grabbing', 'snag', 'acquire', 'cart', 'shopping', 'want', 'need', 'like']);
const PAY_INTENT_PAIRS = ['check out', 'top up', 'pick up', 'sign up for', 'pre order', 're order'];
const TERMS_INTENT = new Set(['accept', 'agree', 'register', 'join', 'enroll', 'enrol', 'consent']);
const TERMS_INTENT_PAIRS = ['sign up', 'sign me up', 'opt in'];

// A verb word used as a noun is not intent: after a determiner ("the book I ordered") or before a noun-sense word
// ("pay attention", "order status"). Grammar, not a phrasing list.
// "his"/"her" are also object pronouns ("help her buy a cable"), so they are not determiners here (Opus self-review 4413013938).
const DETERMINERS = new Set(['my', 'the', 'a', 'an', 'this', 'your', 'that', 'last', 'our', 'their']);
// Opus self-review 4413013938 H-A: an intent word before a question or clause word ("pick up where we left off") or after
// "in" ("in order of price", "in order to") is not a purchase. Grammar; it only narrows intent and never refuses an owner on
// wording that asks to buy with the verb used as a verb. ASTRA 22aa273d10: "check out" before a determiner is NOT read as
// look-at any more ("Please check out the cable" is the owner asking); MAIN-RULING 02:15:31Z, the card guards the other reading.
const CLAUSE_AFTER = new Set(['where', 'when', 'why', 'how', 'what', 'whether', 'if']);
const NOUN_AFTER = new Set(['status', 'history', 'number', 'details', 'tracking', 'confirmation', 'page', 'attention',
  'respect', 'tribute', 'id']);

// A host is a name, not a word of the request: "cart.example" or "get-it.example" never reads as intent.
const HOST_IN_TEXT = /[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}[\p{L}\p{N}-]*/gu;

export interface OwnerAsk { pay: boolean; terms: boolean }

function hasIntent(words: readonly string[], single: ReadonlySet<string>, pairs: readonly string[]): boolean {
  for (let at = 0; at < words.length; at++) {
    if (at > 0 && DETERMINERS.has(words[at - 1])) continue;
    const pair = pairs.find(phrase => phrase.split(' ').every((part, k) => words[at + k] === part));
    const len = pair ? pair.split(' ').length : single.has(words[at]) ? 1 : 0;
    const after = words[at + len] ?? '';
    if (!len || NOUN_AFTER.has(after) || CLAUSE_AFTER.has(after) || words[at - 1] === 'in') continue;
    return true;
  }
  return false;
}

/** Did the owner's own message of this turn ask for a purchase (pay) or a sign-up (terms)? Any wording, any quantity. */
export function ownerAsk(ownerText: string): OwnerAsk {
  if (typeof ownerText !== 'string' || !ownerText.trim()) return { pay: false, terms: false };
  const words = foldText(ownerText.replace(HOST_IN_TEXT, ' ')).split(' ');
  const pay = hasIntent(words, PAY_INTENT, PAY_INTENT_PAIRS);
  const terms = pay || hasIntent(words, TERMS_INTENT, TERMS_INTENT_PAIRS);
  return { pay, terms };
}

/** L1: the owner named this site in the owner's own message of this turn. */
function ownerNamedHost(ownerText: string, host: string): boolean {
  return ownerNamedBareOrigin(ownerText, `https://${host}`);
}

function hostOf(raw: string): string | null {
  try { const url = new URL(raw); return url.protocol === 'https:' ? url.hostname.toLowerCase() : null; } catch { return null; }
}

function isProcessor(host: string): boolean {
  return PAY_PROCESSORS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export interface SiteLineage {
  /** The bot reached this page by following a result on a search page after the owner's instruction (L2). */
  fromSearchResult: boolean;
  /** The previous main-frame page in this tab and task, with its own L2 flag (for L4). */
  previous?: { url: string; fromSearchResult: boolean } | null;
}

/** A5 L1/L2/L4. L3 (Allow always) never counts alone (round 2), so it is not an input here. */
export function ownerLinkedSite(ownerText: string, pageUrl: string, lineage: SiteLineage): boolean {
  const host = hostOf(pageUrl);
  if (!host) return false;
  const linked = (url: string, fromSearch: boolean) => {
    const h = hostOf(url);
    return !!h && (ownerNamedHost(ownerText, h) || fromSearch === true);
  };
  if (linked(pageUrl, lineage.fromSearchResult)) return true;
  const prev = lineage.previous;
  return isProcessor(host) && !!prev && linked(prev.url, prev.fromSearchResult);
}

export interface PayStepInput {
  actor: string | undefined;
  initiator: string | undefined;
  roomOwnerOnly: boolean | undefined;
  /** True only when the caller shows the one-tap card for this step (Full access). The round-4 rule (any wording, the
   *  card is the guard) has no card at No limits, so a no-card lift is refused here until MAIN rules on its own test
   *  (Opus self-review 4413013938 H-B; QUESTIONS.md FABLE-DESIGN NEEDED). */
  card: boolean | undefined;
  /** The owner's own message for this generation (`ownerTurnText`); undefined when the turn has none. */
  ownerText: string | undefined;
  floor: FloorResult;
  pageUrl: string;
  lineage: SiteLineage;
  /** M1/M2 + the edge marks: an inbound email was delivered this turn (or that could not be read), or the turn's lineage
   *  carries an outside mark (notOwnerAudience: another person, a channel person, a webhook or another bot). */
  outsideMark: boolean;
}

export type PayStepAnswer = { ok: true; kind: 'pay' | 'terms' } | { ok: false; why: string };

/** E1, E3, E4, E5, E6, E9 (A10; E10 removed by MAIN-RULING 2026-11-27T02:15:31Z: the card shows the order). The level, the card caps and the amount rule belong to the callers. */
export function ownerPayStep(input: PayStepInput): PayStepAnswer {
  try {
    if (input.actor !== 'owner') return { ok: false, why: 'E1' };
    if (input.card !== true) return { ok: false, why: 'E2-nocard' };
    if (input.initiator !== 'owner-typed' && input.initiator !== 'owner-channel-dm') return { ok: false, why: 'E3' };
    if (typeof input.ownerText !== 'string' || !input.ownerText) return { ok: false, why: 'E3' };
    if (input.roomOwnerOnly !== true) return { ok: false, why: 'E4' };
    const floor = input.floor;
    if (!floor || floor.unsure === true || (floor.floor !== 'payment' && floor.floor !== 'consent')) return { ok: false, why: 'E5' };
    if (!CARDED_RULES[floor.floor].includes(floor.rule)) return { ok: false, why: 'E5' };
    if (input.outsideMark !== false) return { ok: false, why: 'E6-mark' };
    const ask = ownerAsk(input.ownerText);
    if (floor.floor === 'payment') {
      if (!ask.pay) return { ok: false, why: 'E9' };
      // A page that sent the bot to another merchant steered the purchase: only a site the owner named, a search result
      // after the owner's instruction, or the hosted checkout of such a site (L1/L2/L4).
      if (!ownerLinkedSite(input.ownerText, input.pageUrl, input.lineage)) return { ok: false, why: 'E6-site' };
      return { ok: true, kind: 'pay' };
    }
    // A2: a terms step is carded only on a site the owner named this turn (L1). The terms box on the page of a
    // payment that passed E1 to E9 is decided by the caller with the payment's own answer.
    const host = hostOf(input.pageUrl);
    if (!host || !ownerNamedHost(input.ownerText, host)) return { ok: false, why: 'E6-site' };
    if (!ask.terms) return { ok: false, why: 'E9' };
    return { ok: true, kind: 'terms' };
  } catch {
    return { ok: false, why: 'error' };
  }
}
