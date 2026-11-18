# Windows plain-form text gate

Owners: wg-winproof owns this corpus, runner and launcher. wg-text owns the
`wipeBreaker` entry and context contract; wg-win owns its Windows text model.
MAIN owns real Windows gate-box execution, supplying private Windows logs,
and the release decision; wg-proof owns the existing private-log replay
harness. MAIN preserves each Windows gate report as external release evidence.

With a checkout and Node 24+ on a real Windows box, one command from either
Windows PowerShell 5.1 or PowerShell 7 runs all 240 cases:

```powershell
& .\server\wipe-proof\windows-gate\run-windows.ps1
```

From cmd, use:

```bat
powershell -NoProfile -File server\wipe-proof\windows-gate\run-windows.ps1
```

Run the same launcher under both `powershell` (5.1) and `pwsh` (7) on the gate
box; preserve each summary at the path printed by the launcher outside the
checkout. The launcher checks Node, propagates failure as exit 1, and writes
a uniquely named JSON summary in the system temporary directory. Output is evidence,
never a source artifact to commit. No dependency installation is needed.

The identical Linux entry is:

```sh
node server/wipe-proof/windows-gate/run.mjs --summary /external/job/RESULT-LINUX.json
```

Each row is independently authored and maintained in `cases.json`, with its
complete Windows cwd, home, project, data directory, engine environment,
platform and dialect. No product command/option table generates expectations.
The engine label distinguishes Windows PowerShell 5.1 and PowerShell 7
reference spellings; both use the public `pwsh` dialect. Child wrapper names
in the command text specify the child edition. All 119 CARD and 121 RUN rows
are mandatory. IDs, reasons and counts make failures reviewable without
changing the expected verdict to match the implementation. C100 retains its
original ID and command with RUN under // MAIN RULING 23:15Z(b):
Initialize-Disk cannot destroy existing data. MAIN 1114-WIPE-REVIEW-BOUND
requires ordinary commands to run. This is an oracle correction, not a disguise.

The runner imports the current tree's `server/wipe-breaker.ts` and calls only
`wipeBreaker(command, context)`. Corpus commands are strings, never evaluated,
spawned, invoked or sent to an app. Every row has fresh isolated filesystem,
mount and registry ports; unavailable paths do not borrow the user's actual
filesystem or registration state. Windows roots are supplied as lexical
fixture context, so no physical root needs to be created or touched. The
product parser and root classifier still decide the verdict. No live server
or conversation is used or mutated. A checker fault fails even a CARD row.

Each row prints PASS/FAIL. Final JSON includes actual host platform, Node and
launcher PowerShell versions, corpus/checker hashes, counts by expectation
and engine, and every failing row ID. Exit 1 means any miss or setup failure;
a missing runtime is never a passing gate. Linux results qualify these text
verdicts only. Real Windows reports remain required by SEAN
1114-WIPE-GATE-FOUR/WINDOWS. Even a passing Windows run proves only item 1:
it does not prove command execution, runtime guards, engine wiring, or zero
new cards against the owner's Windows logs (item 4).
