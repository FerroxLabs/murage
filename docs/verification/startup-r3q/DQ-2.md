DQ-2 audit: a1d3688456

Red: restored main.mjs, backup-offline-return.mjs, fixtures/browser-closed-shadow.cjs and vendor/electron-updater.cjs from a1d3688456^; ran `node_modules/.bin/vitest run electron/quit-causes.test.mjs`. Scanner found 12 unmarked calls. Full output: DQ-2-red.log.

Green: restored HEAD sources; both scanner tests pass. Tier: all in ci/gate-tests.txt. Source scan only; no live app or data used.
