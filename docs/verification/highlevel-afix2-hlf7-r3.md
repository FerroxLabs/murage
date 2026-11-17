# Invoice recovery and approval review follow-up

Base: `33b5a61d2cb5d13feb29a7d92cf130ea41bbdeb8`.
Job: `afix2-hlf7-r3`. Provider calls use repository fakes only.

Invoice creation no longer reads the existing invoice collection before review
or dispatch. The durable recovery plan retains the approved contact ID and a
window bound to the action journal's creation time and review expiry, with a
60-second completion allowance. Recovery requests one page of at most 100
invoices, filtered by contact and date. Candidate confirmation additionally
checks `createdAt` against the exact window and hashes every approved effect
field. Empty, incomplete, ambiguous, out-of-window or conflicting evidence stays
`outcome_unknown`. Recovery never resends. Old invoice plans without a bounded
lookup are refused before a provider read.

The [provider list reference](https://marketplace.gohighlevel.com/docs/ghl/invoices/list-invoices/)
documents contact and date filters. It does not establish creation-time
semantics for the date filters. They narrow the lookup; local timestamp and
full-effect checks supply confirmation. Missing candidates never prove absence.

Approval snapshots refuse arrays, strings, depth or budgets that would clip
financial details. Successful snapshots retain each projected financial field
in full, including line items, taxes, currency and total. The returned identity
binder maps `invoiceItems` to the request's `items` collection on both ordinary
success and recovery. It still walks every original response field and checks
conflicting sibling aliases.

The durable action journal now accepts and validates the existing optional
`approvalContextDigest` field. Restart tests exposed that the previous reader
rejected the writer's financial-review rows.

## Regression evidence

Logs and fixture JSON are under `.test-tmp/afix2-hlf7-r3/`; a persistent copy is
retained with the job's evidence. All execution used the supplied
`it-remote.sh`, offline Node containers, at most two containers at once.

| R | Base RED | GREEN behavior |
| --- | --- | --- |
| R1: bounded recovery | Whole-collection pre-read blocks totals 101 and 1,000; missing filters; empty evidence becomes negative confirmation | Create and text2pay each send once with 0, 101, 1,000 and 100,000 existing invoices, with zero collection pre-reads. One filtered page after restart; uncertain outcomes have zero resends. |
| R2: complete approval | A 101-line invoice, long string, exhausted budget and deep financial data reach approval | Each refuses before review/send, with a plain refusal. A complete 20-line snapshot retains all lines, taxes, total and currency. |
| R3: item identity mapping | Only `invoiceItems` plus product and tax IDs leaves successful create/text2pay unconfirmed | Both operations apply and cache replay after one POST. Recovery applies the same binding; foreign product/tax IDs and conflicting aliases are withheld. |
| R4: durable context dependency | Four restart cases fail because the journal rejects `approvalContextDigest` | Applied, empty, incomplete and foreign restart cases reload the journal, make one bounded read and never resend. |

The first base run recorded 20 failures across 45 tests (`red-final.log`).
The first implementation run passed all 45. Durable restart coverage separately
recorded its RED in `restart-first.log` before the journal reader fix.
The broad HighLevel run passed 49 files and 15,720 tests. The final targeted and
release-workflow run passed 3 files and 136 tests. Full `pnpm typecheck` passed.

The isolated launcher allocated temporary data/home and ports. Doctor passed;
the child verified exact review values, a single update across cached replay,
foreign-read refusal, a stale draft without a write, creation with only
`invoiceItems` and product/tax IDs, and refusal of a 101-line invoice before a
send. Its JSON and server log are retained; the fixture was closed.

## Copy review

One new English user-facing string:

> The full invoice details could not be shown for approval. Nothing was sent.

## Mutation evidence

All 24 source mutants were killed by assertion failures, with no load, syntax
or type errors counted as kills. `mutants-qualified/table.json` records the
commands and exit codes, and each mutant has its own log.

| M | Result |
| --- | --- |
| M1-invoice-collection | KILLED |
| M2-invoice-aliases | KILLED |
| M3-review-values | KILLED |
| M4-ordinary-read-context | KILLED |
| M5-frozen-location | KILLED |
| M6-reviewed-read-context | KILLED |
| M7-review-digest | KILLED |
| M8-created-at-window | KILLED |
| M9-complete-invoice-list | KILLED |
| M10-retained-contact-proof | KILLED |
| M12-retained-discount | KILLED |
| M13-retained-dynamic-taxes | KILLED |
| M14-snapshot-dispatch-race | KILLED |
| M15-precreation-collection-read | KILLED |
| M16-contact-filter | KILLED |
| M17-review-clipping | KILLED |
| M18-review-string-clipping | KILLED |
| M19-review-budget | KILLED |
| M20-invoiceItems-identity | KILLED |
| M21-empty-is-unknown | KILLED |
| M22-fixed-page-cap | KILLED |
| M23-created-before-bound | KILLED |
| M24-journal-context-digest | KILLED |
| M11-text2pay-prestate | KILLED |

The initial cap mutant survived because the fake reused nested objects. The
response-safety guard rejected that shared graph before reaching the cap. The
final test uses independent JSON-shaped records, and the cap mutant is killed.
An attempted local fallback lacked Vitest and was not qualified as evidence;
the complete final mutation run used the prepared offline remote container.

## Leak guard v2

The whole-tree guard fails on 582 inherited matches. Running the same v2 guard
against the base produced the exact same 582 matches: zero added or removed
matches, and zero matches in this change's added lines. This is a baseline
failure, not a whole-tree pass. The full logs and machine-readable comparison
are retained with the job evidence. No unrelated leak findings were edited.
