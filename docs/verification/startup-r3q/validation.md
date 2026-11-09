# STARTUP-SILENT r3-q validation

All tests used isolated temporary directories or in-memory Electron/child fixtures. No live app or user data was used. The before-fix output for each item is recorded alongside its item note.

Commands and results:

- `node_modules/.bin/vitest run electron/startup-paint.test.mjs electron/memory-upgrade-window.test.mjs electron/startup-settle.test.mjs electron/startup-slow.test.mjs electron/deferred-startup.test.mjs electron/dock-quit.test.mjs electron/quit-causes.test.mjs`: 39 passed in 7 files.
- `node scripts/prepare-backup-test-fixtures.mjs --tool-directory /tmp/startup-r3q/age`: staged hash-verified fixture tools.
- `MURAGE_BACKUP_TEST_AGE_DIR=/tmp/startup-r3q/age node --import ./server/testing/safe-wipe-preload.mjs --test electron/*startup*.node-test.mjs electron/*handoff*.node-test.mjs electron/*recovery*.node-test.mjs electron/*upgrade*.node-test.mjs electron/quit-reentry.node-test.mjs`: 247 passed, none skipped.
- `node_modules/.bin/vitest run electron/memory-upgrade-window.test.mjs electron/updater-handoff.electron.test.mjs`: 2 passed; updater runtime test skipped because neither DISPLAY nor xvfb-run is available.
- `node_modules/.bin/tsc -b`: passed.
- Server typecheck: default Node heap exhausted at 4 GB; passed on rerun with `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json`.
- `node scripts/ci-test-tiers.mjs check`: passed, 3479 files (1991 gate, 1488 extended).
- `git diff --check`: passed.

The first broad test run found stale source assertions for the owner quit callback and for closing the upgrade splash. These now check the explicit owner cause callback and retaining the splash, respectively. The new BF tests run under Vitest to give each an enforced tier row. Earlier red logs use their original Node runner names.

Not run here:

- Packaged Linux BF-B2 SIGSTOP stall proof: BOOT-INDEX rig owner a352aafb5d8fe5321 reruns it on the landed SHA.
- Packaged cold-cache BF-B1 compositor proof and native Dock/Cmd+Q interaction; real functions were exercised with substituted Electron windows.
- Updater clipboard/terminal runtime fixture (display unavailable).

The memory prelude tool and .ijfw/memory were unavailable. inputs/BF-STARTUP-bootidx.md and _reviews/D-STARTUP-astra3.md are absent from this checkout; the binding requirements supplied in the user message were used.
