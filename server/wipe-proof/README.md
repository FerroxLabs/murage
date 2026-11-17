# Wipe proof harness

Owners: wg-proof owns this harness and the scope documents; wg-shim owns POSIX
guard entrypoints; wg-pwsh owns PowerShell entrypoints; wg-callback owns the
guard/client/socket protocol; wg-wiring owns engine integration; wg-text and
wg-win own the text checker. Entry-point assumptions live in `adapter.mjs`.

Run from any directory with Node 24 or a Node runtime that supports the
repository's TypeScript imports. Bash/dash/zsh/fish and Python are discovered
on the test machine; unavailable tools are reported explicitly. The Windows
launcher requires Windows and tests each installed 5.1/7 engine. Linux cannot
qualify macOS, Git Bash or Windows. No dependency installation is needed for
the standalone guard harness. The real replay checker needs the repository's
normal runtime dependencies.

```sh
sh server/wipe-proof/posix/run.sh --stub   # validate the harness contract
sh server/wipe-proof/posix/run.sh          # validate merged guard + client
```

```powershell
.\server\wipe-proof\windows\run.ps1
# Before merge, an explicit lane artifact directory can be supplied:
.\server\wipe-proof\windows\run.ps1 -GuardDirectory C:\fixture\guard
```

Every case prints one PASS/FAIL line. A final JSON object contains case counts,
exit codes, callback/backend counts, missing tools and fast-path timing. Exit
1 means an assertion failed, exit 2 means invalid invocation. UNAVAILABLE is
an evidence gap, never a passing case. `productionQualified` stays false for
the contract stub or missing required tools. Even a green production harness
only qualifies those entrypoints on that machine: engine integration,
approval-fingerprint lifecycle and the owner's real logs need their own proof.

The harness creates its own fresh `wipe-proof-*` tree under the OS temp
directory, resolves that directory physically and refuses other roots. It
takes no user-supplied root or command payload. A new fake protected home is
populated for each fixed witness. The PATH overlay comes before both the
fixture backends and the inherited PATH, and the guard lists only that fake
home. All POSIX `realTools` are fixture programs; no production destructive
tool is used as a backend. The backend rejects paths outside the tree and
symlink traversal before mutation. Disk backends record a call and do no disk
work. Kills target only the exact owned child process group; temp cleanup
validates its root again. Keep redirected output outside the checkout.

The fixture app is a fresh Unix socket or Windows named pipe. It validates
the JSON-line request and can allow, deny, disconnect or reply with the wrong
id. It is never a user's running app. The stub client reads its token from
the guard file. POSIX denial exits 10 under the shim owner's published interface;
unreachable exits 126 under the refined design. These statuses are in the adapter.
Deny/unreachable tests require no backend call, the expected
refusal status and an unchanged protected tree. Allow and ordinary cases
check backend counts, exact stream/status preservation, and selected original
argv. Each case also hashes the fixture's outside directory and sentinel;
the whole sandbox outside the tree and harness-control directory must stay
identical. This is not a claim to observe unrelated writes by other processes
across the host filesystem. Fixture backends enforce the mutation boundary.

POSIX witnesses cover root/variable/glob paths, relative cwd, >=90% children,
long and nested lists, native shell loops, child shells, Bash nounset across
processes, noninherited functions, python3 `-uc`, fish `--command=`, and `su
--command=` when a noninteractive same-user probe succeeds. All witness paths
stay inside the fake tree, including the unset-variable case. Plain benign
deletes, spaces, printed source, dd/shred/wipefs file arguments and exact exit
and stream controls must pass without callbacks. Missing/malformed/off guard
states exercise the specified fail-open direction using fixture tools only.
Forty warmed alternating real/shim samples measure median added overhead,
with a strict <5 ms assertion and no callback. The fast backend is inert sh,
so Node startup does not dominate this measurement.

Windows exercises pipeline/work/location/wildcard removal, aliases, lists,
movement, ordinary deletion, allow/deny/unreachable and the fail directions.
Native filesystem mutators are removed before loading the guard. Compiled
fixture Remove-Item and Move-Item cmdlets provide the proxy metadata and enforce
a separate temp-tree boundary on every source and destination, including each
existing ancestor and every descendant of a directory being removed or moved.
Reparse points and non-filesystem providers are refused. The remaining Set-Item
function accepts only function-provider assignments for proxy installation.
Outside-target negatives call the captured backends directly, independent of
guard decisions. Every Windows case compares the entire expected fake tree,
including benign deletions and the exact child selected by a pipeline.
Compiled inert disk cmdlets supply metadata for the four storage proxies.
The harness asserts the implementing namespace and absence of native removal
and movement cmdlets before loading the guard; module autoloading stays off.
The disk cmdlets only record calls. `format` and
`diskpart` must resolve through the first PATH directory before invocation;
their `realTools` are recording `.cmd` backends. SystemRoot is then set to an
empty fixture directory, so a failed guard cannot fall back to real disk
executables. A deny must record a callback and zero backend calls; an allow
must record exactly one sentinel call. No actual storage cmdlet or disk tool
is a test target. PowerShell startup is excluded from the per-operation proxy
overhead measurement. These Windows assertions need a real Windows run;
compiling or reading them on Linux is not qualification.

Run the harness self-test through the assigned isolated runner, with output
redirected to the external job directory:

```sh
node server/wipe-proof/selftest.mjs
```

That test runs the POSIX contract stub, kills a deliberately bypassing stub
mutant, checks outside-root and symlink refusals, and exercises replay privacy,
positive/zero-new counts, the actual text adapter and private failure output.
It never claims that the production guard is implemented or wired.

Review regressions and rollback mutants run with:

```sh
WIPE_PROOF_PWSH=/path/to/pwsh node --test server/wipe-proof/regression.test.mjs
WIPE_PROOF_PWSH=/path/to/pwsh node server/wipe-proof/mutants.mjs
```

The PowerShell boundary tests can run on a portable PowerShell runtime on Linux.
They do not qualify Windows. Mutants run in disposable copies and all their
outside targets remain disposable temp fixtures. The POSIX production harness
also calls the published `wg_device` predicate with Linux/macOS disk spellings
and benign controls, without executing a disk tool or opening a device path.
It separately tests dd/shred/wipefs dispatch against the fake protected root.
This proves classification and dispatch separately; it does not perform device
I/O. The adapter installs guard-request.sh alongside the other two shim files.

Each captured process stream is bounded to 65,536 bytes. Overflow sets both
`overflow` and `error`, so case assertions fail explicitly; the summary records
the overflow flag. Diagnostic wording is inventoried in `DIAGNOSTICS.md`.

## Private command-log replay

Input is an external directory of UTF-8 files, one complete command per line.
It may contain subdirectories; symlinks and special files are refused. Empty
lines are ignored. Do not copy the owner's logs or context into the checkout.
Provide that engine's cwd, home, platform, dialect and environment in an
external `WipeContext` JSON file when they are known. Without context, this
is only a default-context measurement. Multiline commands must first be
represented as single command records by the log owner; this reader does not
join separate lines or guess their boundaries.

```sh
node server/wipe-proof/replay/replay.mjs /private/command-logs \
  --context /private/engine-context.json \
  --baseline-checker /private/baseline-checkout/server/wipe-breaker.ts \
  --require-zero-new
```

The candidate defaults to the current repository checker; `--checker FILE`
can select another complete checkout's `wipeBreaker` entrypoint. Baseline and
candidate receive exactly the same rows/context. Output contains only file,
command and card counts, rule counts, new-card counts and new-rule counts.
New means baseline RUN became candidate CARD, even if the candidate's other
cards changed rule. `--require-zero-new` requires a baseline and exits 1 when
any new card appears. Without a baseline, `newCards` is null: it cannot prove
zero new cards. Raw rows, paths, targets, context, exception details and
producer diagnostics never leave the replay worker. Replay is read-only and
does not execute commands. Keep its count report as external release evidence.
