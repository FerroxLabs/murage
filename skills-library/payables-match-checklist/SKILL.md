---
name: payables-match-checklist
description: |
  Matches supplier invoices to approved orders, delivery or service evidence and credit notes. Produces a source-linked review queue with duplicate, quantity, amount, due-date and supplier-detail exceptions. Use before an owner reviews bills for payment. Use the supplied rules and records; payment execution and supplier changes remain separate owner decisions.
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  tags: "payables invoice matching exceptions"
  category: "finance"
---
# Payables Match Checklist

Use this procedure to prepare a supplier-bill review pack from records you can actually read. Your result is a review queue. It does not authorize payment, a change to supplier details or an accounting entry.

## First task

Ask for the period and the invoice, order and receipt records, including any credits. If the owner already supplied them, begin with a source inventory. State which records and dates you have and which are missing. Work from pasted tables or exports when a connection is unavailable.

## Establish the matching rules

Keep source identifiers, supplier identifiers, invoice references, currency, document dates, due dates, quantities, units, line amounts, tax and totals. Preserve the original text and attach a source row or document reference to each normalized row. Ask for the owner's matching tolerance and approval rules when they affect a decision. Until a tolerance is supplied, treat any difference as a review item. Keep amounts in their original currency and period.

## Reconcile the documents

1. Identify duplicate candidates using supplier, invoice reference, currency, amount and date. A repeated reference is evidence to review, not permission to remove a record. Distinguish an exact copy from an amendment or credit.
2. Match each invoice to the approved order using explicit identifiers. A similar supplier name or equal amount alone is insufficient. Keep a confidence note for a proposed match.
3. Match billed quantities or service milestones to received or accepted quantities. For partial deliveries, compare only the portion supported by the receipt. Keep the remainder pending.
4. Compare units, quantities, unit amounts, tax, delivery charges, discounts and currency. Calculate line extensions and document totals independently. Record rounding and tax assumptions.
5. Match each credit to its referenced invoice. Keep the gross invoice, credit and net position visible. Do not apply a credit twice.
6. Compare supplied supplier details with the approved record. A changed bank or contact detail remains a separate owner verification item. A matching invoice does not verify the change.
7. Check due dates from the supplied terms. Missing dates remain unknown. Do not invent payment priorities from assumptions about a supplier.
8. Reconcile the total value of all input invoices to the queue: reviewed, exception, missing evidence and duplicate candidates. Present gross totals separately from any proposed adjustment so every input remains accounted for.

## Decide the review state

Use these states: Matched for owner review, Difference to resolve, Receipt or approval missing, Duplicate candidate, and Supplier verification needed. More than one flag may apply. Matched means the supplied documents agree under the supplied rules; it is not an instruction to pay.

Keep one row per source invoice, with supplier, invoice, order, receipt, amount, currency, due date, flags, supporting references and the exact decision required. Keep uncertain matches explicit.

## Approval and recovery

Draft any supplier enquiry and show its recipient, purpose and exact text. Sending, posting an entry, changing supplier details or recording a payment needs the owner's explicit yes to that action. Do not request credentials in chat. Use the normal Settings flow for a required connection.

After an interruption, read the existing review queue and any action receipt before repeating work. A prepared row is not a completed external action. Preserve owner annotations and distinguish proposed corrections from confirmed updates.

## Output and checks

Return the input coverage note, reconciled totals, review queue and draft enquiries, followed by a short action-state line. Preserve every source invoice, including duplicates awaiting a decision. Check arithmetic, currency, row counts, evidence links and unapplied credits. Explain each remaining unknown. End by stating which actions, if any, were actually performed.
