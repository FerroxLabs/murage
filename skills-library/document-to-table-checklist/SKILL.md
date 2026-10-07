---
name: document-to-table-checklist
description: |
  Turns supplied PDFs, receipts and forms into a traceable table. Defines destination fields, links each value to a document and page, records uncertain readings, and reconciles row counts and totals against the source. Use when structured data must be extracted from documents. The procedure uses an available reader and does not claim OCR or file access that has not been demonstrated.
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  tags: "documents extraction tables provenance"
  category: "data-analysis"
---
# Document-to-Table Checklist

Extract a structured table from documents the owner supplies or explicitly makes available. Preserve the source of each value and make uncertainty visible. A readable-looking table is not evidence that every source page was inspected.

## First task

Ask for the documents and the destination columns or an example of the intended table. If both are supplied, begin with a source inventory. Infer a reversible draft schema only when the owner's goal supports it, and show the assumption.

## Define the extraction

Record document identifiers, filenames as provided, page counts when known and any unreadable pages. Define each destination column, its meaning, unit, format and whether blank is allowed. Preserve identifiers as text where leading zeros or punctuation carry meaning.

## Extract with evidence

1. Inspect each accessible document with an available reader. Establish whether the content is text, a scan or a mix. If a needed page cannot be read, ask for a clearer copy or text and keep that page unresolved.
2. Record a source document and page or section for each row. For a value combined from several places, retain all contributing references.
3. Extract the literal value before normalization. Keep the original alongside a normalized date, amount, unit or name where the transformation matters.
4. Distinguish blank, not applicable, unreadable and absent. Do not turn an unreadable field into zero or infer an identifier because it resembles another row.
5. When several interpretations are plausible, record the alternatives and the exact field needing confirmation. Use a confidence label with its reason, not an unsupported numerical probability.
6. Detect repeated documents and duplicate rows by source identifiers and content. Keep duplicate candidates pending an owner decision.
7. Reconcile document coverage, source line counts, extracted row counts and known totals. Explain omitted headers, subtotals or repeated pages.
8. Validate destination types, date formats, currencies, units and required fields. Do not combine currencies or convert a unit without a supported conversion.
9. Return the table with its exception list. If the owner wants a file, use the available writer and inspect the saved content before reporting success.

## Approval and recovery

Writing to a connected spreadsheet, updating a business record, uploading documents to a new service or sharing the extracted table requires the owner's explicit yes to the exact destination and content. A request to extract information is not permission to send it elsewhere. Credentials remain in the normal Settings flow.

After interruption, read the existing extraction map and identify completed pages before continuing. Recheck a revised document rather than treating the old page references as current. Preserve confirmed corrections and avoid repeating an external write whose result is unknown.

## Output checks

Return a source coverage note, the extracted table, the unresolved fields and a reconciliation summary. Check representative rows against their exact source locations and independently recompute totals. A completed row without support stays marked as an inference. End with what was read, what was saved or updated, and what still requires review.
