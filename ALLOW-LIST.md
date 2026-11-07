# MARKS allow-list

The executable lists live in `server/shell/walk.ts` (`MARKS_COMMANDS`,
`PURE_READERS`, `SHELLS`, `INTERPRETERS`, wrapper and operand tables), with
response-file lists and fixed `DoubtReason` values in `server/shell/marks.ts`.
Unknown command names hold. Listed commands still pass the existing operand,
redirect, loader, protected-path, and destructive-command checks. Named existing
scripts retain the existing `unseenShapeAdmits` admission; session-edited scripts
must supply readable, bounded bytes and are scanned as written code.

Commands include ordinary shell builtins, local readers, file operations,
compilers, git/package/build commands, downloaders and archives. This is a name
and modeled-position allow-list, not a proof of arbitrary build-system behavior.
Executable options (`less +`, sort/tar compressors, rsync remote shells and git
pager/editor/ssh overrides) hold. Compiler response files, other non-reader
`@file` arguments, xargs argument files and tar/rsync file lists hold separately.
The compiler and generic response-file sets are disjoint.

Paths pass `canonPath` before write-position matching: slash runs, dot components,
parent components, and case on Windows/macOS are folded. Unplaceable relative
paths and control characters hold. Windows drive names are case-folded even when
tests run on POSIX. Proc traversal is checked before folding; canonical `/proc`
is checked independently afterwards. Device streams retain `DEVICE_STREAMS`;
other devices, system trees, drive roots and home roots are protected. Ordinary
project and temporary file targets remain allowed. Read positions add no write
rule: `cat /proc/self/status` remains a control. Pre-existing symlink resolution
is outside this lexical model. `dd` is **not** a name-only disk erase command;
its `of=` tail is canonicalized in write position and holds only on a protected
or device result (or when canonicalization cannot complete).

Inline and same-text/session-written interpreter bodies share `opaqueParts` and
`scanWritten`. A whole-body closed grammar admits Python literal `print`, literal
string `.format` inside `print`, and literal `open(...).write(...)`; JS/TS runner
`console.log`, Ruby `puts`, Perl `print`, PHP `echo`, and Lua `print` admit the
listed literal forms. Unclassified bodies return `incomplete`, which holds with
`Doubt(tokenizer)`. Literal path checks run first in write position. Runtime path
assembly, imports, arbitrary calls, interpolation and escaped/adjacent literals
are not admitted by this grammar.

| Cost/control | Result |
| --- | --- |
| osascript `-e`, rscript `-e`, tclsh stdin one-liners | Hold: no approved grammar |
| Other interpreter programs outside the small grammar | Hold, including benign imports/computation |
| sed file programs and inline programs beyond numeric `p` ranges | Hold |
| Unknown command names or incomplete syntax | Hold |
| Embedded dotted device text, even printed by echo | Hold under the device-word rule |
| cat proc status, project dd, sort output, sed `-n 1,5p` | Retained controls |
| Python format-print and project literal open/write | Retained controls |
| Whole command 131,072 characters / 131,073 characters | Allowed by size gate / hold |

Fixed doubts are `tokenizer`, `value-path`, `file-fed-args`, `unavailable-exec`,
`scan-gate`, and `command`. They carry no `couldNotRead` waiver. Existing named
catastrophes retain their own rule. The `fromFile` classification is in
`server/always-ask.ts`, not `walk.ts`.

Late frames carry `lateFrame`; outside marks retain `{callKey, late}` provenance.
`markCallOutside` is the single exemption guard: late frames and interpreter
marks supply no `by`, while retaining `item.callKey` as provenance. The existing
`server/email/external-marks.ts` stores that provenance; no duplicate module is
needed. An unseen ask remains an ask-only mark under the preserved V5 edits.

`server/nlmi-marks-r16-rows.test.ts` retains every supplied case and adds strict
heredoc, cost, control and independent-branch rows. `server/nlmi-marks-guards.test.ts`
checks all fourteen named mutations. Driver invocation:

```sh
python3 scripts/check-marks-mutations.py -- npx vitest run server/nlmi-marks-guards.test.ts
```

The script checks the baseline, changes one guard at a time, selects its named
test, requires failure, and restores the exact original file bytes in `finally`.
M-PR-1a has an embedded-device echo witness; M-PR-3a uses
`/tmp/../proc/../w/out`, which folds outside proc; M-PR-3b has no raw climb;
M-PR-6a uses a compiler that the generic branch excludes. Reason assertions also
ensure a different guard cannot silently substitute the wrong Doubt reason.

Verification status: only static inspection, `git diff --check`, and mutation
selector uniqueness were checked here. The brief prohibits running Node, npm,
Vitest or tsc; the driver must run the acceptance/control tests, mutation suite,
strict typecheck and isolated fixture verification from `docs/verification/README.md`.
No live app or user data was used. The neighbour verdict is `BASE-SAME`: the fifteen neighbour reds occur on clean
51bec1dfe, so the conditional FROM-V5 fix does not apply. Existing V5 edits were
preserved.
