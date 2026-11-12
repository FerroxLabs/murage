# Connector reconnect, round 2

Scope: Murage-only broker account status, reactive failures, and scheduled safe reads. No Flux changes, live providers, external network in tests, billable calls, or Mac access.

The previous round is at 4dc2e6c4c71682cf2eba250a2874682e5d8b5932. FluxMain's supplied FLUX-ERRORS.txt says that broker transport auth belongs to Flux's project key, while user failures arrive inside MCP results. Any failed tool result refreshes the account inventory; non-ACTIVE accounts require reconnect. An upstream HTTP 401, or HTTP 401/403 from a safe preflight, covers an account whose inventory still says ACTIVE. Generic errors with ACTIVE status do not establish a lapse. Provider prose alone is not the authority.

The safe-read table is shared/connector-safe-reads.ts: Gmail profile, Calendar list (one result), Slack auth.test, Buffer account context. Scheduled dispatch waits for checks of the toolkit it is about to use, before sending its action. All accounts of that toolkit are checked. Idle checks and scheduled checks share a durable hourly budget per owner/toolkit/account, including failed attempts. Concurrent checks join the same flight. Unknown toolkits have status/error coverage and a Settings note explaining that they are checked when used.

## Reproduce

From the worktree, use:

```
IT_JOB=fix-connreconnect-r2 IT_W=/work/build/bld-connreconnect/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh 'bash lane-evidence/connector-reconnect-r2/verify.sh'
```

Tests use network-none containers and fake loopback brokers. The workflow tests call launchVerificationServer and pin every request to its isolated URL. Their JSON contains fixture URL/data directory/log path, failed and recovered run states, bounded transcripts, reconnect action, call counts, and control-murage wait output. The fixture removes its temporary data and stops its exact child.

## RED evidence

- red.log: initial test typo, NOT behavioral evidence.
- red-behavior.log: status/auth/preflight assertions failed; its workflow had a fake-server typo and is NOT workflow evidence.
- red-confirmed.log: corrected fake server; scheduled run incorrectly reported completed. The preflight assertions also failed.
- red-unit.log: forced inventory reads demonstrate missing INITIATED/INITIALIZING/FAILED/UNKNOWN mapping, missing account-specific projection, auth failure handling, safe reads, and durable hourly budget.
- red-flux-contract.log: intermediate implementation missed error-triggered refreshes and ACTIVE preflight auth, and falsely blamed a user's account for Flux project-key rejection.
- red-envelopes.log: JSON errors inside MCP text and unattributed multi-app errors failed their inventory/preflight assertions.

## Final results

- final-followup.log: 197 tests pass, including both isolated scheduled workflows and the operation/recovery regressions.
- final-account-guard.log: 26 tests pass, including A blocked/B allowed without clearing A.
- final-electron.log: 49 tests pass for sign-in and notification receipt behavior.
- final-types-server.log and final-types-ui.log: TypeScript exits 0; followup-status.txt records the exits.
- broad-before-followup.log: 461 passes and the two failures described below; both affected suites pass in final-followup.log. Do not add overlapping suite counts.
- mutants.json: seven mutants killed at assertions; mutant-source-sha256.json matches the restored final production files.

## Mutants

Run mutants.py through the same container wrapper, after other tests have exited. It retains each exact patch, argv, failure log, result, and source SHA-256, and restores source in finally. Every mutant must fail at an assertion, never just a startup/type error.

## Regression changes

The broad regression run found two follow-ups: the inventory cache test previously expected a vanished INITIATED account to disappear, while the requested mapping now preserves its incident; and the reactive GitHub workflow replayed a prior direct-read auth failure after reconnect. The final follow-up verifies the new expectation and fresh execution of direct reads from the existing verified-read list. Writes, unknown tools, and mixed batches retain their operation protection. Bot grants and approval routes are unchanged.

The original round-1 evidence remains untouched; rerun workflow output is archived under regression-r1 where applicable. Source-only diff whitespace checks pass; raw tool logs and mutation patches preserve their original output.

## Copy and limits

New product string, needs Sol copy review: `Murage checks this app when it is used.` No copy-review record has been invented. App-named failure text reuses existing eight-locale connectorHealth.signIn and connectorHealth.reconnectApp keys. Reconnect uses the existing owner route and incident banner.

This verifies isolated server/scheduler behavior and component tests, not native notification delivery or packaged UI interaction. A provider with no safe read and an idle lapse still reported ACTIVE cannot be discovered until it is used or its inventory status changes.
