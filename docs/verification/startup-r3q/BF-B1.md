BF-B1

Red: `node --test electron/startup-paint.node-test.mjs` against main.mjs before this fix: both normal and quiet startup closed the splash at 15 seconds with loadURL pending (BF-B1-red.log).

Green: same command passes both cases. The fixture executes the complete real createWindow function with isolated BrowserWindow and timer substitutes. It advances past 15 seconds, resolves loadURL, then emits ready-to-show. The splash stays until that first-paint signal. Normal startup shows the main window; quiet startup leaves it hidden. No live app or data used. Packaged compositor behavior is not proven by this fixture.

Removed the timed reveal and timed quiet splash close: time alone cannot prove content exists. Tier row: all.

Final gate runner: `node_modules/.bin/vitest run electron/startup-paint.test.mjs`. The test moved from the Node runner to Vitest because ci/gate-tests.txt classifies Vitest files. The red logs retain the original Node command.
