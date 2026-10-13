# OVERWITHHOLD: where the write-time model withholds a line the read-time judge showed

The gate list for `server/memory/writetime-differential.test.ts` (DESIGN-WRITETIME section 5). The differential runs the frozen RC judge
(`server/memory/testing/legacy-lineage/`, from f0559322c, unmetered) and the new lookup (`deny-read.ts`) on the same history, for every line
and reader pair. Two kinds of disagreement:

- **New shows, old withholds**: never allowed. Any such pair fails the test.
- **New withholds, old shows**: allowed only when the verdict maps to a class in the table below. The test reads the class ids from this file
  (the first column). A verdict that maps to no class here fails the test.

The mapping from the new verdict to a class is fixed in the test (`classOf`). A class is removed from this table only together with the code
path that produces it.

| Class | New verdict | Why it withholds more | Source |
|---|---|---|---|
| `pending-window` | checking `pending` | A revoke's job has not drained. The pending closure covers every line after since(X) in each reached thread. Compared only in the "checking" direction (design 3, 5). | design 3 |
| `u1-unprovable` | checking `no-lineage` | The backfill (U1) found no provable ancestry and wrote no row: the RC unprovable marker (set `''`), a root-set member or copy origin whose message is gone, a root set whose row is missing, a copy with more than `COPY_ORIGINS` origins. The RC judged some of these on receipts alone and could show them. | lineage-backfill.ts U1 |
| `positional` | withheld `deny-range`; withheld `deny-line` on a line a positional range of the same revoke covers; withheld `deny-session` on a session of a thread the same revoke walked | PROVEN per line (the differential's `proveRange`): the range starts at a line `a` that is an ANCESTOR of the withheld line (its parent chain reaches `a`; a flat legacy file is one chain in write order), so the reader at that position could have seen `a`'s content; and, for a forget the U2 seed bounded by its time (`until`), the line was written before the forget or its turn began before it (an owner line the turn answered, or the parent of its first row, older than the forget). The RC had no positional rule and showed these lines (no receipt names them): a reply may repeat words with no receipt to say so (1.0.2 revoke-bounded r3). A range the proof cannot cover is unproven and blocks (not a class). | revbound R2, design 1, U2 `until` |
| `positional-branch` | withheld `deny-range`; withheld `deny-line` the same way | COUNTED over-withhold, proven by ancestry: the range starts at a line that is NOT an ancestor of the withheld line (a regenerated or edited reply on another branch of the thread, written after the forgotten line). The reader at that position could not have seen the forgotten content; positional ranges do not look at branches (revbound R2). | revbound R2, design 1 |
| `range-coalesced` | withheld `deny-range` of a coalesced row (revoke -1 or -2) | COUNTED over-withhold: a thread's ranges merged once it holds `DENY_RANGE_COALESCE` (64) rows (minimum from, maximum until), so the row no longer names one forgotten line. Withholds more, never less. | design 1, coalescing |
| `range-unplaced` | withheld `deny-range` of a range that starts at no lineage row | COUNTED over-withhold, proven from the rows: the range starts at the first lsn (a root that had no position: a forgotten or hidden line with no row) or at the lsn of a line reached through a carry that has no row either, and the thread holds a line with no lineage row (U1 found its ancestry unprovable and wrote none). The range has no origin line to prove by ancestry, so it withholds by position alone, fail closed. | design 4 (U1 unprovable), revoke-commit.ts |
| `positional-carried` | withheld `deny-line` | The line's every `deny_line` mark came along a point carry (a copy, a root-set member from another thread) from a generated parent line that a positional `deny_range` of the same revoke withholds: inheritance (design 2.3) passes a `positional` over-withhold on to what rests on it. The test proves this per line from the carry, range and mark rows; any other `deny-line` mismatch is unlisted. | design 2.3, revbound R2 |
| `positional-propagated` | withheld `deny-line` or `deny-session` | Every mark on the line came from a revoke whose walk crossed a positional over-withhold: one of that revoke's ranges withholds a generated line the RC shows, and the marker walks on from such a line as from any denied line (its capture becomes a denied source, the receipts citing that source and records resting on it are reached, then their outputs). The test proves it per line: each marking revoke has a range covering a generated line the RC shows. | design 3 (marker: captures of generated lines after a), revbound R2 |
| `footprint-star` | withheld `footprint`, checking `footprint-wide` | A footprint over 32 scopes interns to `*`; U1 folds a cross-thread parent it could not read yet as `*`. Any non-owner audience is withheld. | design 1 (Fable's cap), U1 |
| `watermark-positional` | withheld `watermark` | mem_lsn is the thread's running minimum, so a stale receipt anywhere earlier in the thread withholds every later generated line for an audience reader. The RC judged the line's own root set, which in practice holds the same receipts (design risk 4: parity, not new strictness). | design 1, risk 4 |
| `upgrade-window-fold` | withheld `watermark` or `footprint` | A line 1.0.2 wrote while U1 ran folds its thread's old tail (U1f) and, when a cross-thread parent had no row at its write, the widest fold. | lineage-backfill.ts U1f |
| `old-hole-project-read` | any withheld | Project `read_messages` recorded no parents in the RC (hole 1): the RC showed lines it should have withheld. | design 2.2 |
| `old-hole-bring-in` | any withheld | Bring-in judged only at read in the RC (hole 2). | design 2.2 |
| `flip-window` | withheld `deny-line` or `deny-range`, audience readers | A receipt some path turned `revoked` (settings, restore, bookkeeping) is committed by the marker, not when the path ran: the audience-only range ends at the commit, so a clean line written between the flip and the commit lies inside it. Readers hold the receipt's lines "checking" from its first output until then (design 3); the class is the lines written in that window. Compared only for the clean fresh lines of the differential (`writeFresh`), which have no class otherwise. | receipt-outputs.ts drainReceiptFlips |

## What is compared (integration, 2026-10-12)

- Every owner action is compared twice: in the pending window right after U1 and U2 (new may read "checking" where old shows, never shown
  where old withholds), and after the marker drained every revoke (`memory-revocation.ts drainRevokeMarker`), where no "pending" verdict is
  accepted.
- `receipt-revoke-after`: a receipt revoked after the upgrade by plain SQL, as settings, restore and the bookkeeping job do. The v10 trigger
  `memory_receipt_flip` queues it, readers hold its lines "checking", and the marker commits it as a receipt root from the receipt range
  (`receipt-outputs.ts`: first output and session per receipt).
- The RC's direct facts the frozen judge does not read itself are applied as the RC's callers applied them: a line's own flag, its forgotten
  source, a deleted conversation's lines and sessions (gone).
- A receipt only revoked by state binds audience readers only (the RC: `audience !== null && state === 'revoked'`): the content reader
  shows its lines in both models; it is not a class here. The `deny-range` verdict maps to `positional` without a per-line proof, so a
  semantic difference hidden under a range would pass as `positional`: the content-reader case above was such a difference (fixed
  2026-10-13, found by engine-dispatch-parity, not by this gate). Keep that in mind before adding a range-producing root.
- U2 commits every deny fact into one of two bulk revokes (all readers; audience only): the per-revoke proofs (`covered`,
  `crossedPositional`) then range over the bulk revoke's ranges.
- Scale: the default shape every run; a large shape (WRITETIME_DIFF_SHAPE=12,2000,8000) all actions; the extreme shape is run on the new
  side alone (WRITETIME_DIFF_NO_ORACLE=1): the frozen RC judge walks each reply's whole root-set chain (root-set-handles.ts meteredHandle,
  about 95% of its time in a CPU profile), so at 75k messages one action takes over 50 minutes and at 3M it would take days.

## Not compared yet (open)

- Owner actions through the other 1.0.2 commit paths after the upgrade (forget, hide, delete through `forget.ts`, `message-db.ts`): covered by
  `revoke-marker.test.ts` and `writetime-integration.test.ts`, not by the frozen judge.
- Branch switch: the RC kept no fact for it that the frozen judge reads.

## `until` (U2 gives a pre-upgrade forget a proven bound)

`commitRevoke(tx, root, { until })` ends a line root's range at the turn lsn the forget bounds. The U2 seed passes it for a tombstone of the owner's
own forget (`owner-forget`, `forgotten-supporting-source`: the reasons whose `created_at` means "at this moment"), computed by
`lineage-backfill.ts forgetBound` from the legacy rows: 1 + the newest turn lsn among the generated lines after the forgotten one that were written
before the forget or whose turn began before it. A turn began no earlier than the time of what it was put together from: its first row's own time when
that is the owner's line, else its first row's parent's time; a turn whose beginning cannot be read counts as begun before the forget. The range row is
written with the reason suffix `:until`, so the marker (and a second root of the same bulk revoke at the same line, such as the deleted source) does
not widen it again. More than 20,000 lines after the forgotten one, a line with no row, a forget with no time, or a tombstone of another reason: no
bound, the range runs to the upgrade as before. The third case of `positional` is therefore closed for forgets with a time; the differential proves it
per line (`exposedByTime`).

Contagion is separate: a captured reply withheld by the range is itself a denied source, and the marker walks on from it (`positional-propagated`), so
in a thread whose later replies are captured the bound narrows the range but the walk may still reach them.

## Astra audit round (2026-10-13): shapes added to the gate

`writetime-differential.test.ts` now also builds receipts that cite a record (whose evidence is a document), a hot pool of parents that several
threads' root sets share, a live forget committed after the upgrade (`forget-live`, the marker left to drain), and clean fresh turns written
between a commit and its drain (an answer, a copy of it elsewhere). A clean fresh line has no class: it must read shown once the marker drained
(a range or a capture must not reach a turn that began at or after the commit's cap), and "checking: pending" while it runs (`flip-window` above is
the one exception). `writetime-live-differential.test.ts` covers what the frozen judge has no word for (objects other threads read, prompts and
the send fence, concurrent turns sharing a head and parents, forgets made while turns are in flight) against a model of the design's rules; it has no
over-withhold class: a clean line, object or prompt the model leaves alone reads shown after the drain.

Two over-withholds the receipts fix carries (not generated by the differential): `receiptContentBad` now applies the frozen judge's derivation
ancestry check (a cited record whose ancestor is not active or is tombstoned) to every reader, where the frozen judge applied it to content readers
only; an audience reader loses the receipt's lines in that case where the frozen judge showed them.
