Windows release test gate

From a prepared Windows checkout:
  pwsh -NoProfile -File scripts/win-gate/run-win-tests.ps1

Use the Node version in .nvmrc and the locked dependencies. Prepare the same
native engine-exclusion addon as .github/actions/vitest-runtime first. The gate
checks Git, ordinary file symlinks (Developer Mode or equivalent permission),
and directory junctions. It does not install software or contact providers.

files.json is the explicit test inventory. The runner uses the repository's
vite.config.ts, CI=1 (snapshots cannot be written), and the regular release tag
filter. Fixtures use temporary homes, fake engines and loopback ports.

The last stdout line is exactly:
  WINTEST-RESULT files=<n> pass=<n> fail=<n> skipped=<n>

files counts collected inventory files; pass/fail/skipped count assertion rows.
A missing, duplicate, unexpected, empty or wholly skipped file, malformed report,
failed suite, or nonzero Vitest exit makes the gate fail (at least one failure).
Both the Vitest exit and parsed report must pass. JSON evidence stays in a unique
.test-tmp/win-gate directory, or a unique subdirectory beneath -ReportDirectory.

POSIX FIFO, literal-backslash/control-character filename and delayed catchable
SIGTERM checks retain narrowly named exclusions: these OS primitives do not
exist on Windows. Windows exercises junctions, ACL denial, non-regular attachment
entries and process-tree close before restore instead. This Linux development
run does not establish a real-Windows PASS; MAIN must run the script on the rig.
