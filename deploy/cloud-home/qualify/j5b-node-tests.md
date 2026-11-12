# J5b home Node runner

From the home checkout, install its locked dependencies. Once, with network
access, stage the host tools in an absolute cache directory:

```sh
export MURAGE_BACKUP_TEST_AGE_DIR="$HOME/.cache/murage/j5b-backup-test-age"
node scripts/prepare-backup-test-fixtures.mjs --cache-directory "$MURAGE_BACKUP_TEST_AGE_DIR"
```

The staging command downloads from the existing age source, verifies the
archive and both extracted tools against the committed shared SHA256 pins,
and refuses missing pins or changed bytes. No additional sources are used.

With that cache pre-staged, run the offline suite:

```sh
scripts/run-j5b-home-tests.sh
```

The default `--all` runs two separate steps. To run each step explicitly:

```sh
scripts/run-j5b-home-tests.sh --ordinary
scripts/run-j5b-home-tests.sh --app-health
```

`--ordinary` runs only the uid 1000 group. `--app-health` runs only the 25
tests in `server/cloud-home/app-health.test.ts`, in one container started as
uid 0. The runner announces this root step before starting that container.
It does not invoke sudo. The lane owner authorized the uid 0 exception only
for this file; all other home tests continue to run as uid 1000.

The test runner needs Docker, Node, tar, installed dependencies, and the
pre-staged cache. It never downloads. Before starting a container, it reads
both cached tools and verifies their hashes again against the shared pins.
A missing cache, missing pin, or changed hash stops the run with a diagnostic.
The cache is mounted read-only and retained for subsequent runs.
The Docker image defaults to the locally installed
`node:24-bookworm`; `MURAGE_HOME_TEST_IMAGE` can select another installed image.

The runner snapshots the current bytes of tracked files. Each container
extracts its own writable copy with execution enabled and mounts the installed
dependency store read-only. The CP package dependency links are copied into
the temporary tree so home tests importing CP auth use its locked dependencies.
Untracked test files are outside this snapshot. Temporary source copies and
container caches are removed when the run ends.

All `server/cloud-home` tests run as uid 1000 except `app-health.test.ts`,
which runs in a second container started as uid 0. Its existing volume tests
assert root ownership and use chown on the container's mount. This follows
the split in `.github/workflows/ci.yml` at the extended test job.

Both containers receive `MURAGE_BACKUP_TEST_AGE_DIR` pointing to the verified
cache mount. CI's existing `--tool-directory` staging command retains its
payload fixture preparation. Assertions and test selection within the home
directory stay intact. With `--all`, both groups run even if the first returns
an error; either group's error makes the runner return a nonzero status.

Runs are sequential and wait for the host load threshold before each Docker
invocation. Every container has `--rm --network none` and the lane labels
`owner=mc63`, `purpose=basereds-j5b`, `expires_at=2026-11-14`.
This runner does not change CI wiring.
