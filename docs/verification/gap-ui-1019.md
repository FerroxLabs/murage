# Startup avatars and application focus (1.0.19)

> gap-ui-r4 follow-up (2026-11-13): **qualified, NEW=0**. The requested SQLite `answered=true` case without attachments reproduces on the unchanged baseline with `Error: not an error`. The required single-ID batches pass 5/5 on both revisions; supplemental complete-file target counts are base 1,289/1,290 and HEAD 263/265. Final complete-file reruns pass 4/4 on both. The full comparison by test ID and strict complete-inventory gate pass, with no missing or newly unexecuted IDs. See [the R4 evidence and limitations](../../evidence/gap-ui/r4/README.md).

> gap-ui-r3 follow-up (2026-11-13): **OPEN, NEW=1**. The two original test IDs now have isolated baseline assertion failures; SQLite's original diagnostic repeats twice, while R6's exact missing-journal diagnostic repeats once and its earlier capture assertion repeats twice. A later `answered=true` SQLite case without attachments remains unmatched on baseline. Both complete files were rerun twice on base/head, the full test-ID comparison was recomputed, and every observed failure was retained. See [the R3 report](../../evidence/gap-ui/r3/README.md).


The original avatar and focus implementations exist in the assigned integration base,
`7c9ce6fe3e783b19a9cda1969d7aa9de676ec356`:

- Row 10: `a04fe6032dd65d70cb302e18ad0075c4dd848b7d`, on
  `dev/1019-firstrun19fix`, adds the real starter team to the welcome and the
  person's first five teammates plus the remaining count to the cached daily
  splash. The cache uses the real Ember component or the uploaded photo with
  its saved crop, zoom and focus.
- Row 23 (the assigned application-focus requirement):
  `e10dcd6bdfd408f08cb6478989e448e1023f3083`, on
  `dev/1019-notify-s0-s4a-int19m2`, supplies Electron's current focused window
  to attention delivery. The gate covers auxiliary windows and asynchronous
  banner preparation and fallback.

Both commits are already ancestors of the integration base. Merging each
returns `Already up to date.` The job's history audit retains those checks and the searches across the
1.0.19 branches and READY SHAs. `FOUND.txt` records the complete focus
implementation. Row 10 is classified BUILT because its cache behavior needed
the correction below.

The avatar cache still tracked only two teammate names. Recolouring a displayed
teammate, changing their photo framing, replacing the fifth face, or changing
the overflow count could leave the next launch showing the old picture.
`pictureSignature` now tracks the Chief's appearance, the same first five
teammates that `faceRow` displays, and the total teammate count. Changes to an
undisplayed overflow face do not invalidate the picture.

## Isolated verification

Use the job's network-disabled `it-remote.sh` wrapper. The evidence is in
`evidence/gap-ui/`, with the full run's raw reports in the job artifact bundle.
The tests use temporary homes, injected Electron windows and fake engines;
no user application or data is used.

The RED run precedes the implementation. It records two signature failures
and one mounted-writer failure for the stale roster. The GREEN focused run
covers the writer, scheduling, composition, validation, splash and welcome.
The schedule regression changes every saved appearance field on all five
visible teammates, checks replacement and overflow count changes, and checks
that changing an undisplayed overflow face does not trigger a write.

The additional `evidence/gap-ui/cache-workflow.fixture.ts` uses the mounted
writer, real Ember rendering and composition, the production disk cache
writer/reader, and the next-launch splash. It fails on base when changing
the fifth teammate produces no second save. With the fix, all three saves
complete, the fifth face changes, and the overflow count changes from two to
one. Both light and dark splash pages embed exactly the five saved SVGs.
Application TypeScript checks pass on both revisions.

The Node tests cover the real attention-delivery and tray-panel factories with
injected Electron windows. The focus cases cover Linux, macOS and Windows
adapters, focus acquired while preparing a banner, and fallback rechecks.
These fixtures establish the routing contract; they do not establish native
packaged desktop interaction on those operating systems.

The locked board originally calls L2 ambiguous. `ORPHAN-PLAN-1019` separately
uses L2 for sidebar follow-ups. This verification covers the explicitly
assigned focus row at `electron/main.mjs`. The historical sidebar work is a
separate requirement.

The comparison keys results by file and full test name. Repeated identical
names retain their stable declaration occurrence, so no assertion is lost
when a file declares the same name more than once. Source revisions, complete
file inventories, inherited failures, missing IDs and new nonexecution are
retained alongside the raw reports.

## Review completion round

The measured product SHA is `5f290a8b1d363ec6dfcee2984896c14b8dd3ea02`.
The r2 work retains that production code and its tests. Its verification scripts
and results live under `evidence/gap-ui/r2/`; original review evidence remains
under `evidence/gap-ui/` and `evidence/gap-ui/afix/`.

The actual default inventory is 4,696 Vitest files and 268 package Node files,
exceeding the brief's historical 649/42. The complete comparison must include
every file on both source snapshots, all six completed shards, and every
executed baseline assertion. Source receipts and completion markers must agree
on the same base and head. Runner errors, snapshot changes, missing assertion
IDs, newly unexecuted IDs and NEW failures reject the gate. The consolidated
r2 report gives the actual result; passing validator fixtures cannot qualify an
incomplete or failing broad run.

The comparator preserves every observed assertion failure across both complete
runs and matched rechecks. A passing retry cannot erase a failure. Rechecks also
verify unchanged test blobs and retain each raw attempt. Full reports remain
available for older property-specific rechecks; skipped assertions in a focused
recheck do not replace earlier execution. New r2 WAL rechecks execute the entire
unchanged file. An interrupted r2 attempt whose output was lost to concurrent
wrapper synchronization is explicitly invalid and has a separate replacement.

One test title embeds `homedir()`, which setup supplies as a random temporary
HOME. Only that parameter of `C3 recursive deletion through a link to ...` in
`server/no-limits-symlink-r31.test.ts` becomes `<fixture-home>` for identity
comparison. Its ordinary=true/false cases and literal `/` and `/etc` cases stay
distinct. The exact source checkout root is also stripped from titles that embed it; all seven website template paths stay distinct. Other files and names remain unchanged. Helper regressions check this
mapping and verify that failures survive later passes or skips.

The two narrowly recognized fixture startup collisions are the usage-root
fixture on port 48405 and the desktop-action fixture on port 18799. Resolution
requires the exact suite-start error, its referenced original server stderr
with EADDRINUSE and the expected port, a SHA-256 of that log, unchanged source
blobs, and complete serial baseline/head files that execute and pass every
assertion. Assertion failures cannot use this resolution. A possible upstream
SQLite explanation remains an investigation and does not waive a test failure.

`r2/mutations.mjs` runs five explicit production mutations only in throwaway
source copies: reducing visible faces, omitting the overflow count, omitting
photo framing, removing Electron's application-focus wiring and ignoring
auxiliary-window focus. Each retains a real production patch and assertion
failures, with unchanged tests green before and after restoration.
`r2/check-review.mjs` also reproduces the reviewed High, Medium and Low gaps as
RED checks, verifies the stricter gate and kills four validator/report mutants.

All new tests use `/work/fuigo-builds/tools/it-remote.sh` with
`IT_JOB=gap-ui-r2`, the assigned worktree and generic local fallback, network
none, and at most eight containers. Inherited same-SHA shards retain their
original afix job receipts. Host selections for concurrent new calls must be
disjoint because the wrapper synchronizes the complete worktree. Tests use
throwaway homes, fake engines and injected Electron windows. Native packaged
OS interaction remains outside this fixture coverage. Final status and
remaining limitations are recorded in the consolidated r2 report.

## Completed inventory and remaining blocker

The r2 comparison finishes all six shards and reports all 4,696 Vitest files
and 268 Node files on both revisions. Missing executed IDs, newly unexecuted
IDs, runner errors and snapshot mutations are zero. The Node comparison has
NEW=0. The strict combined comparison remains OPEN with NEW=2:

- The pending-email backup attachment case reports `Error: not an error`.
- The R6 cloned-folder correction through mounted memory MCP reports a missing
  auto-approved/no-limits decision.

Both failures remain preserved; passing rechecks do not clear them. The WAL
performance failure has a same-ID baseline witness in complete trial 73. The
complete memory replay trial 75 passes the disputed case on both revisions
and supplies no baseline witness. No server, No-limits or test-source change
is made to force the gate green. `r2/result.json` and the consolidated report
record the exact counts and receipt locations.

Two additional original-mode complete-file memory replays (76/77), with
reversed preparation order, pass the disputed R6 case on both revisions. They
supply no baseline failure witness. Fresh case facts and server logs are
written to each trial's separate `base-field-evidence` and
`head-field-evidence` directories. Every attempt and its process/JSON receipts
remain preserved; the final strict comparison still has NEW=2.
