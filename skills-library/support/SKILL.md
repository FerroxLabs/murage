---
name: support
description: "Entry point for customer support work: reads what the request actually is — one reply, a pattern across tickets, an escalation, a refund, a queue review — and either routes to the specialist skill or runs the procedure inline. Covers reply drafting, knowledge-base articles, FAQ generation, escalation briefs, refund and credit scripts, SLA and queue review, NPS and CSAT analysis, and the support health report. Use when a support task arrives without a shape yet. Do NOT use when the shape is already known — go straight to mend-ticket-triage for prioritising a queue, mend-churn-prevention for a save play on an at-risk account, or mend-onboarding-flow for the first-thirty-days path — and do NOT use it to write policy (use sop-creation) or to redesign the process itself (use process-mapping). Support templates can create binding commitments: check refund and SLA language against actual policy and applicable consumer law before it is sent."
license: Apache-2.0
metadata:
  author: wayland
  version: "1.0.0"
  tags: "orchestrator customer-support tickets escalation smb"
  category: "support"
  attribution: "Wayland Business Suite (Original)"
---

> **Note.** Support templates are starting points, not policy. Refund, credit and SLA language can create commitments the company then has to honour — check every one against the actual policy and against applicable consumer law (FTC, EU consumer rights, state UDAP statutes) before it goes out.

# Support router

A support task has arrived. Establish what is really being asked, then route or work it inline.

## Step 0 — The question under every support task

Before drafting anything: **what is this customer trying to achieve, and is the product moving them toward it or away from it?** A reply that is polite and leaves the customer no closer to their outcome is a failed reply. Answer that question first; the tone takes care of itself afterwards.

And separate the ticket from the signal. One person asking how export works is a ticket. Five in a week is product feedback, and it goes upstream as well as back to the customer. Write both.

## Step 1 — Route to the specialist skill

| The request | Load |
|---|---|
| A queue to prioritise; what to work first and why | `mend-ticket-triage` |
| An account showing churn signals; a save play | `mend-churn-prevention` |
| A new customer's first thirty days; activation path | `mend-onboarding-flow` |
| Turning a repeated resolution into a repeatable procedure | `sop-creation` |
| Redesigning how support work flows through the team | `process-mapping` |
| Membership, subscription and community operations | `membership-manager` |
| Standing up onboarding as a programme, not a checklist | `onboarding-plan` |

## Step 2 — Work it inline

### Reply to a customer

1. **Read for the outcome, not the tone.** What did they want to do? What stopped them? Is the policy in their favour or against them? Get those three before writing a word.
2. **Lead with the answer.** Whether the answer is a fix, a workaround or a no, it goes in the first two lines. Apology first, answer buried, is the standard failure.
3. **Name reality.** If it is broken, say it is broken, say when a fix is realistic, and say what to do until then. Calling a defect a "feature request under consideration" burns more trust than the defect did.
4. **Close the loop.** One concrete next step, who owns it, and by when. If the answer is no, say no plainly and give the nearest thing that is a yes.
5. **Write the framework, not a canned voice.** Produce the structure and the substance so a human — or a tuned assistant — sends it in the team's real voice. "We appreciate your feedback" is worse than silence.

### Knowledge-base article

Take a resolved ticket and generalise it. Title as the symptom the customer would search for, not the internal cause. Then: who this affects, how to tell it is your problem, the fix in numbered steps with the exact strings and clicks, what to do if the fix does not work, and a link to the adjacent article. One article, one problem. If the article needs an "it depends", it is two articles.

### FAQ set

Mine the ticket log for the questions actually asked, in the words actually used — not the questions the team wishes were asked. Rank by volume times friction. Each entry: the question verbatim, a two-sentence answer, and a link to depth. When an FAQ entry gets long, it has become a KB article; promote it.

### Escalation brief

For engineering, product or leadership. Structure: one-line impact statement (who is affected, how many, since when, revenue at risk); reproduction steps or the evidence; what has already been tried; the specific decision or action being asked for; the deadline and what happens if it passes. An escalation without a named ask is a complaint, and it will sit.

### Refund or credit script

Establish the policy position first, then the goodwill position, and keep them separate — the customer hears one number, but the company needs to know which bucket it came from. The script states what is being refunded or credited, the amount, the mechanism, the timeline to land, and whether anything changes about the account. Never promise a refund timeline the processor cannot meet. Where consumer law grants a right the policy does not, the law wins; flag it rather than arguing it.

### SLA and queue review

For each tier: target first response, target resolution, and actual against both. Report the breach count and, more usefully, the breach *pattern* — which tier, which hours, which topic. Then the two or three changes that would move it: coverage, routing, deflection through documentation, or a product fix upstream. An SLA report with no proposed change is a dashboard, not a review.

### NPS or CSAT analysis

Score movement matters less than the verbatims. Theme them by desired outcome — what were these people trying to do — not by sentiment. Separate detractors who are blocked from detractors who are disappointed; they need different responses. Name the single theme with the highest volume-times-severity and hand it to whoever can actually fix it. Close the loop with every detractor who left contact details.

### Support health report

Volume and trend, first-response and resolution times against target, backlog age, top five topics by volume, top five by handling cost, deflection rate, and the customers with three or more unresolved tickets. Then one paragraph: what changed since last period, and what is being done about it.

## Rules

- **Silent customers churn.** They do not complain, they leave. A drop in logins or usage is a support signal even with a clean ticket queue — route it to `mend-churn-prevention` before the cancellation email, not after.
- **A pattern goes upstream every time.** The reply solves one customer; the upstream note stops the next fifty.
- **Never commit on someone else's behalf.** Dates from engineering, exceptions from finance, terms from legal — get them, or say what you are waiting on.
- **Escalate on impact, not on volume.** One enterprise account blocked at renewal outranks twenty low-severity tickets.
