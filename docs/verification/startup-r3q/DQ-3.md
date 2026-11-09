DQ-3 audit: e9c0a68802

This commit only renames the test. Its parent already asserts ["relaunch", "release", "exit 0"], so reverting this commit passes all eight tests; it is not a behavioral fix.

Red: temporarily restored the rejected assertion ["release", "relaunch", "exit 0"] and ran `node --test electron/cloud-link-handoff.node-test.mjs`. The assertion failed on actual relaunch-before-release. Full output: DQ-3-red.log.

Green: restored the agreed assertion; all eight tests pass. Tests use temporary stash directories, no live app or data.
