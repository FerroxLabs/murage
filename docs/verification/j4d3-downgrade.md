# J4d3 downgrade inventory

DG1 compares every sorted `restore_*` table name and the exact inspector result.
No table name is filtered from the ledger. MurageMain's r7b ruling retains
`restore_holds` on target 13. The refusal code is
`DATABASE_SCHEMA_UNSUPPORTED`.

| Inspector | Case | Exact sorted inventory | Result |
| --- | --- | --- | --- |
| I101, d950cbf67, target 6 | control | `[]` | accepted |
| I101, d950cbf67, target 6 | marks-only | `[restore_job_marks]` | DATABASE_SCHEMA_UNSUPPORTED |
| I101, d950cbf67, target 6 | notice-only | `[restore_boot_wait]` | DATABASE_SCHEMA_UNSUPPORTED |
| I101, d950cbf67, target 6 | both | `[restore_boot_wait, restore_job_marks]` | DATABASE_SCHEMA_UNSUPPORTED |
| IREL, fc3782abe834bb0a62c96437bff78ac4dbd96eeb, target 13 | control | `[restore_holds]` | accepted |
| IREL, fc3782abe834bb0a62c96437bff78ac4dbd96eeb, target 13 | marks-only | `[restore_holds, restore_job_marks]` | DATABASE_SCHEMA_UNSUPPORTED |
| IREL, fc3782abe834bb0a62c96437bff78ac4dbd96eeb, target 13 | notice-only | `[restore_boot_wait, restore_holds]` | DATABASE_SCHEMA_UNSUPPORTED |
| IREL, fc3782abe834bb0a62c96437bff78ac4dbd96eeb, target 13 | both | `[restore_boot_wait, restore_holds, restore_job_marks]` | DATABASE_SCHEMA_UNSUPPORTED |

These are the actual 1.0.1 and published 1.0.18 inspectors. Their acceptance
of the control copy is an inspector result; it does not establish that the
older server was opened.

## DG2 refusal and owner action

MurageMain's ruling keeps the existing preflight refusal. With live
`restore_holds` rows, target 13 returns `DOWNGRADE_WORK_PENDING`. The DG2
fixture compares complete, deterministically ordered dumps of every
`restore_*` table and every `sqlite_master` column before and after the
attempt. The serialized bytes must match, including hold generations and
exact schema SQL. This refusal already passes at f13135115c; removing the
preflight call or the hold count must make the assertion RED.

The empty-holds control downgrades to 13, opens through head's initializers,
then creates and restores an archive. The restored result remains held until
an owner action presents its current restore generation.

`recovery.downgradeWorkPending` in all eight main locale packs supplies the
reason and the instruction to finish or cancel the pending restore first.
The desktop previous-version flow uses the saved app language. The CLI uses
the English catalogue line. Tests execute the desktop function with fixture
dialogs and the actual CLI against an isolated data directory. This proves
the selected dialog text, not an interactive Electron window.

Copy proposals are linted in the container. Copy review records belong to
MurageMain; `copy-final` remains RED until that review lands.
