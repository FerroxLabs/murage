# Skill switch settlement

Owners: the skills lane owns authenticated review, session binding, snapshots,
and the final executor. The decision lane owns delivery, the producer attempt
store, receipt projection, and scheduling.

Use the isolated launcher described in [README.md](README.md). Never replay a
saved approval against a running user's data. The API regression suite launches
that fixture and drives the same authenticated display controls as the app.

Owner settlement is a private, one-use object capability. Preview and verdict
hashes bind the reviewed snapshot; they do not confer permission. Preview GET,
bulk delivery, upgrade, recovery, and a saved Allow cannot supply owner proof.
Attended No limits requests encountering review return a status without a card.

The producer queue writes pending-before-effect and then effect-started before
the primitive. Accepted receipts and uncertain attempts return before reading
skill content. Decision rows are projections. Restoring a skill's previous state
does not unlock its old attempt. Terminal switch identities are retained; full
storage refuses new work instead of trimming those identities.

The file store requires both file fsync and a positively reported directory
sync, including newly created parent directories. Windows and filesystems that
report unsupported directory sync refuse before mutation. This supplies an
at-most-one invocation fence, not a transaction across manifest and link changes.
Any error after primitive entry remains uncertain unless execution was confirmed
by the durable producer receipt.

Settlement reads one target using bounded no-follow descriptors and uses only
scans matching the current scanner version and exact content. Stale scans require
refreshing in Skills; settlement does not enter the existing unbudgeted regex
scanner (the chosen settlement scanner-call limit is zero). Deletion requires a protected revision index and a bounded removal
plan. The current implementation refuses historical revision sets requiring
maintenance rather than partially deleting them. Manual Skills controls retain
their existing policy.

Upgrade and recovery select indexed pages of sixteen and deliver serially,
yielding after every page, including a partial final page. Upgrade, recovery,
reply-end setup and immediate automatic requests share one runtime lane; an owner
response enters immediately or stays open for retry. Full access setup settles
serially after reply end. Process-loss tests discard the child runtime and restore
the skill before replaying against the retained producer attempt store.

Run the focused suites and mutation runner inside the lane container. Set
`MURAGE_EVIDENCE_DIR` to a directory outside the checkout for mutation reports.
Keep baseline behavioral failures, final passes, and mutant results separate.
An invalid run or a surviving mutant remains open; it is not a kill. DOM tests
cover private review rendering, not a packaged desktop or phone workflow.
