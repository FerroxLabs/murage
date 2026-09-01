---
name: legal
description: "Entry point for business legal-document work: reads the request, collects the jurisdiction and party facts every binding document needs, then either hands off to the matching drafting skill or drafts inline against a required-clause checklist for NDAs, terms of service, privacy policies, service contracts, employment agreements, refund policies and equity grants. Use when the user asks for a legal document and it is not yet clear which one they need. Do NOT use when the document type is already known — go straight to legal-contractor, legal-eula, legal-dmca, legal-cease-and-desist or legal-gdpr. Templates only, never legal advice: every output requires review by an attorney licensed in the user's jurisdiction."
license: Apache-2.0
metadata:
  author: wayland
  version: "1.0.0"
  tags: "orchestrator legal contracts smb business"
  category: "legal"
  attribution: "Wayland Business Suite (Original)"
---

> **⚠️ Templates only — not legal advice.**
>
> Everything produced here is a **template document or analytical framework**. It is **not legal advice**, it is **not a substitute for an attorney**, and it may be unenforceable, non-compliant or actively harmful in the user's jurisdiction. Contract law, consumer law and employment law vary by country, state and locality.
>
> Before the user relies on any output:
> - An attorney licensed in their jurisdiction reviews the document.
> - Every clause is checked against applicable local, state and federal law.
> - The document is confirmed to fit the actual parties, facts and intended use.
>
> Say this once, plainly, at the start of the work. Do not bury it, and never tell the user they do not need a lawyer.

# Legal document router

The user wants a legal document and has not said which one, or has named one loosely ("I need something for a freelancer", "we need terms for the site"). Your job is to identify the document, clear the jurisdiction gate, then draft — either by loading the specialist skill or by working inline against the checklist below.

## Step 1 — Jurisdiction gate (before any drafting)

No binding document gets drafted until these four are on the table:

1. **Governing jurisdiction** — country, and state or province. Not "the US".
2. **The parties** — legal entity names and types on both sides (individual, sole proprietor, LLC, corporation), and where each is located.
3. **What the document is actually for** — the transaction or relationship it governs, in one sentence from the user.
4. **Consumer or business counterparty** — consumer-facing documents pick up mandatory consumer-protection rules that B2B documents do not.

If any of the four is unknown: ask once. If it is still unknown, mark the output `DRAFT — JURISDICTION-DEPENDENT CLAUSES UNFILLED` and leave those clauses as labelled blanks. **Never silently default to Delaware, to at-will, or to US-federal-only.** A template that quietly assumes the wrong jurisdiction is worse than no template, because it looks finished.

## Step 2 — Route to the specialist skill

| What the user is asking for | Load |
|---|---|
| Freelancer, consultant, agency or fractional engagement; 1099 relationship; worker classification | `legal-contractor` |
| Software licence for an installed app, desktop tool, plugin or mobile app; App Store or Play addenda | `legal-eula` |
| Takedown of infringing content, counter-notice, designated-agent registration, safe harbour | `legal-dmca` |
| Formal demand that a behaviour stop — trademark, copyright, defamation, breach, unpaid debt | `legal-cease-and-desist` |
| EU or UK personal data, a DPA to sign, sub-processors, international transfers, DPIA | `legal-gdpr` |
| Entity choice, formation, ownership structure, cap table hygiene | `sentry-formation-and-structure` |
| Commercial terms strategy — what to concede, what to hold, how to negotiate a contract | `sentry-contracts-and-terms` |
| Trademark, copyright and trade-secret posture; compliance program design | `sentry-ip-and-compliance` |
| Employee vs contractor classification, exempt vs non-exempt, offer structure | `sentry-employment-and-classification` |

## Step 3 — Draft inline when there is no specialist skill

For these, work from the checklist. The checklist is the deliverable's spine: a document missing one of its clauses is incomplete, and you say so in the output rather than letting the gap pass.

### Mutual or one-way NDA

- **Decide direction first.** One-way if only one side discloses; mutual if both will. Founders default to mutual out of politeness and then cannot enforce it cleanly — ask who is actually disclosing.
- **Required:** definition of confidential information (and what is carved out — already public, independently developed, lawfully received, required by law); permitted purpose; permitted recipients and their obligation to be bound; term of the obligation (survival often outlives the agreement); return-or-destroy on termination; no-licence clause; remedies including injunctive relief; governing law and venue.
- **Failure mode:** a definition so broad it covers everything, which courts narrow or refuse to enforce. Tie confidentiality to what is marked or reasonably identifiable as confidential.
- **Do not** use an NDA to bind a prospective employee's future employment; that is a different instrument with different rules.

### Terms of service / terms of use

- **Required:** who the provider is; eligibility and account rules; the licence or access grant and its limits; acceptable use; user content and the licence the user grants back; payment, renewal and cancellation terms; suspension and termination rights on both sides; disclaimers of warranty; limitation of liability; indemnity; dispute resolution (and whether arbitration and class-action waiver are used — a live compliance question in several jurisdictions); modification and notice-of-change mechanics; governing law.
- **Consumer-facing adds:** clear pre-contract disclosure, a functioning cancellation and refund path, and (in the EU/UK) withdrawal rights. Auto-renewal disclosure and cancellation rules are separately regulated in several US states.
- **Failure mode:** terms that are never actually agreed to. Record how acceptance is captured — clickwrap with an affirmative action beats a footer link every time.

### Privacy policy

- **Required:** what personal data is collected and from where; why, and on what basis; who it is shared with (categories and named processors); international transfers; retention; user rights and how to exercise them; cookies and tracking; children's data; security posture in general terms; contact point and effective date.
- **The policy must describe what the product actually does.** Generate the inventory of data flows first. A policy that misdescribes real processing is a misrepresentation, not a formality.
- For EU/UK data specifics, the DPA, transfers and DPIA triggers, hand off to `legal-gdpr`.

### Service contract, MSA or SOW

- **Required:** scope and deliverables in specific, testable language; acceptance criteria and the review window; fees, invoicing schedule, late fees and expenses; change-order procedure; IP ownership and licence (who owns the work product, who owns pre-existing material); confidentiality; warranties; limitation of liability and its carve-outs; term, termination for cause and for convenience, and what happens to work in progress; independent-contractor status; governing law and dispute resolution.
- **Failure mode:** vague scope with no change-order path — the single most common cause of a services relationship going bad. If the user cannot describe the deliverable in a sentence, the scope is not ready to sign.

### Employment agreement or offer letter

- Run the classification question first (`sentry-employment-and-classification`). Employee and contractor are not interchangeable, and choosing wrong is expensive.
- **Required:** role, start date, reporting line; compensation, pay frequency and exempt/non-exempt classification; benefits summary by reference to plan documents; at-will status where applicable **plus** the acknowledgement that nothing in the letter is a contract of employment for a fixed term; confidentiality and IP assignment (with the state-mandated carve-outs where they apply); restrictive covenants only where they are enforceable in that state; contingencies (background check, work authorisation); the state-required wage notice.
- **Failure mode:** promising anything about equity, bonus or severance in the letter that the plan documents do not actually deliver.

### Refund or return policy

- **Required:** what is refundable and what is not; the window; condition requirements for goods; who pays return shipping; how refunds are issued and how long they take; exceptions (digital goods, custom work, services already performed); how to request one.
- **Must match reality**: the policy has to match what the payment processor, the marketplace and the storefront actually do. Consumer-protection law and platform rules can both override what the policy says.

### Equity grant

- This one is the least forgiving. **Required:** the plan it is granted under; grant type (ISO, NSO, RSU, profits interest) and whether the entity type even supports it; number and class of shares; strike price and the valuation supporting it; vesting schedule, cliff, and acceleration terms; exercise window after termination; transfer restrictions; the 83(b) election window if restricted stock is involved (30 days, not extendable).
- **Route to counsel, do not freelance.** A mispriced option grant or a missed 83(b) creates personal tax liability for the recipient that cannot be fixed afterwards. Produce the fact pattern and the questions; let a lawyer and a tax advisor produce the instrument.

## Step 4 — Output discipline

Every generated document ends with the disclaimer block, reproduced verbatim, never summarised. Every unfilled jurisdiction-dependent clause stays visibly labelled. Every document lists, at the end, the specific things the reviewing attorney should look at first — that list is what makes the review cheap.

## Route to counsel, do not draft

- Anything already in dispute, in litigation, or under a demand letter.
- Regulated activity: securities offerings, lending, insurance, healthcare data, licensed professions.
- Immigration, criminal exposure, or anything involving a government investigation.
- Equity, convertible instruments and cap-table changes.
- Cross-border employment.
- Any document the user intends to sign today under time pressure. The pressure is the reason to slow down.

> _Templates only — not legal advice. Have an attorney licensed in the user's jurisdiction review every document before it is signed, published or sent._
