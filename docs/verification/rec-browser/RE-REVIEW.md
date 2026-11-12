# Browser corrections re-review

Recorded Sol's exact 86 passing verdicts with `scripts/copy-review.mjs record`, reviewer `sol`. Record: `2026-11-11-1019-browser-re-review-3f31e16e2daa`. The ledger has exactly 86 additions; existing entries and the original failed record are unchanged. No shipped strings, source hashes, reviewer identities or verdicts were edited.

[sol-re-review.json](sol-re-review.json) is the exact single fenced JSON block from `/work/fuigo-builds/swarm-b/sol-browser-rr/last.txt`. It reviews the corrected text at `d0236fbc995ba5bfe3005d2093f4c3c317a80256`. Source response SHA256: `fb96add796646da166b867a4231e294a2742af9e3a30a5f653a02bad890dfa0e`. Extracted bundle SHA256: `8d815d4ac26fe10e1447d922933d835e761e4869d3a308e516bcfd0a364ba059`.

## Verification

The recorder has no `verify` subcommand. Following the original job's verification procedure, the re-review audit checked the exact bundle hash, every recorded field and verdict, reviewer identity, record filename hash, shipped text and English, and all 86 ledger entries. It also checked that the ledger equals `ledgerFromRecords()` and that running `rebuild()` leaves its bytes unchanged. No ignored records, date problems or conflicts were found. Deterministic copy rules, links, completeness and same-as-English checks passed.

Verification and tests ran in one Node 24 container on `murage-vt4`, through `/work/fuigo-builds/tools/it-remote.sh`, with `IT_JOB=rec-browser2`, `IT_W=/work/fuigo-builds/swarm-b/rec-browser/wt`, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and network none. No server or browser behavior changed or was claimed verified.

| Check | Result |
| --- | --- |
| Exact re-review record and ledger verification | PASS |
| Recorder tests | 133 passed |
| Copy, locale, recorder and i18n tests, 14 files | 527 passed, 5 inherited failures / 532 |
| i18n, locale resolution and project i18n unit tests | 41 passed |
| Deterministic copy rules, links and completeness | PASS |
| `generate-locale.mjs --check` | OPEN: inherited source acceptance gaps |

The five failing test names match the prior job's saved results: two generator acceptance checks, two ledger completeness checks, and the pinned lint file check. All 86 newly reviewed entries pass verification. The broader ledger still reports 562 problems for entries outside this bundle. The seven `browser.BrowserSetupCard.2` translations (de, es, fr, hi, ja, pt-br, zh) and `links.json` still need independent review. This bundle contains no verdicts for them, so they remain open. The branch is not release-ready.

Commands:

```sh
node scripts/copy-review.mjs record docs/verification/rec-browser/sol-re-review.json --reviewer sol --slug 1019-browser-re-review --date 2026-11-11
node .rec-browser2-evidence/verify.mjs
node node_modules/vitest/vitest.mjs run scripts/copy-review.test.mjs scripts/generate-locale.test.mjs scripts/browser-extension-locales.test.mjs src/locales src/lib/i18n.test.ts src/lib/i18n-intl-locale.test.ts src/lib/projects-lib-i18n.test.ts src/components/projects-i18n.test.ts --maxWorkers=2 --reporter=json --outputFile=.rec-browser2-evidence/tests.json
node scripts/generate-locale.mjs --check
```

The verification script, JSON test report, logs and provenance are retained at `/work/fuigo-builds/swarm-b/rec-browser2/evidence/`. The temporary worktree evidence directory and container dependency links were removed after saving the evidence. No Mac, live app data or billable service was used.
