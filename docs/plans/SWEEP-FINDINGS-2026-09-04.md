# Cross-audit findings — upstream sweep 2026-09-04
Auditors: gpt-5.6-terra (effort=high) + gemini-3.8-flash, run per lane on the
full diff vs fork point 1234d669. Every finding below was re-verified by me
against the real file before being recorded.

## Lane: desktop (VERIFIED BY ME, both auditors agree on the security surface)

CLEARED by both auditors independently:
- Permission allow-list (electron/desktop-viewer-permissions.mjs): exactly 5
  input/display permissions, all others denied. Origin compare via URL.origin,
  opaque origins ("null") never match. No privileged device API reachable.
- release.yml cannot publish from a push: `publish` is workflow_dispatch-only,
  defaults false. Push runs produce a DRAFT at most.

### D-1 | MED | .github/workflows/release.yml:83 | CONFIRMED
`should_release` skips only when `previous = current`. Any DIFFERENT version —
including a DOWNGRADE — starts the signed mac/win/linux build.
Trigger: main at 1.2.3, merge sets 1.2.2, no published v1.2.2 → full signing
pipeline runs and assembles a draft for an older version.
Real impact: burned CI minutes + a bogus draft. NOT a publish, NOT a security
hole — the "Refuse to overwrite a published release" step still blocks a
version already published. Fix is a semver-greater-than compare, one line.

### D-2 | LOW | .github/workflows/prepare-release.yml:92 | CONFIRMED
`if gh release view ... 2>&1; then exit 1; fi` fails OPEN. A revoked
RELEASES_PAT, an API outage, or a rate limit exits nonzero and is read as
"no such release" → proceeds to create the branch and PR.
Notable because the SAME lane applied explicit fail-closed discipline to the
other guard (release.yml `git cat-file -e || exit 1`). Inconsistent, and the
inconsistency is in the direction that fails unsafe.
Bounded by the `git ls-remote` branch check immediately after.

### D-3 | LOW | .github/workflows/prepare-release.yml:96 | CONFIRMED
An existing `release/vX.Y.Z` branch is assumed to have an open PR; never
checked. If `gh pr create` failed once, every retry exits on the branch check
and the missing PR can never be recreated by the workflow.

## Status of other lanes
engines: complete, not yet cross-audited (awaiting full run)
server / sidebar / acp-images / routines / mcp: still running

## Lane: server — 1422 tests, 19 controls. Audited; MOST auditor findings were WRONG.

### S-1 | MED | server/drivers/codex.ts:537-547 | CONFIRMED (GPT)
The native-tee redaction spreads `...msg.params.item` and replaces only
`result` + `savedPath`. `revisedPrompt` (line 453 shows it is provider text)
survives verbatim into ~/.murage/native/<thread>.ndjson. The code's OWN comment
calls that file "a plain file people paste into issues". So an image prompt
containing personal detail rides into a pasted bug report.
Fix: null revisedPrompt in the same object literal. One line.

### S-2 | LOW | server/delegations.ts:693 | CONFIRMED (asymmetry, mine)
summarizeDelegatedActivity applies NO redaction, while buildNotification DOES
run redactSecretsInText on the same class of provider text. Same tree, same
kind of data, opposite treatment. Single-user tailnet box, and the 403 owner
check means only the delegating conversation can read it, so impact is low --
but the inconsistency is real and runs in the unsafe direction.

## REJECTED auditor findings (verified false — recorded so they are not re-raised)

- Gemini HIGH "Message.at is undefined, real field is createdAt, so the
  startedAtMs filter never fires": FALSE. server/store.ts Message declares
  `at: number`. The filter works.
- Gemini MED "delegationWatch has no toBotId so toBotName renders empty":
  FALSE. server/index.ts:2311 declares `toBotId: string`, required.
- Gemini LOW "workspace.test.ts is a corrupted binary file": FALSE. It holds
  ONE deliberate NUL byte at line 118, inside the bad-input table for
  isMemoryTopicName, next to "../x.md" and "..%2F..%2Fsecret.md". It is a
  path-injection test vector. Git flags the file binary; the test is correct.
- GPT HIGH "check_delegation leaks another bot's data": REJECTED AS FRAMED.
  My own prompt's FOCUS line said "check_delegation must not expose another
  bot's data" and the model echoed it back as a finding. Prompt contamination
  -- my error in harness design. Owner check at index.ts:6357 already 403s a
  foreign conversation, and in a single-user box A delegating to B gets B's
  result regardless. The residual real issue is S-2, not a boundary break.

## Lane: engines — CLEAN
Gemini: no defects. GPT: one MED that is not a defect but the plan's own
deliberate choice (60-90s ACP budgets instead of upstream's 300s); a slow
`npx` cold start can still exceed them. Both confirmed the session/load null
guard and the synchronous refreshingRef double-fire guard are correct.

## Lane: acp-images — CLEAN, BOTH AUDITORS
The lane the cross-audit created, on fuigo's own code path. Both independently
confirmed: base64 redacted before provider-native logging while the parsed
message survives for normalization; image blocks emit as assistant_image and
do NOT synthesize an <attached-image/> marker into model text; no double
emission as both image and text delta. Gemini additionally traced
purgeGeneratedImagesForThread and found staged files unlinked on bot deletion.

## AUDITOR CALIBRATION (matters for how to read the rest)
gemini-3.8-flash produced 3 confident, specific, plausible server findings.
ALL THREE were fabricated on details it never opened the file to check. Its
"sound parts" analysis was accurate and useful. Read its positives; verify
every negative before acting.
gpt-5.6-terra produced 2 server findings: 1 confirmed, 1 contaminated by my
own prompt. Its desktop findings were 3 for 3 real.

================================================================
## Lane: mcp — 546 tests, 5 controls, 0 ownership violations
The bypass I demanded in the plan is CLOSED and PROVEN: control 2 reverted
both guards and PUT /api/config immediately smuggled mcpServers through
(200 instead of 400). Control 3 went further than asked -- it restored the
.omit() strip while leaving the explicit throw deleted, to establish which
half is load-bearing. Answer: .omit() is what stops the write.

### M-1 | HIGH | server/mcp-probe.ts:87-92 | CONFIRMED, REPRODUCED
No `child.stdin.on("error")` listener. Listeners are stdout 'data' (135),
child 'error' (146) and child 'close' (147) -- the last two are on the
ChildProcess, not on the stdin stream. write() catches only SYNCHRONOUS
throws. An unhandled 'error' event on a stream terminates the process.

BOTH auditors flagged this and BOTH gave the wrong trigger ("a command that
exits immediately"). Measured on node v22.23.1:
    child exits          -> writeCallbackErr=ERR_STREAM_DESTROYED, NO 'error' event (safe)
    stdin destroyed      -> writeCallbackErr=ERR_STREAM_DESTROYED, NO 'error' event (safe)
    child CLOSES STDIN
      and stays alive    -> stdin 'error' EPIPE FIRES        <-- the real trigger
End-to-end repro of the exact mcp-probe listener shape: uncaught EPIPE,
process exit 42. A server that closes stdin after answering `initialize`
kills the whole harness, and the probe writes three frames, so the window
is real.
FIX: child.stdin.on("error", () => finish({ ok:false, error: publicProbeError("closed") }))

### M-2 | MED | src/components/PluginsPanel.tsx:516 | CONFIRMED (Gemini)
`(["apps","mcp"] as const).map(...)` renders the MCP tab with no desktop
check. On a phone the tab appears, tapping it fires GET /api/mcp/servers,
which 404s by design, and the UI shows an error. Same class as the retry
loop fixed in 8b20fe46: offering a surface something it can never do.

### M-3 | MED | server/mcp-probe.ts:104 | PLAUSIBLE, not yet reproduced (Gemini)
An `initialize` reply carrying a JSON-RPC `error` (no `result`) misses the
id===1 branch, then falls out of the id!==2 guard, so the probe never
settles and waits the full 8s before reporting "did not answer in time" --
misleading, since the server answered at once.

### M-4 | MED | server/mcp-probe.ts:24 | PLAUSIBLE (GPT)
Probe child inherits `{...process.env}`. stripWorkspaceCredentialEnv and
PROVIDER_CREDENTIAL_ENV remove the known ones; anything else in the host env
reaches a user-supplied command. Worth a decision, not obviously a defect.

## REJECTED from the mcp lane
- Gemini HIGH "protocolVersion 2025-06-18 is invalid, spec says 2024-11-05":
  FALSE. 2025-06-18 is the current ratified MCP revision. Gemini cited a
  superseded version as though it were the only valid one.
- Both "the trigger is a command that exits immediately": FALSE, measured.
  That case does not emit a stdin 'error' event at all.

## RUNNING TALLY OF AUDITOR ACCURACY
gpt-5.6-terra : desktop 3/3 real, server 1/2, mcp 1 confirmed + 2 plausible
gemini-3.8-flash: server 0/3 real, mcp 1 confirmed (wrong trigger) + 1 real
                  + 1 false HIGH. Its POSITIVE analysis stays reliable and
                  detailed; its negatives need verifying every time.

================================================================
## Lane: routines — 5 commits (incl. merge), the biggest lane

### R-1 | LOW | server/index.ts:1682 | CONFIRMED (GPT), measured
  const GROUP_GOAL_WAIT_MAX_MS = Math.max(1_000, Number(process.env.MURAGE_GOAL_WAIT_MAX_MS) || 5*60_000);
Floors at 1s, no ceiling. Node clamps any setTimeout delay above 2^31-1 to
1ms -- measured: "TimeoutOverflowWarning: 3000000000 does not fit into a
32-bit signed integer. Timeout duration was set to 1", fired after 2ms.
So MURAGE_GOAL_WAIT_MAX_MS=3000000000 (or Infinity) turns a deliberately
LONG wait into an instant timeout: every busy teammate immediately exhausts
its wait and the goal reassigns or blocks. Exactly inverted.
FIX: Math.min(2_147_483_647, Math.max(1_000, ...)).

### R-2 | MED | server/index.ts:4575 | PLAUSIBLE, not reproduced (GPT)
A worker that loses the ready-to-claim race retries via `continue`, which
skips the outer waitExhaustions accounting, so the wait cap may never be
reached and the goal can stay `working`. Needs a race to reproduce; worth
the verifier's attention.

## REJECTED from the routines lane
- Gemini HIGH "completed group turn operations are never removed from
  groupTurnOperations, so interrupts get a false 409": FALSE.
  finishGroupTurnOperation (index.ts:1119) deletes the operation and drops
  the empty set, and ALL THREE registration sites call it through
  `.finally()` (4982, 5458, 5557), so it runs on success and failure alike.
  Gemini reasoned from finishGroupGoalRun setting run.finished without
  clearing `cancelled`, and never checked the enclosing lifecycle.

## FINAL AUDITOR SCORECARD (7 lanes, both models on each)
gpt-5.6-terra    : 8 findings, 6 real (3 desktop, 1 server, 1 mcp, 1 routines),
                   1 contaminated by my own prompt, 2 plausible-unverified.
gemini-3.8-flash : 9 findings, 2 real (mcp stdin w/ WRONG trigger, mcp tab),
                   5 outright false, incl. 3 HIGHs it never opened a file for.
                   Its "areas judged sound" sections were consistently
                   accurate and genuinely useful.
LESSON: keep both. Use Gemini for coverage of what IS sound, GPT for defects,
and verify every single negative before acting on it. Five of tonight's
fourteen findings would have been wasted or harmful work if taken on trust.

================================================================
## VERIFIER FINDINGS I RE-CHECKED (the verifiers get audited too)

### V-1 | acp-images MED — CONFIRMED, and BOTH external auditors missed it
`EventBus.publish` (server/harness/bus.ts:42-52) writes `redactSecrets(event)`
to `events/<threadId>.ndjson`. redactSecrets scrubs CREDENTIAL-shaped content;
nothing filters `assistant_image` base64. So the lane scrubbed the native tee
(`nativeLogMessage`) and left the sibling log — whose own comment calls it
"a file people paste into bug reports" — carrying the full payload.
Zero assistant_image lines on disk today only because the feature has not
merged. Those logs are already 7.1MB; add megabytes of base64 per image.
GPT-5.6 and Gemini both declared this lane CLEAN. The in-repo adversarial
verifier caught what two external models did not.

### V-2 | desktop LOW — CONCLUSION RIGHT, MECHANISM WRONG
Verifier claimed "the version-extraction pipeline's exit status is discarded,
so a node failure silently yields should_release=true". Measured under
`bash -e`, which is the GitHub Actions default shell:
  malformed JSON / node throws -> step exits 1. FAILS CLOSED. Claim is wrong.
  valid JSON with no `version`  -> node exits 0 and prints "undefined",
                                   previous="undefined" != current,
                                   should_release stays true. FAILS OPEN.
So the crack is real but narrower and differently caused than stated. Guard
against the literal string "undefined" and the empty string, not against a
nonzero exit that `set -e` already handles.

### The release guard now has THREE independent fail-open cracks
D-1 (downgrade counts as a release), D-2 (`gh release view` error reads as
"no such release"), V-2 (a previous package.json with no version field).
Each is individually small. The pattern is the finding: the block's stated
contract is fail-closed and it was written with a deliberate
`git cat-file -e || exit 1`, yet three separate paths around it lean open.
Worth one pass over that job with "what does this do when the input is
absent rather than wrong?" as the question.

### V-3 | routines HIGH — CONFIRMED IN FULL. Merge blocker.
The SECOND instance of the exact bypass class I caught in the plan cross-audit
for MCP: the gated route is gated, and a different write path is not.

Verified line by line on sweep/routines:
  - gate (index.ts:7150-7154) covers ONLY POST /api/routines and
    PATCH|DELETE /api/routines/:id
  - requestSurface is called at 6393, 7152, 7264-5, 7338, 7552, 9123, 9211,
    10131, 10160, 10207, 10750 — NONE between 9600 and 9850
  - POST /api/bots/:id/respond (9693) and POST /api/threads/:id/respond
    (9728) both call resolveAndSendRoutine (9701, 9762)
  - which reaches routines.create/update/remove
  - inputFromDefinition sets `enabled: true` (routine-requests.ts:582)
  - /api/teams/import — the path the executor DID audit — sets
    `enabled: false` (index.ts:8039), so the barrier it relied on is absent
    on the path that matters

Net: a phone confirms a routine card and creates an ENABLED interval routine
that spawns turns on a timer, with the desktop gate never consulted. This
lane is what made the path spawn-deciding, by teaching the request chain
interval schedules. It therefore falls squarely under the sweep's own
standing port rule.

TWO instances of this class in one sweep (MCP PUT /api/config, and this) is
the real lesson: gating the obvious route is not the same as gating the
capability. The rule should be restated as "every path that can WRITE a
spawn-deciding record", and the check should be a test that enumerates
writers, not a reviewer's memory.

================================================================
## *** STAGING IS NOT SAFE TO FAST-FORWARD *** (my plan's defect)

Verdicts: sidebar SOUND, desktop SOUND, server SOUND, mcp SOUND,
          engines FIX-LIST, acp-images FIX-LIST, routines FIX-LIST.

The stage agent merged the four SOUND lanes. But `git merge-base --is-ancestor`
says sweep/routines IS an ancestor of upstream-sweep-2026-09 anyway, because
sweep/mcp was BUILT ON sweep/routines (1fbf316c "Merge sweep/routines into
sweep/mcp") — my plan required M to merge S and R before starting.

So merging the SOUND mcp lane transitively landed the FIX-LIST routines lane,
carrying V-3, the enabled-routine desktop-gate bypass. Confirmed present on
the staging branch: zero requestSurface calls in 9600-9900, and
routine-requests.ts:582 still `enabled: true`.

The workflow filtered its DIRECT merge list by verdict and never checked the
dependency closure. "Only SOUND lanes are merged" was not actually enforced.
engines and acp-images were correctly excluded only because nothing depended
on them.

MY defect, not the workflow's: I wrote the lane dependency graph AND the
verdict filter, and never reconciled them.

RECOMMENDATION: fix V-3 on sweep/routines (gate the respond path, or refuse
enabled routine writes from a non-desktop surface), re-run the routines
verifier, then rebuild staging. Rebuilding staging WITHOUT routines is the
alternative but it means re-basing mcp onto server alone, which is the
riskier move for the smaller prize.

DO NOT fast-forward main to upstream-sweep-2026-09 as it stands.

================================================================
## STAGE AGENT REPORT — and it caught its own false green

Workflow complete: agents_done 15/15, errors 0, skipped 0, empty 0.
2,548,790 subagent tokens, 1608 tool uses, 5h18m.

The worktree had NO node_modules, so its first `pnpm typecheck` was a FALSE
PASS — tsc was absent and the failure was swallowed. The agent noticed,
ran `pnpm install --frozen-lockfile` under node v24, and re-ran everything.
Exactly the "registering a thing is not creating a thing" failure mode, self-
caught. Worth keeping in the plan as a standing worktree pre-check.

After a real install: typecheck PASS, lint PASS (0 errors), boot PASS
(fuigo present, 86 model options), and a full-diff identity grep whose only
hit is a test asserting upstream's ABSENCE. Nothing leaked.

vitest: 4 failed / 4528 passed. All four reproduced in isolation — not flake.
  - server/wayland-library.integration.test.ts (2) — ENVIRONMENTAL, verified:
    `teams-library/` exists locally with ZERO tracked files and is not
    gitignored, so it is invisible to any fresh worktree. Fails on main too.
  - src/lib/role-leaks.test.ts (1) — REAL REGRESSION, verified:
    RoutineCalendarPage.tsx:142 reads raw `bot.chiefOfStaff` instead of
    botRole(). `git log -S` attributes it to c592aa2f — a ROUTINES commit
    (the stage agent labelled it sweep/mcp; the commit attribution is right,
    the lane label is not — mcp merely carried routines in).
  - server/notification-wiring.test.ts (1) — NOT a defect. The new desktop
    gate is correct; a pre-existing test posts POST /api/routines without the
    desktop surface and now gets its 404. Fix the test, not the gate.

## BOTTOM LINE
Everything wrong with staging traces to ONE lane: routines.
  V-3   HIGH  respond-path bypass creates ENABLED interval routines
  role-leaks regression at RoutineCalendarPage.tsx:142
  plus the notification-wiring test its own gate invalidated
Fix those three on sweep/routines, re-run its verifier, rebuild staging.
The other three merged lanes (server, desktop, sidebar, mcp) are clean.
