# BLD4 display-fidelity replay

Started at `52b44b60f90d7b9c5426b54ea5decaf958991b34`; worktree HEAD and
`/work/mb-105-git.git`'s `dev/1019-bld-nolimreplay` both matched. Project memory
prelude was unavailable (no tool/command or `.ijfw/memory` directory).

`MAC-SELECT-V2.md` and `mac-select-v2.sql` replace the exact-key recovery path
for this task. The query is one read-only SELECT over windowed permission
cards, capped at 2,000 plus a total/emitted count. It projects bounded masked
JSON from the actual 1.0.18 `card.subtitle` storage, discriminates prose
fallbacks, and retains answer and lineage metadata. NULL inputs are counted.
It does not recover originals or read a key file.

`extract.py ingest-cards` seals DISPLAY-FIDELITY independently of the existing
release corpus. It checks field allowlists, caps/counts, identity uniqueness,
window, strict JSON, and production masking again (including completed secret
members in a truncated JSON prefix). It refuses redaction changes rather than
silently altering the display. No unmasking or credential handling occurs.
The optional tool/minute index retains every possible match as APPROXIMATE;
without timestamp-bearing source evidence no matching minutes are fabricated.

`replay-display.py` accepts that seal and evaluates the same masked input using
the production judge from base 1.0.18 and an explicitly selected tip. Git archive
snapshots carry file inventories; only the identical display adapter is added.
The report binds both pins, adapter, and corpus, separates owner-class cards by
reason from routines and non-owner rows, and requires full-verdict base parity
for the latter two. These are explicitly counterfactual judge results under
listed assumptions. Driver identity and runtime marks are absent from cards;
no actual historical owner count or workflow replay is claimed. Truncated and
missing inputs remain unavailable. No command in the corpus is executed.

The fabricated fixture includes ten cards: four judged owner-class rows, two
unavailable owner-class rows, two routine rows, and two non-owner rows. Against
`aaa0e298e8c3abc8dc4156a7b3b4b48d5bba0157`, owner-class judge cards are 1 -> 1
(always-ask); routines 2 -> 1 (sensitive-guard), FAIL parity; non-owner 2 -> 2
(sensitive-guard), PASS full-verdict parity. Display driver assumptions differ
from the ACP workflow witness; these are deliberately separate measurements.

## Defect assigned to the toolid lane

BLD3 found that the actual manual routine AND scheduled routine each changed
from **1 sensitive-guard card at base to 0 at `aaa0e298e`**. This violates MAIN
r1.3b routine base parity. It is a defect against the toolid lane, not a favorable
No limits improvement. **bld6-toolid-s4a owns the routine-parity fix.** The bld4
end-of-job comparison and exact latest tip are recorded in the external
`SUMMARY.md` and `routine-parity.json`; do not presume the fix from its name.

The existing isolated synthetic workflow test is reused for both routine
routes, with its observation-only overlay, fake provider, temporary home/data,
explicit ephemeral URL, paginated messages, terminal receipt, and durable
card/decision reconciliation. No live app is used. API totals establish only
these fabricated routes, not a census replay or release qualification.

Evidence directory:
`/work/fuigo-builds/orph/_ev/nolim-replay/1019/bld4-nolimreplay/`.
All tests use the required `it-remote.sh` `--network none` containers, at most
two at once. Final counts, pin hashes, parity result, and cleanup receipt are
recorded there. No Mac operation, private corpus, real data, or billable action
was performed. The six-file release gate and all prior containment gaps remain
unchanged.

Final rerun: the newest published `dev/1019-toolid-s4a` remained
`aaa0e298e8c3abc8dc4156a7b3b4b48d5bba0157`. Both manual and scheduled routine
workflows reproduced **1 sensitive-guard -> 0**, so **0/2 parity checks pass**.
The four isolated workflow observations passed (two per product pin; 18 per pin
were filtered, not passed). The comparison exits 2 for the detected defect.
The final display comparison also exits 2 for routine parity failure; its
non-owner verdicts retain parity. Validation: **14 display + 36 extractor + 9
receipt tests pass**, plus the four workflow observations. No release PASS.
