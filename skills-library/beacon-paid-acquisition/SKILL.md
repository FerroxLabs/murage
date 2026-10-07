---
name: beacon-paid-acquisition
description: "Plan paid ads on Meta, Google, TikTok or LinkedIn. Check your unit economics first, then set up campaigns, split the budget and test creative."
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  category: "beacon"
---

As of: 2026-05-16

# paid-acquisition

**Mode skill.** Default-enabled on the Channels specialist.

## When to use

Use when the user wants paid traffic, Meta, Google, TikTok, LinkedIn, programmatic, and needs a structure for budget allocation, campaign architecture, creative testing, and measurement. Use when the brief mentions ads, CPC, CPM, ROAS, CAC, or "we have $X to spend."

Trigger phrases:

- "How should I run ads?"
- "What's a good ROAS?"
- "Our CAC is too high."
- "Help me set up [paid platform] campaigns."

If whoever owns pricing and margin has posted pricing and unit economics to `TEAM_MEMORY.md`, start at step 2.

## Procedure

**1. Unit-economics check.** Before any campaign math, confirm with the user: average order value or LTV, gross margin, target CAC, and payback period tolerance. If they cannot answer, route to whoever owns pricing and margin. Paid acquisition without unit economics is a budget-shredder.

**2. Build the campaign architecture by stage.**

- *Awareness-stage campaigns:* broad targeting, brand-led creative, optimization toward reach or video-view rate. Goal: mental availability. Metrics: reach, frequency, branded-search lift, view-through indicators. Do not grade on ROAS.
- *Consideration-stage campaigns:* interest or lookalike targeting, problem-solution creative, optimization toward landing-page view or content engagement. Metrics: assisted conversions, cost-per-engaged-session, return-visitor rate.
- *Buying-stage campaigns:* retargeting + high-intent search + branded search. Optimization toward purchase or qualified-lead event. Metrics: ROAS, CAC, conversion rate.

**3. Split budget 60/40.** Default: 60% to Awareness + Consideration, 40% to Buying. If the user insists on 100% Buying, name the consequence: buying-stage campaigns extract demand that Awareness/Consideration created. Without upstream funding, buying-stage CAC inflates over time as the warm pool empties.

**4. Set the creative-test cadence.** Each stage runs a creative-test budget (10-20% of stage budget) on new variants. Test one variable at a time: hook, format, offer, audience. Kill underperforming variants on volume-based decision rules, not on day-one impressions.

**5. Define measurement honestly.** Last-click attribution under-credits Awareness/Consideration. Use platform-reported assisted conversions and incrementality tests (geo-holdout or campaign-on/off splits) for awareness-stage validation. Do not let last-click reporting kill the campaigns that feed the funnel.

**6. Hand creative to Copy + Brand.** You spec the format requirements (aspect ratio, video length, character limits, hook-in-first-3-seconds rule per platform). They write the words and design the visuals.

## Decision rules

- **Match creative to stage.** A buying-stage offer ad will fail at Awareness; an awareness-stage brand video will fail at Buying. Same product, different jobs.
- **Frequency is the awareness-stage variable.** Reach without repetition does not build memory. Target 3-7 weekly impressions on Awareness campaigns; do not flatten frequency by over-broadening audiences.
- **Optimization event matters more than targeting.** Telling a platform to optimize for purchase teaches its model faster than narrow audience targeting. Volume of events trumps cleverness of segments.
- **Kill rule:** cumulative spend ≥ 3× target CAC with zero conversions = pause the ad set and diagnose creative or audience. Do not wait for "more data."
- **As of 2026-05-16:** signal loss continues to favor platforms with first-party data and broader optimization. Question targeting-heavy playbooks older than 2023.

## Anti-patterns

- Running only buying-stage campaigns and wondering why CAC climbs every quarter. You are extracting demand without replenishing it.
- Judging awareness-stage campaigns by last-click ROAS. Wrong instrument for the job.
- Testing 30 creatives across 5 audiences at $20/day. No variant gets enough volume to read. Concentrate budget.
- Letting the platform "optimize" with a useless event (page view, click). Optimize for the closest event to revenue your volume supports.
- Quoting industry-benchmark CPMs or ROAS from blog posts. Benchmarks vary 10× by category; build your own baseline.

## Before / after

**Brief:** "We have $5,000/month for ads, want to maximize ROAS."

**Before** (all-activation):
> *Run $5,000 on Meta retargeting and Google brand search. Optimize for ROAS.*

**After** (60/40, stage-architected, 2026-05-16):
> *60/40 split: $3,000 to Awareness + Consideration, $2,000 to Buying. Awareness = $1,500 Meta broad targeting on brand-led video; Consideration = $1,500 Google non-brand search + Meta lookalike on problem-aware creative; Buying = $2,000 retargeting + brand search. Metrics: Awareness = branded-search lift week-over-week; Buying = ROAS ≥ 2.5. Hold one geo as control for 8 weeks to measure incremental lift. Confirm AOV and margin with whoever owns pricing and margin before locking spend.*
