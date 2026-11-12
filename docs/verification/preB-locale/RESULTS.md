# preB-locale copy acceptance

Base: `bbf96a5cb20c8cd7a902e1d41cc82905d9864c75`. Branch: `dev/1019-int19m2-preB-locale`.

Added the 17 pause translations to each of de, es, fr, hi, ja, pt-br and zh (119 translations). Removed banned wording from hook and HighLevel messages, preserved all refusal logic, and updated the matching message assertions and two literal generated-hook hashes. Browser setup links and legitimate shared names now have narrowly scoped lint entries; German and Portuguese Snapshots labels are translated.

**OPEN: independent review and source acceptance.** No review records were added. `reviewed.json` was rebuilt using `node scripts/copy-review.mjs rebuild` from existing immutable records. It no longer claims the edited lint files are reviewed. Source hashes were not manually changed. The proposed review bundle contains 2,257 strings and two pinned files with blank verdicts. See [the review requests and exact open checks](REVIEW-REQUESTS.md).

| Check | Result |
| --- | --- |
| Handoff locale stage, before the later pause merge | 932 passed, 7 failed / 939 |
| Reproduced baseline at final preB bbf96a5cb | 929 passed, 10 failed / 939 |
| Final locale suite, same 23 files | 934 passed, 5 failed / 939 |
| Final targeted hook and HighLevel recheck | 174 passed / 174 |
| Latest results per regression file, 9 files | 504 passed, 2 platform skips |
| Locale `--accept`, all seven packs | Each exits 1 for missing reviews |
| Locale `--check` | Exit 1 for unaccepted source hashes |
| Isolated fake-engine fixture, Doctor and cleanup | PASS |
| Shared v2 leak guard | FAIL: 49 inherited tailnet files and 14 other inherited files |

The three extra baseline failures relative to the handoff are the pause translations missing from seven packs: two catalog validation checks and the completeness check. Completeness now passes. All deterministic copy-rule checks pass. The remaining five tests are two source-acceptance checks, two review-ledger checks and the pinned-file review check. Editing the lint files invalidates their old reviews, so that check correctly remains open.

The initial hook regression run found two changed literal hashes after the generated hook and Windows loader wording changed. Their pins were updated explicitly, preserving the assertions, and the targeted rerun passed. The latest-per-file regression total uses the corrected hook-canon result, rather than counting its initial failure as a pass.

Tests ran through `/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=preB-locale`, `IT_W=/work/fuigo-builds/swarm-b/preB-locale/wt`, and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. The worker was `murage-vt3`, one container at a time, Node 24, unprivileged user, network none. Observed host load stayed below 85. No live application or provider, Mac, or billable service was used. The fixture used the repository launcher, temporary home/data, explicit URL for Doctor, and owned-process cleanup. This does not establish visual rendering in the desktop app.

[Leak classification](leak-classification.md) lists every file and reason. The 49 mobile-owned tailnet files are verified to lose the flagged label at `f00e64405`; none was edited here. The original 14 files are all classified as other. No exclusions or guard rules were changed.

Evidence is retained outside the tree at `/work/fuigo-builds/swarm-b/preB-locale/evidence/`: container logs, before/after and regression JSON, acceptance outputs, fixture info/commands/Doctor/cleanup/server log, raw leak reports, and summary JSON. Job-created dependencies and generated outputs are removed after verification.
