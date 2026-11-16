# GH21 backup-return cleanup

The historical progress-window/quit fix exists on 7c9ce6fe. A separate
reproducible hang remained in `cleanupDesktopForExit`: `androidStopped`
combines Android shutdown and `localEngineLogin.shutdown()`, and its final
await had no deadline. An engine sign-in that is already ending may still be
waiting for its launch/probe/real-reply operation. Every automatic return joins
that same cleanup promise. The offline-capture ceiling does not end this final
wait: its return path joins the same unfinished return attempt.

The Android/sign-in stage now uses `awaitOwnedWork`, as the other cleanup
stages do. Its 10-second deadline reports uncertainty through the existing
`BACKUP_UPGRADE_CLEANUP_FAILED` recovery screen. It does not authorize a lease
release, force exit, relaunch, duplicate capture or background retry. An explicit
retry after the owned work finishes runs cleanup and releases the lease once.

`electron/gh21-backup-cleanup.test.mjs` executes the actual production cleanup
function with synthetic resource owners and fake timers. No Electron app,
installed engine, user profile or live data is opened. On the baseline, all
four tests fail: stalled sign-in, stalled Android shutdown, retry after
completion, and the real sign-in runner already checking its final reply.
The real runner's child exits, its setup-check request is held, then backup
cleanup calls its actual shutdown method. That joins the existing ending
promise past the owned-work deadline. The synthetic child and request never
open an engine or call a provider. The same cases pass after the fix, retaining
ownership on failure and releasing it once after an explicit retry. Existing
backup-return/quit and Android/sign-in tests remain unchanged.

This establishes and fixes the code-level hang above. The original reporter's
installation/logs are unavailable; its particular remaining cause and packaged
Windows behavior are not claimed verified by these synthetic fixtures.
