BF-B2

Red: `node --test electron/memory-upgrade-window.node-test.mjs` before the fix: both timeout and blocked-child exit reached app.quit before recovery (BF-B2-red.log).

Green: same command passes both cases. The isolated fixture executes the complete real startServerOn, closeMemoryUpgradeWindow, closeStartupSplash, window-all-closed handler, showDesktopRecovery and openInstallationRecoveryWindow. Electron windows, utility child and health polling are substituted. A delayed window-all-closed event runs after the splash close guard expires while stopping the child. Recovery is visible and exists before the splash closes; quit is never called. No live app or data used. Tier row: all.

The upgrade completion function now resets upgrade state without closing the splash. The existing recovery creation or main-window first paint owns that close, including retry and thrown startup errors.

Not run here: packaged Linux BF-B2 SIGSTOP stall proof. BOOT-INDEX rig owner a352aafb5d8fe5321 reruns it on the landed SHA.

Final gate runner: `node_modules/.bin/vitest run electron/memory-upgrade-window.test.mjs`. The test moved from the Node runner to Vitest because ci/gate-tests.txt classifies Vitest files. The red logs retain the original Node command.
