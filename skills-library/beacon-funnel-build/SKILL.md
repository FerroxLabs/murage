---
name: beacon-funnel-build
description: "Map a full acquisition funnel from traffic source to landing page, email capture, follow-up and offer. Spell out what moves a person from one step to the next."
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.1.0"
  category: "beacon"
---

As of: 2026-10-02

# funnel-build

Design the path from a stranger to a customer, one step at a time, with one job per step.

## When to use

Use when a business needs to build a new funnel, connect scattered pages and emails into one flow, or launch an offer and needs the steps around it.

Trigger phrases:

- "Build me a sales funnel."
- "How do I turn traffic into customers?"
- "What should my lead magnet be?"
- "I have a landing page but nothing happens after."

Do not use to find where an existing funnel leaks (lens-funnel-diagnosis), to choose channels (beacon-channel-strategy) or to write the emails (beacon-email-sequences). If the offer is unproven, build the smallest version and test it before the full flow.

## Inputs to ask for

1. The offer: what it is, who it is for, the outcome, the amount charged.
2. Where traffic will come from, and how much per week.
3. What the visitor knows when they arrive: cold, problem-aware or ready to buy.
4. Tools in use for pages, email and payment.
5. The single result that counts: a purchase, a booked call, a trial start.

## Procedure

**1. Write the promise in one sentence.** "For [buyer] who wants [outcome], we offer [product] so they can [result] without [obstacle]." Every page in the funnel repeats this promise.

**2. Choose the shape by offer.**
- *Low-cost product:* ad or post, landing page, checkout, one add-on, thank-you page.
- *Higher-value product or service:* content, lead magnet, email follow-up, call or demo, proposal.
- *Software:* content or search, free trial or demo, onboarding emails, upgrade prompt.

**3. Define each step with four fields.** Entry source, one job, one action, the message that moves them on. If a step has two actions, split it.

**4. Build the lead magnet.** It should solve one narrow problem fast. Checklists, templates, calculators and short tools convert better than long ebooks, because they deliver a quick win. The magnet must lead naturally to the paid offer.

**5. Build the landing page.** Match the ad or post that sent the visitor. Include: headline with the outcome, one supporting line, proof (a result, a quote, a logo), what they get, one button, and a short form asking only for what you need. Remove site navigation.

**6. Build the follow-up.** Three to five emails over about a week: deliver the magnet, tell the story behind it, show proof, handle one objection, make the offer. Hand the sequence to beacon-email-sequences. Include a plain unsubscribe link and your business address.

**7. Make the offer page and checkout simple.** One price, one button, guarantee stated, order summary clear. Add one relevant add-on at checkout only if it truly helps.

**8. Set up tracking before launch.** Tag every source, count each step as an event, and test the full path on a phone with a real purchase.

**9. Test one change at a time.** Fix the biggest drop first (lens-funnel-diagnosis). Wait for enough traffic before judging: a few dozen conversions at the step, not a few dozen visits.

## Funnel map template

Source -> Landing page (promise, proof, form) -> Thank-you page (next step) -> Email 1 to 5 -> Offer page -> Checkout -> Onboarding email.

For each arrow, write the percent you expect and the percent you see.

## Metrics and what good looks like

Treat these as rough 2026 reference ranges, then build your own baseline.
- Opt-in page: 5 to 20 percent overall; cold traffic often 3 to 10, warm traffic 15 to 30.
- Email open rate on the delivery email: the highest of the sequence.
- Landing page to sale on a direct offer: 1 to 5 percent depending on cost and traffic temperature.
- Cost to acquire a customer against customer value.
- Time from first click to purchase.

## Failure modes

- Sending cold traffic straight to a checkout.
- A lead magnet unrelated to what you sell.
- Too many fields on the form.
- Different promise on the ad and the page.
- Several offers on one page.
- No tracking, so no one knows which step failed.
- Judging results on tiny samples.
- Hidden terms or fake countdown timers. Both break trust and can break advertising rules.

## Hand-offs

- Stage and channel choice: beacon-channel-strategy.
- Email build: beacon-email-sequences.
- Paid traffic: beacon-paid-acquisition.
- Drop-off analysis: lens-funnel-diagnosis.
- Copy review: verdict-flag-and-fix.
