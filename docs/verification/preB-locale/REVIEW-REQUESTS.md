# preB-locale review requests (OPEN)

No review was performed or recorded by this builder. The approved identities in `src/locales/copy-lint/reviewers.json` are `sol` (gpt-6.1-sol, read-only, Codex accounts 2 and 6) and `claude-copyrev` (Claude Sonnet 5.5, MurageMain copy-review seat). Neither identity is available to this builder. No paid model or reviewer was invoked. A different author string is not independent review evidence.

The attached [review-request.json](review-request.json) was produced by `scripts/copy-review.mjs propose` against base `bbf96a5cb20c8cd7a902e1d41cc82905d9864c75`, with author `preB-locale-astra-builder`. All verdicts are blank. This follows the immutable-record process demonstrated by `2026-11-11-1019-cloud-links-1c87e50e5b68` at `c68a7ab3b`; that record was inspected, not reused to approve different bytes.

Requested reviews:

1. **136 pause strings:** 17 English originals and 17 translations each in de, es, fr, hi, ja, pt-br and zh. Check account membership, key/token/bot limits, email-only waiting, placeholders, and the return to notice-only behavior when account figures disappear.
2. **1,705 browser strings:** inherited missing reviews, including Chrome setup instructions. Check locale fluency, permission wording and correspondence with the actual controls.
3. **384 HighLevel strings:** inherited missing reviews, including German and Portuguese translations of Snapshots. Check the permission levels, approval behavior and destructive-action disclosures.
4. **24 hook error strings:** title, message and action in all eight packs. Check that “tool check” and its translations accurately describe the check before execution and preserve the restart instruction.
5. **8 step-up labels:** `stepup/<locale>:label.claudeCodeImport`, one per language. The integration changed the English label and needs review against the current text.
6. **2 pinned lint files:** `links.json` and `same-as-english.json`. New links are Chrome’s local debugging page for two browser setup strings in each language. Shared text is restricted to browser brands, the SaaS acronym, established local words (Blogs and French Contacts), and German ` in {browser}`. No general copied-English exemption was added. Review the complete pinned files, as required by the tool.
7. **Server wording outside the locale ledger:** review the wording-only changes in `server/drivers/codex-hook.ts`, `server/hook-canon.ts`, `server/hook-safety.ts`, `shared/provider-error.ts`, `server/drivers/muse-code.ts`, `server/highlevel/operations/schemas/common.ts`, `server/highlevel/operations/schemas/opportunities.ts`, `server/highlevel/operations/opportunities.ts`, and `server/index.ts`. Refusal and retry behavior is unchanged; existing expected-message assertions were updated with the text. The two literal Codex artifact hashes in `server/hook-canon.test.ts` also changed because the generated hook and Windows loader contain this wording; check those byte changes with the implementation diff.

After an approved reviewer actually fills the verdicts, use the repository commands below. Do not fill verdicts from lint results or copy an existing reviewer’s identity without that review. If a reviewer requests edits, apply them and propose the affected text again before recording.

```sh
node scripts/copy-review.mjs record docs/verification/preB-locale/review-request.json --reviewer <actual-approved-reviewer> --slug 1019-preb-locale
node scripts/copy-review.mjs rebuild
for locale in de es fr hi ja pt-br zh; do
  node scripts/generate-locale.mjs "$locale" --accept
done
```

`reviewed.json` in this change is rebuilt only from existing immutable records. No records were added, edited or deleted. Source hashes are deliberately unchanged: `--accept` refuses unreviewed text, and manually writing acceptance hashes would bypass that gate.

Open checks pending review and source acceptance:

- `scripts/generate-locale.test.mjs`: `locale draft validation > accepts every shipped catalog`.
- `scripts/generate-locale.test.mjs`: `D24 catalog and hashes include the English fragment actually shipped to the renderer`.
- `src/locales/copy-final.test.ts`: `section 2: every review record and ledger entry is valid (and complete once LEDGER_REQUIRED)`.
- `src/locales/copy-final.test.ts`: `section 2: the records alone give a valid ledger, so a reviewed.json merge conflict can always be rebuilt`.
- `src/locales/copy-final.test.ts`: `section 4: the ledger is required and pins every lint file`.
- `generate-locale.mjs --accept` for de, es, fr, hi, ja, pt-br and zh, plus `generate-locale.mjs --check`.

The new pause translations are committed drafts awaiting acceptance. Source acceptance remains blocked until the review and acceptance steps succeed. This branch is not release-ready.
