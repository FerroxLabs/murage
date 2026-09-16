# GEPA worker source and packaging contract

The source includes executable optimizer and protocol fixtures using an explicitly
supplied development runtime and scripted reflection. Those checks do not establish
production native builds, signing or installed-app qualification.

The worker uses the actual GEPA 0.1.4 `optimize` interface, with one mutable
component named `instruction`. Its adapter and reflection callable exchange
bounded JSONL with the Murage parent. The child receives train/validation IDs;
untouched promotion holdout, credentials and evaluator authority stay in the
parent. No candidate is executed as code. No network/provider API is implemented.
This process boundary is not an operating-system network sandbox.

## Fixed inputs

- GEPA 0.1.4: tag `8b0ce6cd99a234f6b74daf37558a2ac0ce18f975`, MIT.
  Wheel SHA256 `12b971039599625c156d2231f6d72a29c31a22e9c237689459b5f1a3c353f532`.
  [Official metadata](https://pypi.org/pypi/gepa/0.1.4/json).
- Standard GIL CPython 3.13.15. Source `Python-3.13.15.tar.xz` SHA256
  `1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76`.
  [Official release/files](https://www.python.org/downloads/release/python-31315/).
- PyInstaller 6.22.3. `requirements-build.txt` freezes its complete dependency
  closure for CPython 3.13 on the four targets below, using only wheel hashes.
  [Official metadata](https://pypi.org/pypi/pyinstaller/6.22.3/json).

Build wheels must be obtained and hash-checked into a task-owned wheelhouse in an
explicitly authorized build session. Install only into that build's isolated
environment, with `--no-index --find-links <wheelhouse> --only-binary=:all:
--require-hashes -r native/gepa/requirements-build.txt`. Do not upgrade the user's
Python, discover credentials or install anything at application startup.

Invoke `python -I -m PyInstaller --clean --noconfirm --distpath <private-output>
--workpath <private-work> native/gepa/gepa-worker.spec` from the pinned build
environment. The spec refuses other CPython/GEPA/PyInstaller versions. Build each
native architecture using its matching interpreter. The spec's `console=True`
keeps stdio available on Windows; the Electron parent hides the child window.

| Target | Native receipt |
| --- | --- |
| darwin-arm64 | arm64 CPython and helper; signed nested runtime binaries |
| darwin-x64 | x64 CPython and helper; separate native launch proof |
| win32-x64 | AMD64 CPython; DLL inventory, hidden-child stdio and cancellation |
| linux-x64 | CPython built on supported baseline; record glibc/linked libraries |

Stage the complete onedir tree at `dist-native/gepa/<target>/`, outside ASAR,
for the existing per-platform Electron `extraResources` join. No symlink to a
developer interpreter or absolute Homebrew path may remain in the shipped tree.
Each receipt records source SHA, input hashes, lock/spec hashes, actual
interpreter/build-tool identity, OS/architecture/baseline, complete helper file
manifest and unsigned/signed hashes. Include GEPA's MIT notice, CPython license
and bundled runtime dependency notices. Signing/notarization and publication
retain their existing authority boundaries.

Before generating a final manifest, stage `licenses/GEPA-LICENSE.txt`,
`licenses/Python-LICENSE.txt` and `licenses/THIRD-PARTY-NOTICES.txt` from the actual
redistributed dependencies. In an authorized native build session, sign and
verify every applicable native file first. Then invoke the explicit source-only
recipe `node native/gepa/create-manifest.mjs <absolute-staged-tree> <target>
<absolute-new-receipt.json>`. This inventories every directory, file and safe
in-tree symlink, stamps `manifest.json`, and writes an external build-config
fragment containing `extraMetadata.murageGepaManifests[target]`. It does not
execute or authenticate the runtime; those remain the native qualification
receipt's responsibility. Combine all requested target hashes into that metadata
object for a multi-architecture build, preserving the normal builder config.

The mandatory `afterPack` GEPA gate reads the trusted configuration hash and
refuses a missing/changed bundle or missing receipt. No runtime hashes are
invented or accepted from environment variables. Host runtime admission receives
the expected hash from the app's trusted build/package metadata. A self-consistent
manifest sitting beside an executable is insufficient authority.

macOS skips re-signing only `/Contents/Resources/gepa-worker` because the tree
must already be signed before its manifest is frozen. Normal outer app signing
and sealing remain enabled. Windows copies only `gepa-worker.exe` separately to
bypass the directory copy signing transformer; all other signer configuration
is unchanged, and a GEPA tree with additional EXEs is refused. These options were
source-checked against installed app-builder-lib 26.15.3 (`macOptions.d.ts`,
`mac/MacTargetHelper.js`, `winPackager.js`). Actual codesign/Authenticode trust,
outer seals, runtime launch and four-platform packaging proof remain pending.

Qualification must run the final packaged executable with Python absent from
PATH. Source qualification on existing CPython 3.13.13, when separately
authorized, is explicitly development evidence rather than production-pin proof.
`offline-fixture.py` owns only its subprocess and accepts an explicit command;
it never installs a dependency or contacts a provider. Its scripted reflection
exercises actual GEPA decisions, not model-generated learning.

## JSONL v1

One job per process. Every frame includes `v:1` and `type`; the entire UTF-8 line
including newline is at most 1 MiB. Duplicate keys, unknown fields, NaN/infinity,
deeply nested JSON and unrelated responses fail closed. Call IDs are sequential
per RPC kind: `<jobId>:evaluate:N` or `<jobId>:reflect:N`.

- Child `ready`: `gepaVersion`, `pythonVersion` (actual runtime).
- Parent `start`: `jobId`, `candidate:{instruction}`, `trainIds`, `validationIds`,
  `limits:{maxMetricCalls,maxReflections,wallMs}`, `randomSeed`. IDs are disjoint,
  distinct, nonempty lists, at most 24 each. Limits are positive and at most
  24 metric cases, two reflections, 30000ms. Random seed is 0..2147483647.
- Child `evaluate`: `jobId`, `callId`, `candidate:{instruction}`, `caseIds`,
  `captureTraces`.
- Parent `evaluate-result`: same `jobId`/`callId`, aligned JSON `outputs`, finite
  `scores`, and `trajectories` array when requested (otherwise exactly null).
- Child `reflect`: `jobId`, `callId`, text-only `prompt` built by GEPA.
- Parent `reflect-result`: same `jobId`/`callId`, `text` containing an outer
  triple-backtick envelope with opening/closing newline and no outside prose.
  Optional language label and interior Markdown code fences are allowed. Nested
  fences remain part of the instruction; upstream GEPA strips surrounding
  instruction whitespace. Protected skill identity and precondition sections
  must still pass the parent's exact preservation checks. Example:
  `"```\nUse verified results.\n```"`.
- Parent `call-error`: `jobId`, `callId`, bounded identifier `code`.
- Parent `cancel`: `jobId`. Cancellation bypasses GEPA's internal retry catch.
- Child `result`: `jobId`, `bestCandidate`, `bestIndex`, `candidates`,
  `parents:Array<Array<number|null>>`, `validationScores`, `metricCalls`,
  `reflectionCalls`, `decisionEvents`. Candidate pool and best index come from
  GEPA itself; rejected proposals remain in actual callback events.
- Child `failed`: `jobId` (null before job admission), static `code`; nonzero exit.

Decision events are `proposal` (`iteration`, `candidate`), `rejected`
(`iteration`, `oldScore`, `newScore`, `reason`) or `accepted` (`iteration`,
`candidateIndex`, `newScore`, `parents`). A terminal result is incomplete until
the child exits zero. A hard wall timeout may exit 124 without a final frame;
the parent must preserve its durable call ledger and classify that interruption.
GEPA exceptions/protocol errors must not cause hidden RPC retries. The parent
independently enforces all limits and owns uncertain-call recovery.
