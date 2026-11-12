# Synthetic oracle correction against MAIN r13b

Authority: `/work/fuigo-builds/swarm-b/nolimint-redesign/RULING-toolid-r13b-MAIN.md`
(2026-11-11). B6 is resolved: own hook/relay files are check+restore without a
card. The old `expectations-v1.json` was explicitly awaiting dual review; its
all-allow baseline cells were not measured baseline characterizations. They
must not be used as evidence of parity or as the r13b oracle. Those baseline
verdict fields are now replaced by SHA-bound fabricated baseline measurements;
non-owner candidate verdicts copy that baseline, never toolid output. Counter
fields remain expected single-request recipes, not observed card totals. Clean
owner fixture rows now explicitly set ownerStarted; route controls retain their
non-owner start facts.

The new `r13b-oracle.ts` is independent of production readers and decisions.
It does not turn diagnostic reason strings into original inputs. Its matrix
checks clean owner allow, actual wipe stop, B6 allow, and non-owner verdict
parity against separately pinned baseline characterization. A tainted turn
also needs an independent reader verdict: clean can run, cut/effect must card.
Absence of that reader witness fails rather than inventing one from the mark.

| Old rows | r13b disposition |
| --- | --- |
| dirty-owner, outside-destructive, outside-prompt | Tainted controls, not ordinary-owner zero-card targets. Reader verdict required. |
| unreadable, truncated, key-row, home-glob, unresolved-value, remote-elevated, invalid-cwd, reader-throw, environment-unread | Clean owner No limits must run unless an actual deny/wipe target was detected. Runtime fault/invalid-cwd witnesses remain separate from static judge inputs. |
| phone | Owner initiation must be proven by the companion entrypoint. |
| owner-channel, continuation, delegation, manual-routine, scheduled-routine | Preserve BASE, never silently rewrite the trigger to desktop. |
| origin-other, origin-missing, origin-conflicting | Preserve BASE byte for byte, never invent owner initiation. |
| parity-ask, parity-auto, parity-full | Original-level path preserves BASE; a separately executed No limits counterfactual uses the owner rule. |
| wipe-* | Actual approved wipe targets stay stopped, including nested and summary witnesses. |
| hook-conflict, own-tool | B6; no longer a policy-conflict cohort. Check+restore needs its own durable witness. |
| draft-only | Effective Ask and BASE behavior, not clean-owner automatic allowance. |

`characterize.ts` measures original and No limits judge paths on the fabricated
fixtures only. Its output binds the product SHA and cannot supply candidate
expectations. The production listener receipts separately measure actual card
insertions; judge counts never substitute for them. Full field-level release
oracle/fidelity reviews and real-context replay are still required.
