# Signal H3 amendments 6–8 (sig-b1)

Starting branch `dev/1019-signal-a1` and hub ref both resolved to
`7048099d0c60a49134cf775c33f32c3c7dbaf003`. Binding documents:
`swarm-b/signal-ruling/RULING-signal.md`, as amended by
`swarm-b/orul-signal/last.txt`; timer scope follows SIGNAL-SLICE-1019-r3 §2.5.

## Persistence and recovery

Signal receipts and tombstones retain `expiresAt` and optional `expiryKnown: true`.
The latter records durable evidence of the original timer, including a note with
no timer. New Signal admissions establish it; migration establishes it from an
intact ingress row or a retained deadline and propagates it through recoverable
resend ancestry. Other adapters do not opt into Signal's unknown-expiry policy.
A legacy Signal receipt with no recoverable evidence is redacted, its run is
cancelled, and Send again cannot dispatch it. This deliberately sacrifices
resend availability when the old data cannot establish expiry safety.

Migration and `setExpiry` propagate the family minimum, including siblings,
intermediate tombstones and descendants whose original receipt is absent.
Journal keys can reconstruct deterministic legacy resend links even without the
original receipt. Reclamation keeps future deadlines and referenced ancestors.
Expiry coverage commits before `expiryMirrored`; startup revalidates old flags.
A failed migration or missing forwarded-receipt coverage blocks prune and drain.
A note's first received timer remains immutable, including a note with no timer;
conversation timer controls and duplicate notifications cannot change it.

## RED and GREEN classification

Logs are retained at `/work/build/sig-b1/evidence/`.
All execution used `it-remote.sh` with `IT_ORIG=it-local-generic.sh` and an isolated
container. The runner's supported local fallback used network isolation and a
private tmpfs for fixtures. At most two containers ran concurrently. The initial
remote-capacity/dependency failure in `red.log` is infrastructure evidence only.

| Test | RED evidence | What GREEN establishes |
| --- | --- | --- |
| T-EXPIRY-UPGRADE / DESCENDANT | `red-98f8a3ac5.log`: expired legacy responses still sent | Backfill survives day-seven prune and prevents day-nine sends; text removed and exact runs cancelled |
| T-PRUNE-KEEPS-UNMIRRORED | `red-98f8a3ac5.log`: missing ledger, age seven days plus one minute, journal incorrectly removed | Unbackfillable forwarded deadline survives; migration remains blocked |
| T-EXPIRY-RECLAIM | `red-behavior.log` on 7048099d0: future tombstone absent after admission | Future deadline survives reclamation and reopen |
| T-EXPIRY-FAMILY-MIN | `red-behavior.log`: siblings retain different deadlines, both with and without root | Minimum covers all retained copies and their next resend |
| T-EXPIRY-UNKNOWN | Both baseline logs: orphan/no-journal receipts send | Missing expiry evidence fails closed with redaction and targeted cancellation |
| T-EXPIRY-MIGRATION-ENOENT | `red-behavior.log`: constructor accepts failed migration | A missing-directory write error cannot be mistaken for a new ledger |
| T-EXPIRY-MIGRATION-FENCE | GREEN on 7048099d0; RED on 98f8a3ac5 (send despite unavailable migration write) | Failed backfill cannot prune, mark mirrored, enqueue or send |
| T-EXPIRY-ABSENT-ORIGINAL | `red-absent-original.log`: first repair cannot cover deterministic copies without root | Journal restores copy and grandchild ancestry, then expiry redacts both |
| T-EXPIRY-MIRROR-COVERAGE | `red-mirror-coverage.log`: stale mirror flag bypasses lost coverage | Startup validates actual durable coverage before pruning |
| T-TIMER-IMMUTABLE | RED on 7048099d0; both cases GREEN on 98f8a3ac5 | Guards r3 §2.5 against the retroactive update introduced by the earlier H3 implementation; no-timer and timed notes survive restart unchanged |
| T-EXPIRY-BACKFILL-CRASH | Regression check; no absent-method baseline RED claim | Injected failure between ledger commit and journal flag; restart preserves deadline without duplicate work |
| T-EXPIRY-MONOTONIC / ATOMIC / LINEAGE | Regression checks; absent `setExpiry` or type failure on 98f8a3ac5 is not behavioral RED | One durable commit, minimum-only updates, rejected clearing, write-failure rollback and lineage inheritance |
| T-EXPIRY-KNOWN-PERMANENT | Regression check | Proven no-timer receipts remain resendable after journal prune and restart |

The baseline comparison copied the two production modules from `git show
98f8a3ac5:<path>` and changed only their imports to use those copies. Tests used
isolated temporary service fixtures; no missing-module failure counts as RED.
Temporary baseline files were removed after execution and retained outside the
worktree as evidence. Every committed test is listed in `ci/gate-tests.txt`.

The targeted checks also cover the shared ledger's Slack, Discord and WhatsApp
neighbors, Signal access and transport, and release-workflow classification.
The control-murage launch/doctor/new-bot/send/wait/messages fixture proves the
generic server/chat path only. Synthetic Signal service fixtures do not establish
G0 activation, live-account behavior, packaged OS qualification or full-rig
zero-NEW acceptance. The full run is queued after pushing and is not awaited by
this builder. Windows power-loss qualification remains a platform-specific skip.

Recorded results: the eight-file run passed 356 tests with one expected Windows
skip; the final Signal service run passed all 47 tests, including the added
coverage check (357 distinct passing checks across the targeted selection).
Final server typecheck and all 81 workflow tests passed. UI typecheck, i18n,
model/catalog generators and the isolated chat fixture also exited zero. The
fixture's wait returned `settled`, and messages contained the fake engine reply.
