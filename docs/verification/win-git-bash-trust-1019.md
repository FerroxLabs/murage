# WIN-GIT-BASH-TRUST-1019 — W0 builder packet

Status: **OPEN — W0 preparation only; no production trust implementation or Windows qualification.**
Base: `c12aaad9341e8f87126a193f35b5c2768f0aa66f`.
Lane: `dev/1019-bld-gitbash`.

The authoritative inputs are preserved byte-for-byte in
[DESIGN-r2.md](win-git-bash-trust-1019/DESIGN-r2.md),
[Astra r2](win-git-bash-trust-1019/astra-r2.txt) and
[Astra r1](win-git-bash-trust-1019/astra-r1.txt).
The current builder request authorizes execution; the design's descriptions of its
previous read-only authoring session do not prohibit this builder from running tests.
Astra r2 agrees subject to seven amendments. The following contract incorporates all
seven as requirements. It does **not** claim their implementation or qualification.
No scope, engine, matrix cell, native control, policy invariant or wave is waived.

## Amendment attachment

### A1 — separately prepared nested and direct-script reservations

An invocation contains an ordered reservation graph, not an outer-shell trust bit.
Each reservation has the design's private engine/call/revision/epoch fields plus
`reservationId`, `parentReservationId`, `parentProcessIdentity`, `ordinal`,
`occurrence`, `expectedImageIdentity`, `expectedArgv`, `expectedCwdIdentity`,
`expectedEnvironmentDigest`, `processRole`, and single-use state. Parent identity
includes PID **and creation time**, backed by the supervisor's held process handle.
Before scanning, a not-yet-created parent is bound to its own reservation; actual
parent identity is resolved and checked at its initial process event before any
child reservation may be consumed. Parentless/ambiguous mappings receive no relief.

Claude outer shell, native prefix inner shell, nested `bash hello.sh`, and routed
`./hello.sh` are distinct reservations. Prepare the complete statically proven
occurrence graph before the first scan. Original occurrence identity includes the
source digest, dialect, tree path, byte interval and operand role. An ordinary
command child cannot consume a Bash reservation, and the next expected sibling
ordinal cannot be skipped, replayed or stolen by another process. Loops, branches
and dynamic resolution without a bounded exact plan receive no exception.

The 192 matrix definitions record expected nested/direct byte intervals. They
must run through Claude, Pi and Fuigo (576 engine/cell combinations), preserving
Write-vs-printf provenance. A direct sh shebang obtains Bash identity relief only
when the enforced route actually executes the selected Bash; `sh.exe` itself is
never exempt. The fixture's expected interval is test data, not parser output or
an authorization record. A runtime parser must independently derive it.

### A2 — process roles and separate image inventories

`protected-bash` is the selected entry and its registered runtime transition.
Only this role uses the eight-member Git inventory plus the qualified OS-image
policy. A protected runtime member is not an additional scanner-exempt pathname.

`authenticated-prefix` is `murage-exec-win.exe`. Package its own authenticated
inventory (prefix image and complete non-OS dependency closure), bound to the
Murage package receipt, independent of the Git inventory. Missing prefix receipt,
wrong dependency, changed source/configuration or incorrect parent refuses relief.
Do not invent prefix digests before a real build exists.

`ordinary-child` includes Git, Node, MCP and other approved tools. Existing scanner
and approval rules govern its executable admission; the Git-member image allowlist
must not be applied to its ordinary DLL loads. It still belongs to the job, debug
relationship, descendant budget and drain accounting. It neither inherits a Bash
exception nor consumes a protected reservation. A Bash descendant can enter the
protected role only through its own previously prepared reservation. Unknown roles
cannot continue as a protected process. Record and test role transitions explicitly.

### A3 — neutral startup values

Retain Claude's existing `BASH_ENV=/dev/null` and `ENV=""` pins. Literal absence is
not required for those two values. Qualification must prove that `/dev/null` maps
to the effective MSYS null device under the frozen startup-input snapshot, and
that the empty ENV has no executable startup effect. Do not grant this rule from
string comparison alone or strip the owner's settings to obtain it. Every other
startup/environment input retains the design's exact-rule or refusal requirement.
Include spoofed null mapping and changed mount configuration negatives.

### A4 — consumed startup inputs, including absence

At prepare, capture a bounded immutable snapshot of every startup input listed
in section 6.4. Hold present files by identity and freeze bytes, not only names.
For each absent input, record its containing directory identity and exact name.
A qualifying native implementation must enforce that same absence through the
last possible consumption, or mediate **every** relevant read to return the
frozen snapshot, including absence. Watching and subsequently revoking is not
sufficient. Do not publish PREPARED merely because no notification has arrived.

Required adversarial cases: create after prepare but before commit; create after
commit before startup read; replace present configuration during startup; change
a parent component; delayed runtime reads; and a filesystem call that cannot be
mediated. No new or substituted bytes may be consumed before rejection. There is
currently no implemented/qualified mechanism for this contract in the lane.
Choosing and proving that mechanism remains W1B engineering work, with the
standard-user requirement intact. The packet cannot treat directory notifications
or ACL assumptions as that proof.

### A5 — structured original-byte occurrence enumeration

Use the structured dialect reader and attach original UTF-8 byte intervals and
wrapper roles to its nodes. Do not derive identity from `runnerResolves`' NFKC
normalization or its superset of wrapper operands. The enumerator must distinguish
command, wrapper target, finder target, redirection, script operand and ordinary
argument. Offsets refer to the original unnormalized command revision, including
quotes, Unicode and CRLF. An expansion/alias/function with no provable executable
role cannot obtain a reservation. No text regexp may authorize an occurrence.

`env printf bash`, `find . -exec printf bash \;`, and `printf bash` have zero Bash
command occurrences. `env bash hello.sh` and `find . -exec bash hello.sh \;` each
have one. The Unicode fixture distinguishes character indexes from byte offsets.
These expected results do not require removing other existing independent findings.
The new Windows tightening occurs before missing-cwd/probe/lookup exits, solely
for actual Bash occurrences, as section 5 requires.

### A6 — target-specific argv serialization

Freeze a vector of Unicode arguments and a serializer identity with each native
launch. Set the explicit application name. Select the serializer for GFW-BIN,
GFW-USR, or the native prefix independently; do not assume all targets use the
same Windows command-line parser. Never concatenate a shell command from argv,
normalize the `-c` payload or shell-escape it a second time.

The round-trip corpus includes empty arguments, embedded quotes, trailing
backslashes, paths with spaces, Unicode and the exact Bash `-c` payload. Each
actual target must report precisely the frozen vector; bin-to-usr forwarding is a
separate round trip. The packet deliberately supplies no purported expected
command-line string or native success receipt before target behavior is measured.
A failing target/parser mapping cannot be enabled on a positive route.

### A7 — supervisor physical ownership and disconnect/drain

The separate process **`murage-bash-supervisor.exe`**, built from
`native/engine-exclusion/bash-launch.c`, is the sole physical owner of lease
files/directories/sections, jobs, process/thread handles and debug events.
`scripts/build-engine-exclusion.mjs` must build/package it and
`murage-exec-win.exe` with the addon. Packaging/resource tests must require matching
architecture and protocol/ABI receipts for all three resources.

Addon objects are opaque logical proxies containing supervisor epoch and operation
identity, never transferable HANDLEs. An authenticated inherited private channel
binds the server and engine peers to held process identities. Control frames carry
protocol, epoch, bounded sequence, operation ID and payload length. Replays, wrong
peer, oversized input and disconnect revoke admission immediately. A disconnect
enters DRAINING, cancels/join workers, terminates dependent jobs and consumes native
exit/debug events until zero dependents. Only then may the supervisor release the
physical protection and acknowledge RELEASED. The addon cannot make a slot reusable
before this acknowledgment. Late epoch messages cannot resurrect or release a new
operation. Supervisor death must terminate dependents without an unprotected run
interval; this is an explicit crash-test obligation, not a JS-finally guarantee.
All resource caps and restart overlap in section 7 remain unchanged.

## Fixture and evidence custody

`server/testing/fixtures/win-git-bash-trust/` holds **synthetic definitions**:

- Four requested family files: Claude plain/cd, Fuigo PowerShell and Codex control.
- `same-turn-matrix.json`: all 192 cells, unnormalized commands/body bytes,
  SHA-256 digests, Write inputs and expected nested/direct-script byte intervals.
- `occurrence-controls.json`: wrapper operand controls and Unicode offset control.
- `argv-roundtrip.json`: data for three real target parser round trips.
- `reference.json`: the eight digests copied from Q-A1; this builder has not
  downloaded/reproduced the package or executed any of those Windows binaries.

Every runtime evidence cell is null. Do not turn a null into a pass because a unit
test accepts the fixture. None is an original LEGS transcript. Historical names
`gwin wsb\\l9nl12-fu1`, `gwin wsb\\l9nl13-cx` and LEGS10 hello.sh remain requested
captures. The supplied evidence directory contains a LEGS handoff and ledger, not
raw transcripts located by this builder. Exact replay remains unproven. Equivalent
real-engine captures require the reviewers' explicit disposition under section 2.4.

A Linux scanner-only measurement is recorded separately under
`win-git-bash-trust-1019/scanner-baseline.json`, with its exact recorder alongside.
It injects probe results and does not prove Windows path mapping, native identity,
script-body visitation, final policy, card count or actual engine execution. GB01,
GB11 and GB17 **real Windows baselines remain UNMEASURED**, not RED or GREEN.

The fixture test was run before adding fixture data: 8 failures (missing files).
After adding data, 8/8 pass. This is W0 packet RED/GREEN only, not missing verifier
behavior or native feature RED. Neighboring scanner/WIN-PWSH/wire tests and the
release workflow test also pass (238 tests in six files). No baseline guard was
relabelled a new feature failure. Test logs and exit codes are retained in the
builder lane's `evidence/`; exact commands/hashes are in the receipt attachment.

## Dependency and source inspection

| Input | Status on the supplied base |
| --- | --- |
| NL-ST4 `8bddd0b22c077847185c081309883c82d23adfa2` | Object exists, not an ancestor; no port performed. |
| No limits `0765e00d3a5846f0d162793c4b7fe9b13bd01267` | Object exists, not an ancestor; no port performed. |
| argv `5de94ab23e4e2d124e9fd38492246a773884f5d1` | Rejected as drop-in by r2; retain conservative section 5 behavior. |
| Fuigo candidate | `/root/fuigo-builds/u42/src`, clean at `413f407d6afe85ba8fb7f411af5006f6240577b2`; read-only inspection only. |

The Fuigo candidate is a Rust workspace. The shell crate is
`crates/codegen/fuigo-shell`, not a repository-root `fuigo-shell` directory.
Actual ACP initialization is in
`crates/codegen/fuigo-shell/src/agent/mvp_agent/acp_agent.rs::initialize`;
launch-policy state is in `agent/mvp_agent/mod.rs` and session handling in
`agent/mvp_agent/session_setup.rs`. Existing policy implementation is in
`crates/codegen/fuigo-workspace/src/permission/launch_policy.rs`.
This locates integration seams, not a completed dispatch audit or protocol diff.
No Fuigo source was modified, no version pin was changed, and no 1.0.42 capability
or artifact receipt was invented. Exact source integration and build custody
remain required before W1C can close.

The available SSH configuration names only the six Linux vt runners. The adjacent
Windows repair lane explicitly describes Windows execution as unavailable here.
No isolated Windows qualification endpoint was supplied with this lane. The builder
requested its location while continuing independent W0 work. Existing global
Windows failure JSON is not a substitute for this feature's actual engine baseline.

## Open wave gates — full scope retained

W0 cannot close until real GB01/11/17 base runs, historical/equivalent disposition,
combined dependency-port receipts and the complete required review packet exist.
Astra's supplied amended agreement is preserved; no Fable receipt has been supplied
or fabricated. The blocking runtime input is an isolated standard-user Windows x64
runner with the specified engine versions, Git layouts and package custody.

W1A then needs the strict production manifest, private registry and bounded lease
coordinator with GB03–06/08/14 RED/GREEN. W1B needs actual Windows GB05–08/14/19/20,
including mapped writers, startup consumption and role-separated image enforcement.
W1C needs real Claude/Pi/Fuigo execution binding and a built authenticated Fuigo
protocol artifact, GB08/16/21/23. W2 needs exhaustive scanner and reader integration,
GB01/02/09–13 and source-order tests. W3 needs GB15–18/22, all packaged workflow
positives, Codex control, original/equivalent replay, final code reads and evidence.
The complete GB01–23 specification is in the preserved design. These are unfinished
requirements in this task, not deferred release scope or an accepted disabled feature.

Sean-only decisions: **none**. No product scope/policy change is requested. Explicit
owner denies, wipes and `murage-engine-hooks`, origin rules, Advanced settings and
existing unsupported-shell behavior all remain mandatory invariants.
