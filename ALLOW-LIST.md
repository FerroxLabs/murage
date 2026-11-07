# MARKS allow-list

The executable lists live in `server/shell/walk.ts` (`MARKS_COMMANDS`,
`PURE_READERS`, `SHELLS`, `INTERPRETERS`, wrapper and operand tables), with
response-file lists and fixed `DoubtReason` values in `server/shell/marks.ts`.
Unknown command names hold. Listed commands still pass the operand,
redirect, loader, protected-path, and destructive-command checks. Unseen scripts
hold at every level. Session-edited scripts must supply readable, bounded bytes
and are scanned as written code.

The name list is only the first gate. `checkCommandOptions` supplies a second,
closed command and option model. A command without that model holds, including
git, compilers, package/build tools, archives, remote clients, containers and find.
Their names alone cannot prove their programs, configuration or writes safe.
Shell constructs, interpreters and sed have separate parsers.
Executable options (`less +`, sort/tar compressors, rsync remote shells and git
pager/editor/ssh overrides) hold. Compiler response files, other non-reader
`@file` arguments, xargs argument files and tar/rsync file lists hold separately.
The compiler and generic response-file sets are disjoint. Git overrides hold
regardless of key case or alias spelling because git has no admitted model.
Unmodeled options hold in attached, combined, long and separate forms.

Paths pass `canonPath` before write-position matching, including relative write
operands and target-directory options. Existing filesystem components are resolved
before parent components are consumed. Case folding applies to the complete
resolved path on Windows/macOS and to drive paths. Unplaceable relative
paths and control characters hold. Windows drive names are case-folded even when
tests run on POSIX. Proc traversal is checked before folding; canonical `/proc`
is checked independently afterwards. Device streams retain `DEVICE_STREAMS`;
other devices, system trees, drive roots and home roots are protected. Ordinary
project and temporary file targets remain allowed. Read positions add no write
rule: `cat /proc/self/status` remains a control. Existing symlink parents are
resolved; dangling links, permission failures and other uncertain resolutions hold.
Missing leaf components retain their resolved parent. Protected trees include
descendants, including home descendants. `dd` is **not** a name-only disk erase command;
its `of=` tail is canonicalized in write position and holds only on a protected
or device result (or when canonicalization cannot complete).

Inline and same-text/session-written interpreter bodies share `opaqueParts` and
`scanWritten`. A whole-body closed grammar admits Python literal `print`, literal
string `.format` inside `print` with only the fixed `{}` substitution and scalar
arguments, and literal `open(...).write(...)` within the canonical cwd; JS/TS runner
`console.log`, Ruby `puts`, Perl `print`, PHP `echo`, and Lua `print` admit the
listed literal forms. Unclassified bodies return `incomplete`, which holds with
`Doubt(tokenizer)`. Literal path checks run first in write position. Runtime path
assembly, imports, arbitrary calls, interpolation and escaped/adjacent literals
are not admitted by this grammar. Dollar, at-sign, backtick and Ruby interpolation
markers hold even within quotes. Shell interpreter strings and written shell
scripts use the same marker guard. Python format attribute/index fields hold.
The fixed scalar format-print control performs no field lookup or evaluation.

Sed consumes every expression, including repeated, long and combined short
options. File programs must supply readable bounded text through the file hook
or same-text provenance. Only numeric print programs are modeled. Write, read,
execute, substitution and in-place programs hold with `Doubt(tokenizer)`.
Awk variants have no approved grammar and hold. Perl in-place and print-loop
options hold; Perl code otherwise passes the shared closed grammar.

| Cost/control | Result |
| --- | --- |
| osascript `-e`, rscript `-e`, tclsh stdin one-liners | Hold: no approved grammar |
| Other interpreter programs outside the small grammar | Hold, including benign imports/computation |
| sed programs beyond numeric `p` ranges, unknown options or unreadable files | Hold |
| Unknown command names or incomplete syntax | Hold |
| Embedded dotted device text, even printed by echo | Hold under the device-word rule |
| cat proc status, project dd, sort output, sed `-n 1,5p` | Retained controls |
| Python format-print and project literal open/write | Retained on clean contexts and Full access; S1 marked No limits holds |
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

The original eleven controls deliberately supply `outsideRead: null`: they test
the always-ask belt on a clean context. They do not prove S1 admission. New S1
rows use `outsideScanMarks` and pass its interpreter mark into `outsideRead`.
The safe interpreter controls hold on marked No limits and remain admitted on
Full access. This retains S1's interpreter policy without claiming a clean
context exercises marking. Project `dd if=proj of=proj` remains a clean control.

`server/nlmi-marks-r16-rows.test.ts` retains every supplied case and adds strict
heredoc, cost, control and independent-branch rows. `server/nlmi-marks-guards.test.ts`
checks the original and added named mutations. Driver invocation:

```sh
python3 scripts/check-marks-mutations.py -- npx vitest run server/nlmi-marks-guards.test.ts
```

The script checks the baseline, changes one guard at a time, selects its named
test, requires a JSON assertion result naming that test with a failed assertion,
and restores the exact original file bytes in `finally`. Missing reports, zero
selected tests, compilation failures and other infrastructure errors do not count
as kills. Added selectors cover sed programs/options, interpreter markers,
relative targets, unknown cwd, complete case folding and symlink parents.
M-PR-1a has an embedded-device echo witness; M-PR-3a uses
`/tmp/../proc/../w/out`, which folds outside proc; M-PR-3b has no raw climb;
M-PR-6a uses a compiler that the generic branch excludes. Reason assertions also
ensure a different guard cannot silently substitute the wrong Doubt reason.

Verification status for this revision: static inspection and `git diff --check`
only. Baseline reds, mutation kills and selector uniqueness were not executed.
The brief prohibits running scripts, Node, npm,
Vitest or tsc; the driver must run the acceptance/control tests, mutation suite,
strict typecheck and isolated fixture verification from `docs/verification/README.md`.
No live app or user data was used. Historical baseline claims above refer to
earlier revisions, not a test run for FIX2.

## FIX2 default-deny decisions

The waivable hit list is empty. Neither `couldNotRead`, a clean lane, Full access,
nor an admitted unseen-file shape proves execution safe. `marksHitWaivable`
returns false for every hit. Shape rejections and named unseen reasons no longer
gain `couldNotRead`. This includes device, dot-dot, relayed, `/etc` and `/proc`.
The ordinary read-only proc control does not produce a rejection to waive.

G1 checks path command words before wrapper removal and before function lookup.
Only available current/session bytes can be walked as a path executable. A copied
file whose bytes are unavailable holds too. Siblings cover path-qualified env,
command wrappers, and copied executables.

G2 uses `writtenKey` for both insertion and execution lookup: cwd anchoring,
component resolution, normalization, platform case folding and hard-link identity.
Paths through links created by this same text hold because the disk cannot prove
their new parent resolution yet. Current writes take precedence over older session bytes.
Noncanonical matching session keys hold rather than selecting an older snapshot.
Sed cannot fall back to session bytes after a current unknown write. Rows cover
dot segments, repeated slashes, parent segments, drive case and symlink parents.

G3/R1 keep the existing whole-program sed parser. Every expression is checked;
file and expression options consume attached, separate and combined spellings.
Unknown flags, in-place flags and unread programs hold. Awk variants still hold
without a grammar; Perl/Ruby/Python share the existing closed literal scan.
R3 adds a project-placement check for Python literal writes outside the cwd.
The cwd is the only project root proven by the walker, so sibling-root writes
also ask. Safe `/w/out.txt` controls with cwd `/w` remain in the suite.

G4/R4 retain component-by-component resolution before parent traversal, tilde
expansion, and write checks. `protectedClass` now includes protected descendants.
Unmodeled archive, container, find and remote write grammars hold altogether.
The symlink attack uses an isolated temporary fixture equivalent to
`cp ./blob /tmp/escape/pwn`, with `escape` pointing to `/etc/cron.d`.

G5/R2/R3 retain the closed interpreter grammar and add direct, session and
heredoc regressions. G7 removes all reader-hit waivers, including unseen-script
mode coverage. R5 environment assignments admit only the listed locale/display
names; executable, startup and config variables hold. R6 has a closed option
table; R7 holds find and checks xargs file options at every wrapper depth.

Regression rows are named `FIX2 attack`, `FIX2 attack sibling`, `FIX2 G3`,
`G1 path command`, `G2 stale session`, `G4 sibling`, `G5 sibling`, and
`M-FIX2-*`. All 41 report hits are represented, with gawk/nawk, clang/scp and
other explicit sibling commands kept separately. Existing controls are retained.
Not all rows can be red on e4754381b: that HEAD already closed the Astra classes.
No baseline-red or mutation-kill result is claimed without the driver's run.

The new mutation entries select assertion witnesses for canonical keys, current
bytes, stale sessions, sed shadowing, wrapper paths, copied files, Python roots,
option models/values, dd operands, environment names, protected descendants and
waivers. The driver still counts only a failed assertion, not a compiler error.
The full baseline deliberately includes the pending G6 rows below, so apply the
handoff patch in the driver's isolated checkout before running mutation checks.
Memory prelude was unavailable: no matching tool or `.ijfw/memory` directory
was present. No script, typecheck, test or fixture was executed in this task.

## FIX3 raw writes and data

Raw candidate paths survive until the write checks. Parent steps cannot erase
protected roots, and protected classes check raw and normalized spellings.
Data candidates do not probe the filesystem. Print data is not a write target;
redirects and copy destinations still use canonical paths and fail closed on
errors, including ENAMETOOLONG. No deny rule or existing row was changed.
The M-FIX3 rows cover climbs, padded writes, long data and protected redirects.
Mutation witnesses cover candidate resolution, parent steps, protected classes,
destination recording and print data. Kills still require assertion failures.
The 131072 limit applies to the whole command: a word of that length is tested
as candidate data, but adding printf syntax must still card at the command gate.
Tests, mutation checks, strict typechecking and isolated fixture verification
were not run because this task prohibits scripts. Results await the driver.

## FIX2 item 6 for outside-scan.ts

Apply this exact patch in the owning lane. Join the original text so case-sensitive
root options retain their spelling, then look up runner names. The pending
`M-FIX2-runner needs item 6 patch` rows cover lerna, nx and CRLF turbo.

```diff
--- a/server/outside-scan.ts
+++ b/server/outside-scan.ts
@@ -1086,4 +1086,4 @@
 function packageRunMarks(raw: string, text: string, hooks: OutsideScanHooks, at: Probe | undefined): boolean {
   // Workspace runners select roots even without an npm/pnpm/yarn/cargo word.
-  if (rootMoves(text)) return true;
+  if (rootMoves(text.replace(/\\\r?\n/g, ""))) return true; // M-FIX2-runner
   const segments = listBMemo(raw);
```

After applying it, register the mutation below in the owning checkout. Reverting
the join must fail the named runner assertions; it must not count a compile error.

```python
"M-FIX2-runner": ("server/outside-scan.ts",
    'rootMoves(text.replace(/\\\\\\r?\\n/g, ""))', 'rootMoves(text)'),
```
