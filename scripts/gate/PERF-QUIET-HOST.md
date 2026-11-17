# C6 wall-clock performance check

The candidate's wall-clock suite is the existing Vitest `perf-budget` tag
(including inherited tags). Its numeric assertions are unchanged. The shared
setup enforces them only when `MURAGE_PERF_QUIET_HOST=1` and the one-minute load
is finite, nonnegative and below 2.0. It prints the exact line
`ENFORCED: quiet host` for each admitted timing test. A busy requested run fails;
it never falls back to advisory mode. Load is checked again after each test.

Without that exact opt-in, the harness reports `INFORMATIONAL: not a quiet host`
and names each selected timing test whose bounds it skips. Untagged structural
neighbours still run. CI's normal tag exclusions continue to apply; a normal or
nightly green result is not a C6 receipt.

Run `bash scripts/gate/perf-quiet-host.sh` from a prepared candidate checkout in
an isolated Linux test container on the quiet host. Install the locked
dependencies and the usual test runtime first. Make the host's `/work/memwq`
directory available at the same container path, writable and traversable by the
test user. Every timing leg must share that host directory, not a private lock.
The wrapper holds `flock /work/memwq/timing.lock` across the load check and entire
serial perf-budget run. It accepts no filters. It checks load again at completion
and validates the JSON report: every collected perf-budget test must pass and
carry enforcement metadata. Empty runs, hook failures, and skipped bounds fail.

The wrapper prints one `PERF-QUIET-HOST sha=... load=... result=PASS|FAIL` receipt.
Keep stdout and the printed JSON report path in the release evidence; reports
remain under `node_modules/.cache/perf-quiet-host.*`. A PASS receipt is required
in addition to the enforcement lines. Unit and fixture tests inject load into
the decision or a disposable mocked OS module; there is no production load
override. They belong in the blocking gate and work on loaded test hosts.
