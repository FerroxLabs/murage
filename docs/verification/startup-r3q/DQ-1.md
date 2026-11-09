DQ-1 audit: f4a0eaed14

Red: restored main.mjs and startup-settle.mjs from f4a0eaed14^, retained the regression test, ran `node_modules/.bin/vitest run electron/dock-quit.test.mjs`. Both cases failed: null instead of unclassified. Full output: DQ-1-red.log.

Green: restored HEAD sources; the same two tests pass, including cleanup failure, no A7 surface and no new window. Tier: all in ci/gate-tests.txt. Isolated VM fixtures; no live app or data used.
