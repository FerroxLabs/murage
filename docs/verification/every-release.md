# Every release: Signal

Before cutting the RC or merging the version bump, run:

    node scripts/signal-inventory.mjs --assert-release-pin

A failure blocks the release. Do not add skips to the three Signal staging
steps. During development, the separate --assert-runtime-inputs command checks
all build and S1-SYNC source evidence while allowing g0 to remain null.

Reproduce the archives with scripts/build-signal-runtime-inputs.sh OUTPUT
--check. release.yml repeats this check before any platform packaging and uses
the verified local workflow artifacts on the first release. Its publish step
alone attaches the archives to the public murage-releases runtime tag; it never
overwrites a mismatched asset.

Review the licence/source inventory, the G0 fixture manifest and independent
review, and the packaged qualification evidence on all three native targets.
The Linux assembly and --version check do not replace native qualification.
