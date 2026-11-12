# Connector reconnect alerts

Field item 5, branch `dev/1019-connector-reconnect-alert`, base `b4dc27ea9`.

Reconnect incidents are stored atomically in the owned data directory. Empty or disconnected inventory cannot clear them. A monitor checks account metadata 15 seconds after startup and every five minutes after the previous check completes. No chat turn triggers this monitor. Recovery, account removal and broker credential replacement preserve the intended owner/account boundaries.

An incident has one persistent UUID and a 24-hour connector cooldown. Notifications use the existing failure category, bot mute, quiet hours and privacy filtering. Desktop receipts survive restart; phones deduplicate per binding and use an opaque deep-link target. The owner opens an authenticated account reconnect form. Tray, badge, bubble and dock receive an Open-only row through the existing attention path. The application-wide reconnect status is visible while idle. Custom MCP terminal failures project their persisted state through the protected main-process commit route, with revisions that reject stale failure delivery after a newer sign-in.

## Verification

RED: `red.log` records passive expiry returning no reconnect incident (1 failed, 17 passed). GREEN: `acceptance-vitest.log` records 254 passing tests across 13 files; `acceptance-electron.log` records 209 passing tests. Both server and UI TypeScript checks exited zero, recorded in `acceptance-status.txt`.

Run from this worktree:

```sh
IT_JOB=bld-connreconnect IT_W=$PWD IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh 'bash lane-evidence/connector-reconnect/verify.sh'
```

All execution used network-none containers. The workflow test uses `launchVerificationServer` and `runControlMurage` with temporary data, a fake engine and a loopback fake broker. `workflow.json` records idle detection, one event, restart persistence, disconnected inventory preservation, the phone owner access checks and sign-in request, recovery, and custom MCP revision fencing. The fixture was closed after the test. No live data, real broker, Buffer account, paid operation or Mac was used.

## Remaining qualification

`copy-review-bundle.json` contains all 32 new strings across eight locales, accepted by deterministic copy rules. Independent registered review is still required. The full copy suite has four failures: existing deterministic/completeness findings and incomplete review records, including this lane's new strings. See `copy-status.txt`. No review was fabricated or policy relaxed.

Installed native OS notification qualification belongs with notifyos; see `notifyos-handoff.md`. The current desktop main reports `pillAvailable=false`, so this lane does not claim a working pill or real installed OS delivery. Renderer dialog interaction is covered by route/target and component tests, not a packaged interactive smoke test. Composio metadata must report a lapse before polling can detect it; upstream grant refresh and incorrectly ACTIVE metadata remain the credential provider's responsibility.

The No limits decision and level controls were not changed. Integration conflict and leak-guard results are recorded in the job DONE report after commit.
