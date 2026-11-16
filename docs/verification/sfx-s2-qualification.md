# E-S2 qualification: real receipts pending

S2 remains disabled in production. `server/drivers/claude-s2-qualification.ts`
has no admitted builds. Admission requires an exact platform, architecture,
Claude version, native artifact SHA-256 and a reviewed evidence directory.
Upgrades, rebuilt binaries, unknown versions and wrapper/npm launchers stay S1.
Each dispatch checks the current identity before reusing a retained process.
`NODE_ENV=test` exercises S2 only in the existing isolated test harness; a real
test receipt never updates the production allowlist.

The offline protocol peer is a deterministic fake reporting version 2.1.310.
It launches the actual relay shims, sends initialize/list/call requests and
reconnects them. It is not Anthropic's pinned CLI and cannot qualify production.

## Offline reproduction

Use this checkout's matching dependencies, Node 24 and the network-disabled
container wrapper. Do not install, log in, copy a login directory, or use a live
Murage instance. From the job checkout:

```sh
export IT_JOB=sfx-s2
export IT_W=<job-checkout>
export IT_ORIG=<tools>/it-local-generic.sh
export IT_CAP=6
# Wait to start a shard until the shared host's one-minute load is below 60.
mkdir -p evidence/sfx-s2
<tools>/it-remote.sh \
  'node scripts/qualify-claude-s2.mjs --mode offline --output /work/evidence/sfx-s2/offline-NEW'
```

The output directory must not exist. The runner uses a new HOME/config directory
and a minimal environment without provider credentials. It records file hashes,
OS/architecture, Node version, every assertion ID and status, the raw Vitest JSON
and six actual-stdin timing samples. The two timing cohorts are successful warm
reconnect and rejected reconnect followed by cold fallback. Shared-host fake
timings are not real-CLI latency qualification or a production latency budget.

The existing component and driver tests cover Stop before release and during
reconnect, prompt-before-steer order, revoked queued input, failed retirement,
credential clearing and teardown. `T-S2-NO-CROSS-PRODUCTION-OFFLINE` additionally
holds the real MCP tools/list response, delays a previously released owner answer
below the driver writer, delivers old stdout/error/end callbacks, sends an old
ticket, and proves generation N+1 still completes on one retained CLI without an
old request, old content, refusal or resource closure. No real test is replaced
by this offline case.

## Dedicated Linux runner: exact real command

This job does not authorize provider calls. Run the command below only on a
separately authorized qualification runner, with its dedicated credential and
network policy. No login command is part of this runbook.

Prerequisites:

1. A complete checkout of the reviewed source with its matching dependencies and
   Node 24. Use an isolated user/container and no user or live app mounts.
2. A self-contained Linux Claude **2.1.310** native artifact installed outside the
   user's HOME, plus its SHA-256 from an independent artifact record. The CLI must
   report exactly `2.1.310 (Claude Code)`. Disable artifact replacement/updating
   for the run. A PATH alias, npm wrapper or version string alone is insufficient.
3. Exactly one dedicated, already-issued qualification credential injected as
   `S2_QUALIFICATION_CLAUDE_CODE_OAUTH_TOKEN` or
   `S2_QUALIFICATION_ANTHROPIC_API_KEY`. Never set the value on a command line,
   print it, read `~/.claude`, or copy production credentials/settings/hooks.
4. A new private evidence directory with enough space for the reports. Provider
   access must be authorized separately; the `--network none` offline runner
   cannot produce model-backed real receipts.

```sh
# Credential injection happens in the runner's secret manager, not in this shell recipe.
mkdir -p evidence/sfx-s2
node scripts/qualify-claude-s2.mjs \
  --mode real \
  --cli /opt/qualification/claude-2.1.310 \
  --build-sha256 REPLACE_WITH_INDEPENDENT_64_HEX_SHA256 \
  --allow-provider-calls \
  --output "$PWD/evidence/sfx-s2/real-linux-NEW"
```

The runner supplies a fresh empty HOME/USERPROFILE/CLAUDE_CONFIG_DIR to the tests,
checks the artifact before and after the run, and requires all five existing
real IDs to pass. Missing, failed or skipped real IDs fail its receipt. The tests
also require an absolute CLI path, build pin and explicit credential; there is
no fallback to the account's `claude` or login files.

Required real IDs (the four in `claude-s2-real.test.ts` share the describe prefix
`pinned real CLI S2 protocol qualification (isolated relay; not dispatcher coverage)`):

| ID prefix | Observation |
| --- | --- |
| `T-S2-REAL-RELIST` | Retained actual CLI calls the newly listed tool |
| `T-S2-REAL-IDENTITY` | Fresh shim/initialize/ticket; tools/list acceptance precedes connected status |
| `T-S2-NO-CROSS` | Held real elicitation and old ticket cannot enter the successor |
| `T-S2-REAL-SHIM-EOF` | Actual shim exits on socket EOF without self-reconnect |
| `T-S2-NO-CROSS-PRODUCTION: real` | Actual production settlement/reconnect followed by delayed old callback |

Keep `identity.json`, `tests.json`, `assertions.json`, `receipt.json`, the stdout
log and their hashes. A reviewer must also assess real Stop, teardown, cold
fallback, prompt/steer ordering and representative latency against the agreed
acceptance criteria before admitting any build. Passing the five existing real
IDs alone does not silently close these remaining real-engine observations.

## Outstanding qualification

Initial discovery found no dedicated runner artifact or passing real S2 receipt
under the private tools and coordination directories.
A subsequent content search found MAIN's new `_small/w447.sh`: it announces a
dedicated Linux host, `s2-qual-linux`, with Claude 2.1.310 and a dedicated
credential, and assigns real qualification to the separate `s2-real` lane.
This slice did not access that credential, inspect login state, execute the
runner CLI, or write to that lane. Its runner must use an absolute native CLI
path and an explicit build pin with this harness; the bare `claude` example in
the launch note intentionally does not satisfy the strengthened test preflight.

The ambient `/usr/local/bin/claude` on this host was not executed or treated as
a qualification installation. No credentials, login, Mac, or other lane was used.

Linux real execution remains OPEN pending the dedicated runner lane's receipts.
The announced runner's auth state and artifact pin were not verified here.
macOS and Windows real receipts
also remain OPEN: the current real shim PID witness uses Linux `/proc`, and the
script deliberately refuses to present a different platform as qualified. A
platform-specific, reviewed process-identity/teardown witness is required before
running that real qualification there. Do not remove its assertions or skip
them to obtain a green report.

S1 fallback preserves safe production behavior while these gates remain open;
it does not discharge E-S2 qualification. Full-suite comparison on the combined
integration head remains the integrator's responsibility.
