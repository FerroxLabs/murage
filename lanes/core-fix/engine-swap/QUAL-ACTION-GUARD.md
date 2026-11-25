# Action guard qualification

Status: NOT QUALIFIED. No real replies were sampled or labelled during this fix.
Synthetic cases are regression tests and do not establish release precision or recall.
The language gate is heuristic and does not prove that a reply is English.

The spec's release thresholds remain precision >= 0.9 and recall >= 0.6 on a
disjoint qualification half of 200 owner-approved, redacted real replies:
100 with recorded actions and 100 without. Owner labels and the split must be
fixed before calibration. Keep replies from the same turn in the same split.
No qualification scores are reported here.

Export a pool from an explicitly supplied database copy for owner labelling:

```sh
node scripts/action-guard-sample.mjs /path/to/copy/messages.db 200 > replies.jsonl
```

The exporter opens the copy read-only, rejects paths inside the account's
`.murage` folder (including symlink targets), and leaves `label` and `split`
empty. It has no default database path. The owner must redact and approve the
sample before using it for qualification; a recent pool need not be balanced.

Pure regressions, including execution of the production event fold with inert
outside services and an isolated Store:

```sh
node node_modules/vitest/vitest.mjs run --config lanes/core-fix/engine-swap/vitest.offline.config.mjs
```

The offline config allowlists only tests that require no listener. Its setup
bypasses the unrelated control-port probe while retaining the repository's
isolated home, database, environment scrubbing and cleanup guards.

The separate real-server workflow uses two fake engines and the documented
`launchVerificationServer` fixture:

```sh
node node_modules/vitest/vitest.mjs run server/engine-swap-workflow.test.ts
```

This workflow was attempted, but this sandbox could not bind loopback ports.
A direct fixture launch failed at the same port probe before server startup.
Consequently the A-to-B-to-A server workflow is unverified here. The offline
fold tests do execute production tool-start, completion, options-card and ACP
recovery code. They are not a substitute for the listening-server workflow.

Evidence files in this directory record the regression run, the failing
baseline, the bounded old-scanner probe, and the fixture launch refusal.
No builds, installs, external network calls or live data were used.
