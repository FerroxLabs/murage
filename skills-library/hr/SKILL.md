---
name: hr
description: "Entry point for people-operations work at the two-to-twenty-employee stage: collects the jurisdiction, headcount and classification facts that decide which employment rules apply, then routes or works inline — job descriptions, interview loops, onboarding, reviews, 1-on-1s, offer letters, comp bands and performance plans. Use when a people question arrives without a document attached to it. Do NOT use when the task is already named — go straight to hr-handbook, hr-termination-letter, hr-offboard, hr-leave-of-absence, hr-accommodation-request or hr-rif — or when the work is role and hiring design (use slate-role-design). Templates only, never employment-law advice: outputs need review by HR counsel."
license: Apache-2.0
metadata:
  author: wayland
  version: "1.0.0"
  tags: "orchestrator hr people-ops employment smb"
  category: "hr"
  attribution: "Wayland Business Suite (Original)"
---

> **⚠️ Templates only — not employment-law advice.**
>
> Outputs are templates and people-ops frameworks. They are **not employment-law advice**, **not a substitute for HR counsel**, and employment law is both jurisdiction-specific and fast-moving. What is lawful in one state is a claim in the next.
>
> Before the user relies on any output:
> - Employment counsel reviews it for the states and countries where the affected people work.
> - Wage notices, mandatory training and posting requirements are verified separately.
> - The document is confirmed against the real facts — headcount, classification, jurisdiction.

# People operations router

A people question has arrived. Establish the facts that decide which rules apply, then route or draft.

## Step 1 — Pre-flight (required before any binding document)

Anything that will be handed to an employee — offer letter, termination letter, separation agreement, handbook section, accommodation response, leave letter, RIF notice, performance plan — needs these four first:

1. **State(s) of employment.** Where the work is actually performed, including every state a remote worker sits in. Remote headcount pulls in that state's rules, not the company's home state.
2. **Country.** US, UK, EU member state, Canada, Australia, other. At-will employment is a US concept and does not travel.
3. **Total company headcount.** It is the switch on nearly every threshold: Title VII at 15, ADEA at 20, federal COBRA at 20, FMLA at 50 within 75 miles, WARN at 100 — plus state mini-versions that trigger far lower.
4. **Classification.** W-2 or 1099; exempt or non-exempt under the FLSA salary *and* duties tests; full-time, part-time or temporary.

If any of the four is unknown: ask once. If still unknown, mark the output `DRAFT — JURISDICTION-DEPENDENT FIELDS UNFILLED` and refuse to fill state-specific clauses. Do not default to at-will, to federal-only, or to the founder's home state.

## Step 2 — Route to the specialist skill

| The request | Load |
|---|---|
| Handbook, policy sections, required-by-law policies | `hr-handbook` |
| One person being terminated involuntarily; separation agreement | `hr-termination-letter` |
| Departure logistics, final pay, COBRA, access revocation, data preservation | `hr-offboard` |
| More than one person cut for business reasons; WARN exposure | `hr-rif` |
| FMLA, state PFML, parental, medical or personal leave | `hr-leave-of-absence` |
| ADA, pregnancy or religious accommodation; interactive process | `hr-accommodation-request` |
| Designing the role itself — scope, level, whether to hire at all | `slate-role-design` |
| Evaluating candidates, scorecards, reference checks | `slate-candidate-evaluation` |
| Structuring the hiring process end to end | `slate-hiring-structure` |
| Engaging a freelancer or agency rather than an employee | `legal-contractor` |
| Whether this person is an employee or a contractor at all | `sentry-employment-and-classification` |
| Whether the company can afford the hire | `coin-runway-and-burn` |

## Step 3 — Work it inline

### Job description and posting

Scope from `slate-role-design` if the role is not yet defined. The posting itself needs: the outcomes the person owns in the first year (not a duty list), the level and its calibration, must-have versus nice-to-have separated honestly, location and remote policy naming the eligible states, and the pay range where pay-transparency law requires it — which is now most large markets, and applies to remote roles open to those states. Strip requirements that screen on proxies rather than the work.

### Interview loop and question bank

Structured beats unstructured, every time: the same questions, in the same order, scored against the same rubric. Build one behavioural question per required competency, a work-sample or scenario stage, and a scorecard with anchored ratings. Off-limits: age, family status, pregnancy, disability, religion, national origin, arrest record, and — in a growing number of states — salary history. Write the bank so an untrained interviewer cannot wander into those.

### Onboarding plan

Day one: paperwork (I-9 within the statutory window, W-4, state forms, handbook acknowledgement), access, and a named buddy. Week one: context, not tasks. Day 30 / 60 / 90: explicit outcomes the new hire is accountable for, agreed in writing with the manager. For a full programme, `onboarding-plan` and `sop-creation` go deeper.

### Performance review

Fix the cycle and the rubric before writing any individual review. Each review: outcomes against what was agreed, behaviours against stated values, evidence with dates for both, and one development priority. Calibrate across the group before anything is delivered — uncalibrated ratings are where disparate-impact problems start. Never let a review be the first time an employee hears a criticism.

### 1-on-1 agenda

Employee's items first, manager's second, then one forward-looking question. Fifteen minutes of preparation from the manager beats an hour of improvisation. Keep a running document; it becomes the evidence base for the review.

### Offer letter

Role, start date, reporting line; compensation, pay frequency and exempt/non-exempt classification; benefits by reference to plan documents; at-will language where lawful, with the explicit statement that the letter is not a fixed-term contract; contingencies (work authorisation, background check where lawful and disclosed); the state-required wage notice; and the expiry of the offer. Do not promise equity, bonus or severance terms the plan documents do not deliver.

### Comp band

Anchor on two or three market sources for the role, level and geography; state the sources and the date. Set the band as minimum / midpoint / maximum, place the offer against it, and write down the rule for where in the band a candidate lands — experience, scope, or location. Bands without a written placement rule reintroduce exactly the pay gaps they were built to close. Affordability is a separate question: `coin-runway-and-burn`.

### Performance improvement plan

Only after the manager has given direct feedback and it is documented. The plan names specific, measurable outcomes; the support the company will provide; the review checkpoints; and the consequence if the outcomes are not met. Thirty to sixty days is typical. **Check first** whether the employee recently took protected leave, raised a complaint, or requested an accommodation — a PIP that follows any of those needs counsel before it is delivered, because the timing itself is evidence.

### People report

Headcount by team and type, open roles and time-to-fill, offer acceptance rate, voluntary and involuntary attrition separated, and the one number the leadership team is going to ask about next month. Keep individual performance data out of a distributed report.

## Route to counsel — do not draft

- Active harassment, discrimination or retaliation complaints. These need counsel and a neutral investigator, immediately.
- Executive separations with bespoke equity, IP or restrictive-covenant terms.
- Multi-state RIFs at or near WARN thresholds — counsel clears the notice timing before anyone is told.
- Terminating a visa-sponsored employee (H-1B, L-1, O-1 implications).
- Whistleblower, SOX or Dodd-Frank matters.
- Union activity or NLRA §7 protected concerted activity.
- Any adverse action within weeks of protected leave, a complaint, or an accommodation request.

> _Templates only — not employment-law advice. Have HR counsel licensed in the relevant jurisdiction review every document before it is delivered._
