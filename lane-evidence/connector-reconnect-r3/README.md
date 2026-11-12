# Connector reconnect, round 3

Binding inputs: DESIGN-CONN-r3.md and all eight amendments in REVIEW-from-last.txt, with amendments taking precedence. Base: b11a727b3045ad61495e24c7c9bfc6210494ba0b. Only assigned production files, the assigned tests (including the amendment-authorized r2 fixture corrections), locale files and lane evidence changed.

Every preflight evaluates a bounded, awaited inventory refresh initiated after its probe. Cache invalidation prevents joining a pre-probe fetch; the inventory loader applies no health decisions from obsolete or timed-out work. Stale display responses cannot clear incidents. Unknown checks persist per owner/account, hide the healthy checkmark, preserve confirmed reconnect presentation, and survive alias edits/restart. Status/expiry/removal or proven success clears the unknown flag.

Guard and attribution share normalized call rows and account resolution, including retained incident accounts for explicit removed IDs. Malformed scan results supply requirements only. Multi-row replies need indexed attribution; outcomes aggregate per account with failure precedence, regardless of row order. Only strict structured HTTP fields can establish upstream 401/403; response.error.status is included. Flux kind=auth in all recognized envelopes/rows is an outage. The documented Flux sentence only suppresses reconnect and never raises one.

Background provider reads require a nonempty list learned from scheduled dispatches for enabled routines due within 60 minutes (overdue occurrences included). Learning unions actual dispatched toolkits under owner/routine ID and definition updatedAt, persists, and is invalidated on revision mismatch/deletion at selection. The internal route uses routineRunForThread, including execution threads distinct from definition threads. Unknown routines retain dispatch-time checks. The durable hourly account budget is unchanged.

## Reproduce

```sh
IT_JOB=fix-connreconnect-r3 IT_W=/work/fuigo-builds/swarm-b/bld-connreconnect/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh 'bash lane-evidence/connector-reconnect-r3/verify.sh'
IT_JOB=fix-connreconnect-r3 IT_W=/work/fuigo-builds/swarm-b/bld-connreconnect/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh 'python3 lane-evidence/connector-reconnect-r3/mutants.py'
```

Runs use network-none containers, at most one at a time, launched only with host load below 60. Unit fixtures have throwaway homes; both workflow tests call launchVerificationServer, use a fake engine and loopback broker, pin the URL, retain wait/messages and fixture log paths, and close their exact fixture children. No live app/data, billable provider, or Mac was used.

## RED → GREEN and mutations

red-final.json/log and red-command.json are the final baseline replay: 47 assertion failures, seven already-passing controls, 27 unrelated tests skipped by the R filter. No startup, type, or timeout failures count as RED. Earlier red.log/green-attempt logs are development history only. Green.log contains 510 passing regressions. workflows.log records two passing isolated workflows. final-status.txt records zero exits for all three full typecheck commands (UI, server and Flux conformance). All 17 mutants are killed by assertions. Mutants.json records each exact command, patch, exit and assertion kill; source SHA-256 values prove restoration. M3-row is the seventeenth mutation required by amendment 1, in addition to the design's sixteen.

| R row | b11a727b3 | Final | Killed mutation coverage |
|---|---|---|---|
| R1a | 1 RED assertion(s) | GREEN | M1a |
| R1b | 1 RED assertion(s) | GREEN | M1b (HTTP case of R1h) |
| R1c | 1 RED assertion(s) | GREEN | — |
| R1d | 1 RED assertion(s) | GREEN | M1d |
| R1e | 2 RED assertion(s) | GREEN | — |
| R1f | 2 RED assertion(s) | GREEN | M1c |
| R1g | 1 RED assertion(s) | GREEN | M3c / M3-row (broker exclusion) |
| R1h | 5 RED assertion(s); 3 GREEN control(s) | GREEN | M1a, M1b |
| R2a | 1 RED assertion(s) | GREEN | M2a |
| R2b | 1 RED assertion(s) | GREEN | M2d |
| R2c | 1 RED assertion(s) | GREEN | — |
| R2d | 1 RED assertion(s) | GREEN | — |
| R2e | 1 RED assertion(s) | GREEN | — |
| R3a | 1 RED assertion(s) | GREEN | M3a |
| R3b | 1 RED assertion(s) | GREEN | M3a |
| R3c | 1 RED assertion(s) | GREEN | — |
| R3d | 1 RED assertion(s); 1 GREEN control(s) | GREEN | M3d |
| R3e | 6 RED assertion(s) | GREEN | M3c, M3-row |
| R3f | 1 RED assertion(s) | GREEN | — |
| R3g | 1 RED assertion(s) | GREEN | M3b, M3d |
| R4a | 1 RED assertion(s) | GREEN | M4a |
| R4b | 2 RED assertion(s) | GREEN | M4b, M4c |
| R4c | 1 RED assertion(s) | GREEN | — |
| R4d | 1 RED assertion(s); 1 GREEN control(s) | GREEN | — |
| Amendments / additional cases | Duplicate-account order, malformed/missing-index attribution, removed accounts, durable unknown, row auth envelopes, retention and tick phase: assertion regressions plus explicitly retained controls | GREEN | M1e (unknown preserves incident); M2b (mixed toolkit whole-call error); M2c (unattributed multi-row fallback); M3-row |

“—” means no separate mutant was assigned to that row; the row is covered by its regression/control assertions. The M2b/M2c/M1e amendment cases are listed separately rather than falsely crediting R2a or a baseline-passing control with their kills.

## Evidence limits and copy review

No captured real failing response from Marc was found in repository fixtures or /work/fuigo-builds/swarm-b/fix-connreconnect-r2. Those contain synthetic examples, implementation logs and the supplied FLUX-ERRORS description, not proof of a structured status in his response. Detection is therefore limited to non-ACTIVE/removed inventory or attributable structured upstream HTTP 401 (and safe-preflight 401/403). Persistent ACTIVE inventory with prose-only failures can remain unverified indefinitely. Repetition does not turn prose into authentication evidence.

Advance detection is bounded best effort, not guaranteed: the T−61 probe / T−5 tick phase can miss eligibility until after the last tick. Dispatch checks when budget permits; when an earlier successful probe still consumes the budget, the reactive path evaluates the actual action. Restart, no learned routine, disabled/out-of-window/newly enabled/overdue selection, persistence/revision/deletion and failure after earlier success are covered. Unknown outcomes do not block dispatch.

New product string for Sol copy review: `connectorHealth.unverified` = `Murage could not check {app} just now. It will try again.` Added to en, de, es, fr, hi, ja, pt-br and zh, with the existing seven-locale source-hash pattern. No copy-review record was created. UI source assertions verify unknown text/checkmark suppression and reconnect precedence; native notification delivery and packaged Settings rendering were not exercised.
