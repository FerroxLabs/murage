# Signal release mutation prerequisites

`scripts/release-guard.mjs` owns every GitHub release write. Its `upload`,
`publish`, `body`, `probe`, and `notes` commands call the unchanged
`assertSignalReleaseReady()` before any external command. The prerequisite
validates the current checkout's reviewed Signal pin, runs all five named
post-G0 gates with `RELEASE=1`, then checks the fresh report for missing or
skipped cases. Null G0 refuses immediately. There is no environment opt-out,
cached receipt, or alternate publisher.

| Function | Release writes |
| --- | --- |
| `uploadDraft` | Create draft; POST assets |
| `publishDraft` | PATCH draft to published |
| `setReleaseBody` | PATCH body; PATCH tag, target and title |
| `probeReleaseToken` | POST throwaway draft; re-read its identity and draft state; DELETE that draft |
| `generateReleaseNotes` | POST notes generation |

The release workflows call the guard for every write, including the token
probe and notes generation. The early preparation gate remains in both
workflows. Direct function and CLI calls also refuse null G0.

Both electron-builder configurations set `publish: null`. This disables
publisher inference from repository metadata or a token as well as explicit
publishers. `scripts/offline-update-metadata.mjs` writes only local updater
files: `app-update.yml` during afterPack, and final-byte hashes in the platform
feeds after artifact creation. Windows signer names come from the builder's
verified signing manager. Qualification feeds retain their separate marker
and cache directory. No publish configuration is used to generate these files.

`scripts/release-mutation-audit.mjs` reads **every tracked file**, without test,
fixture, extension, or directory exclusions. It parses JS/TS calls, JSON
(including package scripts), YAML workflow commands and builder settings;
inspects shell/PowerShell and documentation command blocks; and checks other
tracked content as text. Inert quoted test inputs are data, not call sites.
Malformed non-executable YAML/JSON documentation falls back to text inspection;
workflows and builder configurations must parse.

The enforced forms are CLI release create/upload/edit/delete, API
POST/PATCH/PUT/DELETE (including implicit POST fields), REST mutations on
release URLs, Octokit release/asset writes, builder publishers, and the three
publishing CLI policies. An allowed call must be in release-guard itself, in
a function whose first statement is the imported prerequisite call. Copying
the prerequisite to a second publisher does not make that publisher allowed.
The inventory currently contains exactly eight mutation call sites.

The structural tests insert a workflow POST before its existing gate, restore
a GitHub builder publisher, add an Octokit writer, remove the upload check,
and exercise each CLI/API/SDK/publish-policy form. Each mutant must be rejected.
Direct function and CLI refusal tests use isolated null-G0 fixtures.

For containers that cannot access a worktree's host Git directory, the test
runner supplies `RELEASE_AUDIT_INDEX`, a NUL-delimited snapshot produced by
`git ls-files -z --cached`. Ordinary checkouts read Git directly. Refresh the
snapshot after staging new files; it must include all candidate tracked files.
This affects only test discovery, never the release prerequisite.

The cfix4 evidence directory records RED-first and GREEN test runs and actual
electron-builder CLI runs with fake tokens and a loopback API mock. Those runs
package an isolated prepackaged fixture with each checked-in configuration;
restoring the publisher in a temporary config is the positive control. The
containers have no external network. No release credentials or Signal accounts
are used, and nothing is published.
