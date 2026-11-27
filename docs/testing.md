# GATE and EXTENDED tests

Every root Vitest file must appear in exactly one of `ci/gate-tests.txt` or
`ci/extended-tests.txt`. Run `node scripts/ci-test-tiers.mjs check` after adding,
renaming or removing a test. Each gate row names its applicable operating
systems and the user failure it prevents.

Security, authority, privacy, data preservation, backup, restore and downgrade
checks belong in GATE. Signal park and Cloud email checks are gate tests.
CI runs gate shards on the listed operating systems and failures block the
build. EXTENDED holds supplementary coverage and runs on Linux; its failures
remain findings even though that CI job is nonblocking.

A test using `node:test` must have an explicit blocking Node runner, an entry
in the gate inventory, and an exclusion from Vitest if its filename matches
Vitest's includes. `scripts/nolim-replay/j1-availability.test.mjs` runs through
`test:electron`; excluding it from Vitest prevents a false “No test suite”
failure without suppressing its assertions.

Files tagged `nightly` run through `.github/workflows/nightly.yml`; they must
still be classified. A release needs that job's green result. That workflow
does not run `perf-budget` assertions: its documented dedicated-hardware
qualification remains separate evidence (audit M6), and must not be counted
as executed CI coverage.
Never skip a newly classified red test to make the tier check green: record
the assertion ID, distinguish product defects from incorrect fixtures, and
fix the responsible code. Existing red assertions also require an owner.

`ci/test-truth-1019-tiers.tsv` records the 1.0.19 classification review.
Complete-source comparisons must preserve every tracked path (including
export-ignored development fixtures), stage verified backup tools, and report
new failures and failures on both sides by file plus full assertion name.
A timeout or missing report is a failure, never evidence of a pass.

## Windows identity custody

The CI custody step checks added text lines between the merge base and the
checked-out commit for Windows account SIDs and drive-letter profile paths.
Pull requests use the target SHA, pushes use the previous tip, and manual
runs use the default branch (the first parent when already at its tip).
`node scripts/check-repository-custody.mjs --windows-private --added-since <ref>`
reproduces the scan. Omit `--added-since <ref>` for a whole-index Windows audit.

The profile names `Public` and `Default` are Windows system folders. The scanner
also permits the synthetic `testuser` profile in `server/protected-folders.test.ts`,
where it exercises Windows folder discovery with fake inputs. The exception
applies to that exact name and file. Construct other synthetic profiles and
SIDs from pieces in tests so they never enter source as literal identities.
