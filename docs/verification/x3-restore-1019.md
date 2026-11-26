# X3 restoration on 1.0.19

Restoration owner: x3-restore. Integration and security rulings owner: MAIN.
Source: reviewed `a6f88169299d8f1d24565cc66c44b8216a18624e`.
Comparison base: `bd72463db3d28f71b12f60d4647068facd5e9403`.

The restoration reapplies the X3 file delta from its original RC port to the
reviewed correction, preserving subsequent train changes. No integration branch
is merged: the explicit restoration brief overrides the generic host merge rule.
The November 12 wipe-only reconciliation remains authoritative. The train's newer
wipe checker, current origin authentication and release authority are retained.

## Conflicts

There were 117 conflicting hunks in 12 files. Hunk numbers below follow the
three-way apply, in file order. Every conflict is accounted for here. Retaining
the train means retaining later work that superseded the older source; X3
additions outside those hunks remain applied.

| File | Hunks | Resolution |
| --- | --- | --- |
| `ci/gate-tests.txt` | 1–13 | Keep the complete train inventory and its newer OS classifications/descriptions; append every missing restored X3 test row. No train row is removed. |
| `server/auto-approve.ts` | 1–2, 4–5, 7–9 | Keep the current wipe imports/context, parser, command-read bounds, failure context, routine origin and origin finalizer. |
| `server/auto-approve.ts` | 3, 6 | Add X3 context fields beside wipe identity and prepare protected-mode cwd state beside the current effective No limits decision. |
| `server/drivers/acp/core.ts` | 1–3 | Keep tracked child teardown, the process folder-trust reply and guarded startup replacement. Add only X3 driver/version facts outside these conflicts. |
| `server/drivers/claude.test.ts` | 1 | Preserve all credential and I/O proxy environment assertions; require their nonce-bound KEEP marker. |
| `server/drivers/claude.ts` | 1–3 | Keep permission-output accounting and the existing boolean No limits API; add X3 value-free settings diagnostics. |
| `server/drivers/claude.ts` | 4 | Select the wrapper using the effective launch level. |
| `server/drivers/claude.ts` | 5 | Keep wipe-guard setup and filter every reserved X3 name from the command map. |
| `server/drivers/claude.ts` | 6 | Keep the current live permission lookup for the overlay. |
| `server/drivers/claude.ts` | 7 | Retain credential relay, metered MCP proxying and Cloud rendering; add the launch nonce to MCP shell stanzas. |
| `server/drivers/claude.ts` | 8–10 | Keep incoming-request admission, release binding and the current wipe-aware Bash relay. |
| `server/drivers/murage-exec` | 1–2 | Keep wipe guard/PATH parsing beside X3 PROVEN and unreadable-map validation. |
| `server/drivers/murage-exec` | 3–5 | Keep Windows guard-path conversion, guarded PATH reset, positional arguments, child writer reaping and zsh handling. Execute X3's checked, snapshot-stripped command and retain Bash's no-rc invocation. |
| `server/drivers/murage-exec.ts` | 1–2 | Keep counted writes and wipe-shim installation; add bounded diagnostics and atomically install the level-bound wrapper together with its shape list. |
| `server/drivers/pi-permission-gate.ts` | 1–5 | Keep the approved native wipe checker, persisted mode/context inventory, reload state and fail-closed refusal. Restore X3 credential rows without the obsolete visible-wipe fallback. |
| `server/index.ts` | 1–2, 4–16, 18–25, 27–36, 42, 44–65 | Keep the train's imports, private persistence/credential wiring, origin and routine authority, approval builder, denial lifecycle, memory admission, teardown receipts and route responses. |
| `server/index.ts` | 3, 17 | Add X3 proof imports and prepared shell facts beside the existing command/wipe context. |
| `server/index.ts` | 26 | Prepare on the original execution event, then carry its result into the current mutable speaker projection; retain memory capture, settlement and execution leases. |
| `server/index.ts` | 37–39 | Track launch/acceptance/cancellation around the current spend and project dispatch paths; retain their fences, shared-owner binding and ledger. |
| `server/index.ts` | 40–41, 43 | Bind proposal acceptance and retire reset/stopped shell records while keeping exact-turn proposal ownership and confirmed teardown checks. |
| `server/nolimits-means-it.test.ts` | 1–2 | Keep the current literal wipe and invalid-shell oracles; append the reviewed X3 coverage assertions. |
| `server/nolimits-node-109.test.ts` | 1 | Keep the current other-person authentication assertion and both original bracket fixtures; add the reviewed key-file glob fixtures alongside them. |
| `server/testing/murage-env.mjs` | 1 | Preserve all current fixture control names and allow the X3 replay input control. |

## Fixture and mutant reconciliation

The restored API fixture uses the existing fake engine's MCP-ready/list protocol
and the existing native memory meter fixture. Its root listing remains backed by
real temporary files; commands are inert. Synchronous reads of those real fixture
files keep worker-pool scheduling out of the unchanged 50 ms product deadline.
Full access explicitly disables the newer No limits default. Card detection and
Deny delivery use the current opaque display handles. Full access cards, delivered Deny,
No limits twins and executable wipe controls retain their assertions.

Diagnostic tests reset the setup module cache before installing their filesystem
spies and require the bounded read to be observed. The literal-render mutant
targets the renderer after the newly added bounded pre-scan.

The mutation runner writes only to an explicitly supplied directory outside the
checkout. It retains the original mutation cases, updates sites renamed by the
canonical No limits reconciliation and restores root/depth/lexer, cap/scanner,
diagnostic, production handoff and current authority/release mutants. The train now applies canonical No limits policy in both release paths, so
disabling the older branch selector is equivalent for these writes. Its release
mutant instead removes the current fresh wipe evidence; an added final-writer
witness requires a late executable wipe to remain held. Each
mutation restores and verifies the original source bytes. Assertion failures are
required; a process timeout alone does not qualify a kill.
The P6 link-operand witness additionally requires the SSH finding, so an
unrelated deadline hold cannot conceal removal of the operand check.

The train's added `env-glob` text row now includes its existing literal Read
projection; the earlier literal env row still wins every literal match. Its Pi
copy and generated checker are synchronized. The writer inventory also records
the noncredential root-discovery record now produced by the Flux connector.
The shell-site checker accepts the real CLI's NUL-delimited text entry with its
trailing newline and retains its rejection of unclassified executable sites.

The newer refused-mount configuration fixture now creates and returns the same
nonce it gives the production MCP shell-stanza builder. Its existing exact
environment assertions remain intact. The `env-glob` literal projection matches
only bare `.env` and the existing glob spelling; template suffixes retain their
established in-project carve-out. The nine Claude regressions introduced by
these integration seams passed after correction, along with three template
checks, with no assertion or deadline changes.
The image-result fixture settles a real inert setup turn before recording its
image turn, so the cold MCP readiness chip cannot change its exact result-chip
count. Every image and computer-frame privacy assertion remains unchanged.

The two original sample-based bracket holds in `nolimits-node-109` are retained
against X3's verbatim legacy reader, with an additional assertion through the
active prepared-shell production verdict. The reviewed credential-glob fixtures
remain alongside them. All 168 tests in that file pass without skips.

The S0 wiring fixture binds the real credential-root setter, UUID and realpath
helpers, and a fresh real shell-session registry. The project admission witness
also selects the production spawn-folder function. Existing refusal and send
ordering assertions stay intact. The wipe handoff source check now requires
X3's proven argument and nonce binding beside the unchanged turn environment.
The wipe MSYS seam uses the reviewed MCP fixture's private wrapper-copy pattern
to supply trusted stand-in tools, including cygpath's POSIX passthrough. Its
native Windows paths and conversion assertions are retained.

Current qualification results are recorded in the lane's external handoff and
logs. Historical result documents are provenance, not proof of this restoration.

The first restoration checkpoint passed all 11,647 assertions in 24 X3 and
coverage files, without skips. The current mutation set kills all 56 cases;
the three reconciled witnesses have a 45-assertion green control. All four
server typecheck partitions passed at their recorded repository budgets.
Broader differential qualification remains recorded by the external handoff.

## MAIN ruling 1116-X3FA: Q2

Witness owner: x3-restore. Approval contract owner: MAIN.
The known-cwd and persistent-shell witnesses now select Full access with their
exact assertions retained. Explicit No limits twins retain the wipe-only policy;
no production No limits code changed. Each retired diagnostic maps as follows:

| Read path | Previous expectation | Current expectation |
| --- | --- | --- |
| `~/.qwen/settings.json` | No limits with `held=` | Allowed, No limits, no hold rule |
| `/home/Jane Doe/.pi/agent/models.json` | No limits with `held=` | Allowed, No limits, no hold rule |
| `C:/Users/Jane Doe/.gemini/config/mcp_config.json` | No limits with `held=` | Allowed, No limits, no hold rule |
| `$KIMI_CODE_HOME/credentials/kimi-code.json` | No limits with `held=` | Allowed, No limits, no hold rule |
| `~/.agent-browser/sessions/work.json.enc` | No limits with `held=` | Allowed, No limits, no hold rule |

## MAIN ruling 1116-X3FA: Q1 and Q4

Matcher/witness owner: x3-restore. Full access contract owner: MAIN.
Unprepared shell intersections now consume the existing lexer's glob operands.
Parameter syntax is never intersected as a filename. Directory changes place
actual glob operands; they do not imply reads of every child. Literal credential
paths, known cwd placement, persistent shell state, and prepared-shell findings
retain their guards. A bare home star needs a named folder to intersect a row;
anchored extensions and credential directories retain their existing coverage.
The four ruling commands keep the train outcomes; literal and resolved credential
reads still hold. Q4's three frozen suites retain their snapshots and inspection
bytes. Mutants restore raw intersection, synthetic cd reads, and the bare-home
intersection independently.

## MAIN ruling 1116-X3FA: Q3

Scanner/witness owner: x3-restore. Credential privacy contract owner: MAIN.
The names-only Pi inventory is checked at read call sites rather than rejecting
file-reading imports throughout the module. The scanner permits only the exact
mode, bounded context and inventory reads and pins their path sources and helper
callers. The runtime witness observes the real guard opening only its mode file,
authenticated context descriptor and inventory, with credential files present
but unopened. Independent mode-to-`.claude.json` and context-to-owner-config
mutants are rejected. Reader aliases and bracket-property calls cannot introduce
another read outside the allowed sites; an aliased credential-read mutant is
rejected too. The retained wipe guard is unchanged.

## Round two qualification

Restoration, witnesses and qualification owner: x3-restore. Integration and
approval/privacy/data ruling owner: MAIN.
The frozen round-two source is `b0c44e619a`; later commits only update this
report and the ruling questions. All 29 originally pending witnesses now pass.
The 25 X3 suites pass 11,824 tests without a failure or skip, and all 65 distinct
mutants are killed with assertion failures and source restoration receipts.
Q4 snapshots and inspection bytes remain unchanged.

Four candidate shards and four isolated train5 shards ran with one Vitest
worker, at most two containers, the host's binding load gate of 76, unchanged
test deadlines and no retry wrapper. The candidate has 49,545 passes and 210
failures; train5 has 37,896 passes and 199 failures in the selected 586/563-file
manifests. Exact test identities give 17 NEW failures, 193 retained failures,
eight newly skipped identities and 90 missing passing identities. The unmerged
checkout also lacks 12 newer train test files outside the common-file scope.
The original-base corpus has no missing passes or new skips. No skip or test
exclusion was added in this round.

The 17 NEW failures are six stopped-installation downgrade rows, one EventBus
subscription privacy inventory row and ten browser read-consent/saved-Never
rows. Their data, privacy and approval contracts are recorded for MAIN in
`QUESTIONS-FOR-MAIN.md`; none was changed to silence an assertion. The brief's
simultaneous train5 merge request and hard integration-merge prohibition remain
unresolved, so no integration branch was merged.

The 68-file Node batch has zero NEW failures: candidate 506 passes/six retained
failures, train5 507 passes/six failures, with one missing passing identity.
Both settings-shell runs pass all six tests. Both project-shell runs pass six,
fail the same Reassign test with the same click-timeout diagnostic and leave
11 unrun under the unchanged maxFailures configuration. The browser comparison
has zero new failed titles; this is not a fully green project-shell spec.
All four server typecheck partitions, frontend, conformance and the test-tier
inventory pass at their recorded budgets. Native Windows and macOS were not run.

Two initial overlapping mutation/qualification attempts were stopped and
excluded. The accepted reports were produced only after mutation restoration
and the final scanner checkpoint. Heap-limit failures in the broad runs remain
in their reports; no memory budget was raised. Legacy fixture-generated outputs
are retained only in the external job evidence and restored/removed during cleanup.
External receipts include `qualification-final.json`, `ruling-closure.json`,
`comparison.json`, `comparison-node.json`, `playwright-comparison.json`,
`typecheck-measurements.json`, `mutants-qualified.json` and the shard logs.
The round remains PARTIAL: the zero-NEW and integration-parity gates are unmet.

Train5 moved during qualification: the completed baseline is pinned to
`8eda8357c945938c346821c4925b58cb2fe55e73`; its tip at handoff is
`da642fc0ceadf50fb9fbfa76d77e2d931b54e0d8`. The newer tip is not merged or
qualified. All differential counts above refer to the pinned baseline.
