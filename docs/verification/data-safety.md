# Data safety: tests and scripts can never delete a real Murage data directory

Lane SAFEWIPE1, 0.1.52. This document is the audit of every recursive
delete in the repository, the policy that now sits between each of them and
the filesystem, and the investigation of the 2026-09-11 21:05 incident. The
test `server/testing/data-safety.test.ts` keeps the audit true: a recursive
delete that is neither routed through `server/testing/safe-wipe.mjs` /
`scripts/safe-wipe.sh` nor allowlisted here with a reason fails CI.

## 1. The incident (2026-09-11, 21:05:06 +07)

**What happened.** While Murage 0.1.51 was running on the developer's Mac
and eight build lanes were running vitest, Playwright human specs and
`node --test` files on the same machine, the contents of the live
`~/.murage` disappeared. `~/.murage` itself and `~/.murage/native/` stayed.
No tool-call transcript shows the delete.

**What the filesystem says** (read-only `stat`, birth times, taken 23:5x):

| Entry | Born | Note |
|---|---|---|
| `~/.murage` | Sep 2 01:00 | the original directory inode — it was **not** recreated |
| `~/.murage/native` | Sep 2 06:24 | the original inode — not recreated |
| `~/.murage/native/*.ndjson` (12 files) | 21:05:06 and later | **every** transcript inside `native/` is new; the earliest was born 21:05:06 |
| `~/.murage/messages.db` | 21:05:06 | recreated by the running app at the same second |
| `workspaces`, `skill-state` | 21:21:02 | recreated on first use |
| `events` | 21:22:54 | recreated |
| `attachments`, `skill-index.db` | 21:23:08 | recreated |
| `checkpoints` | 21:42:58 | recreated |
| `~/.murage-data-owner-*.lease` (in `~`) | 21:42:20 | the app was relaunched at 21:42:20 |

So the delete removed everything below `~/.murage`, **including the files
inside `native/`**, and left exactly two directory inodes. That is not the
shape of a per-component reset, a restore, or a migration (all of which
rename whole directories or replace `~/.murage` itself). It is the shape of
one recursive delete of `~/.murage` that could unlink every file but could
not `rmdir` two directories.

**Why two directories survived — reproduced.** A recursive delete
(`fs.rmSync(dir, { recursive: true })` or `rm -rf dir`) that races a live
process appending into `dir/native/` fails with `ENOTEMPTY` on
`rmdir(native)` — the app wrote a new transcript between the listing and
the rmdir — and therefore also on `rmdir(dir)`. Everything else is gone; the
directory and `native/` remain, with only fresh files inside. The probe
`docs/verification/data-safety-probes/wipe-race.mjs` reproduces this on this Mac for both
`rmSync` and `rm -rf`:

```
rmSync error: ENOTEMPTY
data dir survived: true (same inode)
entries left: [ 'native' ]
rm -rf status: 1 stderr: rm: .../.murage/native: Directory not empty
                         rm: .../.murage: Directory not empty
```

`appendNative` (server/drivers/native.ts) appends to `NATIVE_DIR` on every
engine message, and the developer had live agent threads at 21:05, so the
running 0.1.51 app is the writer that kept those two inodes alive. The
earliest surviving transcript (`52090000-….previous.ndjson`, born 21:05:06)
is that write. An open fd, an `fs.watch`, or a child's cwd does **not**
keep a directory alive on this macOS (probed: all "fully removed"), so the
race is the only mechanism consistent with the evidence.

**Conclusion on mechanism: a whole-tree recursive delete of the path
`/Users/seandonahoe/.murage` ran at 21:05:0x while the app was writing.**

**Who ran it — not attributed.** Every candidate the lane map names was
run against the *unfixed* integration branch (`release/v0.1.52` at
`c80d3d99`, checked out to scratch) with `HOME`/`USERPROFILE` pointed at a
throwaway fake home holding a fake `.murage` full of marker files,
`MURAGE_E2E_DATA_DIR` / `MURAGE_DATA_DIR` / `MURAGE_COMPANION_DIR` unset,
and every process wrapped in a macOS seatbelt profile that denies writes
under the real `~/.murage` (`docs/verification/data-safety-probes/deny-data-dir.sh`), so
a wrong path would show as `EPERM` in the log instead of deleting anything:

| Candidate (unfixed code, fake HOME, vars unset) | Result | Markers | Denied writes to real `~/.murage` |
|---|---|---|---|
| `node --test electron/*.node-test.mjs` (41 files, 378 tests) | pass | 11/11 intact | 0 |
| `node --test installer/test/*.test.mjs` | pass | 11/11 intact | 0 |
| `node --test scripts/*.node-test.mjs` | pass | 11/11 intact | 0 |
| `scripts/control-murage.ts launch` → SIGINT → cleanup | fixture dir removed (mkdtemp) | 11/11 intact | 0 |
| `playwright test --list` with the root config (loads every `*.human.spec.ts` module) | stops at the first spec that requires `MURAGE_E2E_DATA_DIR` | 11/11 intact | 0 |
| `playwright test --list -c src/e2e/<each of 52 configs>` | every config refuses at load without `MURAGE_E2E_DATA_DIR` (CLAC3-2) | 11/11 intact | 0 |
| an earlier pass of the same matrix, including vitest subsets and the shell scripts, nine fake homes | — | 9 homes × 11/11 intact | — |

And in the code as it stood on the integration branch at 21:03 (`ddb0fcba`,
the last merge before the incident): every human spec that wipes at module
load already required `MURAGE_E2E_DATA_DIR` and threw without it;
`rig.ts` fell back to `<repo>/.murage-scratch/e2e`, inside the checkout;
`prepare-scratch.mjs` refused `~/.murage` by name; every Playwright
`outputDir` fallback was `<repo>/.planning/<x>`; every `node --test`,
installer and script fixture used `mkdtemp`; vitest's setup faked `HOME`.
No code path in the repository at that time resolves a recursive delete to
`~/.murage` with the variables unset or inherited. The lanes' working trees
were also grepped for a wipe target derived from `homedir()` or `.murage`:
none.

What that leaves: an ad-hoc command run by an agent or a person (a shell
`rm -rf` on a mistyped or mis-expanded path, or a spec run with
`MURAGE_E2E_DATA_DIR` pointed at `~/.murage` or `~`), or an uncommitted
change in a lane tree that has since been reverted. None of those leave a
trace this lane can read. **The cause is not identified; the mechanism
is.** The guard below is designed so that neither a wrong variable, a wrong
default, nor a wrong argument can reach a data directory again, in any of
the runners that were live that night.

Operator recommendations that the code cannot enforce:

- Give parallel lanes a separate macOS user, or wrap agent shells in the
  seatbelt wrapper above (`docs/verification/data-safety-probes/deny-data-dir.sh <cmd>`); it costs
  nothing and turns a repeat into an `EPERM` with a log line.
- Keep `~/.murage` under Time Machine / a nightly `installation-archive`
  export; the restore path exists (0.1.50 recovery).

## 2. Policy and helper

`server/testing/safe-wipe.mjs` (types in `safe-wipe.d.mts`) is the one
recursive delete tests, human specs, fixtures and scripts may use;
`scripts/safe-wipe.sh` is its shell twin with the same rules.

`assertSafeToWipe(target, options)` admits a target only when it is

- under the OS temp directory (`os.tmpdir()`), or
- marked scratch: some path segment contains `scratch`, `evidence` or
  `.e2e` (`<lanes>/.e2e/<LANE>`, `<repo>/.murage-scratch/e2e`,
  `evidence-CLAC1`), or
- strictly inside a root the caller names with `within` (build outputs
  under the repository; never a home or data directory),

and refuses — whatever the above says — when it

- is, contains, or lies inside `~/.murage`, `~/.opengrokbot` or
  `~/.murage-companion`, where `~` is **both** `$HOME` and the account's
  home from the passwd database, so a faked `HOME` never hides the real
  installation. The account home is never treated as disposable, whatever
  `TMPDIR` says: `TMPDIR=$HOME` or `TMPDIR=/Users` must not admit `~/.murage`
  as "under the temp dir". A different `$HOME` is disposable only when it sits
  *strictly* inside the temp dir (the `mkdtemp` home vitest fakes); a `$HOME`
  that equals the temp dir is not a throwaway;
- is, contains, or lies inside a `MURAGE_DATA_DIR` / `MURAGE_COMPANION_DIR`
  inherited from the environment that is not itself temp or scratch;
- is, or contains, a home directory, the working directory, or a filesystem
  root;
- holds a live installation lease (`.murage-data-owner-<sha256>.lease`,
  the sibling record `electron/data-dir-lease.mjs` writes) owned by another
  process on this host, beside it or up to three levels inside it. Outside
  the temp dir an unreadable or foreign-host lease also refuses ("cannot
  prove it dead" is not "safe").

A refusal throws `SafeWipeRefused` naming the path and the rule; nothing is
deleted while it stands. `safeWipeSync` is `assertSafeToWipe` followed by
`rmSync` recursive+force and never retries a refusal. The async teardowns
(`safeWipe`, `removeTempDir` in `server/testing/cleanup.ts`) re-run
`assertSafeToWipe` on every attempt of their bounded retry loop and throw a
refusal that outlives it: the lease rule reads a just-killed owner as live
until the OS reaps it (`process.kill(pid, 0)` answers for a zombie), so a
single judgement before the loop turned that beat into a one-off refusal on
a green suite (FOLLOW7). `installSafeWipeGuard()` patches `node:fs` so every
recursive `rm` / `rmSync` / `rmdir` in the process runs the deny rules,
judging the target by the path it names whether it is a string, a `file:`
URL, a URL-like object or a Buffer (`String(url)` is `file:///...` and
`String(object)` is `[object Object]`, nonexistent paths under the checkout,
which a URL once used to walk past the guard — FOLLOW7; `node:fs` never
checks `instanceof URL` and never checks the target's type, it duck-types
any value whose `href` and `protocol` are truthy — of any type, a numeric
`href: 1` counts, and a *function* carrying the properties counts — with no
legacy `auth`/`path`, and deletes the object's `pathname`, so the guard
runs that predicate verbatim, with no type gate of its own, and judges the
`pathname`, never the `href`) —
the vitest setup file installs it, and `pnpm test:electron` preloads it
(`--import ./server/testing/safe-wipe-preload.mjs`) for `node --test` files,
which get no faked home.

Known gap: the process-wide guard is not inherited by child processes.
Harness servers, fake CLIs and helper scripts that a `node --test` file or a
fixture spawns run without `NODE_OPTIONS=--import=<preload>`, so a recursive
delete computed *inside* a spawned helper is covered only where that helper
calls `safeWipeSync` itself (the audit in section 4 lists those sites). The
preload deliberately does not export `NODE_OPTIONS` for children: the app
server under test legitimately deletes subdirectories of its own data
directory (workspaces, staging, snapshots), the variable would also reach
Electron and other non-test children whose behaviour under `NODE_OPTIONS`
this lane has not verified, and a guard that fires inside the product would
be testing the guard rather than the product. Scratch data directories handed to children
are admitted by `lane-data-dir.ts` / `assertSafeToWipe` before the child
starts, which is the layer that keeps a child's data dir out of `~/.murage`.

Human specs: `src/e2e/lane-data-dir.ts` is the only reader of
`MURAGE_E2E_DATA_DIR`. It throws without the variable (no fallback anywhere,
finishing the CLAC2/CLAC3 sweep) and admits the value through
`assertSafeToWipe` before anything is created. `src/e2e/evidence.ts` (every
config's `outputDir`, which Playwright deletes before a run) resolves its
root through it and admits an override (`MURAGE_E2E_OUTPUT`,
`MURAGE_E2E_EVIDENCE_DIR`, …) by the same rules.

## 3. Verifying

```
pnpm exec vitest run server/testing/safe-wipe.test.ts server/testing/safe-wipe-sh.test.ts server/testing/cleanup.test.ts server/testing/data-safety.test.ts src/e2e/evidence.test.ts
pnpm test:electron          # node --test with the guard preloaded
node --test installer/test/*.test.mjs
```

`safe-wipe.test.ts` covers: temp admitted; scratch segment admitted;
`within` admitted only strictly inside a non-home root; `~/.murage`, its
children and every parent of it refused; the account's real data dir
refused while `HOME` is faked and while `TMPDIR` is pointed at the home, a
parent of it or `~/.murage` itself; a faked `HOME` equal to the temp dir
refused while one strictly inside it stays disposable; a non-scratch
`MURAGE_DATA_DIR` and its parents refused; cwd, its parents and `/` refused;
a directory whose lease is held by a live foreign process refused (a real
child process holds it) while a dead or self-owned lease is admitted; a
symlink inside scratch that points at protected data refused; the
process-wide guard refusing `fs.rmSync` / `fs.promises.rm` / callback
`fs.rm` on protected paths while letting temp deletes through, and refusing
the same delete when the target is spelled as a `file:` URL, a hand-rolled
URL-like object (judged by its `pathname`, so a scratch `href` cannot launder
a leased `pathname`) or a Buffer.
`cleanup.test.ts` covers `removeTempDir` and `safeWipe` re-judging the lease
on every attempt: an owner that dies mid-teardown no longer refuses the
wipe, one that outlives every attempt still does, and nothing is deleted
while it stands.
`safe-wipe-sh.test.ts` drives `scripts/safe-wipe.sh` from bash through the
same matrix (faked and real home, `TMPDIR` misconfiguration, cwd, roots,
`MURAGE_DATA_DIR`, live and dead leases, symlinks, `SAFE_WIPE_WITHIN`). It
is skipped on Windows: no `.sh` script runs there, and its live-lease case
needs a `kill -0` that knows a Windows pid, which MSYS `kill` without `-W`
does not.
`data-safety.test.ts` is the repository scan (section 4), including
recursive deletes whose options object spans lines.

**Test-safety rule for these tests.** No test in this repository fires a
recursive delete at a real location and relies on the guard to refuse it.
Every live-fire probe that names the real `~/.murage` or the account home
names a *child that does not exist* (`~/.murage/safe-wipe-guard-probe-does-not-exist-<pid>`):
the "lies inside the Murage data directory" rule refuses it, and with
`force: true` (or `rm -rf`) a guard that failed to refuse would be a no-op.
The real directory itself is checked assert-only (`assertNotProtected`) with
no filesystem call. A regression in the guard therefore fails the test; it
cannot reproduce the incident.

The probes under `docs/verification/data-safety-probes/` (`wipe-race.mjs`,
`rmdir-semantics.mjs`) use raw `rmSync` recursive on `mkdtemp` roots on
purpose, to reproduce the incident's filesystem signature; `docs/` is outside
the repository scan for that reason.

## 4. Audit: every recursive delete outside vitest files

Generated from the tree at the head of this lane. vitest files
(`server/**/*.test.ts`, `electron/**/*.test.mjs`, `src/**/*.test.ts`,
`shared/**/*.test.ts`, `companion/**/*.test.ts`, `scripts/**/*.test.mjs`)
are excluded: they run under `server/testing/setup.ts`, which fakes `HOME`
to a mkdtemp under the OS temp dir, deletes `MURAGE_DATA_DIR` before any
import, and installs the process-wide guard. Everything else — `node --test`
files, Playwright specs and configs, fixtures, scripts, installer, shell
scripts and `.planning` runners — is listed. "Call" is what the site now
invokes; `rmSync`/`rm`/`rm -rf` rows are the allowlisted ones in section 5.

| Site | Call | Target | Derivation |
|---|---|---|---|
| `.planning/0149-separate-recovery-confirm/run-native.mjs:13` | `safeWipeSync` | `scratch` | L9 `mkdtempSync(path.join(tmpdir(),'murage-recovery-native-'));` |
| `.planning/flux-native-runner.mjs:52` | `safeWipeSync` | `scratch` | L14 `mkdtempSync(join(tmpdir(), "murage-flux-native-"));` |
| `.planning/native-fuigo-production-closeout.mjs:98` | `safeWipe` | `root` | L70 parameter |
| `.planning/updater-http-closeout.mjs:109` | `safeWipe` | `root` | L81 parameter |
| `.planning/watch-flow-http.mjs:109` | `safeWipe` | `root` | L12 `await mkdtemp(join(tmpdir(), "murage-watch-http-")), data = join(root, "data"), folder = j` |
| `electron/artifact-action.node-test.mjs:21` | `safeWipeSync` | `scratch` | L11 `mkdtempSync(join(tmpdir(), "murage-native-artifact-"));` |
| `electron/artifact-action.node-test.mjs:30` | `safeWipeSync` | `scratch` | L24 `mkdtempSync(join(tmpdir(), "murage-native-artifact-link-"));` |
| `electron/background-login.node-test.mjs:28` | `safeWipeSync` | `root` | L20 `mkdtempSync(join(tmpdir(),"murage-login-"));` |
| `electron/cua-linux-bundle.cjs:132` | `rmSync` | `directory` | L111 `path.join(temporaryRoot, name);` |
| `electron/cua-linux-bundle.cjs:187` | `rmSync` | `stageDirectory` | L158 `fileSystem.mkdtempSync(` |
| `electron/cua-linux-bundle.cjs:209` | `rmSync` | `directory` | L196 `stage?.directory;` |
| `electron/data-dir-lease.node-test.mjs:173` | `safeWipeSync` | `root` | L20 `mkdtempSync(join(tmpdir(), "murage-data-lease-"));` |
| `electron/data-dir-lease.node-test.mjs:178` | `safeWipeSync` | `f.dataDir` | L177 `fixture();` |
| `electron/data-dir-migration.node-test.mjs:12` | `safeWipeSync` | `root` | L11 `mkdtempSync(join(tmpdir(), "murage-migration-proof-"));` |
| `electron/fixtures/browser-click-after-screenshot.cjs:66` | `safeWipeSync` | `privateRoot` | L10 `mkdtempSync(join(tmpdir(), "murage-click-after-shot-"));` |
| `electron/fixtures/browser-click-after-screenshot.cjs:68` | `safeWipeSync` | `privateRoot` | L10 `mkdtempSync(join(tmpdir(), "murage-click-after-shot-"));` |
| `electron/fixtures/browser-navigation-readiness.cjs:110` | `safeWipeSync` | `privateRoot` | L12 `mkdtempSync(join(tmpdir(), "murage-navigation-readiness-"));` |
| `electron/fixtures/browser-navigation-readiness.cjs:112` | `safeWipeSync` | `privateRoot` | L12 `mkdtempSync(join(tmpdir(), "murage-navigation-readiness-"));` |
| `electron/fixtures/updater-handoff.cjs:63` | `safeWipeSync` | `empty` | L57 `mkdtempSync(join(tmpdir(), "murage-handoff-empty-"));` |
| `electron/fixtures/updater-handoff.cjs:82` | `safeWipeSync` | `workspace` | L27 `mkdtempSync(join(tmpdir(), "murage-handoff-fixture-"));` |
| `electron/installation-selection.integration.node-test.mjs:20` | `safeWipeSync` | `root` | each `root` is `realpathSync(mkdtempSync(join(tmpdir(), "murage-separate-archive-")))` (L23) |
| `electron/installation-selection.node-test.mjs:11` | `safeWipeSync` | `root` | each `root` is `realpathSync(mkdtempSync(join(tmpdir(), "murage-selection-test-")))` (L13) |
| `electron/main-ipc-trust.node-test.mjs:420` | `safeWipeSync` | `scratch` | L384 `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murage-ipc-trust-")));` |
| `electron/main-module-load.node-test.mjs:49` | `safeWipeSync` | `scratch` | L29 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-main-undef-"));` |
| `electron/main-module-load.node-test.mjs:180` | `safeWipeSync` | `scratch` | L131 `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murage-main-load-")));` |
| `electron/memory-profile.node-test.mjs:32` | `safeWipeSync` | `root` | L23 `fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));` |
| `electron/memory-profile.node-test.mjs:46` | `safeWipeSync` | `root` | L36 `fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));` |
| `electron/memory-profile.node-test.mjs:66` | `safeWipeSync` | `root` | L50 `fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));` |
| `electron/package-install-command.node-test.mjs:63` | `safeWipeSync` | `workspace` | L47 `mkdtempSync(join(tmpdir(), "murage-staged-"));` |
| `electron/package-install-command.node-test.mjs:93` | `safeWipeSync` | `workspace` | L80 `mkdtempSync(join(tmpdir(), "murage-quote-"));` |
| `electron/restored-connections.node-test.mjs:23` | `safeWipeSync` | `root` | L11 `mkdtempSync(path.join(os.tmpdir(), "murage-connection-profile-"));` |
| `electron/restored-connections.node-test.mjs:38` | `safeWipeSync` | `root` | L26 `mkdtempSync(path.join(os.tmpdir(), "murage-connection-marker-"));` |
| `electron/save-file.node-test.mjs:23` | `safeWipeSync` | `probe` | L16 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-symlink-probe-"));` |
| `electron/save-file.node-test.mjs:41` | `safeWipeSync` | `home` | L33 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-save-file-"));` |
| `electron/save-file.node-test.mjs:69` | `safeWipeSync` | `realHome` | L56 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-real-home-"));` |
| `electron/save-file.node-test.mjs:70` | `safeWipeSync` | `linkedHome` | L57 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-linked-home-"));` |
| `electron/save-file.node-test.mjs:108` | `safeWipeSync` | `active` | L97 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-active-root-"));` |
| `electron/save-file.node-test.mjs:131` | `safeWipeSync` | `downloads` | L122 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-downloads-"));` |
| `electron/save-file.node-test.mjs:141` | `safeWipeSync` | `downloads` | L135 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-downloads-ext-"));` |
| `electron/save-file.node-test.mjs:336` | `safeWipeSync` | `directory` | L321 `path.join(home, "large-dir");` |
| `electron/save-file.node-test.mjs:360` | `safeWipeSync` | `selected` | L354 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-selected-root-"));` |
| `electron/save-file.node-test.mjs:361` | `safeWipeSync` | `downloads` | L357 `fs.mkdtempSync(path.join(os.tmpdir(), "murage-save-downloads-"));` |
| `electron/server-child-lifecycle.node-test.mjs:44` | `safeWipeSync` | `root` | L32 `mkdtempSync(join(tmpdir(),"murage-owned-child-"));` |
| `electron/skill-recorder.mjs:116` | `rmSync` | `sessionDir` | L89 `mkdtempSync(path.join(app.getPath("temp"), "murage-recorder-"));` |
| `electron/skill-recorder.mjs:168` | `rmSync` | `sessionDir` | L89 `mkdtempSync(path.join(app.getPath("temp"), "murage-recorder-"));` |
| `electron/skill-recording-store.mjs:274` | `rmSync` | `temporary` | L175 ``${target.directory}.creating-${process.pid}`;` |
| `electron/speech.mjs:136` | `rmSync` | `sessionDir` | L105 `mkdtempSync(path.join(app.getPath("temp"), "murage-speech-"));` |
| `electron/speech.mjs:193` | `rmSync` | `sessionDir` | L105 `mkdtempSync(path.join(app.getPath("temp"), "murage-speech-"));` |
| `electron/vendor-updater.node-test.mjs:105` | `safeWipeSync` | `workspace` | L104 `mkdtempSync(join(tmpdir(), "murage-appimage-install-"));` |
| `electron/vendor-updater.node-test.mjs:153` | `safeWipeSync` | `workspace` | L152 `mkdtempSync(join(tmpdir(), "murage-appimage-failed-"));` |
| `electron/workspace-file-actions.node-test.mjs:20` | `safeWipeSync` | `root` | `scratch()` mkdtemp under tmpdir (L15-24) |
| `electron/workspace-file-actions.node-test.mjs:132` | `safeWipeSync` | `join(nested.root` | `nested.root` from `fixture()`, a mkdtemp under tmpdir (L128) |
| `ember-rename.sh:54` | `safe_wipe` | `$D` | L46 `"$(mktemp -d)"; R="$D/rules.pl"` |
| `installer/lib/tailscale.mjs:272` | `rmSync` | `join(path` | `path` is the auth-key file inside the private mkdtemp dir `shredAuthKeyFile` created; `join(path, "..")` is that mkdtemp dir (runtime, allowlisted) |
| `installer/test/door-port.test.mjs:60` | `safeWipeSync` | `dir` | L56 `realpathSync(mkdtempSync(join(tmpdir(), "murage-door-test-")));` |
| `installer/test/no-public-exposure.test.mjs:119` | `safeWipeSync` | `dir` | L111 `mkdtempSync(join(tmpdir(), "murage-lane-scan-"));` |
| `installer/test/sidecar.test.mjs:58` | `safeWipeSync` | `dir` | L54 `realpathSync(mkdtempSync(join(tmpdir(), "murage-sidecar-test-")));` |
| `installer/test/start-lifecycle.test.mjs:74` | `safeWipeSync` | `dir` | L24 `realpathSync(mkdtempSync(join(tmpdir(), "murage-start-lifecycle-")));` |
| `installer/test/systemd.test.mjs:69` | `safeWipeSync` | `dir` | L64 `realpathSync(mkdtempSync(join(tmpdir(), "murage-systemd-test-")));` |
| `installer/test/ui-secret.test.mjs:129` | `safeWipeSync` | `dir` | `dir` is `realpathSync(mkdtempSync(join(tmpdir(), "murage-ui-secret-")))` (L138) |
| `installer/test/unattended.test.mjs:56` | `safeWipeSync` | `dir` | L51 `realpathSync(mkdtempSync(join(tmpdir(), "murage-unattended-test-")));` |
| `rebrand.sh:81` | `safe_wipe` | `$RULESDIR` | L70 `"$(mktemp -d)"; RULES="$RULESDIR/rules.pl"` |
| `scripts/bench-concurrency.ts:158` | `removeTempDir` | `home` | L12 `mkdtempSync(join(tmpdir(), "murage-concurrency-"));` |
| `scripts/bench-memory-service.ts:85` | `safeWipeSync` | `root` | L19 `mkdtempSync(join(tmpdir(),"murage-memory-service-benchmark-"));process.env.MURAGE_DATA_DIR` |
| `scripts/bench-memory.ts:64` | `safeWipeSync` | `dir` | L24 `mkdtempSync(join(tmpdir(), "murage-memory-baseline-"));` |
| `scripts/build-windows-browser-vendor.mjs:121` | `safeWipeSync` | `scratch` | L77 `mkdtempSync(join(tmpdir(), "omb-browser-vendor-"));` |
| `scripts/capture-companion-fixtures.mjs:271` | `safeWipeSync` | `home` | L137 `mkdtempSync(join(tmpdir(), "companion-fixtures-"));` |
| `scripts/clean.mjs:21` | `safeWipe` | `join(root` | `join(root, path)` for each generated output name; `root` is the repository, passed as `within` (L9-21) |
| `scripts/control-murage.ts:357` | `removeTempDir` | `dataDir` | L272 `mkdtempSync(join(tmpdir(), "murage-verify-data-"));` |
| `scripts/control-murage.ts:386` | `removeTempDir` | `dataDir` | L272 `mkdtempSync(join(tmpdir(), "murage-verify-data-"));` |
| `scripts/control-murage.ts:436` | `removeTempDir` | `session.info.dataDir` | L413 `await launchVerificationServer(process.env, startup.signal);` |
| `scripts/cua-linux-release.mjs:458` | `safeWipe` | `temporaryDirectory` | L452 `await mkdtemp(path.join(cacheDirectory, ".cua-archive-"));` |
| `scripts/cua-linux-release.mjs:535` | `safeWipe` | `backup` | L514 ``${stageDirectory}.previous`;` |
| `scripts/cua-linux-release.mjs:543` | `safeWipe` | `backup` | L514 ``${stageDirectory}.previous`;` |
| `scripts/cua-linux-release.mjs:545` | `safeWipe` | `temporary` | L513 `await mkdtemp(path.join(stageParent, ".cua-linux-x64-"));` |
| `scripts/eval-memory.ts:162` | `safeWipeSync` | `root` | L56 `mkdtempSync(join(tmpdir(),"murage-p10-eval-"));process.env.MURAGE_DATA_DIR=root;` |
| `scripts/fuigo-probe-resources.node-test.mjs:13` | `safeWipe` | `resources` | L12 `await mkdtemp(join(tmpdir(), 'murage-fuigo-resource-'));` |
| `scripts/fuigo-probe-resources.node-test.mjs:49` | `safeWipe` | `f.root` | L47 `await fixture(t); await writeFile(join(f.root, 'canary'), 'must not ship');` |
| `scripts/fuigo-probe-resources.node-test.mjs:60` | `safeWipe` | `f.root` | L59 `await fixture(t), source = join(f.resources, 'other');` |
| `scripts/generate-locale.mjs:306` | `safeWipeSync` | `workDir` | L292 `mkdtempSync(join(tmpdir(), "murage-locale-"));` |
| `scripts/import-wayland-assistants.mjs:305` | `safeWipeSync` | `directory` | L294 parameter |
| `scripts/import-wayland-skills.mjs:192` | `safeWipeSync` | `out` | L168 parameter |
| `scripts/import-wayland-teams-packages.mjs:58` | `safeWipeSync` | `OUT` | L17 `process.argv.includes("--out")` |
| `scripts/import-wayland-teams.mjs:245` | `safeWipeSync` | `out` | L235 parameter |
| `scripts/prepare-android-tools.mjs:61` | `safeWipeSync` | `finalDir` | L17 `join(root, "dist-native", "android-platform-tools", platform);` |
| `scripts/prepare-android-tools.mjs:65` | `safeWipeSync` | `temporary` | L19 `mkdtempSync(join(tmpdir(), "murage-android-tools-"));` |
| `scripts/prepare-browser.mjs:181` | `safeWipeSync` | `scratch` | L151 `mkdtempSync(join(parent, `.prepare-${target}-`));` |
| `scripts/prepare-cloudflared.mjs:265` | `safeWipeSync` | `finalDirectory` | L215 `join(root, "dist-native", "cloudflared", target);` |
| `scripts/prepare-cloudflared.mjs:271` | `safeWipeSync` | `scratch` | L223 `mkdtempSync(join(tmpdir(), `murage-cloudflared-${target}-`));` |
| `scripts/prepare-cua.mjs:53` | `safeWipe` | `cache` | L49 `join(root, "node_modules", ".cache", "murage", `cua-driver-${release.version}`);` |
| `scripts/prepare-cua.mjs:124` | `safeWipe` | `archStage` | L123 `join(stage, arch);` |
| `scripts/prepare-fuigo.mjs:389` | `safeWipeSync` | `finalDirectory` | L333 `stagedDirectory(root, target);` |
| `scripts/prepare-fuigo.mjs:393` | `safeWipeSync` | `scratch` | L342 `mkdtempSync(join(tmpdir(), `murage-fuigo-${target}-`));` |
| `scripts/prove-browser-guard.mjs:36` | `safeWipeSync` | `root` | L11 `mkdtempSync(join(tmpdir(),'murage-c11-guard-'));` |
| `scripts/prove-fuigo-tools.mjs:237` | `removeTempDir` | `owned` | L28 `mkdtempSync(join(tmpdir(), "murage-fuigo-proof-"));` |
| `scripts/prove-unified-browser.mjs:55` | `safeWipeSync` | `root` | L11 `mkdtempSync(join(tmpdir(), 'murage-c11-proof-'));` |
| `scripts/publish-profiles.mjs:78` | `safeWipeSync` | `dir` | L75 `join(options.repo, "teams", pkg.id);` |
| `scripts/publish-profiles.mjs:99` | `safeWipeSync` | `join(dir` | `join(dir, "skills")`, `dir = join(options.repo, "teams", pkg.id)` (L75), `within: options.repo` |
| `scripts/qualify-memory-runtime.ts:78` | `safeWipeSync` | `root` | L65 `mkdtempSync(join(tmpdir(), "murage-memory-sqlite-"));` |
| `scripts/release-digests.node-test.mjs:53` | `safeWipeSync` | `dir` | L48 `mkdtempSync(join(tmpdir(), "murage-release-digests-"));` |
| `scripts/release-digests.node-test.mjs:275` | `safeWipeSync` | `dir` | L245 `mkdtempSync(join(tmpdir(), "murage-release-tail-"));` |
| `scripts/run-linux-package-smoke.mjs:15` | `safeWipeSync` | `directory` | L12 parameter |
| `scripts/safe-wipe.sh:122` | `rm -rf` | `--` | the shell helper's own `rm -rf -- "$path"` after every check passed |
| `scripts/smoke-app-permissions.mjs:35` | `safeWipeSync` | `data` | L28 `mkdtempSync(join(tmpdir(), "murage-permission-smoke-"));` |
| `scripts/smoke-browser-bundle.mjs:356` | `safeWipe` | `fixture` | L173 parameter |
| `scripts/smoke-clipboard.mjs:95` | `safeWipeSync` | `profile` | L21 `mkdtempSync(join(tmpdir(), "murage-native-clipboard-"));` |
| `scripts/smoke-cua-x11-input.mjs:266` | `safeWipeSync` | `sandbox` | L18 `mkdtempSync(path.join(tmpdir(), prefix));` |
| `scripts/smoke-deb-upgrade.mjs:113` | `safeWipeSync` | `temporary` | L30 `fs.mkdtempSync(path.join(path.resolve(runnerTemp), "murage-deb-upgrade-"));` |
| `scripts/smoke-installation-recovery.mjs:60` | `safeWipeSync` | `scratch` | L12 `mkdtempSync(join(tmpdir(), "murage-packaged-recovery-"));` |
| `scripts/smoke-linux-package.mjs:594` | `safeWipeSync` | `sandbox` | L33 `mkdtempSync(path.join(tmpdir(), "murage-linux-smoke-"));` |
| `scripts/smoke-linux-update.mjs:230` | `safeWipeSync` | `workspace` | L76 `mkdtempSync(path.join(tmpdir(), "murage-update-smoke-"));` |
| `scripts/smoke-memory-desktop.mjs:204` | `safeWipeSync` | `root` | L58 `mkdtempSync(join(tmpdir(),"murage-memory-desktop-")),data=join(root,"data"),userData=join(` |
| `scripts/smoke-memory-packaged.mjs:228` | `safeWipeSync` | `root` | L187 `mkdtempSync(join(tmpdir(), "murage-memory-packaged-"));` |
| `scripts/smoke-mvp-mac.mjs:55` | `safeWipeSync` | `scratch` | L11 `mkdtempSync(join(tmpdir(), "murage-native-mvp-"));` |
| `scripts/smoke-packaged-server.mjs:55` | `safeWipeSync` | `dir` | L53 parameter |
| `scripts/stage-memory-runtime.mjs:37` | `safeWipeSync` | `destination` | L33 `join(root,"dist-server","node_modules","@huggingface","transformers");` |
| `scripts/test-desktop-recovery.mjs:25` | `safeWipeSync` | `scratch` | L10 `mkdtempSync(path.join(tmpdir(), "murage-recovery-window-"));` |
| `scripts/testing/workspace-native-action-fixture.mjs:101` | `safeWipeSync` | `base` | L24 `realpathSync(mkdtempSync(join(tmpdir(), "murage-f4t5-fixture-")));` |
| `scripts/verify-background-native.mjs:25` | `safeWipeSync` | `scratch` | L12 `mkdtempSync(join(tmpdir(),"murage-background-native-"));` |
| `scripts/verify-linux-package.mjs:496` | `safeWipeSync` | `extracted` | L447 `mkdtempSync(path.join(tmpdir(), "murage-deb-verify-"));` |
| `scripts/verify-linux-package.mjs:543` | `safeWipeSync` | `appImageExtracted` | L499 `mkdtempSync(path.join(tmpdir(), "murage-appimage-verify-"));` |
| `scripts/verify-memory-faults.ts:589` | `safeWipeSync` | `root` | L577 `mkdtempSync(join(tmpdir(),"murage-p10-fault-"));writeFileSync(join(root,".memory-fault-fix` |
| `scripts/verify-question-claude.ts:139` | `safeWipeSync` | `scratch` | L30 `mkdtempSync(join(tmpdir(), "murage-live-auq-"));` |
| `scripts/verify-question-fuigo.mjs:302` | `removeTempDir` | `owned` | L58 `mkdtempSync(join(tmpdir(), "murage-fuigo-question-"));` |
| `server/bot-package-archive.ts:171` | `rmSync` | `scratch` | L149 `mkdtempSync(join(dirname(target), ".murage-package-write-"));` |
| `server/bot-package-import.ts:263` | `rmSync` | `stagingDirectory` | L252 `mkdtempSync(join(options.dataDir, ".package-import-"));` |
| `server/container-computer.ts:909` | `rm` | `context` | L904 `await mkdtemp(join(tmpdir(), "murage-cua-image-"));` |
| `server/drivers/claude.ts:283` | `rmSync` | `dirname(filePath` | `dirname(filePath)`: the per-session mkdtemp `murage-mcp-`/`murage-system-` directory (L980, L1071) (runtime, allowlisted) |
| `server/drivers/claude.ts:1033` | `rmSync` | `dirname(mcpConfigPath` | `dirname(mcpConfigPath)`: mkdtemp `murage-mcp-` (L980) (runtime, allowlisted) |
| `server/drivers/claude.ts:1041` | `rmSync` | `dirname(mcpConfigPath` | same mkdtemp `murage-mcp-` (runtime, allowlisted) |
| `server/drivers/claude.ts:1056` | `rmSync` | `dirname(mcpConfigPath` | same mkdtemp `murage-mcp-` (runtime, allowlisted) |
| `server/drivers/claude.ts:1192` | `rmSync` | `dirname(session.mcpConfigPath` | `dirname(session.mcpConfigPath)`: same mkdtemp (runtime, allowlisted) |
| `server/drivers/claude.ts:1404` | `rmSync` | `dirname(session.mcpConfigPath` | same (runtime, allowlisted) |
| `server/drivers/claude.ts:1476` | `rmSync` | `dirname(session.mcpConfigPath` | same (runtime, allowlisted) |
| `server/drivers/pi.ts:578` | `rmSync` | `mcpTempDir` | L571 `mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));` |
| `server/drivers/pi.ts:604` | `rmSync` | `mcpTempDir` | L602 parameter |
| `server/drivers/pi.ts:672` | `rmSync` | `mcpTempDir` | L670 parameter |
| `server/engine-management.ts:204` | `rm` | `scratch` | L199 `await mkdtemp(join(this.deps.root, "fuigo-bundle-probe-")); let cleanupSafe = true;` |
| `server/fuigo-native-update.ts:192` | `rm` | `home` | L96 `await mkdtemp(join(scratch, "probe-"));` |
| `server/fuigo-native-update.ts:234` | `rm` | `directory` | L225 `join(await realpath(parent), `${version}-${randomUUID()}`); await mkdir(directory, { mode:` |
| `server/index.ts:9577` | `rmSync` | `scratch` | L9569 `mkdtempSync(join(tmpdir(), "murage-selected-export-"));` |
| `server/installation-archive.ts:170` | `rmSync` | `directory` | L82 `mkdtempSync(join(dataDirLeasePaths(outputParent).canonicalDataDir, ".murage-archive-inspec` |
| `server/installation-archive.ts:221` | `rmSync` | `inspection.directory` | L220 `await inspectInstallationArchive(file, scratch, options);` |
| `server/installation-archive.ts:233` | `rmSync` | `stage.directory` | L183 `await stageInstallationState(dataDir, parent, options);` |
| `server/installation-archive.ts:234` | `rmSync` | `scratch` | L190 `mkdtempSync(join(parent, ".murage-archive-write-"));` |
| `server/installation-damaged-export.ts:149` | `rmSync` | `scratch` | L48 `mkdtempSync(join(parent, ".murage-damaged-export-"));` |
| `server/installation-database-snapshot.ts:228` | `rmSync` | `scratch` | L198 `mkdtempSync(join(dirname(target), ".murage-database-snapshot-"));` |
| `server/installation-recovery-command.ts:37` | `rmSync` | `scratch` | L33 `mkdtempSync(join(tmpdir(), "murage-backup-inspect-command-"));` |
| `server/installation-recovery-command.ts:44` | `rmSync` | `scratch` | L40 `mkdtempSync(join(tmpdir(), "murage-restore-plan-command-"));` |
| `server/installation-restore-preparation.ts:205` | `rmSync` | `inspected.directory` | L27 `await inspectInstallationArchive(archive, outputParent, options);` |
| `server/installation-restore.ts:133` | `rmSync` | `candidate` | L105 `tx.candidate;` |
| `server/installation-restore.ts:136` | `rmSync` | `inspection` | L101 `prepared.directory;` |
| `server/installation-state-snapshot.ts:254` | `rmSync` | `stage` | L140 `mkdtempSync(join(parent, ".murage-state-snapshot-"));` |
| `server/package-import-transaction.ts:109` | `rmSync` | `tx` | L108 parameter |
| `server/provider-routing.ts:36` | `rmSync` | `home` | L35 `mkdtempSync(join(parent, `${driver}-`));` |
| `server/skills.ts:651` | `rmSync` | `link` | L648 `join(linkDir, name);` |
| `server/skills.ts:702` | `rmSync` | `link` | L696 `join(linkDir, name);` |
| `server/skills.ts:974` | `rmSync` | `directory` | L971 `join(revisions, revision);` |
| `server/skills.ts:989` | `rmSync` | `directory` | L986 `existingSkillDirectory(botId, name);` |
| `server/skills.ts:1016` | `rmSync` | `directory` | L1008 `join(revisions, revision);` |
| `server/skills.ts:1044` | `rmSync` | `target` | L1043 parameter |
| `server/skills.ts:1265` | `rmSync` | `prepared` | L1259 `join(preparedRoot, revision);` |
| `server/skills.ts:1276` | `rmSync` | `temporary` | L1267 `join(preparedRoot, `.prepare-${revision}-${randomUUID()}`);` |
| `server/skills.ts:1295` | `rmSync` | `prepared` | L1259 `join(preparedRoot, revision);` |
| `server/skills.ts:1344` | `rmSync` | `target` | L1328 `join(root, name);` |
| `server/skills.ts:1345` | `rmSync` | `staged` | L1329 `join(root, `.install-${name}-${randomUUID()}`);` |
| `server/skills.ts:1602` | `rmSync` | `prepared` | L1599 `join(skillStateDir(botId), "reviewed-revisions", revision);` |
| `server/store.ts:1624` | `rmSync` | `workspaceDir(id` | `workspaceDir(id)` = `DATA_DIR/workspaces/<bot id>` of a bot being deleted (runtime, allowlisted; never DATA_DIR itself) |
| `server/store.ts:1630` | `rmSync` | `join(DATA_DIR` | `join(DATA_DIR, "skill-state", id)` of a bot being deleted (runtime, allowlisted) |
| `server/testing/cleanup.ts:89` | `removeTempDir` | `dir: string` | `removeTempDir(dir)` is the wrapper: `assertSafeToWipe(dir)` runs before its retry loop |
| `server/testing/cleanup.ts:94` | `rmSync` | `path` | L90 `assertSafeToWipe(dir);` |
| `server/testing/safe-wipe.mjs:290` | `safeWipeSync` | `target` | L275 parameter |
| `server/testing/safe-wipe.mjs:292` | `rmSync` | `path` | L291 `assertSafeToWipe(target, { ...options, checkLeases: true });` |
| `server/testing/safe-wipe.mjs:302` | `safeWipe` | `target` | L290 parameter |
| `server/testing/safe-wipe.mjs:309` | `rm` | `path` | L303 `assertSafeToWipe(target, { ...options, checkLeases: true });` |
| `server/testing/setup.ts:73` | `removeTempDir` | `home` | L21 `mkdtempSync(join(tmpdir(), "murage-test-home-"));` |
| `server/tts/system-voices.ts:76` | `rm` | `dir` | L67 `await mkdtemp(join(tmpdir(), "murage-say-"));` |
| `src/e2e/account-localisation.human.spec.ts:32` | `safeWipe` | `temporary` | L14 `await mkdtemp(join(tmpdir(), "murage-account-locale-"));` |
| `src/e2e/audio-intake.human.spec.ts:56` | `safeWipeSync` | `cache` | L22 `mkdtempSync(join(tmpdir(), "murage-audio-ui-"));` |
| `src/e2e/bundle-import.human.spec.ts:36` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-bundle-ui-"));` |
| `src/e2e/call-avatar.human.spec.ts:27` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(),"murage-call-avatar-"));` |
| `src/e2e/chat-header.human.spec.ts:162` | `safeWipeSync` | `cache` | L39 `mkdtempSync(join(tmpdir(), "murage-chat-header-"));` |
| `src/e2e/chat-polish.human.spec.ts:57` | `safeWipeSync` | `cache` | L38 `mkdtempSync(join(tmpdir(), "murage-chat-polish-"));` |
| `src/e2e/claude-auth-recovery.human.spec.ts:27` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(),"murage-auth-card-"));` |
| `src/e2e/clipboard.human.spec.ts:116` | `safeWipeSync` | `cache` | L28 `mkdtempSync(join(tmpdir(), "murage-clipboard-vite-"));` |
| `src/e2e/code-block-save.human.spec.ts:71` | `safeWipeSync` | `cache` | L41 `mkdtempSync(join(tmpdir(), "murage-code-block-save-"));` |
| `src/e2e/composer-size-limit.human.spec.ts:61` | `safeWipeSync` | `DATA_DIR` | L35 `resolve(laneDataDir("this spec never uses ~/.murage"), "composer-size-limit-data");` |
| `src/e2e/computer-destination.human.spec.ts:36` | `safeWipeSync` | `cache` | L15 `mkdtempSync(join(tmpdir(), "murage-destination-"));` |
| `src/e2e/connected-apps-alias.human.spec.ts:34` | `safeWipeSync` | `cache` | L16 `mkdtempSync(join(tmpdir(), "murage-apps-alias-"));` |
| `src/e2e/connected-apps-lock.human.spec.ts:86` | `safeWipeSync` | `cache` | L47 `mkdtempSync(join(tmpdir(), "murage-apps-lock-vite-"));` |
| `src/e2e/desktop-capabilities.human.spec.ts:109` | `safeWipeSync` | `cache` | L18 `mkdtempSync(join(tmpdir(), "murage-capabilities-vite-"));` |
| `src/e2e/dialog-localisation.human.spec.ts:38` | `safeWipe` | `temporary` | L17 `await mkdtemp(join(tmpdir(), "murage-dialog-locale-"));` |
| `src/e2e/engine-setup.human.spec.ts:56` | `safeWipeSync` | `cache` | L15 `mkdtempSync(join(tmpdir(), "murage-engine-setup-"));` |
| `src/e2e/files.human.spec.ts:87` | `safeWipeSync` | `root` | L30 `realpathSync(mkdtempSync(join(tmpdir(), "murage-files-browser-")));` |
| `src/e2e/flux-entrypoints.human.spec.ts:65` | `safeWipeSync` | `cache` | L30 `mkdtempSync(join(tmpdir(), 'murage-flux-entry-vite-'));` |
| `src/e2e/http-send.human.spec.ts:112` | `safeWipeSync` | `cache` | L26 `mkdtempSync(join(tmpdir(), "murage-http-send-vite-"));` |
| `src/e2e/image-settings-capability.human.spec.ts:43` | `safeWipeSync` | `DATA_DIR` | L30 `resolve(laneDataDir("this spec never uses ~/.murage"), "image-settings-capability-data");` |
| `src/e2e/inbox.human.spec.ts:50` | `safeWipeSync` | `root` | L22 `mkdtempSync(join(tmpdir(), "murage-inbox-browser-"));` |
| `src/e2e/library-views.human.spec.ts:38` | `safeWipeSync` | `cache` | L13 `mkdtempSync(join(tmpdir(), "murage-library-ui-"));` |
| `src/e2e/markdown-theme.human.spec.ts:32` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-markdown-theme-"));` |
| `src/e2e/media-lightbox.human.spec.ts:124` | `safeWipeSync` | `cache` | L68 `mkdtempSync(join(tmpdir(), "murage-media-lightbox-"));` |
| `src/e2e/media-player.human.spec.ts:228` | `safeWipeSync` | `cache` | L105 `mkdtempSync(join(tmpdir(), "murage-media-player-"));` |
| `src/e2e/memory-provenance-fuigo.human.spec.ts:51` | `safeWipeSync` | `DATA_DIR` | L31 `laneDataDir("this proof never uses ~/.murage");` |
| `src/e2e/model-catalog-refresh.human.spec.ts:44` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-model-refresh-"));` |
| `src/e2e/notification-settings.human.spec.ts:39` | `safeWipeSync` | `cache` | L15 `mkdtempSync(join(tmpdir(), "murage-notification-settings-ui-"));` |
| `src/e2e/onboarding-save.human.spec.ts:84` | `safeWipeSync` | `cache` | L23 `mkdtempSync(join(tmpdir(), "murage-onboarding-vite-"));` |
| `src/e2e/prepare-scratch.mjs:24` | `safeWipeSync` | `resolved` | L20 `== resolve(join(homedir(), ".murage"))) {` |
| `src/e2e/provider-error.human.spec.ts:35` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-provider-error-ui-"));` |
| `src/e2e/question-card.human.spec.ts:127` | `safeWipeSync` | `cache` | L83 `mkdtempSync(join(tmpdir(), "murage-question-card-"));` |
| `src/e2e/routine-watch-picker.human.spec.ts:24` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(), "murage-watch-picker-ui-"));` |
| `src/e2e/search-settings.human.spec.ts:36` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-search-settings-ui-"));` |
| `src/e2e/selected-localization.human.spec.ts:26` | `safeWipeSync` | `scratch` | L13 `realpathSync(mkdtempSync(join(tmpdir(),'murage-selected-locales-')));` |
| `src/e2e/sender-avatar.human.spec.ts:23` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(), "murage-sender-avatar-"));` |
| `src/e2e/sidebar-hide.human.spec.ts:26` | `safeWipeSync` | `cache` | L13 `mkdtempSync(join(tmpdir(),'murage-sidebar-hide-'));` |
| `src/e2e/sidebar-hit-areas.human.spec.ts:48` | `safeWipeSync` | `cache` | L17 `mkdtempSync(join(tmpdir(), "murage-sidebar-hit-"));` |
| `src/e2e/starter-profiles.human.spec.ts:36` | `safeWipeSync` | `cache` | L12 `mkdtempSync(join(tmpdir(), "murage-starter-ui-"));` |
| `src/e2e/startup.human.spec.ts:10` | `safeWipeSync` | `cache` | L9 `mkdtempSync(join(tmpdir(),"murage-startup-ui-"));fixture=await startStartupUiFixture(cache` |
| `src/e2e/surface-recovery.human.spec.ts:57` | `safeWipeSync` | `cache` | L18 `mkdtempSync(join(tmpdir(), "murage-surface-vite-"));` |
| `src/e2e/team-export.human.spec.ts:17` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(),'murage-export-ui-'));` |
| `src/e2e/telegram-settings.human.spec.ts:17` | `safeWipeSync` | `cache` | L11 `mkdtempSync(join(tmpdir(),'murage-telegram-ui-'));` |
| `src/e2e/user-smoke-0152-r2.human.spec.ts:136` | `safeWipeSync` | `DATA_DIR` | L42 `laneDataDir("the smoke test never uses ~/.murage");` |
| `src/e2e/workspace-pane.human.spec.ts:133` | `safeWipeSync` | `root` | L57 `realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-pane-")));` |
## 5. Allowlist (direct deletes that stay, with the reason)

The reason for each is in `ALLOWLIST` in `server/testing/data-safety.test.ts`,
next to the check that keeps it honest (an entry whose file no longer
contains a recursive delete fails). In short:

- **The helpers themselves**: `server/testing/safe-wipe.mjs`,
  `server/testing/cleanup.ts` (`removeTempDir` asserts first),
  `scripts/safe-wipe.sh`.
- **Strings, not deletes**: `server/testing/fake-codex-app-server.ts`
  ("rm -rf scratch" is an approval-request payload),
  `installer/test/systemd.test.mjs` (asserts the text setup prints),
  `installer/lib/systemd.mjs` (prints `rm -r <staging>` for the operator),
  `server/container-computer.ts` (a script that runs inside the sandbox
  container against its own copy).
- **CI build outputs on an ephemeral runner**: `.github/workflows/package-win.yml`,
  `.github/workflows/release.yml` (`rm -rf dist dist-server release`).
- **Production runtime**, deleting paths the app itself created — mkdtemp
  scratch, staging, unpublished candidates, or per-bot/per-skill
  subdirectories under `DATA_DIR` — each covered by its own unit tests:
  `electron/cua-linux-bundle.cjs`, `electron/skill-recorder.mjs`,
  `electron/skill-recording-store.mjs`, `electron/speech.mjs`,
  `installer/lib/tailscale.mjs`, `server/bot-package-archive.ts`,
  `server/bot-package-import.ts`, `server/drivers/claude.ts`,
  `server/drivers/pi.ts`, `server/engine-management.ts`,
  `server/fuigo-native-update.ts`, `server/index.ts`,
  `server/installation-archive.ts`, `server/installation-damaged-export.ts`,
  `server/installation-database-snapshot.ts`,
  `server/installation-recovery-command.ts`,
  `server/installation-restore-preparation.ts`,
  `server/installation-restore.ts` (refuses a home, the cwd or a parent of
  either as restore target: `BROAD_RESTORE_TARGET_REFUSED`),
  `server/installation-state-snapshot.ts`,
  `server/package-import-transaction.ts`, `server/provider-routing.ts`,
  `server/skills.ts`, `server/store.ts`, `server/tts/system-voices.ts`.
  None deletes `DATA_DIR` or a parent of it; routing the app through a
  test helper would be the wrong layer.

## 6. Paths that could have reached a data directory before this lane

For the record, the derivations that were one unset or inherited variable
away from a real directory, and what changed:

| Before | Risk | Now |
|---|---|---|
| `rig.ts`: `MURAGE_E2E_DATA_DIR \|\| <repo>/.murage-scratch/e2e` | a default the harness wipes; inside the checkout, but a default | required, no fallback, admitted by safe-wipe |
| `prepare-scratch.mjs`: refused only the exact string `~/.murage` | `~`, `~/.murage/x`, a symlink, `MURAGE_DATA_DIR` inherited from a parent shell were not refused | `safeWipeSync`, full rule set |
| Playwright `outputDir` fallbacks under `<repo>/.planning/<x>`; `MURAGE_E2E_OUTPUT` / `MURAGE_E2E_EVIDENCE_DIR` overrides honoured verbatim | Playwright deletes `outputDir`; an override could name anything | `evidence.ts` → `lane-data-dir.ts`, overrides admitted by safe-wipe |
| `user-smoke-0152-r2.config.ts`: `join(MURAGE_E2E_DATA_DIR, "..", "results")` | wiped a sibling of the data dir's parent | `evidenceDir` under the data dir |
| `scripts/clean.mjs`: `rm("dist")` etc. relative to `process.cwd()` | run from `~`, deletes `~/dist`, `~/release`, … | absolute under the repo with `within` |
| `scripts/import-wayland-*.mjs`, `publish-profiles.mjs`: `rm -rf <argument>` | any `--out` | admitted only when temp, scratch-marked or inside the repo |
| `node --test` files and `control-murage.ts`: mkdtemp targets, no faked home, no guard | a single wrong `join` reaches the real home | `safeWipeSync` per site plus the preloaded process guard |
| every human spec's `rmSync(DATA_DIR)` / `rmSync(cache)` at module load or teardown | one variable away | `safeWipeSync`, variable required and admitted |
