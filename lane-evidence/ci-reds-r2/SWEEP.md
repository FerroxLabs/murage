# PowerShell JSON array sweep — ci-reds-r2

Starting checkout: b45d7db77897a5ae38bc6f0356c3048998799a3d (5138c3ed plus the previous round's evidence-only commit).

Searched tracked repository source with `git grep -n ConvertFrom-Json` (excluding retained evidence and duplicate allowlist receipts), and searched all JS/TS source extensions for embedded scripts. Full raw inventory: `convert-from-json-inventory.txt` beside this report. The new pure test independently walks repository source and inspects string/template literals with TypeScript's parser.

| Embedded script | JSON input | Fix |
| --- | --- | --- |
| `server/channels/signal/storage.ts:32` SECURITY_SCRIPT | `MURAGE_SIGNAL_ROOTS`, always six paths (also the point reader's repeated path) | `@(($env:MURAGE_SIGNAL_ROOTS \| ConvertFrom-Json) \| ForEach-Object { $_ })` |
| `server/channels/signal/service.ts:138` directory bootstrap | `MURAGE_SIGNAL_DIRS`, existing directory paths | `@(($env:MURAGE_SIGNAL_DIRS \| ConvertFrom-Json) \| ForEach-Object { $_ })` before the consuming `ForEach-Object` |

These are the only embedded executable script strings parsing JSON arrays. `server/full-access-corpus-108.test.ts` reads the package.json object; `server/reader-ps-variants-1015.test.ts` models an object with an items property. The winbox audit test contains a regex matching standalone PowerShell source, not an executed embedded script. JSON allowlist entries mirror the two scripts; both full-source SHA256 pins and invocation fingerprints were refreshed. The existing storage transport assertion now demands the unwrap form.

The sweep also fixes all six analogous standalone array wrappers:

| Standalone script | Array input | Fixed sites |
| --- | --- | --- |
| `scripts/windows/parse-native.ps1:11` | Native-source manifest entries | 1 |
| `scripts/windows/job-check.ps1:18` | Owned-process snapshot receipt | 1 |
| `scripts/win-gate/run-win-tests.ps1:27` | Windows test file manifest | 1 |
| `scripts/windows/winbox-gate.ps1:72,79,184` | Successful/partial phase receipts and offending-window receipt | 3 |

Each uses `@((Get-Content ... | ConvertFrom-Json) | ForEach-Object { $_ })`. The winbox audit's exact source assertion now requires that form, and a pure test pins all six sites. Standalone scripts have no entries in the shipped-code PowerShell allowlist. Remaining standalone reads either parse objects or assign directly without the nested `@(...)` wrapper; the ledger parses one JSON object per input line. Documentation examples read objects. No other affected array wrappers remain.

The new pure regression fails on both original embedded parsers: see `lane-evidence/ci-reds-r2/array-red.log`. Controls reject both the roots assignment and an external consuming pipeline, accept the portable unwrap, and reject an unsafe second parser following a safe one. It scans every embedded environment JSON parser, so a new such parser must also use the portable form.

No production ACL-reset change exists in the starting checkout: `/reset` occurs only in `server/testing/windows-acl-fixture.ts`. That helper restricts disposable test roots and is retained as expressly authorized test environment setup; its simulated test is not evidence of the product failure's cause. The real Windows `T-MODES` security-reader test and the native full/CLM reader qualification tests remain intact. No test or assertion was removed or newly skipped.

The T-ACCOUNTS symlink case now expects `kept-check` on win32 and `identity-unavailable` elsewhere, with the existing explicit assertion that `spawnChild` was never called. The escaping-path assertion remains unchanged.

Windows PowerShell 5.1 runtime reproduction was supplied by the user. This Linux container job does not claim native Windows qualification. Native reader tests retain their existing Windows requirements.


Validation completed in supplied network-none containers (four sequential runs, at most one own container):

- Initial pure regression: 1 expected failure naming both original Signal parsers; 1 detector-control test passed.
- Broad Signal plus guard: 664 passed, 12 failed, 13 existing platform skips across 36 files. Both changed Signal suites and the new array regression passed.
- Exact final touched suite: 209 passed, 13 existing platform skips, 6 files green. The pure regression now has 3 passing tests, including standalone reader coverage.
- Windows tooling: 40 passed, zero skipped, including exact-source and string-inventory assertions.
- Isolated verification fixture: Doctor returned `ok: true`; the owned child closed and its temporary data directory was removed. Fixture info, JSON and persistent server log were retained. This is a Linux startup smoke, not native Signal/Windows qualification.
- Starting-source comparison: restoring the original storage/service/allowlist bytes reproduces the identical 12 failing test names (2 transport custody fixtures and 10 broad guard assertions). See `comparison.json` and both complete logs. Current Signal allowlist entries have no stale/forbidden Signal finding; unrelated guard findings remain.
- CI test-tier inventory: 4672 Vitest files, 3173 gate, 1536 extended; passed. The new pure test is an all-platform release gate.
- Exact Signal source SHA256 and invocation fingerprints: both match; passed.

Receipts and replay scripts are committed under `lane-evidence/ci-reds-r2/`. No native Windows execution was performed by this job. The 12 baseline failures remain open; this patch does not claim a globally green release gate.
