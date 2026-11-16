# Corrected-copy integration verification

Comparison base: `28811f8bb0356e19e77d7705636f41832a359908` (`dev/1019-int19m2`).
Starting integration tip: `42d527c91ff0ebb38def2b81cb24fb6b762befab`.

Recorded Sol's fenced re-review bundle unchanged using `scripts/copy-review.mjs record --reviewer sol --slug rec-int19c`: 20 pass, 0 fail. The immutable record is `src/locales/copy-lint/reviews/2026-11-11-rec-int19c-507dbab78c84.json`. Parsed string entries, English text, verdicts, scope, author and base were compared with the source bundle. Rebuilt the ledger from records and ran `scripts/generate-locale.mjs <locale> --accept` successfully for de, es, fr, hi, ja, pt-br and zh; English is the source catalog.

Verification used the prescribed container wrapper and job identity, with network disabled and at most two concurrent containers. The wrapper's local fallback provided read-only shared dependencies and fixture tools. No live application/data, Mac or paid service was used.

All frontend, server and conformance typechecks passed on both revisions. The 17-suite test set includes both preceding red tables and all copy/locale suites. Current: 733 tests, 710 pass, 23 fail. Base: 711 tests, 681 pass, 30 fail. All 526 copy/locale tests passed on current. Catalog findings fell from 616 to zero; review-ledger findings fell from 412 to zero. Test-inventory findings remain the same 35 on both revisions.

Every current failed assertion has the same failure details on base after normalizing checkout paths and source line numbers. The offline runner also reproduces the same settings PATCH HTTP 400 failure on base after its fake-ask control passes. Because that runner did not exist on base, only its five unchanged test-support modules were overlaid in the disposable baseline checkout; baseline product files were unchanged.

| Classification | Suite | Failed checks |
| --- | --- | ---: |
| BASE | release workflows | 1 |
| BASE | database busy | 1 |
| BASE | delegation pack dispatch | 16 |
| BASE | Flux endpoint inventory | 1 |
| BASE | harness HTTP API | 3 |
| BASE | shared leak guard fixture | 1 |
| BASE | offline no-limits runner | 1 |
| NEW | all checks | 0 |

The isolated verification fixture passed doctor, bot creation, send, settled wait and bot transcript checks; its owned session was closed. This is fixture coverage, not a claim of live-provider or renderer verification.

Raw logs, JSON results, the per-assertion red table, exact review bundle, diagnostic comparison, fixture transcript and guard receipts are retained in the private job evidence directory outside the repository.
