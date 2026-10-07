---
name: beacon-newsletter
description: "Plan a recurring newsletter that keeps your audience engaged between purchases. Set a cadence, one repeating format and one call to action per send."
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.1.0"
  category: "beacon"
---

As of: 2026-10-02

# newsletter

Plan and run a recurring email that readers look forward to and that moves some of them to act.

## When to use

Use when a business has or wants a list and needs a repeating broadcast: what to send, how often, in what format, and how to keep it deliverable and lawful.

Trigger phrases:

- "Should I start a newsletter?"
- "What should I put in my newsletter?"
- "How often should I email my list?"
- "My open rates are dropping."

Do not use for automated flows such as welcome or sales sequences (beacon-email-sequences). Do not use to grow a list from nothing; that needs a lead magnet and traffic (beacon-funnel-build). If no one has agreed to hear from you, fix consent first.

## Inputs to ask for

1. Who is on the list, how they joined, and how many.
2. The reader's problem and what they would be glad to receive every week.
3. Sending tool, sending domain, and whether authentication is set up.
4. Time available per issue and who writes.
5. The one action you most want readers to take.
6. Countries your readers live in.

## Procedure

**1. Name the promise.** One sentence: "Every [day], [reader] gets [benefit] in [minutes] minutes." Put it on the signup page and in the welcome email.

**2. Pick one repeating format.** Readers value a familiar shape. Options: one idea and one example; three curated links with your take; a customer story with a lesson; a short teardown. Choose a format you can produce at the same quality for six months.

**3. Set the cadence.** Weekly suits most businesses. Fortnightly is fine if each issue is strong. Daily needs a team. Pick a fixed day and time and keep it for two months before judging.

**4. Build the issue layout.**
- Subject line: specific, honest, under about 50 characters.
- Preview text that adds to the subject.
- Opening line that gives the reason to read.
- Body in the chosen format, short paragraphs, one image at most.
- One call to action with one button. Secondary links stay as plain text.
- Footer with unsubscribe link, your name and a physical mailing address.

**5. Keep the list deliverable.**
- Authenticate the sending domain with SPF, DKIM and DMARC.
- Bulk senders to Gmail and Yahoo (over about 5,000 a day) must also offer one-click unsubscribe and keep the spam complaint rate under 0.30 percent. Aim under 0.10.
- Honor unsubscribes promptly. The US CAN-SPAM Act sets a limit of 10 business days; one click and same day is better.
- Remove or re-confirm readers who have not opened in 90 to 180 days. Send a final "still want this?" email before removing.
- Warm up a new domain slowly.

**6. Get consent right.**
- US: CAN-SPAM requires a truthful sender and subject, a postal address, a clear opt-out, and labelling of ads. Penalties run to tens of thousands of dollars per email.
- EU and UK: get clear opt-in consent, keep a record of when and how it was given, make withdrawal as easy as signing up. The UK allows a narrow "soft opt-in" only for similar products to existing customers who were offered an opt-out at the time.
- Never import a bought list.

**7. Grow with intent.** Add a signup box at the end of every post, a pinned social link, a referral mention in each issue, and a swap with a partner newsletter whose audience matches. Track the source of each signup.

**8. Review monthly.** Look at clicks, replies, unsubscribes and complaints by issue. Keep the formats that earn replies.

## Metrics and what good looks like

- Click rate on the main link: the best signal. Open rates are distorted by mail privacy features, so read them as a trend only.
- Reply rate: even a few replies per hundred show a real audience.
- Unsubscribe rate: under 0.5 percent per issue is typical.
- Spam complaints: under 0.1 percent.
- Revenue or leads per issue, tracked by tagged link.
- Net list growth per month, after removals.

## Failure modes

- No repeating format, so each issue is a fresh scramble.
- Several calls to action in one send.
- Selling in every issue. Aim for mostly useful content and a clear ask once in a while.
- Missing authentication or a hidden unsubscribe link.
- Mailing a dormant list and wrecking the sender reputation.
- Inconsistent schedule.
- Judging on open rate alone.

## Hand-offs

- Automated flows: beacon-email-sequences.
- List-building funnel: beacon-funnel-build.
- Content topics: beacon-blog-content.
- Retention of buyers: lens-cohort-and-retention.
- Draft review: verdict-flag-and-fix.
