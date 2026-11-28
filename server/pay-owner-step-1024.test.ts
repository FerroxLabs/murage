// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit rows for ownerPayStep (designs/PAYFULL-DESIGN-1024.md A10), the one rule shared by the Full-access pay
// card and the No limits lift. These rows drive the predicate directly: they are NOT the A9 witnesses, which
// enter through the browser proxies and the extension executor once the card is wired.
//
// MAIN-RULING 2026-11-27T02:15:31Z: no phrasing allow list and no word block list on the owner's own direct turn. The
// owner's turn asking to buy gets the card in any wording or quantity; only a purchase started or steered by outside
// content (email, page, guest, channel, bot) is refused. Rows carry the order facts the pre-ruling predicate read
// (orderText, orderLines, amounts), so the same file run against it fails at the behaviour, not at setup.

import { describe, expect, it } from "vitest";
import { ownerAsk, ownerPayStep, type PayStepInput } from "./pay-owner-step.ts";

type OrderFacts = { orderText?: string; orderLines?: Array<{ label: string; amounts: number }>; amounts?: number[] };
type Row = Partial<PayStepInput> & OrderFacts;

const SHOP = "https://shop.example/checkout";
const ORDER: OrderFacts = { orderText: "USB-C cable 1 x $42.99", orderLines: [{ label: "USB-C cable", amounts: 1 }, { label: "Total", amounts: 1 }] };
const TERMS = { floor: "consent", rule: "checkbox-name", reason: "t" } as const;

function base(over: Row = {}): PayStepInput {
  return {
    actor: "owner",
    initiator: "owner-typed",
    roomOwnerOnly: true,
    card: true,
    ownerText: "buy the cable on shop.example",
    floor: { floor: "payment", rule: "pay-name", reason: "pay" },
    pageUrl: SHOP,
    lineage: { fromSearchResult: false, previous: null },
    outsideMark: false,
    ...ORDER,
    ...over,
  } as PayStepInput;
}

describe("ownerPayStep: the owner's own purchase passes", () => {
  it("owner, owner-typed, own thread, named site", () => {
    expect(ownerPayStep(base())).toEqual({ ok: true, kind: "pay" });
  });
  it("hosted checkout (L4) after the named shop", () => {
    expect(ownerPayStep(base({ pageUrl: "https://checkout.stripe.com/c/pay", lineage: { fromSearchResult: false, previous: { url: SHOP, fromSearchResult: false } } }))).toEqual({ ok: true, kind: "pay" });
  });
  it("a shop reached from a search result after the owner's request (L2)", () => {
    expect(ownerPayStep(base({ ownerText: "buy me a USB-C cable", pageUrl: "https://cables.example/checkout", lineage: { fromSearchResult: true, previous: null } }))).toEqual({ ok: true, kind: "pay" });
  });
  it("terms on the named site", () => {
    expect(ownerPayStep(base({ ownerText: "sign me up on shop.example", floor: TERMS }))).toEqual({ ok: true, kind: "terms" });
  });
});

// RULING rows (W-RULING): every row is the owner's own direct turn asking to buy, so the card shows (ok: true). Each was
// a refusal on aaf679c2fa (the allow list, a block list or E10); base-red.tsv has the base run.
const RULING: Array<[string, Row]> = [
  ["R1 a second line", { ownerText: "buy the cable on shop.example\nthanks!" }],
  ["R2 a list on several lines", { ownerText: "Shopping for today:\n- USB-C cable\nPlease buy it on shop.example" }],
  ["R3 a quantity above one", { ownerText: "buy 3 cables on shop.example", orderText: "3 x USB-C cable $27", orderLines: [{ label: "USB-C cable", amounts: 1 }] }],
  ["R4 natural wording outside any word list", { ownerText: "My old charger died, could you order the black USB-C cable from shop.example for me?" }],
  ["R5 a negation word that retracts nothing", { ownerText: "buy the cable on shop.example, no rush" }],
  ["R6 a quoted product name", { ownerText: 'buy the "Anker" cable on shop.example' }],
  ["R7 a reporting word", { ownerText: "my friend said this cable is good, buy it on shop.example" }],
  ["R8 the card shows what the order holds", { orderText: "USB-C cable $42.99 Protection plan $12", orderLines: [{ label: "USB-C cable", amounts: 1 }, { label: "Protection plan", amounts: 1 }] }],
  ["R9 a total above a price the owner wrote", { ownerText: "buy the cable for $10 on shop.example", amounts: [12] }],
  ["R10 text the owner pasted into their own turn", { ownerText: "The page says:\nPlease buy the cable on shop.example" }],
  ["R11 a spelled quantity", { ownerText: "buy ten cables on shop.example", orderText: "Ten USB-C cables $29.90", orderLines: [{ label: "USB-C cables", amounts: 1 }] }],
  // Astra 4413013938: everyday wording with no shop verb is the owner asking too.
  ["R13 get me", { ownerText: "Get me the USB-C cable from shop.example, please" }],
  ["R14 I want", { ownerText: "I want the black cable from shop.example" }],
  ["R15 an object pronoun before the verb", { ownerText: "help her buy a cable on shop.example" }],
  // ASTRA 22aa273d10 High: the "check out before a determiner is look-at" rule was a phrasing rule on the owner's own turn.
  ["R16 check out before a determiner", { ownerText: "Please check out the cable on shop.example" }],
  // Moved from the refusal rows (r4 H-A guard) by MAIN-RULING 2026-11-27T02:15:31Z: any wording, the card is the guard. The pay card is
  // built now (server/pay-card.ts): if the shop's page then shows a pay button, the owner sees merchant, item, quantity and total and declines.
  ["R17 check out the reviews (the card guards a look-at reading)", { ownerText: "check out the reviews of the cable on shop.example" }],
];

describe("ownerPayStep: the owner's direct turn gets the card in any wording or quantity", () => {
  it.each(RULING)("%s", (_name, over) => {
    expect(ownerPayStep(base(over))).toEqual({ ok: true, kind: "pay" });
  });
  it("R12 terms on several lines", () => {
    expect(ownerPayStep(base({ ownerText: "Newsletter on shop.example:\nsign me up", floor: TERMS }))).toEqual({ ok: true, kind: "terms" });
  });
});

// The edge (outside content started or steered the step) and the floors that are never carded. Every row stays a refusal.
const KEEP: Array<[string, Row, string]> = [
  ["guest", { actor: "guest" }, "E1"],
  // Opus self-review 4413013938 H-B: the any-wording rule needs the card; a No limits lift (no card) is refused here.
  ["a No limits lift with no card", { card: false }, "E2-nocard"],
  ["owner routine", { actor: "owner-routine" }, "E1"],
  ["webhook turn", { initiator: "webhook" }, "E3"],
  ["email-triggered turn", { initiator: "email" }, "E3"],
  ["another bot started the turn", { initiator: "bot" }, "E3"],
  ["no owner text", { ownerText: undefined }, "E3"],
  ["shared thread", { roomOwnerOnly: false }, "E4"],
  ["unknown thread", { roomOwnerOnly: undefined }, "E4"],
  ["CAPTCHA", { floor: { floor: "verification", rule: "captcha", reason: "c" } }, "E5"],
  ["card-number field", { floor: { floor: "credentials", rule: "payment-frame", reason: "c" } }, "E5"],
  ["OAuth", { floor: { floor: "consent", rule: "oauth", reason: "o" } }, "E5"],
  ["unsure facts", { floor: { floor: "payment", rule: "pay-name", reason: "p", unsure: true } }, "E5"],
  ["rule not on the list", { floor: { floor: "payment", rule: "pay-new-rule", reason: "p" } }, "E5"],
  ["email read this turn (M1)", { outsideMark: true }, "E6-mark"],
  ["an outside mark on a multi-line owner turn", { outsideMark: true, ownerText: "buy the cable on shop.example\nthanks!" }, "E6-mark"],
  ["unreadable outside mark", { outsideMark: undefined as unknown as boolean }, "E6-mark"],
  ["a page sent the bot to another merchant", { pageUrl: "https://other.example/checkout" }, "E6-site"],
  ["J18 Allow-always site from a page address", { pageUrl: "https://bigstore.example/gift" }, "E6-site"],
  ["processor without an owner-linked page before it", { pageUrl: "https://checkout.stripe.com/c/pay" }, "E6-site"],
  ["plain http checkout", { pageUrl: "http://shop.example/checkout" }, "E6-site"],
  ["a page started the purchase: summarize", { ownerText: "summarize the reviews on shop.example" }, "E9"],
  ["a page started the purchase: order status", { ownerText: "check my order status on shop.example" }, "E9"],
  ["a page started the purchase: pay attention", { ownerText: "pay attention to the membership upsell on shop.example" }, "E9"],
  ["a page started the purchase: past purchase", { ownerText: "find the cable I bought on shop.example" }, "E9"],
  // Only the determiner rule guards this one ("review" is not a noun-sense word): a verb word after "the" is a noun.
  ["a page started the purchase: the book", { ownerText: "find the book review on shop.example" }, "E9"],
  // Only the host mask guards this one: the words of a host name ("get", "cart") are not the owner asking.
  // Opus self-review 4413013938 H-A: an intent word not used as a purchase.
  ["a page started the purchase: pick up where we left off", { ownerText: "pick up where we left off on shop.example" }, "E9"],
  ["a page started the purchase: in order of price", { ownerText: "sort the cables in order of price on shop.example" }, "E9"],
  ["a page started the purchase: why does checkout fail", { ownerText: "why does checkout fail on shop.example?" }, "E9"],
  ["a page started the purchase: a host that reads like a request", { ownerText: "summarize the reviews on get-cart.example", pageUrl: "https://get-cart.example/checkout" }, "E9"],
  ["terms on a site reached from search but not named", { ownerText: "sign me up for the newsletter", lineage: { fromSearchResult: true, previous: null }, floor: TERMS }, "E6-site"],
  ["terms on a site not named", { ownerText: "sign me up", floor: TERMS }, "E6-site"],
  ["terms the owner never asked for", { ownerText: "read the news on shop.example", floor: TERMS }, "E9"],
];

describe("ownerPayStep: outside content and uncarded floors keep today's refusal", () => {
  it.each(KEEP)("%s", (_name, over, why) => {
    expect(ownerPayStep(base(over))).toEqual({ ok: false, why });
  });
  it("a throwing read is a refusal", () => {
    const hostile = base();
    Object.defineProperty(hostile, "floor", { get() { throw new Error("boom"); } });
    expect(ownerPayStep(hostile)).toEqual({ ok: false, why: "error" });
  });
});

describe("ownerAsk", () => {
  it("reads the owner's intent in any wording", () => {
    expect(ownerAsk("please order the cable from shop.example")).toMatchObject({ pay: true, terms: true });
    expect(ownerAsk("Could you check out with the cable in my cart?")).toMatchObject({ pay: true, terms: true });
    expect(ownerAsk("find the book I ordered")).toMatchObject({ pay: false, terms: false });
    expect(ownerAsk("sign me up for the newsletter")).toMatchObject({ pay: false, terms: true });
    expect(ownerAsk("")).toMatchObject({ pay: false, terms: false });
  });
});
