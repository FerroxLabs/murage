# Linux package/search component proof

Date: 2026-09-06. Source: `395d790b82aebd9f7b536e0c3406dde78070f31c`.
Transport: existing `hetzner-dsm` SSH alias, BatchMode and StrictHostKeyChecking enabled.
Host: Linux 6.8.0-101-generic x86_64. Node 24.20.0, pnpm 10.33.0.
Task-owned checkout: `/var/tmp/murage-linux-proof-20260906-h1RECn`.
Source transferred with `git archive` of the exact commit. No uncommitted budget
or packaging correction was transferred. Dependencies installed with frozen lockfile
and lifecycle scripts disabled; existing host services were untouched.

Command after entering the checkout and selecting the verified Node runtime:

```sh
corepack pnpm exec vitest run server/bot-package-archive.test.ts server/bot-package-import.test.ts server/package-import-transaction.test.ts server/package-import-batch.test.ts server/package-import-fatal.test.ts server/package-export-files.test.ts server/package-export-bundle.test.ts server/package-import-comparison.test.ts server/web-search.test.ts server/routine-event.test.ts
```

Result: exit 0, 10 files passed, 76 tests passed, duration 3.73 seconds.

| Test file | Passed |
|---|---:|
| bot-package-archive | 17 |
| bot-package-import | 5 |
| package-import-transaction | 14 |
| package-import-batch | 3 |
| package-import-fatal | 1 |
| package-export-files | 10 |
| package-export-bundle | 4 |
| package-import-comparison | 4 |
| web-search | 15 |
| routine-event | 3 |

Local and remote SHA-256 matches:

```text
0b92a1e0cdbc463cad8f93ce29f8dfd21af6912554504acabd68139ca40fe455  pnpm-lock.yaml
c267e177bce560a62650dfe645175e77c88f539e226f35945f01349215be8eff  server/package-export-files.ts
ab1e9ceee775b0734a9ebe5ccddd979e1a0d13f19a38e8e8a2f87571769d0184  server/web-search.ts
```

Limits: component fixtures and real local filesystem/child-process behavior only.
Search uses fake provider transport. No signed package, fresh-install startup,
desktop GUI, physical power interruption, Windows behavior, private VPS customer
journey, or live-provider search is established by this result. The known packaged
fresh-start blocker was not rerun or bypassed.

Cleanup is recorded in the controlling `.planning/STATE.md` after execution.
