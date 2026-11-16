# Update notifications, 1.0.18 verification

Round 3: lane X1 UPDATE-NOTICE-SYSTEM-NOTIFY, reviewed head `7d90fed41`.
Earlier-round evidence below used base `9e34321e4e`.
Design: `designs/UPDATE-NOTICE-NOTIFY-1018.md`.
No live app, user data, listening ports, commits or pushes were used.
Round 3 ran offline tools; Corepack attempted a pnpm download and failed DNS
resolution. A retry with `COREPACK_ENABLE_NETWORK=0` refused the download.
No dependency was installed.
All filesystem fixtures were isolated under the worktree and cleaned up.

## Earlier-round findings and regression evidence

1. After `authorization.current()` resolves, eligibility is checked again before
   recording a permission request or calling `ensure()`. The same check runs
   after `ensure()`. Deferred-answer tests cover focus, dismissal, installing,
   version replacement and storage failure. Focus, dismissal, installing and
   version replacement all failed against the base before the implementation
   changed: they called `ensure()` after eligibility had been lost.
2. Every enabled resume broadcasts `publicState()` before popup eligibility or
   the silent-check throttle. The updater integration test starts a pending
   check, fails a user download, then resumes twice. Both wakes must send the
   retained error state without requesting a popup. Before the fix, neither
   wake sent anything.
3. The component effect now owns a renderer bridge subscription to locale
   changes and returns cleanup for both locale and notice listeners. Reports
   are translated again on locale change. The main process also uses the latest
   cached words after awaiting permission; its deferred-answer test failed on
   the old English title before the fix. The renderer tests were written before
   extraction and initially failed on the missing bridge module. An additional
   diagnostic run with only the locale subscription disabled failed the language
   test (one report instead of two); the subscription was restored afterward.
4. Removed hand-executed mock React effects and the test that revived a destroyed
   window. Tests now exercise the renderer bridge directly, with real catalog
   subscriptions, cleanup, stale handlers, dismissal and readiness decisions.
   The existing VM integration test now clicks a fake notification through the
   actual `ensureDesktopUpdater`, lifecycle `openWindow`, and `createWindow`
   source wiring. It checks a distinct replacement window receives retained
   state, focus and the popup request, while the old window remains destroyed.
   Write and rename failures use real isolated filesystem fixtures and verify
   the then-current native suppression plus the retained in-app path; X1 receipts
   below supersedes that suppression rule. These passed at base. The pending-check wake regression is described above.

The initial red run had six failed tests, 26 passed, and one failed renderer
suite (the not-yet-created bridge). Added coverage of existing correct behavior
is not presented as a reproduced product bug.

## Earlier-round commands and results

The normal Vitest setup starts a server and requires listening ports. For these
port-free unit/VM/static-render tests, use this temporary worktree config:

```ts
// .notify-vitest.config.mts
import base from './vite.config';
export default { ...base, test: { ...base.test, setupFiles: [] } };
```

```sh
npx --no-install vitest run --config .notify-vitest.config.mts \
  electron/update-notifications.test.mjs electron/updater.test.mjs \
  src/lib/update-notify-bridge.test.ts src/lib/update-card.test.ts \
  src/components/UpdateBanner.test.ts src/components/UpdatePopup.test.ts \
  src/components/UpdateDot.test.ts src/components/UpdateStaleNotice.test.ts
npx --no-install tsc -b
pnpm -s i18n:check
```

Vitest: 82 passed in eight files. Locale validation: passed, eight languages.
TypeScript: passed. `git diff --check`: passed.

## Boundaries and tests requiring another runner

No renderer is mounted in these tests. Popup markup is server-rendered; bridge
subscriptions and pure popup/focus-return decisions execute directly. Existing
source checks cover the popup's absence of autofocus, keyboard-close-only focus
transfer and modal-host integration. Modal ordering has pure fake-element
coverage. These checks do **not** demonstrate browser typing continuity, actual
focus, top-layer ordering or React effect scheduling/cleanup in a mounted app.
The Electron VM test executes real window-creation wiring with fake native
objects; it does not demonstrate native notification delivery or OS activation.

Not run here because listening ports are prohibited: the normal Vitest shared
server fixture, `node --experimental-strip-types scripts/control-murage.ts launch`
and its doctor/interactive checks, and browser/Electron end-to-end workflows
that launch the app server. Any such verification must use the isolated fixture
specified in `docs/verification/README.md`, never the owner's live app/data.
Packaged macOS/Windows/Linux still require permission, denial, native delivery,
suspend/resume, click activation, and mounted typing/modal smoke checks.

Changes remain uncommitted for the shepherd. No staging or commit was attempted.

## Round 3: executable effect boundaries

Removed the two source-substring assertions. `startPopupLatch` now owns the
commit effect; it commits the injected latch once and returns cleanup (no
resources are acquired). `startUpdateNotice` owns the notice effect, including
the live dismissal reader, translation, IPC report adapter, locale subscription
and activation subscription. Both hooks are single-line `useEffect` calls that
return the starter's cleanup. `reportUpdateNotice` is the exported IPC adapter
used by the notice callback and explicit dismissal reports.

Tests call these actual exports with isolated in-memory state, real catalog
subscriptions and an injected updater. They assert the complete IPC payload,
locale refresh, live dismissal, readiness/version gating, latch commit and both
subscription counts. Captured locale and activation callbacks are invoked after
cleanup: neither may report or show anything. The bridge marks itself inactive
before unsubscribing, so already-queued callbacks are inert too.

Seven diagnostic mutations were applied individually, tested and restored.
Each made the renderer suite fail: no-op report adapter; no-op effect report
callback; omitted latch commit; removed locale active guard; removed activation
active guard; omitted locale unsubscribe; omitted activation unsubscribe.
These are behavioral tests, not claims of mounted React coverage.

### Round 3 commands and results

The temporary `.notify-vitest.config.mts` above disables only shared setup,
which starts a listening server. Both requested Vitest commands therefore need
`--config .notify-vitest.config.mts` in this sandbox. No DOM library was added.
All temporary HOME, TMPDIR and npm cache paths were under `.notify-run/` inside
the worktree; npm ran with `npm_config_offline=true`.

```sh
npx vitest run src/lib/update-notify-bridge.test.ts --config .notify-vitest.config.mts
npx vitest run electron/update-notifications.test.mjs --config .notify-vitest.config.mts
npx vitest run src/lib/update-card.test.ts --config .notify-vitest.config.mts
npx tsc -b
pnpm -s i18n:check
node scripts/generate-locale.mjs --check
```

Renderer bridge: 8 passed. Notifications: 23 passed. Existing card: 18 passed.
The exact pnpm command is blocked by the absent cached pnpm 10.33.0; the direct
script from `package.json` passes (8 languages, 4065 English strings).
TypeScript: passed, including a rerun after restoring all mutations.
`git diff --check`: passed. Temporary config, caches and mutation logs were
removed after verification; only the four intended source/test/doc files remain
modified and uncommitted.

### Packaged-app proof still required: one row per hook decision

These checks have **not** run here. Unit tests do not prove the hook's dependency
selection, effect ordering, store subscription or mounted cleanup. On a runner
that permits ports, use an isolated packaged QA installation with a disposable
home/data directory, fake update feed containing two distinct versions A and B,
and OS notifications enabled. Follow the isolation rules in
`docs/verification/README.md`; its server harness alone cannot drive the updater
UI. Use a packaged build with the updater enabled, not the owner's installation.
Keep a screen recording and the fixture's updater/IPC log for each row. Reset
only that fixture's notification receipts between native-notice cases.

| Decision still in `useUpdatePopup` | Exact actions in the packaged fixture | What the person sees / records |
| --- | --- | --- |
| Subscribe to the popup store and read its snapshot | Download A; while progress is visible click Later, then the round update button beside the account menu. | Popup hides, then returns with current progress without navigating or reloading. |
| Derive the render latch from stored latch and updater state | Check for A; click Download; click Later before it finishes; wait for completion. | Availability alone does not open the popup; download opens it; Later hides progress; readiness reopens it once. |
| Memoize latch dependencies and run the commit effect before notice setup | Finish A; click Later on the ready popup; close the application window without quitting; reopen it from the dock/tray. | A's ready popup stays dismissed; the fixture log records the saved ready dismissal, never an intervening undismissed report for that mount. |
| Select notice dependencies: status, version and closed state | Download A, dismiss its ready popup, then offer B from the fixture feed; check and download B. | Progress cannot be activated as ready; dismissing A reports dismissed=true without a version change; B produces its own report and ready popup. |
| Supply live latch reader, translator, updater, locale subscription and show action | With A ready and undismissed, open Settings and change Language to German; minimize the window, trigger a fresh eligible ready notice in the fixture, then click the OS notification. | IPC log shows a German title for A after the language change; the notification uses that title; clicking it restores/focuses the window and shows A's ready popup. |
| Return the notice effect's cleanup on dependency replacement | Stay in one window: do not close it, reload or quit. Download A to ready, which replaces the effect's dependencies at each status change. Click Later on the ready popup, which replaces them again. Note the fixture log's report count. Change Language once. | The log gains exactly one report for that language change, in the new language. Dropping the cleanup gives one report per earlier subscription, so a count above one fails this row. |
| Return the effect cleanups on unmount | Not reachable from a person's steps if `UpdateBanner` stays mounted for the renderer's life: destroying the renderer removes its listeners with or without the cleanup. Proven by the `startUpdateNotice` and `startPopupLatch` cleanup tests only. | Nothing to see. This row records that packaged steps cannot prove it. |
| Return visibility from the derived latch and current status | In a fresh fixture check for A, download it, click Later at ready, then check again without offering B. | No popup in idle/checking or availability alone; progress/ready are visible until dismissed; another check does not revive dismissed A. |

Tests requiring listening ports and therefore not run: default Vitest shared
server setup, isolated `control-murage.ts launch` plus doctor checks, and
browser/Electron/package workflows that start the application server, including
the table above. Native permission/denial/delivery and mounted focus/modal checks
remain packaged-runner verification boundaries, not unit-test claims.

## Review round: X1 UPDATE-NOTICE at 90f6d570b

All six findings were confirmed. No server or conversation code changed, and no
live app/data was used. No network, commit or push was used. Temporary homes,
receipt fixtures, npm cache and TMPDIR were inside this worktree. No product
strings or locale keys changed.

The receipt now flushes its file descriptor before closing and renaming, then
attempts a directory flush. The X1 receipts rule below supersedes the earlier
failure behavior: show precedes the notification receipt, file failures keep
in-memory receipts dirty, and every directory error leaves rename success intact. Permission receipts are saved only
for completed authorized/denied/not-required answers. Pending attempts retain
process exclusivity; only a different undismissed version gets a follow-up.
Window blur/hide/minimize retry the retained report, and all four window
listeners are detached on retarget. Minimized windows count as background.

Snapshot audit: all sections (`base`, `note`, `handles`, `ons`, `bridgeMembers`)
were inspected. `handles` already contains `update:notice-report`.
`update:notice` is a main-to-renderer event subscribed to in preload, not a main
handler, so it does not belong in `handles` or `ons`. The missing sorted bridge
members were `updater.onNotice()` and `updater.reportNotice()`.

### Regression evidence

Each mutation below was applied to the working-tree source, tested, and restored.
No existing assertion was weakened. Focused-window fixtures now explicitly say
that they are not minimized, and completed permission fixtures supply their
finished status.

| Item | Removed fix / diagnostic mutation | Observed failure |
| --- | --- | --- |
| 1 | Restore original updater window wiring | All three blur/hide/minimize cases expected one show but got zero. |
| 1 | Remove minimized-background check alone | Minimize case expected one show but got zero. |
| 2 | Remove different-version follow-up | Existing version case expected one notice but got zero; newer-report-during-ensure case also failed. |
| 3 | Restore permission receipt write before ensure | Actual child process exits with code 42 inside ensure; restarted controller expected one ensure call but got zero. All three unfinished-status cases expected two calls but got one. |
| 4 | Restore original snapshot | Bridge deep equality fails on the two missing members; restored snapshot passes that same test. Inventory failures below occur both before and after. |
| 5 | Restore original write/rename save implementation | All three durable-receipt cases fail: first operation is writeFileSync instead of openSync. Tests also assert descriptor mode, write/fsync/close/rename/directory order, the then-current suppression after file-sync failure and tolerance of unsupported directory sync (superseded by X1 receipts below). |
| 6 | Delete post-ensure `|| !eligible()` | Focus, dismissal, install and version cases each expected zero notices but got one. Restored guard passes, with empty notified receipts. |

Offline Vitest command (local installed dependency only):

```sh
npx --no-install vitest run electron/update-notifications.test.mjs electron/updater.test.mjs --config .notify-run/vitest.config.mts
```

The temporary config selected the Node environment and `electron/*.test.mjs`,
without the shared setup that starts an application server. Final result: 47
passed in two files. This is isolated unit/VM/child-process proof, not native
notification delivery. No server-compiled inputs changed, so server tsc was not
required.

The requested `node --test` parity and IPC-class runs initially failed because
the sandbox rejected default spawnSync stdin (`EPERM`). The diagnostic rerun
used `--experimental-test-isolation=none` and a temporary preload that made
spawnSync inherit stdin and removed NODE_TEST_CONTEXT from child environments;
it changed no assertions or application code. The same runner was used before
and after restoring all three original source/snapshot files, for:

```sh
node --test --experimental-test-isolation=none \
  electron/cloud-flag-off-parity.node-test.mjs electron/ipc-channel-classes.node-test.mjs \
  electron/updater-coordinator.node-test.mjs electron/updater-visible.node-test.mjs \
  electron/updater-restart.node-test.mjs electron/updater-staging.node-test.mjs \
  electron/updater-candidate.node-test.mjs electron/notification-authorization.node-test.mjs \
  electron/background-lifecycle.node-test.mjs electron/main-ipc-trust.node-test.mjs \
  electron/packaged-bare-imports.node-test.mjs
```

Before: 113 passed, 7 failed. After: 114 passed, 6 failed. The removed failure is
the bridge parity assertion. Remaining failures at both heads: parity's channel
inventory and the IPC-class file receive no inventory from their child; the
main-IPC-trust child produces no expected result; three updater-staging tests
execute extracted startup code without defining `updateNotificationsEnabled`.
These suites are not claimed green. The installed Node is 22.21.1; the project
requires Node >=24. No dependencies were fetched. Temporary runner files and
logs were removed after recording these results.

### Additional packaged-app proof still required

Use the disposable packaged QA installation described above, never the owner's
installation. These rows have not been executed here.

| Decision | Exact actions in the isolated packaged fixture | Expected evidence |
| --- | --- | --- |
| Retry focused readiness on blur, hide and minimize | With permission granted, download A while the window stays focused. Confirm no OS notice. Move focus to another app, then hide and minimize the window; repeat with fresh fixture receipts so each of those three actions is first. Also repeat after granting permission in a dialog that returns focus to the app. | Exactly one native notice per ready version after the first background transition, none from subsequent transitions. Retarget/reopen the window and verify only the current window triggers retries. |
| Recover from quitting/crashing during permission | In a fresh fixture with OS permission not determined, download A in background, open the permission dialog, then terminate only the fixture process before answering. Restart the same fixture, still with permission undetermined, and report A again. | The unfinished prompt did not persist permissionRequested=true; ensure is called once on restart, never twice concurrently. After answering, the completed status is persisted and an authorized eligible A notifies once. |

## X1 receipts build at fc4af608ba (BUILD-FIX 1–7)

This section supersedes earlier receipt-failure expectations and is the current
failure table. `show()` runs before the notification receipt write; a permission
receipt can precede `show()`. “Shown” means handed to the OS, not proven display.
With only disk failures there is one notification per version per launch. An OS
throw after acceptance or a late `failed` can cause same-launch duplicates, up to
three constructor attempts per version. No timer or same-version inline retry
is introduced. Counts reset on restart; unsupported notifications and rejected
or throwing authorization consume no attempt.

The temp file is opened with mode 0600, written, flushed, closed and renamed.
Directory open, flush and close are best effort after the rename. Unsupported
codes and EIO/EACCES alike cannot change a landed rename into save failure.
Power loss can lose that rename and cause a duplicate on restart; the same
limit applies to permission and dismissal durability. No rarity claim is made.
`dirty` retries on the next valid report before eligibility/cap checks, and any
other save writes all records. Rejected reports neither read for recovery nor
write. Invalid JSON/schema may be replaced; non-ENOENT read errors require a
reread before any save and preserve disk contents while unreadable. Recovery
unions dismissals and notified versions (excluding this launch's take-backs),
and ORs permissionRequested. There is no writable latch.

| Failure / decision | Disk | Memory / notification | Retry or limit |
| --- | --- | --- | --- |
| Crash before show | Not listed | None | Next launch |
| Crash after show before receipt lands | Not listed | Shown | Duplicate on restart accepted |
| Constructor, handler attach or show throws | No new receipt | Terminal failed attempt; rollback only its own receipt/active entry | Next report, at most 3 constructor attempts/version |
| Synchronous failed during show | No new receipt | Terminal failed; no insertion after show returns | Next report under cap |
| Failed event after save | Receipt taken back if save succeeds | Removed; idempotent rollback, no dismissal removal | Next report under cap |
| Ordinary or stale close | Receipt kept | Only identity-matching active entry removed | No notification retry from close |
| Temp open/write/file flush/file close/rename fails | Previous contents kept | Listed and dirty; shown | Next valid report saves; no duplicate from disk alone |
| Directory open/flush unsupported | Renamed contents | Listed; shown; save true | No recovery needed |
| Directory open/flush other error, including EIO/EACCES | Renamed contents, power-loss limit | Listed; shown; save true | Later saves still work |
| Directory close fails | Renamed contents, same limit | Listed; shown; save true | Later saves still work |
| Take-back save fails | Previous contents kept, possibly still listed | Removed and dirty; failed | Next valid report saves even at cap; restart before recovery reads stale receipt and stays silent |
| Invalid parse or schema | Left until successful save | Empty initially, dirty | May replace invalid file |
| Read EIO/EACCES | Preserved until reread succeeds | Notifications allowed, dirty | Reread before save, merge on recovery; once/version/launch while unreadable |
| Permission save fails | Previous contents kept | Answer held in memory; eligibility rechecked and authorized notice allowed | ensure once/launch; later save recovers |
| Dismissal save fails | Previous contents kept | Dismissed, silent this launch | Later save recovers; may be lost on restart |
| Unsupported notifications or authorization rejects/throws | No new receipt | No constructor attempt | Later report may reconsider |
| Cap reached, dirty | Recovery save allowed | No constructor or attempt-related write | Other versions independent; new launch resets cap |

Every rule below names an executable regression test. These are coverage mappings,
not claims of passing tests or failing-first proof. The lane owner runs mutations
and the process tests on the rig. All receipt fixtures are isolated under the
worktree; no live app or provider is involved.

| Design test / BUILD-FIX | Rule and named test (electron/update-notifications.test.mjs unless noted) |
| --- | --- |
| 1 / BF7 | Permission write distinguished from receipt: `show precedes the notification receipt, independently of the permission write`; crash window: `a process exiting after show before the receipt can notify on restart` |
| 2 / BF1 | Constructor throw counts before an object exists: `construct failure leaves no receipt and retries only on a later report` |
| 3 / BF1,6 | Attach/show throw and synchronous failure: parameterized `… failure leaves no receipt and retries only on a later report`; `throw then late failed and stale close preserve replacement ownership` |
| 4 / BF1 | `failed rollback is idempotent; stale events cannot remove a replacement`; `ordinary close keeps the receipt` |
| 5 / BF2 | `three constructor attempts cap each version independently and restart resets the cap`; cap recovery covered by test 10 |
| 6 / BF6,7 | `… failure allows only one notification per version per launch` covers temp open, write, file flush, file close, rename; no receipt and no second notice this launch |
| 7 | `next report recovers a failed save without another notification` |
| 8 / BF5,7 | `directory %s handles %s by platform`: open, flush, close × EIO/EACCES and every unsupported code × Linux/macOS/Windows; later version saves, restart silent |
| 9 / BF7 | Same full platform/error matrix retains EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS/EISDIR/EPERM; `durable receipt order: …` retains descriptor/order checks |
| 10 / BF2,4,7 | `cap still permits next-report recovery of a failed take-back save; restart before recovery stays silent`: the next valid report triggers recovery, fourth attempt forbidden, no write once clean |
| 11 / BF3 | `… read errors preserve valid disk records and merge recovery`; `a first-read error recovers a dismissal before constructing a notification`; `invalid receipts %s are replaced without suppressing notices`; `%s receipts are recovered by a focused report without constructing a notification`; `a %s failure during a read error keeps the receipt an earlier launch left on disk`: only a receipt this launch's attempt wrote is taken back |
| 12 / BF5,7 | `failed permission saves still allow authorized notification and ensure once per launch`; existing post-ensure eligibility and unfinished-answer tests retained |
| 13 / BF1,5,7 | `failed dismissal save during ensure stays silent through answer, recovery and recovered restart`; `failed rollback is idempotent; stale events cannot remove a replacement` checks late failed retains dismissal |
| 14 / BF7 | `Cloud preload has no updater bridge and remains wired from main to Cloud windows` in existing electron/main-ipc-trust.node-test.mjs: forbids updater/update:/reportNotice and pins main.mjs supply plus cloud-home-window.mjs use of preload-cloud.cjs |
| BF5 | `unsupported/denied/throws consumes no attempt or receipt`: four rejected reports cannot spend constructor budget or write a receipt |

No new test file was introduced; the existing notification suite is already in
ci/gate-tests.txt. Cloud coverage extends the existing node:test IPC trust suite.
Native delivery, permission UI, process-crash proof and failing-first mutation
proof remain rig responsibilities. Server/conversation workflows were not
changed or claimed verified; any such checks must launch the isolated fixture
from docs/verification/README.md.

### This sandbox's observed checks

`node --check` passed for update-notifications.mjs,
update-notifications.test.mjs and main-ipc-trust.node-test.mjs.
`node scripts/ci-test-tiers.mjs check` passed: 3488 files, 2000 gate,
1488 extended. `git diff --check` passed.

One local dependency invocation was attempted:

```sh
node node_modules/vitest/vitest.mjs run electron/update-notifications.test.mjs -t '^(?!.*process exiting)'
```

Vitest 4.1.10 stopped in server/testing/setup.ts:132 / ports.ts:36 with
`no free port block for offsets 0 in 19600..22600`: one failed suite, zero tests
run. No retry, alternate setup, build, install or provider call was made.
The process cases and node:test suite were not run. No runtime pass or
failing-first result is claimed for this build. Changes remain uncommitted.
