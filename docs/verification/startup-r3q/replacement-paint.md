# Replacement first-paint review fix

The single Low in `../review-findings.md` is confirmed. `replaceMainWindow`
used a 15-second timer to finish a swap before `ready-to-show`. Remove that
fallback and its unused constant; keep the old window until the fresh window
paints. The upgrade splash/recovery path is unchanged.

Regression: `electron/startup-paint.test.mjs`, `replacement waits for first
paint past 15 seconds (visible=true/false)`, executes the real replacement
function in isolated in-memory Electron window fixtures. Both cases assert
that the timer cannot show the fresh window or destroy the old window, then
check that first paint reveals and focuses the replacement and destroys the
old window. The false case covers a pending startup reveal. The existing
gate tier row now describes replacement coverage too.

Red on b763c550ef: 2 failed / 2 passed, with both new cases failing at the
blank-replacement assertion. See `replacement-paint-red.log`.

Green and neighbours:

```sh
node_modules/.bin/vitest run electron/startup-paint.test.mjs electron/memory-upgrade-window.test.mjs electron/startup-settle.test.mjs electron/startup-slow.test.mjs electron/deferred-startup.test.mjs electron/dock-quit.test.mjs electron/quit-causes.test.mjs electron/window-state.test.mjs electron/window-chrome.test.mjs electron/updater-handoff.electron.test.mjs
TMPDIR="$PWD/.verification-tmp" node --import ./server/testing/safe-wipe-preload.mjs --test electron/startup-*.node-test.mjs electron/cloud-link-handoff.node-test.mjs electron/installation-recovery-*.node-test.mjs electron/recovery-messages.node-test.mjs electron/renderer-recovery.node-test.mjs electron/memory-upgrade-status.node-test.mjs electron/quit-reentry.node-test.mjs
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -b
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
node scripts/ci-test-tiers.mjs check
git diff --check
```

Vitest: 49 passed, 0 failed, 1 skipped across 10 files (9 passed, 1 skipped).
Node: 99 passed, 0 failed, 0 skipped. Full outputs are the adjacent
`replacement-paint-vitest.log` and `replacement-paint-node.log`.
Tier check: 3479 files, 1991 gate / 1488 extended.

Not run: the updater Electron runtime fixture requires DISPLAY or xvfb-run;
this container has neither. Native packaged compositor behavior was not
verified by these function tests. The packaged BF-B2 stall rerun remains with
the BOOT-INDEX rig owner, as specified in the original brief.
No live app, user data, or real provider API was used.

Both TypeScript projects passed (exit 0, no diagnostics), with the 8 GiB heap
setting shown above. `git diff --check` passed.
