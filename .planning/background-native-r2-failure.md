# Native background R2 failure

Candidate: integrated root 0da7dde9 / merge 9ff84921.
Command: `rtk proxy node scripts/verify-background-native.mjs`.
Native fixture line 28: `await lifecycle.start(); assert.equal(lifecycle.status().trayAvailable, true);`
Observed: AssertionError, actual false, expected true. No later native UI, close/hide/reopen or quit assertion ran.
The outer wrapper rejected absent `.planning/background-evidence/native.json` with ENOENT, so there was no stale/success receipt acceptance.
The icon file is tracked and present at `electron/resources/app-icon.png`, size 63,399 bytes. Raw tray bounds/error are unknown. This does not establish a product root cause.
Tool handles 59518 (node/API/types), 24938 (browser UI), 28805 (native) all completed. Native handle exited 1. `pgrep -fl background-native-fixture.mjs` returned no matches. Temporary native profile and Vite service were cleaned by the wrapper.
Budget: R2 exhausted; no third native attempt authorized. See 0149-background-record.md for the bounded proposed remedy and passing subchecks.
