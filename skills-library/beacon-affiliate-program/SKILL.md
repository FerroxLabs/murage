---
name: beacon-affiliate-program
description: "Set up an affiliate program that pays partners, creators or customers a commission. Choose the partner type, set the terms and check what partners really add."
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.1.0"
  category: "beacon"
---

As of: 2026-10-02

# affiliate-program

Set up, run or repair a program where partners earn a commission for sales or leads they send you.

## When to use

Use when someone wants creators, operators, customers or review sites to promote the business for a commission, or when an existing program pays out but sales feel flat.

Trigger phrases:

- "Should I start an affiliate program?"
- "How much commission should I pay?"
- "How do I get influencers to promote my product?"
- "Our affiliates are mostly coupon sites."

Do not use for one-off paid sponsorships with a flat fee (plan those inside beacon-channel-strategy), for paid ads (beacon-paid-acquisition) or for sales-team commissions. Do not start a program before the offer converts: partners send traffic, they cannot fix a weak page (see beacon-funnel-build).

## Inputs to ask for

1. Average order value or first-year customer value, and gross margin.
2. One-off or recurring purchase, and typical time from first visit to buying.
3. Who already recommends you: customers, creators, agencies, newsletters.
4. Tracking in place today: affiliate platform, discount codes, or neither.
5. Countries you sell to, which sets disclosure and consent rules.

## Procedure

**1. Do the margin check first.** Commission must come out of margin after refunds and the cost to serve. Work out the most you can pay per sale and still profit, then offer less than that. Typical ranges seen in 2026: 10 to 15 percent on ecommerce, 20 to 30 percent recurring on software, a flat fee per qualified lead in finance or services. Treat these as reference points, not targets. Ask whoever owns pricing and margin to confirm the ceiling.

**2. Choose the partner type.** Pick one to start.
- *Creators:* borrowed audience, fast reach, variable quality.
- *Operators and agencies:* borrowed trust, fewer sales, higher value.
- *Customers:* warm referrals, best close rate, small volume.
- *Review and comparison sites:* high intent, but commission goes to whoever is last in line.

**3. Set the terms in writing.**
- Attribution: last click is the common default. Say it.
- Cookie window: 30 days is the baseline. Match the window to your real buying cycle, since a 7-day window on a 30-day cycle loses credit for many sales.
- Payment: a hold period that covers your refund window, a payout threshold, and a monthly date.
- Rules: no bidding on your brand name, no self-referral, no misleading claims, no coupon-code leaks.
- Disclosure: every partner must disclose the relationship.

**4. Pick tracking.** A dedicated affiliate platform or a built-in tool in your store or billing system. Track by link plus code so a promo code posted to a coupon site is traced to the right partner. Test one full purchase and one refund before launch.

**5. Recruit ten, not a hundred.** Start with ten partners who already fit your buyers. Send each a short brief: who it is for, the promise, three proof points, links, assets, and one thing not to say.

**6. Enable and review monthly.** Give partners a swipe file, a discount for their audience if margin allows, and early notice of launches. Every month rank partners by net sales after refunds. Move the top few to a higher tier, pause partners with traffic but no sales, and remove anyone who breaks the rules.

## Disclosure checklist (FTC and equivalents)

- Disclosure sits next to the link, before the click, in plain words such as "I earn a commission if you buy through this link."
- In video it is spoken and shown on screen, not only in the description. In audio it is spoken.
- A platform's built-in tag alone, or a hashtag buried in a group, is not enough.
- Outside the US, check local rules; the UK, EU and Canada all expect a clear label.
- Put the requirement in the partner agreement and check live posts quarterly. Brands share responsibility for what partners say.

## Metrics and what good looks like

- Net revenue per active partner: a small group should produce most sales. A long tail of zero-sale partners is normal.
- Refund and chargeback rate by partner: compare each to your store average.
- Share of commission paid on branded-search or coupon traffic: if it is high, the program is rewarding sales you already had. Test by pausing one coupon partner for a month and watching total sales.
- Partner activation: about a third of recruited partners should send a first click within 60 days.
- Program profit: sales minus commission, refunds and platform fees. If this is negative at the ceiling, reduce the rate or change partner type.

## Failure modes

- Commission set from competitors rather than margin.
- Coupon and cashback sites taking credit at the last click. Fix with code rules and tiered rates.
- Cookie stuffing or fake traffic. Watch for clicks with no engagement and sales that cluster on one hour.
- No disclosure, which puts both sides at legal risk.
- Recruiting without a brief, so partners write their own claims.
- Paying on gross sales before refunds clear.

## Hand-offs

- Offer and landing page weak: beacon-funnel-build.
- Which partner type fits the channel mix: beacon-channel-strategy.
- Credit looks inflated: lens-marketing-attribution.
- Partner or customer cohorts that churn: lens-cohort-and-retention.
- Partner brief wording: the copywriting skill, then verdict-flag-and-fix.
