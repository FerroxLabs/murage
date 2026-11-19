Owner: wg-pwsh owns proxies, pipe client, external shims and prefix helper.
Consumers: wg-wiring owns command rewriting/PATH/packaging; wg-callback owns guard files and callback re-decision; wg-win owns text-only Windows fallback.

Dot-source `guard.ps1` before the original top-level PowerShell command using
`prefixPowerShellWipeGuard(command, absoluteGuardPath)` from `prefix.ts`.
The helper quotes apostrophes and preserves the original command bytes.
Package this entire directory and put it on PATH for `format.cmd` and
`diskpart.cmd`. Those shims use Windows PowerShell with no profile.

The six functions copy native cmdlet metadata and use the native steppable
pipeline, including dynamic provider and common parameters. Records outside protected-root operations stream through the native proxy. Once
a potentially protected record arrives, that record and the remaining suffix
are buffered for one coverage check, then replayed in order on approval.
Coverage uses a hash set. Without a usable guard file, or for a dry run, the
standard streaming proxy runs immediately. Storage
cmdlets are installed only when the real cmdlet exists.

Paths come from PowerShell Resolve-Path, including provider cwd, LiteralPath,
wildcards and pipeline-bound parameters. Roots match directly, or by coverage
of all direct children (90% for ten or more children), recursively for removal;
moving children is inherently recursive. Recursive literal/root operands are
checked before leaf Include/Exclude filtering, since native removal can select
descendants even when the operand leaf does not match. Bound parameters are
passed unchanged to the native cmdlet.
Module-qualified cmdlets, .NET deletion and child PowerShell bypass the proxies
and remain owned by the text layer. For ordinary foreach loops over arrays of paths or filesystem items, the proxy
clones the active runtime enumerator before native dynamic parameter binding.
It checks the remaining values with the current operand without advancing the
user's enumerator. Single-child and partial lists still use the same coverage
threshold. Lazy/custom enumerators are not executed for lookahead.

A positive match sends one JSON line directly through the named pipe. The
client retries connection twice after the initial 3-second attempt, then waits
without a read timeout once connected. Missing/off/broken guards and internal
matching faults run the real cmdlet. Deny or unavailable app writes the plain refusal to stderr and exits the
command host with status 126 before execution, including inside try/catch.
The prefix is for the isolated command host owned by the driver. External cmd
shims also exit 126 on refusal and preserve the real native status when allowed.
WhatIf (including WhatIfPreference) bypasses the app and runs native dry-run
behavior. Helpers stay private; caller-bound proxies retain runtime loop state
and are removed when the module is unloaded.
The token stays inside the guard file and pipe, never process argv.

Run the portable isolated fixture suite with:

    pwsh -NoProfile -NonInteractive -File server/wipe-guard/pwsh/tests/run.ps1
    pwsh -NoProfile -NonInteractive -File server/wipe-guard/pwsh/tests/review.ps1
    pwsh -NoProfile -NonInteractive -File server/wipe-guard/pwsh/tests/mutants.ps1
    node --test server/wipe-guard/pwsh/tests/prefix.test.mjs

Windows runners must execute `tests/windows.ps1` under both Windows PowerShell
5.1 and PowerShell 7. It runs the portable suite, checks the actual Windows
cmdlet parameter metadata, and invokes both cmd shims against harmless fake
tools through a stub named-pipe server. The portable suite compiles harmless
fixture storage cmdlets; it never invokes real disk cmdlets. Every test mutation
and capture is confined to an automatically cleaned temporary fixture tree.
