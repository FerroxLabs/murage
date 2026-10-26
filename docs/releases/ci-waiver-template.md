# CI waiver: Murage <version>

<!--
Template for a one-time CI waiver (scripts/release-ci-gate.mjs, docs/releasing.md
"One-time CI waiver"). Copy it to docs/releases/ci-waivers/<version>.md, fill it
in, commit it on a branch on top of the commit being released, then start
Release by hand from that branch with ref = the released commit and
ci_waiver = that path. The gate reads the key lines below; each must start at
the beginning of its line and appear exactly once. Everything else is free prose.

  Commit:      the full 40-hex SHA being released (the pinned commit)
  CI run:      the numeric id of the CI (ci.yml) run that failed for that
               commit, the newest attempt; the gate checks it against GitHub
  Critical:    must be 0; any other value refuses
  Reviewed failure classes:
               one "- " line per class of failure reviewed, directly below
               the heading, at least one; each names the test files it
               covers in backticks (`server/x.test.ts`). The gate reads the
               failing CI run's job logs and refuses the waiver when any
               blocking job failed on a test no class names, or failed with
               no test named at all (build, setup, cancel, timeout)
  Approved-by: "<name> on YYYY-MM-DD"; only Sean can approve
-->

Commit: 0000000000000000000000000000000000000000
CI run: 00000000000
Critical: 0

Reviewed failure classes:
- <class>: `<test file>` ... <which jobs, why it does not block the release, evidence link>

Approved-by: Sean Donahoe on YYYY-MM-DD

## Evidence

<Summary of the review, for example from lanes/release102/CI-DIFF-101-vs-102.md.>
