# L8 Slice 0 baseline

L13 row 5: **NOT FIXED**. L13 row 8: **NOT FIXED**.
This is provenance and harness recovery, not acceptance of the new F7/M2 implementation. No product lifecycle, receipt, isolation, scoped-Stop or M2 test is claimed GREEN here. B3 owns rebuilt-package M5a/M5b and M8a–d mutation proof; M8e remains demonstrated-equivalence work, expected GREEN. Final combined-head proof and MAIN review are still required.

## Identity and isolation

- Integration base: `c12aaad9341e8f87126a193f35b5c2768f0aa66f`.
- Historical source: `19ef45264b846f5b625e5f00943ca238fda39e0d`, exported with `git archive` into `.l8-history`, without product edits before the baseline.
- Historical lock SHA256: `3dcd75347959bdb73151d2f27ff1fa3fab15fc45d5dce6ff502c2c4bafa0e9fc`; dependencies installed offline/frozen/ignore-scripts from the supplied store, pnpm 10.33.0.
- Image: `node:24-bookworm`, `sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`; Node v24.21.0. Linux x64, user 2001, separate scratch home/data/server inside the container, xvfb, fake Claude only. No live app attachment or live data.
- GUI prerequisites were extracted Debian bookworm packages inside `.l8-artifacts/gui`; the owned ephemeral container received only a symlink for Xvfb's fixed `/usr/bin/xkbcomp` path. The runtime wrapper supplies the extracted library paths and `--no-sandbox` for the container.
- Electron 43.8.1 runtime binaries reused from `/fixture-home/shep2r/l13p/src/release/linux-unpacked`; renderer/server/updater/ws rebuilt from the recorded historical tree. All package files have their own checksum inventory.
- Fixture-only package, never distributable: historical MAIN option A permits removing afterPack from a config copy. Native GEPA/cloudflared/fuigo/browser, backup helpers, cage/engine-exclusion, companion, Android/CUA/memory model and extension build inputs were absent (see complete packaging log); none of these cases claims their behavior. Linux only. The gate is not release-package/native/cross-platform proof.

All execution used `/fixture-home/tools/it-remote.sh` with `IT_JOB=l8r0`, `IT_W=/fixture/jobs/l8r0/wt`, `IT_ORIG=/fixture-home/tools/it-local-generic.sh`. Historical packaging and UI execution used its local-container fallback with load below 60; at most two job containers ran at once. The first Playwright run selected the entire spec, including 7b. No unit or mutation test preceded that run.

Build command (in the historical tree): `pnpm exec vite build --mode help-fixture`; `node scripts/bundle-server.mjs`; `node scripts/bundle-updater.mjs`; `node scripts/bundle-ws.mjs`; `pnpm exec electron-builder --config ../.l8-artifacts/eb-fixture.yml --dir --linux --x64 --publish never -c.electronDist=/work/.l8-artifacts/electron`. The config is the historical electron-builder.yml with only afterPack omitted.

Test command: `HELP_FIXTURE_EXECUTABLE=/work/.l8-artifacts/fixture-executable xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp -xkbdir /work/.l8-artifacts/gui/fixture-home/share/X11/xkb' pnpm exec playwright test --config src/e2e/help-ask-fixture.config.ts --reporter=list`.

## First execution and harness correction

Initial display startup attempts failed before behavioral assertions (missing xauth library, then Xvfb's fixed xkbcomp path); these are **BLOCKED LAUNCH**, not behavioral RED. The first complete historical run reached all 15 cases: **14 passed, 1 failed, exit 1, 45.8 s**. Case 1 dereferenced an undefined `snapshot().bots` because driver installation precedes the first React scope publication. This is **HARNESS RED**, not a product RED-on-base claim. Cases 5, 7b and 8 passed.

After retaining that output, the only historical spec change was an `expect.poll` wait for the seeded Chief in the driver snapshot, before freezing time. No historical product file, fixture driver, config or package changed. The full rerun was **15 passed, exit 0, 38.3 s**. The recovered current-base spec includes the same readiness wait and uses the current admitted evidence directory; current HelpPanel/store wiring belongs to A3 and remains unchanged in this slice.

| Historical packaged case | First complete baseline | Harness-repaired run |
|---|---|---|
| 1 Chief selection and hidden Chief | HARNESS RED | PASS |
| 2 Draft scope changes retain the mount | PASS | PASS |
| 3 Authorization while open and closed | PASS | PASS |
| 4 Every opening dependency permits a fresh receipt | PASS | PASS |
| 5 Held Remove and Stop cannot repaint a reopened Help | PASS | PASS |
| 6 Refused then held retry and unrelated stream | PASS | PASS |
| 7 Unloaded page fails, retries and cancels on close | PASS | PASS |
| 7b Retained page effect replaces record and dispatch independently | PASS | PASS |
| 8 Follow identities, deadline, live hints and approval | PASS | PASS |
| 9 Ask queues behind real held engine without steering | PASS | PASS |
| 10 Retry identity, late receipt and uncertain delivery | PASS | PASS |
| 11 Remove timeout, retired attempt and sending retries | PASS | PASS |
| 12 Stop false nudges an immediate ended read; closed Stop is silent | PASS | PASS |
| 13 Done discards the question and fences late callbacks | PASS | PASS |
| 14 Trim, preview, submit and Open in chat | PASS | PASS |

## Reproducible hashes

Before the readiness repair:

```text
34c11d2cbb5bf342cc701a10d205b2b34db37adf1d5d68c73174aeccf69fa7cd  release/linux-unpacked/murage
838d824173c0e343d553c60df0271166f6d83109e5538f6c735d4687adf430c8  release/linux-unpacked/resources/app.asar
8d2401fce78f78701dc94bd6858811277c8dfab9f7c6a26f8163ca33b90231ba  src/e2e/help-ask-fixture.config.ts
1e47088d29e47745968074cdc108d35b9933560125343297be6b70ab3be59651  src/e2e/help-ask-fixture.human.spec.ts
964c8024b418952b171da1d8dcb7756d91c121bef513ac1612ce9dcef7e8cfb3  src/components/help/HelpAsk.tsx
4bf4a69a78a6f08cb9bcbbe4aeb422011d05227ffcd4f1a09d4ece91968e440a  src/components/help/help-ask-fixture.ts
90758b2617de29ccc6377e7cf61f7beeb8811ecc20ec978d6e340e8419d875db  ../.l8-artifacts/package-files.sha256
```

After the readiness repair (identical package/config/product):

```text
34c11d2cbb5bf342cc701a10d205b2b34db37adf1d5d68c73174aeccf69fa7cd  release/linux-unpacked/murage
838d824173c0e343d553c60df0271166f6d83109e5538f6c735d4687adf430c8  release/linux-unpacked/resources/app.asar
8d2401fce78f78701dc94bd6858811277c8dfab9f7c6a26f8163ca33b90231ba  src/e2e/help-ask-fixture.config.ts
28aa8b6098bcf6a502686681506038877a64480a1bcff5ed0f55ed9b721049c4  src/e2e/help-ask-fixture.human.spec.ts
964c8024b418952b171da1d8dcb7756d91c121bef513ac1612ce9dcef7e8cfb3  src/components/help/HelpAsk.tsx
4bf4a69a78a6f08cb9bcbbe4aeb422011d05227ffcd4f1a09d4ece91968e440a  src/components/help/help-ask-fixture.ts
90758b2617de29ccc6377e7cf61f7beeb8811ecc20ec978d6e340e8419d875db  ../.l8-artifacts/package-files.sha256
```

The last hash covers the sorted checksum inventory of every package file, not just app.asar. Current recovered spec/config hashes are recorded separately with the handoff.

## RED/GREEN and classification

- **RED-ON-BASE (recovery wiring)**: `help-ask-fixture.test.ts` / `checks dist before packaging, and rejects release mode overrides`, observed exit 1 before changing package.json/playwright.config.ts. The assertion reached the default config and showed the isolated packaged spec was not excluded. After restoring the default-config exclusion and production packaging scanner, the recovered suite passed. This is the recovery gate, not a claim that missing F7 behavior was exercised.
- **GUARD**: production fixture-erasure/runtime-opt-in tests, driver fault/timer/abort observations, release workflow registry, and unchanged Help neighbors. The real-renderer build test includes its own negative control: removing the compile-time import guard must make the emitted-output scan throw.
- Historical packaged 15-case results above are historical harness coverage, **not** RED-ON-BASE/GUARD evidence on c12aaad93. No missing route/import or failed launch is relabelled as a behavior failure.
- Design section 10 product tests and R1–R3 additions remain NOT RUN by Slice 0. Their owning seats must append observed RED-ON-BASE or GUARD labels here; I checks completeness with F7-ML7-LABELS. Known existing controls (successful-load retry budget reset; same recorded actionId returning existing) must be GUARD, not fabricated REDs.
- `ci/gate-tests.txt` registers both new Vitest files with OSes/reasons. It also records the human spec as a dedicated packaged Playwright gate comment: the existing tier parser only accepts Vitest/node entries. The dedicated config is run explicitly, never through the generic dev-server human configuration. No CI parser or workflow outside Slice 0 was changed.

## Evidence locations

All paths below are under `/fixture/jobs/l8r0/wt/` and retained for the next seats:

- `.l8-artifacts/baseline-launch-blocked.log`: unsuccessful launch; no behavior claim.
- `.l8-artifacts/baseline-original.log`: 14/15 complete historical baseline.
- `.l8-artifacts/baseline.log`: 15/15 after readiness repair.
- `.l8-artifacts/baseline-original-hashes.txt`, `baseline-hashes.txt`, `package-files.sha256`: source/package identity.
- `.l8-artifacts/history-{vite,server,updater,ws,package}.log`: rebuilt source evidence.
- `.l8-artifacts/build-baseline.sh`, `run-baseline.sh`, `fixture-executable`, `eb-fixture.yml`: exact local reproduction helpers/config.
- `.l8-history/.help-fixture-evidence/`: per-case PNG and attached driver-trace results; `.l8-history/.help-package-*/`: isolated profiles and app logs.
- `.l8-artifacts/historical-q12.log`, `l13-source.diff`: earlier report and 5b0a0a1eb→19ef45264 comparison.
- `.l8-artifacts/recovery-red.log`: observed pre-wiring RED.
- `.l8-artifacts/neighbours-final.log`, `tsc-client-final.log`, `tsc-server.log`: current branch verification.

No Sean-only decision. Final source SHA, full-run NEW count and exact final checks are in the job's DONE after push/full gate.

## Current branch checks before push

`pnpm exec vitest run src/components/help src/first-paint.test.ts src/e2e/evidence.test.ts scripts/run-isolated-human-specs.test.mjs scripts/release-workflows.test.mjs`: **213 passed, 1 known-base failure, 12 files, 67.49 s**. All recovered Help/production-boundary tests and `scripts/release-workflows.test.mjs` (81 tests) pass. The sole failure is `scripts/run-isolated-human-specs.test.mjs :: human specs that need a harness of their own run on it every spec config that boots its own harness is one of them` for unchanged `needsyou-fullwidth.config.ts`; the exact name is already in the supplied c12aaad93 FAILS.txt. No neighbor expectation was changed or skipped.

`pnpm exec tsc -b`: exit 0 after adding the guarded provisional dispatchedIn reader. `pnpm exec tsc -p tsconfig.server.json`: exit 0. `git diff --check`: clean.

Current recovered spec SHA256: `b36b248e626b714cff59d2a2e9608a60f823fd6f285afdcb922ec633c5c45378`; config: `e199b81c2e05dec3c7ecd1332226cda8584f67388bcfcd28f859d033169a1621`. These include current safe evidence-path handling; they are distinct from the historical packaged baseline identities above.
