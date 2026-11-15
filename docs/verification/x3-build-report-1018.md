> Historical 1.0.18 build notes preserved with the ACP session fixes. These results are not evidence for the 1.0.19 re-land.

# X3 build status

Not READY. The work started at 27198a6d7 and preserves the design's Limits.

## Stopped parts

- Step 2: this head has no NLMI-MARKS network-read mark in the approval verdict. ownerNoLimits reads origin and ownerStarted, with no outside-content state. The existing email mark is not a substitute. Marked-turn proof is blocked; no replacement mark design was added.
- Real-server verification: the normal Vitest setup cannot allocate a loopback port in this sandbox. Its forty probes fail before tests load. Unit runs use /tmp/x3-vitest.config.mjs, with a copy of the normal isolation setup that replaces only port allocation. No live app or provider was called.
- Step 4: the full A/B/C coverage columns, production-matcher parsing test and writer-driven fixture matrix are not complete. Neither the scan corrections nor the selected matcher tests prove that inventory complete.
- Step 5: Cloud namespace visibility through the launcher is not proven. No claim is made that the machine files are unreachable.

## Roots and uncovered files read from production code

- electron/cua-connection.cjs:24-35 constructs a descriptor under getUserData() and an atomic .<pid>.<uuid>.tmp name. electron/main.mjs:314-317,2854 supplies browser-connection.json in development. electron/browser-host.cjs:399-401 returns a token in that descriptor. This file and its temp name are absent from the agreed data list.
- server/browser-extension-paths.ts:20-39 can use an override plus mbe-<12hex>, or the OS runtime/temp root plus murage-mbe-<12hex>-<uid>, mbe-<12hex>-<uid>, or mbe-<uid>-<8hex>. browser-extension-broker.ts:154-161 writes the token into browser-<instance>.json, hardlinked as native-host.json. These fallback roots are not supplied to the matcher.
- native/browser-extension/transport.cpp:79 leaves <path>.new-<pid> while writing. Browser client config and broker rows need these names, beyond the final .json names.
- electron/main.mjs:1687 supplies restoredConnections.tunnelRuntime or <userData>/managed-companion-tunnel. The relocated root is not supplied to the verdict.
- server/browser-restore-store.ts:81-87 includes the actual Windows profile in addition to supplied HOME and USERPROFILE. The owner-engine-config row covers its session-file spelling; a real writer fixture across these branches is still required.
- server/drivers/acp/hermes.ts:283 chooses /data/engine-homes/hermesAgent on a Cloud home, otherwise env MURAGE_DATA_DIR or DATA_DIR. The config is directly in flux-hermes-home, not native.
- server/drivers/acp/cursor.ts:432-455 writes <DATA_DIR>/native/cursor-host-config/<bot>/cli-config.json. This is A.
- server/drivers/claude.ts:5735,5782 calls claudeIsolation without overlayEnv. The isolation file at 2738 is N.
- native/backup-age/transport.cpp:185 is a handle helper. Its callers write control stderr, a key pipe, and stdout. It has no disk-file destination.

## Verification evidence

The command-table base run failed 14 assertions. Restoring the base production gate, glob module and reader made six new real-verdict tests fail, including the Pi bash row. The seven file rows and owner-home rows failed 23 assertions before their implementation. The data-folder verdict rows failed 11 assertions before wiring. Scan correction tests failed two assertions before editing the document.

Step 1's initial server type check passed. Further final checks are recorded after the remaining steps. Existing verification limits still apply.

No en.json string was changed. No .review-evidence file is part of these commits.

## Class D root confirmation

The local plaintext backup tree is beside the canonical data folder:
.murage-backup-work/<32hex>/run-<pid>-<six alphanumeric>, from
server/backup-local-work.ts:31-33,80. That is not the SFTP SSH root.

Electron main at 4560 and 4648 passes remoteControlDirectory into
remoteWorkDirectory. On POSIX the root is
<installation parent>/.murage-backup-control/<sha256 installation>/remote/<remoteRef>/<revision>,
from backup-closed-controller.mjs:10 and backup-remote-runtime.mjs:62-67.
On Windows the control root is <LOCALAPPDATA>/murage/offsite/<16hex>, falling
back to <userData>/offsite/<16hex> only for a local userData drive.
remoteSshDirectory uses that root's remote directory, with no remoteRef or
revision. BackupRestic.sshScratch chooses sshDirectory or workDirectory.
writeSshMaterial then creates ssh-<six alphanumeric>/key.

A planted real writeSshMaterial test matches the key with its passed backup
root. The production verdict does not yet receive these remote roots.
Cloud machine-file launcher tests and the complete backup/export prefix
inventory remain outstanding. Recovery-key folders, password/report folders,
save-dialog output, archives, snapshot/inspection/damaged-export trees,
encrypted inspection/recovery trees and database snapshots retain the
design's stated limit. Encrypted output and logs stay ungated.

## Final checks and remaining work

- Normal npx vitest run was attempted for all nine touched test files. All nine stopped in setup while allocating a loopback port; no assertions ran in that configuration.
- The temporary isolated configuration ran the matcher, row, verdict, Pi, Copilot, session-binding, native Windows process, and environment suites: 395 passed and two existing environment child-output tests failed. Both failures receive an empty child stdout.
- The full backup-sftp file had 15 passes and three failures from EPERM starting ssh or ssh-keygen. The planted SSH writer test also passed on its own.
- The full custom-selection file failed all five tests, including the pre-existing ones. The new one-write driver fixture exits with code 0 before its first reply. That is not a fail-on-base proof of the owner-binding bug.
- The two new open-session tests did fail on the unchanged helper: "binds the process owner before the next frame of a fallback one-write response" and "rolls both session bindings back when fallback policy fails". All six helper tests pass after the change. The core passes its actual process owner into this helper.
- The Windows reclaim test failed before the change; all seven Copilot and native Windows inventory tests passed after it. The native case-insensitive argv sweep already existed at the starting head.
- NODE_OPTIONS=--max-old-space-size=12288 npx tsc -p tsconfig.server.json passed, including the final core/helper changes.
- npx tsc -b passed.
- node scripts/ci-test-tiers.mjs check passed: 3498 files, 2005 gate and 1493 extended. It required classifying three pre-existing unclassified ACP test files as well as the new tests.
- The replay without MURAGE_X3_REPLAY_EVENTS failed with the required input message. With the planted five-command folder it printed three added cards, rootThreeLs=1, two no-limits verdicts on both sides after excluding added hits, and zero other differences. It opens each ndjson with mode r. No real events were replayed.

Fail-on-base names for the earlier changes: "X3 command table" (14 assertions),
"X3 credential glob verdicts" (six), "X3 file rows" (23),
"X3 data-folder files" (11), and "X3 scan corrections" (two).
The earlier verdict proof restored the three production modules from
27198a6d7 for the run and restored the built files afterwards.
The Class D planted-writer assertion has no separate base proof.

BUILD-FIX status:
1 implemented with ordinary-content negatives.
2 corrected and the native path tested.
3 corrected with both internal caller expressions checked.
4 literal home forms and project negatives tested.
5 companion-sidecar.pid covered.
6 config-only Hermes coverage and state.db negative tested.
7 not complete: no full coverage-column parsing test.
8 not complete: no full real-writer/work/platform matrix.
9 every render_plan put listed, with route-header content read from the code.
10 eligibility and root-shape rows tested; replay counts the three-level ls.
11 requested store temp-name patterns covered.
12 literal Kimi credential path covered and variable-home glob normalization added; marked-turn proof is blocked.
13 corrected to flux-hermes-home directly under the chosen root.

Still needed: every-family planted real-writer/temp-name proof; complete
A/B/C root audit, coverage columns and strict parsing test; real writer
coverage across platform branches; production backup and relocated tunnel
roots; disposition of the newly found browser paths; every Cloud machine
path tested through the launcher; complete backup/export prefix inventory;
the OpenCode native-read real-server row and round-trip timing; true outside
marked-turn rows; driver-level one-write proof; and the shepherd's real-data
replay. The replay currently extracts command, commandText, commandLine and
cmd fields recursively; the shepherd must reconcile its command count with
the event corpus before accepting replay completeness.

Open questions for the shepherd: which integration commit supplies the
NLMI-MARKS dependency, and how should the listed uncovered browser/runtime
roots be passed to the verdict? No substitute policy or migration was added.

## Continuation: item 1

The rig's one-write assertion used the wrong fixture notification. The fixture
sent agent_message_chunk with the session/new response, before session/prompt.
core.ts:4158 deliberately ignores that text while promptSent is false. It now
sends available_commands_update, handled before that gate at core.ts:4152.
The marker still crosses the process ownership fence, so the assertion checks
fallback ownership without requiring pre-prompt assistant text to be displayed.
No production driver change was needed for this rig failure.

Normal custom-selection Vitest run: setup cannot allocate a loopback port;
no assertions ran. The existing isolated setup also attempted all five tests:
all fail because the child exits before its first reply. The corrected
one-write test and its source-reverted fail-without proof remain unrun on the
rig; neither is claimed passing. The rig's supplied failure is evidence for
the original fixture, not a locally observed fail-without proof.
