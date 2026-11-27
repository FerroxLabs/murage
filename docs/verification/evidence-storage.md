# Qualification evidence storage

Repository tooling owns the pin manifest and the index and package custody checks.
Hosted CI owns pinned input restoration. The shared offline runners own read-only
transport from the host Git repository. Qualification jobs own their capture
directories and retained archives.

Keep verification logs, recordings, fixture captures, and mutant verdicts in an
external job directory. `MURAGE_EVIDENCE_ROOT` selects an absolute external
directory for capture tools. The default is a private temporary directory.
Active synthetic inputs and test harnesses live with their tests.

Historical paths under `evidence/`, `lane-evidence/`, `c2-rule-evidence/`,
top-level `proof/`, and `lanes/*/shots/` identify archived files. The exact
pre-migration entries are recoverable from Git commit
`ce13438869baecb709e495f572bff879c940e740`. Use
`git show <commit>:<historical-path>` to restore one file to an external job
directory. The repository custody check rejects these paths in the index and
in source exports.

Ordinary Vitest and Node tests resolve the inputs listed in
`scripts/evidence-test-inputs.txt`. A full checkout materializes them locally on
demand without fetching. Hosted CI restores them with
`node scripts/prepare-evidence-test-inputs.mjs --allow-fetch`. Offline containers
receive the same inputs on a read-only mount outside the source tree.

For historical replay, set `MURAGE_EVIDENCE_ARCHIVE` to an external directory
containing the archived paths the replay reads. Choose a separate
`MURAGE_EVIDENCE_ROOT` for fresh captures. The output directory and its resolved
files must stay outside all checkouts and must be disjoint from the archive.
