# Browser copy review recording

Update: the 86 corrected strings now have Sol's passing re-review. See [RE-REVIEW.md](RE-REVIEW.md) for the new record and verification. The report below preserves the original recording outcome.

OPEN NEEDS-RE-REVIEW. Applied all 86 corrections from Sol exactly, with no key changes or other locale string edits. The immutable record is `2026-11-11-1019-browser-1d76aad295f3`: 1,619 pass and 86 fail. After the corrections and ledger rebuild, 1,612 of those passes still match the live source. All 86 corrected strings and seven translations whose English changed need review. No corrected string has been marked as approved.

Base: `9aaeaa1195a322d6818adb5ce70b6d31f9091b89`. Branch: `dev/1019-copyrec-browser`.

## Review provenance and recording

[sol-original.json](sol-original.json) is the exact single JSON block extracted from Sol's final response. The source response SHA256 is `c9b88726c06e91f8c85798d9d44040c7b04a4e3fbecf4d616444b7d314ba0881`. Sol described that block as a verdict overlay, with instructions to restore each original `text` and `en` from the preB review request. [record-bundle.json](record-bundle.json) performs only that merge. Every verdict and note is unchanged, and reviewer identity is `sol`.

The reference cloud-links record at `c68a7ab3b` and the recorder implementation were inspected. This recorder accepts only `pass` and `fail`, verifies the current text and English, and has no `corrected` verdict or `verify` subcommand. The original bundle was recorded before applying corrections so the original review, including all fails, remains valid evidence. After applying the corrections, a second record attempt was refused because the shipped text and English no longer match. It wrote no record. The ledger was rebuilt with the repository command; no entries or hashes were approved manually.

[CORRECTIONS.md](CORRECTIONS.md) lists all 86 old and new strings. [corrections.json](corrections.json) also retains each reason and source path. Seven additional entries, `browser.BrowserSetupCard.2` in de, es, fr, hi, ja, pt-br and zh, lost their live pass because the English changed from “Set up” to “Setup”.

The Chinese setup corrections place Chinese punctuation directly after the URL. The existing lint scanner normalizes that punctuation and includes the following words in its URL token. Only the two corresponding exact tokens in `links.json` were updated to match the scanner; neither corrected string was altered. The full links file is included for review alongside the 93 strings in [re-review-request.json](re-review-request.json). Every verdict in that new request is blank. MAIN must seat Sol again.

## Verification

Tests ran through the required `it-remote.sh` wrapper with `IT_JOB=rec-browser`, this worktree as `IT_W`, and `it-local-generic.sh` as `IT_ORIG`. Both runs used murage-vt4, Node 24, an unprivileged user, network none, and one container at a time. Observed host and worker load stayed below 85.

| Check | Result |
| --- | --- |
| 14 copy, locale, recorder and i18n test files | 527 passed, 5 failed / 532 |
| Recorder tests | 133 passed / 133 |
| Deterministic copy rules, plain words, no em dashes, links and completeness | PASS |
| Exact overlay/verdict/source audit and record hash | PASS |
| Ledger equals recorder rebuild; no ignored records or conflicts | PASS |
| `generate-locale.mjs --check` | OPEN: source acceptance requires completed reviews |
| Isolated fake-engine fixture and Doctor | PASS; fixture data removed |
| `git diff --check` | PASS |

The five failing tests are the same named checks documented on the base branch: the two generator acceptance checks, the two ledger completeness checks, and the pinned lint file check. They remain open for this re-review and the other preB review sets. Source hashes remain unchanged because accepting them would bypass the review gate. This branch is not release-ready. The fixture verifies isolated server startup and Doctor only, not browser UI rendering or a browser workflow.

Commands:

```sh
node scripts/copy-review.mjs record docs/verification/rec-browser/record-bundle.json --reviewer sol --slug 1019-browser --date 2026-11-11
node scripts/copy-review.mjs rebuild
node scripts/copy-review.mjs propose docs/verification/rec-browser/re-review-request.json --base 9aaeaa1195a322d6818adb5ce70b6d31f9091b89 --author preB-locale-astra-builder --scope 'Sol browser corrections and translations with changed English; independent re-review required' --only 'en:browser*,de:browser*,es:browser*,fr:browser*,hi:browser*,ja:browser*,pt-br:browser*,zh:browser*'
node node_modules/vitest/vitest.mjs run scripts/copy-review.test.mjs scripts/generate-locale.test.mjs scripts/browser-extension-locales.test.mjs src/locales src/lib/i18n.test.ts src/lib/i18n-intl-locale.test.ts src/lib/projects-lib-i18n.test.ts src/components/projects-i18n.test.ts --reporter=json --outputFile=.rec-browser-evidence/tests.json
node scripts/generate-locale.mjs --check
node --experimental-strip-types .rec-browser-evidence/fixture.mjs
```

The full links file was added to the generated re-review request with a blank verdict. The initial proposal refused the two Chinese strings until their exact link tokens were updated; the final proposal includes all 93 strings.

Detailed logs, verification script, fixture evidence, leak guard reports and final push receipt are retained in the job's external evidence directory. The base leak guard has 63 inherited flagged files: 49 mobile-owned tailnet files and 14 other files, classified in [the base evidence](../preB-locale/leak-classification.md). No guard rules or exclusions were changed. No Mac, live application data or billable service was used. The requested memory prelude tool and `.ijfw/memory` were unavailable in this checkout.
