# Wipe check review scope

Owners: wg-proof owns this review contract and the proof harness. wg-wincheck owns
the text host/process tables and PowerShell/cmd model as successor to wg-text
and wg-win.
wg-shim owns POSIX shims; wg-pwsh owns PowerShell proxies and Windows tool
shims; wg-callback owns guard files, client and callback; wg-wiring owns engine
environment, command rewriting and turn lifecycle integration. MAIN owns the
release decision and WIPE-GATE-BAR.

This is the written scope for acceptance bar item 6, under SEAN
1114-WIPE-HYBRID and WIPE-GATE-BAR. The refined hybrid design takes precedence
over its first draft; both designs' MAIN addenda bind. This is an accident
guard. It does not isolate a process from the filesystem.

**A finding gates only if it is a plain or common form inside this scope;
anything else is listed and fixed as found.** Record the latter in
[KNOWN-DISGUISES.md](KNOWN-DISGUISES.md), with its example and missing layer.
A known limitation does not excuse a missed plain literal wipe covered below.
Release qualification follows SEAN 1114-WIPE-GATE-FOUR and its WINDOWS
addendum: PowerShell exec interception and non-Claude guard reach are bonus
items. This scope adds no release gates beyond that ruling.
Ordinary work must run without a wipe card. Printed examples, commit messages,
ordinary file edits and deletion of a build directory are ordinary work.

## Text layer

Before execution, inspect literal protected targets and variables whose values
are set in the same command text or supplied in that engine's environment.
Do not borrow the server process environment or earlier conversation text.
Protected targets include filesystem and drive roots, homes and their parent,
OS directories, app data, registered project roots and actual mounted roots,
including removal of a whole root's contents and destructive disk operations.
Initialize-Disk is ordinary initialization under MAIN 23:15Z(b), not destructive
disk erasure; Remove-Partition is destructive.
The existing root classifier defines identity and protected-root membership;
this document does not introduce another lexical root list.

The promise includes ordinary quoting, flags, relative paths with known cwd,
literal absolute tool paths, shell lists, ordinary wrappers, inline command
strings, and the supported shell's variable spelling. Process boundaries must
not pretend a child's nounset flags, unexported values or functions are inherited.
At a loop, expansion, list or recursion limit, retain uncertainty instead of
silently dropping a possible protected value. Unknown is not proof of safety
and is not by itself a catastrophic target: card known plain catastrophic
effects; let the exec layer inspect actual supported calls. Do not add shell
prediction features to chase disguised spellings.

The fixed host/wrapper table covers these families and the option forms they
normally use. Tests are independently written, not generated from that table.

| Family | Promised reading |
| --- | --- |
| sh, bash/rbash, zsh, dash, ksh/mksh/oksh, ash/busybox sh, yash, posh | Command string, short bundles and attached values, known value options, zsh long options and bash startup options |
| fish, csh/tcsh | Command/init strings including `--command=`, ordinary bundles; noexec forms remain nonexecuting |
| su/runuser, sudo, doas, run0, pkexec | Program or shell command; `-c`, `--command=`, session command, shell choice, user before or after command; sudo shell/login forms |
| env, nice, ionice, timeout, chrt, taskset, stdbuf, nohup, setsid, time, command, builtin, exec | Program and ordinary options; env split-string, cwd and unset values |
| flock, watch, script, man/ag/rg/sort command options | Declared command-carrying values or joined command text |
| xargs, find -exec | Declared program/payload and existing input splitting |
| python/py/pythonN, perl, ruby, node/nodejs/bun, deno eval, php | Literal inline code; bundles such as `python3 -uc`, `perl -we`, `node -pe`; declared value options |
| powershell 5.1, pwsh 7 | Unique case-insensitive `-Command` prefixes such as `-comm`, command-with-args, value/file options; 5.1 positional command versus 7 positional file |
| cmd | `/c` and `/k`, attached or separate, ordinary outer quotes; built-in `del rd rmdir erase move` with literal targets or resolved `%USERPROFILE%`, `%HOMEDRIVE%`, `%SystemDrive%` |
| PowerShell Invoke-Expression / Start-Process | Literal command strings and declared arguments |

GNU long values use `=` or the next word; unique prefixes and short bundles
follow the host table. An unknown or ambiguous host option does not hide later
literal catastrophic source words: inspect those words once in the host's
language (and code for interpreters). Otherwise run. Recognized noexec/help
forms do not execute their source. EncodedCommand can be recognized as a host
option, but decoding arbitrary payloads is listed, not a gating promise.
The generic embedded-text rule rereads string arguments outside the small
inert-data table (for example echo, printf, grep and commit messages); it cards
only a plain catastrophic form. That is not a promise to model every program.

On Windows the text model includes resolved PowerShell pipeline producers,
ordinary pass-through stages, default/explicit paths and relative wildcard
bases for recursive removal or movement. Narrowing to a first child does not
mean the entire source root. It also covers child PowerShell where proxies
are absent. Literal direct interpreter deletion, `find -delete`, `rsync
--delete`, `git clean`, device redirection, module-qualified removal and known
.NET deletion remain text checks; expansion-dependent variants are listed.

## Exec-time layer

On macOS, Linux and Git Bash, prepend shims for `rm rmdir mv dd shred wipefs
mkfs mkfs.* diskutil`. They see the real argv after expansion, including
variables, globs, loops, lists and child shells that preserve PATH. Match the
protected root itself, all or nearly all its direct children, device targets
for disk-writing tools, and mkfs or diskutil erase. Count distinct direct
children, including dot children; mv checks sources. Ordinary nonrecursive
file removal is not a recursive wipe. The shim owner defines the shared
nearly-all threshold and its tests; do not substitute a proof-only threshold.

On Windows, dot-source the guard into the top-level PowerShell command even
with `-NoProfile`. Standard steppable proxies cover `Remove-Item`, `Move-Item`,
`Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition` and aliases
`ri rm rmdir del erase rd mi mv move`. PowerShell resolves bound paths,
pipeline sources and relative wildcards. Buffer the pipeline before a denied
operation so it cannot delete part of a root first. Storage cmdlets exist only
where the OS supplies them. PATH shims for `format` and `diskpart` always ask;
they must intercept before a real disk tool is started. Child PowerShell,
module-qualified cmdlets and .NET methods do not inherit these proxies.

| Engine | macOS / Linux | Windows Git Bash | Windows PowerShell / cmd |
| --- | --- | --- | --- |
| Claude | Owned non-login exec wrapper guarantees PATH tool interception when the active turn guard is installed; startup files must not undo it | Same wrapper with path conversion | Top-level PowerShell proxies only after rewrite is proved; otherwise text only. cmd built-ins are text only |
| Codex | Engine PATH is set; guard is best effort until actual chosen shell preserves it | Same qualification | Proxies only in a command explicitly prefixed with the guard; otherwise text plus external PATH shims |
| ACP engines (including Fuigo, Gemini, OpenCode, Cursor) | Same best-effort engine PATH | Same qualification | Same conditional proxy reach; cmd built-ins are text only |
| Antigravity / Muse | Same best-effort engine PATH | Same qualification | Same conditional proxy reach |
| Pi | Text gate exists; environment/exec reach must be proved before claiming guard coverage | Unverified until wiring proof | Unverified until wiring proof; text remains |

The table is a scope promise, not evidence that wiring has shipped. wg-wiring
must publish per-engine resolution and rewrite proof. Do not promote a PATH
test into proof of an engine workflow. Profiles that reorder PATH, explicit
tool paths, privilege changes and remote execution can bypass local shims.

## Callback and failures

wg-callback writes a private mode-0600 per-turn JSON guard, named by
`MURAGE_WIPE_GUARD`: `v`, `socket`, `threadId`, `token`, `roots`, `client`
(absolute interpreter and script), `realTools`, `off`. Requests are one JSON
line with `v:1`, `kind:"wipe-exec"`, `id`, `token`, `threadId`, `tool`, `argv`
(excluding the tool), `cwd`, `targets`; reply is `{id,decision:"allow"|"deny"}`.
The shim omits the token in client argv; the client reads it from the file.
Client invocation is `client + ["wipe-exec", requestJson]`: 0 allows, 10 denies,
other status means unreachable. The app independently re-decides actual argv;
client-provided targets do not authorize anything.

Text-check faults card. Missing guard or an internal shim/proxy fault runs
the real tool. `off:true` or `MURAGE_WIPE_GUARD_OFF=1` disables interception.
A positive match with an unreachable app refuses; POSIX and external Windows
shims exit 126 with a plain message. PowerShell refusal is a terminating error
with `LASTEXITCODE=126` (an uncaught error normally makes its process exit 1).
Connect has a 3-second bound and two retries; after connection, wait for the
owner without an approval deadline. Stop/end revokes pending work. Approval
records a matching target fingerprint for one use, for ten minutes, including
retry after a killed waiter and avoiding a second card after text approval.
Ordinary fast-path calls do not contact the app; added overhead is under 5 ms,
with the real tool's argv, exit code, stdout and stderr preserved on allow.

## Acceptance evidence

Keep corpus CARD 957/957 and RUN 681/681, every review-1/review-2 witness by
either layer, the independent host/process/PowerShell/bounds matrices, real
shell proof on macOS/Linux/Git Bash and Windows PowerShell 5.1/7, and owner's
real-log replay with zero new cards. Then perform one bounded scope review.
Missing platforms and real logs remain open evidence; a stub run proves only
the harness. Listed forms stay visible and are fixed as found without
moving this review boundary.
