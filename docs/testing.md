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

Files tagged `nightly` or `perf-budget` run through `.github/workflows/nightly.yml`;
they must still be classified. A release needs that job's green result.
Never skip a newly classified red test to make the tier check green: record
the assertion ID, distinguish product defects from incorrect fixtures, and
fix the responsible code. Existing red assertions also require an owner.

`ci/test-truth-1019-tiers.tsv` records the 1.0.19 classification review.
Complete-source comparisons must preserve every tracked path (including
export-ignored development fixtures), stage verified backup tools, and report
new failures and failures on both sides by file plus full assertion name.
A timeout or missing report is a failure, never evidence of a pass.
