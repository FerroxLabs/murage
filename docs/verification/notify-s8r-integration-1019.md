# S8R integration verification

Integration base: c12aaad9341e8f87126a193f35b5c2768f0aa66f. Incoming S8R: 886fc55b7d298b32df65a9d87ffe8c33d2eb24a9.

All runs use the isolated lane container recipe, or its equivalent network-disabled Node test runner. No live app or user data was used. These automated fixture results do not establish native desktop interaction on macOS or Windows.

## Result

The resolved integration has 512 passing Node tests and 275 passing targeted Vitest tests. Nine targeted HTTP failures have identical names on the unchanged integration base and head; the native Electron notice fixture is skipped. Full Vitest is NO RESULT on both trees after the prescribed five-hour timeout. The capability-database generator check also fails on both trees. These validation blockers remain explicit; the focused results do not establish full-suite 0-NEW or native desktop acceptance.

GH #24 was absent from the integration-base router for global app focus. The new focus gate is `electron/attention-router.mjs:33`, used by the card/receipt/plain routes and quiet release. `electron/attention-main.mjs:213` and its native fallback checks preserve that gate across asynchronous preparation.

## Artifact references

Paths beginning with `out/` refer to files in the lane verification artifact bundle, relative to its root. Download or unpack that bundle to inspect the logs; they are run artifacts, not files shipped in this checkout. This convention also applies to the fix-round logs below.

## Fix-round verification

Review baseline: `0d8cb9784f118639c9627874bd5623d9a361ba44` (the reviewed merge, with the new tests added before implementation).

- Auxiliary-window focus: `electron/attention-delivery.node-test.mjs` exercises the real tray-panel factory and attention-delivery core with an injected Electron window fixture. `GH24 {linux,darwin,win32}: main-to-tray focus keeps approvals in app and releases on hide or close` failed with `notify !== counts` in `out/ofix-red-focus.log` (rc=1). The auxiliary native-preparation and fallback tests also failed on banner count `1 !== 0` and fallback permission `true !== false`; the desktop-composition guard failed because the focus dependency was absent. Existing tests passed.
- Portable evidence: `scripts/notification-evidence.test.mjs` test `S8R verification evidence uses portable artifact references` failed with nine private paths instead of an empty list in `out/ofix-red-paths.log` (FILE rc=1; the recipe wrapper returns 0 independently of individual file failures). The test is registered in `ci/gate-tests.txt`.
- GREEN: `out/ofix-green-focus.log` passes all 132 tests across delivery, main, router, tray-panel, Linux-banner wiring and main IPC trust (rc=0), including all six new focus guards. `out/ofix-green-paths.log` passes the portable-evidence test (1 test, FILE rc=0) and `scripts/release-workflows.test.mjs` (81 tests, FILE rc=0), including test-tier registration.
- TypeScript: application and server checks both return 0 (`out/ofix-tsc.console.log`, overall `out/ofix-tsc.rc` is 0). The local recipe adds a tsc-only mode using the same container flags; all test starts require load below 60 and at most two lane containers. No full suite was run in this fix round; the full comparison is queued separately after push.
- Main now supplies Electron's current application-window focus to the shared banner gate. Every routing and asynchronous presentation check includes auxiliary windows, while existing session-owned visibility checks remain. Reading current focus avoids stale window-lifecycle bookkeeping and notification-history scans.

## RED evidence

The integration base lacks the pill module. Its import failure is not counted as RED evidence. Pill regressions were run against the original S8R parent 0199b7c69. The rev 2.1 and rev 2.2 component baselines used AttentionCard from 8354a9740 and fd1997285 respectively, with the final test fixtures and shared reader/Pill plumbing unchanged from those revisions. These component checks were not whole-tree checkouts of rev 2.1 or rev 2.2. T1d/F1d/F2 and host/reader/race tests also ran against the integration base before implementation.

Missing-method failures for the new draft API are not counted as behavioural RED evidence; renderer draft tests cover that behaviour. The R1d fixture uses an optional draft setter so its re-read assertion runs on the base.

### red-node (integration base)

Raw log: `out/red-node.log`

- not ok 5 - refreshes retain card identity, coalesce pushes into one drain, and publish every accepted commit

    |-
        an accepted commit is never hidden behind a later read

        false !== true

- not ok 10 - R1 a superseded read is a wait: nothing is ever published as failed or empty and the fresh data lands

    'publications: [[false,false],[true,true],[true,true]]'

- not ok 11 - R2 a superseded read with no push queued still reads again

    |-
        Expected values to be strictly equal:
        + actual - expected

        + null
        - {
        -   chief: {
        -     name: 'Chief'
        -   },
        -   items: [
        -     {
        -       actionToken: 'old-action',
        -       cardId: 'card',
        -       display: {
        -         title: 'Private request'
        -       },
        -       openToken: 'old-open'
        -     }
        -   ],
        -   ok: true,
        -   receipts: [
        -     {
        -       text: 'Private receipt'
        -     }
        -   ],
        -   running: [
        -     {
        -       doing: 'Private work'
        -     }
        -   ]
        - }

- not ok 13 - R3 a result whose integer rev is not newer than the applied one is read again, not applied

    |-
        stale rev published

        true !== false

- not ok 15 - R4 eight misses publish stalled once, keep data and drafts, then back off and recover with no push

    |-
        eight reads before the stall

        2 !== 9

- not ok 16 - R4 dispose during a backoff cancels the timer and reads no more

    |-
        Expected values to be strictly equal:

        0 !== 1

- not ok 17 - R6 a redacted commit is published even while a push is queued, and drafts are gone while stalled

    |-
        Expected values to be strictly equal:

        'card' !== 'redacted'

- not ok 18 - R7 under continuous pushes every accepted commit is published and the miss count resets

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

        + []
        - [
        -   2,
        -   3,
        -   4
        - ]

- not ok 20 - X1 a retaining push during a pending read keeps the card, its draft and a working action token

    'a publication blanked the data: [[false,false],[true,true],[false,false],[false,false]]'

- not ok 23 - four live receipts obey each surface's limit and floating content filter

    |-
        pill
        + actual - expected

          [
            {
        -     text: 'Finished 1'
        -   },
        -   {
              text: 'Finished 2'
            },
            {
              text: 'Finished 3'
            },

- not ok 31 - H1 a push (retainCards) during a pending read supersedes it, mints nothing, and the next read keeps the cardId

    |-
        Expected values to be strictly equal:
        + actual - expected

        + 'd81685f88c721ac0d450fa988fc27206'
        - '5e4ed476c5b7dc261104bcd993ebcbd0'

- not ok 32 - H2 a discard (plain invalidateWindow) during a pending read is reported as discarded and drops identity

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

          {
            ok: false,
        +   reason: 'superseded'
        -   reason: 'discarded'
          }

- not ok 33 - H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot item's cardId across a pending read

    |-
        Expected values to be strictly equal:
        + actual - expected

        + '5b2c9cf959c83a33ae505f2eac09150d'
        - '19c47808ebaa3978ffc99c8ed56c8e02'

- not ok 35 - H4 rev strictly increases over commits and refused results carry none

    'a commit carries an integer rev'

- not ok 37 - H6 (A then B) only the newest concurrent read commits; the older one mints nothing and identity carries over

    |-
        Expected values to be strictly equal:
        + actual - expected

        + '36d1849129d63e2551c15478564c16b9'
        - '4283f943082cf1c8961e9e4fe728645c'

- not ok 38 - H6 (B then A) only the newest concurrent read commits; the older one mints nothing and identity carries over

    |-
        Expected values to be strictly equal:
        + actual - expected

        + '5535406b918d46cd3a4386751c2257b3'
        - '739122ad4ba935c95429be0729f07cde'

- not ok 41 - H6c a read pending across a discard cannot commit into the replacement record

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

          {
            ok: false,
        +   reason: 'superseded'
        -   reason: 'discarded'
          }

### red-renderer (integration base)

Raw log: `out/red-renderer.log`

- src/attention-ui/AttentionPanel.test.tsx > attention panel > keeps a typed reply through a pending push and fresh tokens for the same card
  - AssertionError: expected false to be true // Object.is equality
- src/attention-ui/AttentionPanel.test.tsx > attention panel > T1d keeps a typed reply when a push lands during a pending read that comes back superseded
  - AssertionError: expected undefined to be 'Please wait for my notes' // Object.is equality
- src/float/FloatPanel.test.tsx > F1d keeps a Reply on the selected bot card when a push overlaps a read that comes back superseded
  - AssertionError: expected undefined to be 'Float draft' // Object.is equality
- src/float/FloatPanel.test.tsx > F2 restores a Reply when the bot card is collapsed and chosen again with the same cardId
  - AssertionError: expected undefined to be 'Float draft' // Object.is equality

### red-original-node (0199b7c69)

Raw log: `out/red-original-node.log`

- not ok 5 - refreshes retain card identity, coalesce pushes into one drain, and publish every accepted commit

    |-
        an accepted commit is never hidden behind a later read

        false !== true

- not ok 10 - R1 a superseded read is a wait: nothing is ever published as failed or empty and the fresh data lands

    'publications: [[false,false],[true,true],[true,true]]'

- not ok 11 - R2 a superseded read with no push queued still reads again

    |-
        Expected values to be strictly equal:
        + actual - expected

        + null
        - {
        -   chief: {
        -     name: 'Chief'
        -   },
        -   items: [
        -     {
        -       actionToken: 'old-action',
        -       cardId: 'card',
        -       display: {
        -         title: 'Private request'
        -       },
        -       openToken: 'old-open'
        -     }
        -   ],
        -   ok: true,
        -   receipts: [
        -     {
        -       text: 'Private receipt'
        -     }
        -   ],
        -   running: [
        -     {
        -       doing: 'Private work'
        -     }
        -   ]
        - }

- not ok 12 - R1d a superseded read waits for its re-read: nothing is published as empty or failed, the old data and draft stay, refreshing stays true

    |-
        the superseded read and exactly one re-read

        1 !== 2

- not ok 13 - R3 a result whose integer rev is not newer than the applied one is read again, not applied

    |-
        stale rev published

        true !== false

- not ok 15 - R4 eight misses publish stalled once, keep data and drafts, then back off and recover with no push

    |-
        eight reads before the stall

        2 !== 9

- not ok 16 - R4 dispose during a backoff cancels the timer and reads no more

    |-
        Expected values to be strictly equal:

        0 !== 1

- not ok 17 - R6 a redacted commit is published even while a push is queued, and drafts are gone while stalled

    |-
        Expected values to be strictly equal:

        'card' !== 'redacted'

- not ok 18 - R7 under continuous pushes every accepted commit is published and the miss count resets

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

        + []
        - [
        -   2,
        -   3,
        -   4
        - ]

- not ok 20 - X1 a retaining push during a pending read keeps the card, its draft and a working action token

    'a publication blanked the data: [[false,false],[true,true],[false,false],[false,false]]'

- not ok 31 - H1 a push (retainCards) during a pending read supersedes it, mints nothing, and the next read keeps the cardId

    |-
        Expected values to be strictly equal:
        + actual - expected

        + 'ef7ad4e87f1c9e89be0ab1deb57dc158'
        - '5bc4dfe86e0e72c3ccb620ddb810e7e2'

- not ok 32 - H2 a discard (plain invalidateWindow) during a pending read is reported as discarded and drops identity

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

          {
            ok: false,
        +   reason: 'superseded'
        -   reason: 'discarded'
          }

- not ok 33 - H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot item's cardId across a pending read

    |-
        Expected values to be strictly equal:
        + actual - expected

        + '3134707214c6ea372679f96ef3251b5a'
        - 'c179072d19c54c2a355fbce2710658c0'

- not ok 35 - H4 rev strictly increases over commits and refused results carry none

    'a commit carries an integer rev'

- not ok 37 - H6 (A then B) only the newest concurrent read commits; the older one mints nothing and identity carries over

    |-
        Expected values to be strictly equal:
        + actual - expected

        + 'aa6d7da25a3e8ebfc106db6917952718'
        - '68b294e7566310393f52cf76f2e755f6'

- not ok 38 - H6 (B then A) only the newest concurrent read commits; the older one mints nothing and identity carries over

    |-
        Expected values to be strictly equal:
        + actual - expected

        + '2762607970377c9a3dab365cd2569446'
        - 'bf2407570b32340909680c10987205b9'

- not ok 41 - H6c a read pending across a discard cannot commit into the replacement record

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

          {
            ok: false,
        +   reason: 'superseded'
        -   reason: 'discarded'
          }

- not ok 61 - PW1 the real pill surface retains cards on a stack change and discards on hideAll, closed and dispose

    |-
        hideAll discards
        + actual - expected

          [
            1,
        +   {
        +     retainCards: true
        +   }
          ]

### red-original-pill (0199b7c69)

Raw log: `out/red-original-pill.log`

- src/pill/Pill.test.tsx > pill > P1d keeps a Reply in an expanded stack through a superseded read while the re-read is still pending
  - AssertionError: expected undefined to be 'Keep these words' // Object.is equality
- src/pill/Pill.test.tsx > pill > P2 restores a Reply when the stack collapses and expands again with the same cardId
  - AssertionError: expected undefined to be 'Draft survives' // Object.is equality
- src/pill/Pill.test.tsx > pill > P4a focus moved elsewhere during a refresh stays there after recovery (Chromium blur-on-disable path)
  - AssertionError: expected false to be true // Object.is equality
- src/pill/Pill.test.tsx > pill > P4b a click on a non-focusable area during a refresh is not undone by recovery
  - AssertionError: expected false to be true // Object.is equality
- src/pill/Pill.test.tsx > pill > P4g guard: a plain refresh recovery gives the field its focus back
  - AssertionError: expected false to be true // Object.is equality
- src/pill/Pill.test.tsx > pill > P4f switching windows keeps the place in the field across a refresh
  - AssertionError: expected <body><div>…(1)</div></body> to be <textarea id="_r_1q_" …(3)></textarea> // Object.is equality
- src/pill/Pill.test.tsx > pill > P8 an obsolete refusal does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8t an obsolete throw does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8f an owned refusal after a token refresh falls back to the current Open authority
  - AssertionError: expected [ 'focus', 'open' ] to deeply equal [ 'focus', 'fresh-open' ]
- src/pill/Pill.test.tsx > pill > P10 a stale act refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null
- src/pill/Pill.test.tsx > pill > P11 a stale Open refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null

### red-rev21-pill (8354a9740)

Raw log: `out/red-rev21-pill.log`

- src/pill/Pill.test.tsx > pill > P3 keeps words typed while the focus request is pending (the card never writes a stale draft back)
  - AssertionError: expected 'Draft survives' to be 'Draft survives, edited' // Object.is equality
- src/pill/Pill.test.tsx > pill > P4a focus moved elsewhere during a refresh stays there after recovery (Chromium blur-on-disable path)
  - AssertionError: expected <textarea id="_r_1i_" …(3)></textarea> to be <input></input> // Object.is equality
- src/pill/Pill.test.tsx > pill > P4b a click on a non-focusable area during a refresh is not undone by recovery
  - AssertionError: expected <textarea id="_r_1k_" …(3)></textarea> not to be <textarea id="_r_1k_" …(3)></textarea> // Object.is equality
- src/pill/Pill.test.tsx > pill > P4f switching windows keeps the place in the field across a refresh
  - AssertionError: expected <body><div>…(1)</div></body> to be <textarea id="_r_1q_" …(3)></textarea> // Object.is equality
- src/pill/Pill.test.tsx > pill > P5 focus moved elsewhere during the focus request is not stolen back
  - AssertionError: expected <textarea id="_r_1u_" …(3)></textarea> to be <input></input> // Object.is equality
- src/pill/Pill.test.tsx > pill > P7 a deferred Reply on an unmounted card writes nothing after a remount
  - AssertionError: expected 'Draft survives' to be 'Edited after remount' // Object.is equality
- src/pill/Pill.test.tsx > pill > P8 an obsolete refusal does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8t an obsolete throw does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8f an owned refusal after a token refresh falls back to the current Open authority
  - AssertionError: expected [ 'focus', 'open' ] to deeply equal [ 'focus', 'fresh-open' ]
- src/pill/Pill.test.tsx > pill > P10 a stale act refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null
- src/pill/Pill.test.tsx > pill > P11 a stale Open refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null

### red-rev22-pill (fd1997285)

Raw log: `out/red-rev22-pill.log`

- src/pill/Pill.test.tsx > pill > P7 a deferred Reply on an unmounted card writes nothing after a remount
  - AssertionError: expected 'Draft survives' to be 'Edited after remount' // Object.is equality
- src/pill/Pill.test.tsx > pill > P8 an obsolete refusal does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8t an obsolete throw does not clear or replace a newer Reply request
  - AssertionError: expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]
- src/pill/Pill.test.tsx > pill > P8f an owned refusal after a token refresh falls back to the current Open authority
  - AssertionError: expected [ 'focus', 'open' ] to deeply equal [ 'focus', 'fresh-open' ]
- src/pill/Pill.test.tsx > pill > P9 the Reply-typing-off fallback cancels the focus intent
  - AssertionError: expected <textarea id="_r_2i_" …(3)></textarea> not to be <textarea id="_r_2i_" …(3)></textarea> // Object.is equality
- src/pill/Pill.test.tsx > pill > P10 a stale act refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null
- src/pill/Pill.test.tsx > pill > P11 a stale Open refusal after a token refresh shows nothing
  - AssertionError: expected 'That request changed. Open it in Mura…' to be null

### red-gh24-final (integration-base router)

Raw log: `out/red-gh24-final.log`

- not ok 3 - rule 1: on screen is nothing outside for new installs (approvals too); focused upgrades keep approvals in app

    |-
        Expected values to be strictly equal:

        'notify' !== 'counts'

- not ok 23 - GH24 new: Murage focus keeps other conversations in app without OS banners

    |-
        approval: S3R decision

        'notify' !== 'counts'

- not ok 24 - GH24 upgrade: Murage focus keeps other conversations in app without OS banners

    |-
        approval: S3R decision

        'notify' !== 'counts'

- not ok 25 - GH24 focused Murage keeps pill and pinned bubble available without escalating to a banner

    |-
        Expected values to be strictly deep-equal:
        + actual - expected

          [
            'pill',
        +   'notify'
        -   'bubble'
          ]

- not ok 26 - GH24 quiet release while Murage is focused stays in app

    |-
        Expected values to be strictly equal:

        1 !== 0

### red-focus-continuations (integration-base presenter with focused routing)

Raw log: `out/red-focus-continuations.log`

- not ok 46 - GH24 focus during native preparation keeps the pending request in app

    |-
        focus acquired during preparation suppresses the OS banner

        1 !== 0

- not ok 47 - GH24 native fallback rechecks focus after its presence read

    |-
        focus after the read suppresses the fallback

        true !== false

## Final exact-base RED consolidation

`red-final-integration-base` ran the final host, reader, refresh-race, router and delivery test fixtures against the unchanged implementation at c12aaad9341e8f87126a193f35b5c2768f0aa66f. Only test files were copied into the isolated base scratch tree. Result: rc=1, 118 tests, 90 passed and 28 failed. The R5 missing-method TypeError is excluded from behavioural evidence; the other 27 failures reach assertions.

The earlier RED runs above preceded implementation. This final repeat consolidates evidence against the exact integration base, including the completed GH #24 lifecycle guards. Raw log: `out/red-final-integration-base.log`.

| Fixture | Failing assertion on the integration base |
| --- | --- |
| R1d | `the superseded read and exactly one re-read: 1 !== 2` |
| H4 | `a commit carries an integer rev: false !== true` |
| H2 | result reason `superseded` instead of `discarded` |
| X1 | `a publication blanked the data: [[false,false],[true,true],[false,false],[false,false]]` |
| GH24 native preparation | `focus acquired during preparation suppresses the OS banner: 1 !== 0` |
| GH24 native fallback | `focus after the read suppresses the fallback: true !== false` |
| GH24 newer session | actual `notify`, expected `counts` |
| GH24 orphan | `an orphan cannot bypass the current renderer focus: 1 !== 0` |
| GH24 new/upgrade routing | actual `notify`, expected `counts` |
| GH24 nudge | actual `[pill, notify]`, expected `[pill, bubble]` |
| GH24 quiet release | actual summary count 1, expected 0 |

The final head passes these fixtures in `head-notify-final3` (384 tests). The additional notification, native-resource, shortcut and shared-surface Node suites pass in `head-notify-extra-node` (128 tests, rc=0), for 512 passing Node tests across the two runs.

## Integration checks

- Retained the integration base for main composition, native Linux banners/vendor bundle, global shortcuts, and existing locale keys; added the pill catalogue and source hashes without replacing unrelated translations.
- Retained S8R rev 2.2 host/reader ordering, controlled drafts, focus intent and continuation ownership.
- GH #24: focused homes are tracked incrementally, so routing does not scan notification history. Focus suppresses OS banners across conversations and homes; counts and pill/bubble routing remain. The presenter and asynchronous native fallback re-check focus. Renderer teardown clears only visibility owned by that session, preserving a newer session on the same home.
- head-renderer: 69 tests passed across six files, each file rc=0.
- head-notify-final3: 384 tests passed, rc=0.
- head-notify-extra-node: 128 tests passed, rc=0.
- head-notify-extra-renderer: 109 tests passed across twelve files, each file rc=0. Together with head-renderer, 178 targeted Vitest tests passed across eighteen files.
- Head and base gates: build-help-index=0, build-capabilities=0, build-capability-db=1, i18n=0, tiers=0, tsc_src=0, tsc_server=0. The recipe process exits 0 because it prints individual results; this does not make build-capability-db green.
- The capability database checker fails on both trees: settings card computer.browser has no settings.l1.card.computer.browser label. This lies outside the notification merge.
- Original mutation evidence remains in notify19g-s8r-mutations.md; those historical runs are not represented as new lane runs.

The own-base full run reached the prescribed 18000-second timeout: `base-full.rc` is `rc=124`, with no JSON report. This is NO RESULT. The shared `_base-out/base.rc` also reports `rc=124` without JSON and cannot substitute for a valid baseline. The final `head-full` run also reached the prescribed 18000-second timeout: `head-full.rc` is `rc=124`, without a JSON report. Both full runs are NO RESULT. Full-suite 0-NEW is unproven; new failing names cannot be enumerated without completed reports. Neither timeout is counted as a pass. The comparison helper rejected the unavailable baseline explicitly (`out/full-comparison.log`).

## Focus lifecycle guard

The first merged GH #24 implementation exposed a lifecycle regression: a focused renderer that closed while a card was held could suppress its later release. `red-focus-lifecycle.log` records the assertion `a dead renderer cannot suppress a released card: 0 !== 1`. The guard now passes, together with a second guard proving that ending an older session cannot clear a newer session focus. This RED is against the first lane implementation; the original integration base did not have global focus suppression.

The first head full run was stopped before a JSON result to include this correction. It is archived as `head-full-interrupted.*` and is explicitly NO RESULT. The replacement `head-full` run is the comparison candidate.

A second lifecycle guard, `red-focus-orphan.log`, failed with `an orphan cannot bypass the current renderer focus: 1 !== 0`. Removing the dead-home exception leaves session-owned teardown as the single mechanism for clearing focus; a newer focused owner remains authoritative for orphan delivery too. All 384 notification tests pass in `head-notify-final3.log`. A second pre-completion full attempt is archived as `head-full-interrupted2.*` (NO RESULT); only the final `head-full` attempt is eligible for the comparison; the interrupted attempts supply no result.

## Notification API and presence checks

`head-notify-api` ran fifteen additional files: 97 tests passed, nine failed, and the native Electron notice fixture skipped because its binary is unavailable. Fourteen FILE return codes are 0 (including the skipped native fixture); `server/desktop-attention-http.test.ts` returns 1. The outer recipe return code is 0 and is not an all-tests-green verdict.

Each HTTP failure reports `Ask mode raised no card`; the server stderr reports `engine launch refused for /work/server/testing/fake-acp-cli.ts: the shipped bwrap is missing`. The HTTP fixture and `server/host-power.ts` are unchanged by this merge. The separate `base-notify-http` run on unchanged c12aaad9341e8f87126a193f35b5c2768f0aa66f returns FILE rc=1, with the same nine failing test names and one passing test. The head-minus-base failing-name set is empty for this file (`out/notify-http-comparison.json`). Both runs report the missing shipped bwrap. This targeted comparison does not establish full-suite 0-NEW.

Failing names from the head verbose report:

- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > Reply is a deny with the owner's words`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > a changed digest is a 409 and answers nothing; a surface that does not fit is refused`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > a paired phone, a paired browser and plain loopback are refused for Allow, Deny and Reply, and nothing is answered`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > an open card is read with its full display, a digest and a per-surface outsideOk map`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > quiet hours hold what they drop (ids only) until the desktop acks the list`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > refuses the wrong shape: allowForTask, skip, answer, a message on allow, extra fields, an unknown surface`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > the desktop Allow answers once as the in-app Allow does, and a repeat answers nothing more`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > two outside answers, and an outside plus an in-app answer, at once deliver exactly one decision`
- `server/desktop-attention-http.test.ts > outside answers (NOTIFY-EVERYWHERE-1019 S1) > with details hidden nothing can be answered outside, and the reads carry no card text`

## Run scheduling

One early `gh24-green2` Node retry briefly overlapped `base-full` and `head-renderer`, exceeding the two-container limit. The Node runner was corrected to wait whenever two lane containers are active; the later sequences use that guard. This process exception does not change the recorded assertion results.

## Changed files

- `ci/extended-tests.txt`
- `docs/verification/notify-s8r-integration-1019.md`
- `docs/verification/notify19e-s8-handoff.md`
- `docs/verification/notify19g-s8r-mutations.md`
- `electron/attention-delivery.node-test.mjs`
- `electron/attention-items-reader.node-test.mjs`
- `electron/attention-main.mjs`
- `electron/attention-main.node-test.mjs`
- `electron/attention-panel-guards.node-test.mjs`
- `electron/attention-refresh-race.node-test.mjs`
- `electron/attention-router.mjs`
- `electron/attention-router.node-test.mjs`
- `electron/attention-surfaces.mjs`
- `electron/attention-window-host.mjs`
- `electron/attention-window-host.node-test.mjs`
- `electron/pill-guards.node-test.mjs`
- `electron/pill-window.mjs`
- `electron/pill-window.node-test.mjs`
- `src/attention-ui/AttentionCard.tsx`
- `src/attention-ui/AttentionPanel.test.tsx`
- `src/attention-ui/AttentionPanel.tsx`
- `src/attention-ui/bridge.ts`
- `src/attention-ui/items-reader.d.mts`
- `src/attention-ui/items-reader.mjs`
- `src/attention-ui/useAttentionItems.ts`
- `src/float/FloatPanel.test.tsx`
- `src/float/FloatPanel.tsx`
- `src/float/attention-single-reader.test.tsx`
- `src/locales/copy-lint/reviewed.json`
- `src/locales/de.json`
- `src/locales/en.json`
- `src/locales/es.json`
- `src/locales/fr.json`
- `src/locales/hi.json`
- `src/locales/ja.json`
- `src/locales/pt-br.json`
- `src/locales/source-hashes.json`
- `src/locales/zh.json`
- `src/pill/Pill.test.tsx`
- `src/pill/Pill.tsx`
- `src/pill/index.html`
- `src/pill/main.tsx`
- `src/pill/pill-guards.test.ts`
- `src/pill/pill.css`
- `vite.config.ts`
