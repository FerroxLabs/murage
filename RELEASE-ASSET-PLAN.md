# 1.0.19 C5 release asset plan

This is a handoff to MAIN, not authorization to publish. No release, tag, or workflow run was created or changed by this job. MAIN's authenticated read reported `browser-engine-v0.38.1-omb.2` present as a **draft with 10 assets**, the two 0.36.0 vendor releases also drafts, and no `signal-runtime-0.14.11-48a0a5e-r1` release. An authenticated download from a draft does not establish public availability.

## When the URLs are fetched

* Desktop browser: `package.json`'s `package:prepare` calls `build:browser`, which invokes `scripts/prepare-browser.mjs`. `stageBrowserTarget` gets the engine and Chromium via `releaseBytes`, accepts an existing archive only after size/SHA-256 verification, and otherwise downloads anonymously. It stages `dist-native/browser/<target>`; `electron-builder.yml` copies it to `Resources/browser-engine`. On macOS the default preparation includes both desktop architectures. Windows and Linux prepare their current desktop target.
* Packaged browser use: `server/browser-engine.ts` resolves the bundled executable when a resources path is set. `browserEngineStatus` reports a missing/refused packaged browser as not installable and requests reinstall. It does not fetch the release URL at app startup or first browser use. The exported `installAgentBrowserBinary` can download an engine for an unpackaged harness, but has **no production call sites in this checkout**. Linux arm64 and musl 0.36.0 engine pins are not stock desktop bundle targets; they remain checked pins, not automatic customer downloads.
* Cloud browser: `deploy/cloud-home/build-image.sh` sets `MURAGE_CLOUD_ROLE=home` and calls `prepare-browser.mjs --target <linux target>`, then copies the staged bundle into image resources. This selects 0.38.1-omb.2 from `server/cloud-home/browser-pins.ts`. Cloud homes execute the image's installed browser; they do not fetch this release per customer session. Publish the engine before building a new home image.
* Signal: `release.yml` calls `scripts/stage-signal-runtime.mjs --target <target> --release` before packaging on each matching runner. Only this mode may fetch `runtime-pin.json`'s `releaseInputs` URLs, anonymously, and only in the release workflow. It verifies the archive SHA-256, root layout, runtime tree and inventory before staging `dist-native/signal-runtime/<target>`. Packaging includes this as `Resources/signal-runtime`. Normal app activation uses those local resources; it does not download a JRE or runtime archive. Local staging is offline.
* dbus-next, Rust, the Signal builder image and Gradle/Maven are maintainer build inputs, not downloads initiated by installed apps. dbus-next's generated CJS is committed and consumed by the Linux main process. Its generator is not part of `package:prepare`.

## Why 1.0.18 could work

The supplied release-base mapping identifies public v1.0.18 `fc3782abe834bb0a62c96437bff78ac4dbd96eeb` with private source `6e4dda8afd788c113f348a29033ead128ac103c1`. The public export has no `server/` sources, so the comparison uses that mapped private tree, not a guessed public path.

At that source, `server/browser-engine-release.ts` selects upstream Vercel 0.36.0 assets for the six non-Windows targets and the older Windows **0.36.0-omb.1** vendor asset. Cloud pins select upstream Vercel **0.38.1**, without omb.2. None selects today's three FerroxLabs vendor draft tags. The newer all-platform control-token builds are changed release inputs. 1.0.18 also bundled its browser at package time, so installed copies could continue to run without release-asset access. A hash-verified build cache can avoid a fresh network request, but the source does not show authenticated draft downloading in `prepare-browser.mjs`. Thus 1.0.18 working is no evidence that the new draft URLs work anonymously, or that a clean 1.0.19 build can use them. This is a source trace, not a new 1.0.18 runtime qualification.

## Release order owned by MAIN

1. Use MAIN's accepted D094 standing exception and the committed D102 strict dependency verification, then build/qualify the missing Signal runtime inputs as described below. Verify browser draft asset bytes and hashes against the shipped pins; do not rebuild or silently replace reviewed bytes just because the release is a draft.
2. Before the 1.0.19 release workflow's prepare job or a clean Cloud image build, publish the three existing browser vendor releases and create/publish the reviewed Signal runtime release. Browser drafts may be prepared beforehand, but must become public **before packaging**, not merely when the finished Murage app is published. Existing anonymous packaging fetchers cannot consume drafts. MAIN owns all publication actions with Sean's approval (MAIN ruling 2026-11-11); D027-D033, D038, D040 and D044-D046 are OPEN-MAIN-PUBLICATION, outside this builder job.
3. Run the release asset CHECK with a read token that can see drafts in both repositories. The new `release.yml` prepare step runs it with `secrets.RELEASES_PAT`, before the Signal gate and before platform packaging. The token must have contents:read access to `FerroxLabs/murage` and `FerroxLabs/murage-releases`. A repo-scoped token that cannot see the other repo's drafts fails closed. No token is written to disk or sent to download hosts. Re-run the same CHECK before Cloud image builds.
4. Run the existing Signal G0/post-G0 and platform package/signing/offline smoke gates. Then MAIN follows the existing Murage app draft/approval/publication process. This patch does not waive any gate or publish anything.

## Per-row disposition

Tags below are in `FerroxLabs/murage`, except Signal tags in `FerroxLabs/murage-releases`. Browser assets are named `agent-browser-<target>-<revision>` with `.exe` on Windows. Each publication remains OPEN until MAIN publishes and the authenticated CHECK plus anonymous probes pass. Existing FIXED rows remain subject to the CHECK; no second URL was invented for the open release assets.

| Row | Input | Required MAIN action and point of use | State in this job |
| --- | --- | --- | --- |
| D027 | darwin-arm64 engine | Publish `browser-engine-v0.36.0-omb.2`; package preparation downloads `agent-browser-darwin-arm64-0.36.0-omb.2`. | OPEN-MAIN-PUBLICATION |
| D028 | darwin-x64 engine | Publish the same 0.36.0-omb.2 release; Mac package preparation downloads the x64 asset. | OPEN-MAIN-PUBLICATION |
| D029 | linux-arm64 engine | Publish the same 0.36.0-omb.2 release; retained unpackaged engine pin, not a stock desktop target. | OPEN-MAIN-PUBLICATION |
| D030 | linux-musl-arm64 engine | Publish the same 0.36.0-omb.2 release; retained unpackaged musl pin. | OPEN-MAIN-PUBLICATION |
| D031 | linux-musl-x64 engine | Publish the same 0.36.0-omb.2 release; retained unpackaged musl pin. | OPEN-MAIN-PUBLICATION |
| D032 | linux-x64 engine | Publish the same 0.36.0-omb.2 release before Linux package preparation. | OPEN-MAIN-PUBLICATION |
| D033 | win32-x64 engine | Publish `browser-engine-v0.36.0-omb.3` before Windows package preparation; asset `agent-browser-win32-x64-0.36.0-omb.3.exe`. | OPEN-MAIN-PUBLICATION |
| D034 | desktop Chromium darwin-arm64 | No GitHub release to publish. Use the existing pinned Chrome for Testing 152.0.7977.82 mac-arm64 ZIP during package preparation. | Existing FIXED |
| D035 | desktop Chromium darwin-x64 | Same upstream version, mac-x64 ZIP, during package preparation. | Existing FIXED |
| D036 | desktop Chromium linux-x64 | Same upstream version, linux64 ZIP, during package preparation. | Existing FIXED |
| D037 | desktop Chromium win32-x64 | Same upstream version, win64 ZIP, during package preparation. | Existing FIXED |
| D038 | Cloud engine linux-x64 | Publish `browser-engine-v0.38.1-omb.2` before home image construction; asset `agent-browser-linux-x64-0.38.1-omb.2`. | OPEN-MAIN-PUBLICATION |
| D039 | Cloud Chromium linux-x64 | No GitHub release to publish. Use pinned Chrome for Testing 154.0.8037.92 linux64 ZIP at image build. | Existing FIXED |
| D040 | Cloud engine linux-arm64 | Publish the same 0.38.1-omb.2 release before home image construction; asset `agent-browser-linux-arm64-0.38.1-omb.2`. | OPEN-MAIN-PUBLICATION |
| D041 | Cloud Chromium linux-arm64 | No GitHub release to publish. Use pinned Chrome for Testing 154.0.8037.92 linux-arm64 ZIP at image build. | Existing FIXED |
| D042 | 0.36.0 vendor source | No release publication. Existing pinned codeload source commit `eb05921bad874cd2a1b4fa5d1149f1ed26576cae` is needed only if rebuilding vendor binaries. | Existing FIXED |
| D043 | 0.38.1 vendor source | No release publication. Existing pinned codeload source commit `aff6125c023b810ea3f2e5deec5379e9a4270bdc` is needed only if rebuilding vendor binaries. | Existing FIXED |
| D044 | Signal darwin-arm64 | Build/qualify/publish `signal-runtime-0.14.11-48a0a5e-r1`, asset `signal-runtime-0.14.11-48a0a5e-r1-darwin-arm64.tar.gz`, before release staging. | OPEN-MAIN-PUBLICATION |
| D045 | Signal win32-x64 | Same Signal release, asset ending `-win32-x64.tar.gz`, before release staging. | OPEN-MAIN-PUBLICATION |
| D046 | Signal linux-x64 | Same Signal release, asset ending `-linux-x64.tar.gz`, before release staging. | OPEN-MAIN-PUBLICATION |
| D094 | Signal builder OCI image | Retain the immutable manifest digest in JSON, workflow and build evidence; the digest is the integrity guarantee. | ACCEPTED STANDING exception: single registry |
| D098 | dbus-next 0.10.2 closure | No GitHub release. Commit `scripts/dbus-next/package-lock.json`; generator copies its manifest/lock into a fresh temp directory and runs `npm ci --ignore-scripts`. Regenerate only when changing the vendored notification bundle. | FIXED under requested lock/ci criterion |
| D100 | Rust 1.97.1 components | No GitHub release. Vendor build workflow uses `install-browser-rust.mjs` and committed `browser-rust-inputs.json` instead of network rustup install/target-add. | FIXED under requested official-manifest/component pin criterion |
| D102 | Gradle/Maven build closure | Committed SHA-256/PGP metadata covers the pinned source/toolchain installDist closure, including plugins/buildSrc. Both independent input builds use strict verification. | FIXED; 192 components / 342 artifacts; offline tamper rejection and clean build proved |

## Building the missing Signal release

MAIN can dispatch **Signal runtime inputs**, `.github/workflows/signal-runtime-inputs.yml`, at the reviewed source ref. It has `workflow_dispatch` with **no custom inputs**: selecting the reviewed ref is the input selection; there is no release/tag/version parameter. It runs `bash scripts/build-signal-runtime-inputs.sh signal-runtime-inputs` on Linux and uploads an Actions artifact named `signal-runtime-inputs`. It does **not** create a GitHub release. No Mac is needed for this input build; later matching-host packaging/signing remains separate.

Inputs are fixed by the selected tree:

* Image `node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`, checked by `scripts/signal-builder.json` and `SIGNAL_BUILDER_IMAGE`.
* signal-cli source commit `48a0a5e90cb0c36153f0276c0affff090e588290` (`evidence.mjs`, D060), fetched as the reviewed archive through `build-inputs.json`.
* Gradle distribution D061, SHA-256 `21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607`; wrapper is redirected to the locally verified ZIP. `signal-reproducible.init.gradle` controls deterministic archive settings. The plugin/buildSrc/Maven closure is pinned by `gradle/verification-metadata.xml` and `gradle/verification-keyring.keys` (D102); both independent builds copy these inputs and use `--dependency-verification=strict --no-configuration-cache`. Missing or changed inputs fail closed.
* Temurin **25.0.5+8-LTS** Linux x64 build JDK and three target JREs from `signal-java-inputs.json` (D047-D058 include checksum/signature inputs); signing key is vendored and fingerprint checked. Targets: darwin-arm64, win32-x64, linux-x64. Foreign Java/JNI is not executed on the Linux builder.
* Existing native/JAR/layout/license pins and normalization scripts, including `signal-jar-layout.py`, `signal-jdeps-inputs.py`, `normalize-signal-runtime.mjs` and the runtime pin.

The script builds twice from independent source/Gradle directories, byte-compares each archive and fragment, and emits three `.tar.gz` files, `pin-fragment-<target>.json`, logs, `SHA256SUMS` and `container-image.txt`. Archives contain `signal-cli.jar`, `lib`, `native`, `jdk`; staging renames `jdk` to `jre`. MAIN must retain the independent build evidence, check the archives and fragments against the committed runtime pin with `merge-signal-runtime-inputs.mjs --check <directory>` and its required evidence sidecar, and review any mismatch. Current expected archive hashes are:

| Target | SHA-256 |
| --- | --- |
| darwin-arm64 | `ea2a3242fee48e9734692bb5abb7d363a2ad9b9a825eb5f08c8cee8f2eb05cce` |
| win32-x64 | `674b2718120ebecbb2e2fef02379cf12e6f1f5e0aba94dafcf8d434bbe9ef550` |
| linux-x64 | `79932ceca707e25bd30707c8dc75df45a3cfa5675f6498e814fcb8e127e44147` |

Only reviewed bytes matching the pins may be published under the pinned tag. If the build differs, MAIN must review the source/pin/evidence change; uploading mismatched bytes does not close D044-D046. The runtime pin currently has `g0: null` and `rateLimitNotSentProof: null`; an input archive's publication alone does not make the Signal release gate green. `merge --write` does not synthesize these proofs.

## D098 accepted integrity pin

MAIN ruling 2026-11-11 accepts the npm lockfile SHA-512 integrity fields for D098: the hash verifies the downloaded bytes whichever registry serves them. The committed `scripts/dbus-next/package-lock.json` and `npm ci --ignore-scripts` bind the 119 tarballs to those bytes. This row does not require a second registry URL or a duplicate SHA-256 pin.

## D100 exact manifest pin

The official [Rust 1.97.1 channel manifest](https://static.rust-lang.org/dist/channel-rust-1.97.1.toml), dated **2026-07-16**, has SHA-256 `03569b1886ceb5c05276b50c8431ab111de944cd6140fe1fa7d821dd8e0f29cf`, also confirmed against its official `.sha256` sidecar. `scripts/browser-rust-inputs.json` records that exact manifest and the `xz_url`/`xz_hash` entries for 15 components: cargo/rustc for four native hosts and rust-std for those hosts plus two musl targets and Windows GNU.

The installer verifies the manifest digest before extraction/execution, downloads only the selected host's rustc/cargo/rust-std and the cross target's rust-std (deduplicated for native builds), verifies each SHA-256, and installs into a fresh prefix. The workflow prepends that prefix's binaries and sets `RUSTUP_TOOLCHAIN` to its absolute path. No `rustup toolchain install`, `default`, or `target add` downloads remain. No official fallback distribution mirror was established. The official rustup [environment documentation](https://rust-lang.github.io/rustup/environment-variables.html) identifies `https://static.rust-lang.org` as `RUSTUP_DIST_SERVER`; third-party mirrors are not official fallback sources. Per MAIN ruling 2026-11-11, retain the official manifest SHA-256 and individual component SHA-256 pins. All 15 archives were fetched and streamed through SHA-256 in a container on the permitted host; `ci/checkahead-rust-components.json` records the actual byte counts, hashes and URLs. The manifest also matched its official checksum sidecar and all 15 URL/hash pairs matched its fields. The broader Cargo/pnpm source closure remains the existing D101 disposition. Fixture tests do not qualify an actual native vendor rebuild.

## D094 accepted STANDING exception and D102 verification

**D094 — ACCEPTED by MAIN as a STANDING exception (ruling 2026-11-11).** Allow the Signal input builder `node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4` from Docker Hub as a single-registry build prerequisite. The exact immutable OCI manifest digest is pinned in both `scripts/signal-builder.json` and `.github/workflows/signal-runtime-inputs.yml`; that digest is the integrity guarantee. Retain it in input-build evidence. A failed pull blocks the build; no mutable tag substitution or automatic unverified registry fallback is permitted. Revisit when an identical OCI manifest/layer closure is mirrored and verified. This accepts the single-registry availability limitation, without weakening digest verification.

## D102 verified Gradle/Maven closure

MAIN rejected the proposed D102 exception. The committed `gradle/verification-metadata.xml` now pins the complete `installDist` resolution observed for signal-cli commit `48a0a5e90cb0c36153f0276c0affff090e588290`: **192 components, 342 artifacts, all with SHA-256** (142 JARs, 107 POMs, 93 Gradle module metadata files). This includes settings/build plugins, buildSrc/Kotlin, parent POMs and transitive runtime inputs, rather than only shipped JARs. PGP verification is enabled for **334 artifacts using 37 exact signing fingerprints**, scoped per artifact. There are no global trusted key patterns or trusted artifact bypasses. Keyserver lookup is disabled; the public keyring is committed.

**MAIN ruling: D102 is not accepted as an exception.** The strict verification below closes its dependency-verification requirement.

Eight artifacts require SHA-256 alone: four have no retrievable signature (the Kotlin DSL plugin marker POM, javax.inject JAR/POM, Sonatype oss-parent POM); openjson JAR/POM and rxkotlin JAR/POM have unavailable/unusable signer keys `CF776DADF519DEE3` and `94B291AEF984A085`. Those keys are ignored only on those four exact artifacts and their SHA-256 is still required. This is checksum verification, not an exception to D102. Gradle prefers a trusted valid signature where present and otherwise requires the recorded checksum; this does not claim Gradle enforces both simultaneously.

Generation ran on build-host in the pinned builder image, with D060 archive SHA-256 `a8758b3ac6a22f5b35f3690101759a269f765ed619317c6e7903eb040b3cbe9d`, D061 Gradle 9.8.2 ZIP SHA-256 `21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607`, and authenticated pinned Temurin 25.0.5+8 build JDK. Only metadata generation/key retrieval used networking. The Gradle commands were `./gradlew --no-daemon --no-build-cache --max-workers=4 -I /repo/scripts/signal-reproducible.init.gradle --write-verification-metadata sha256,pgp --export-keys installDist`, followed by an offline SHA-256 metadata pass to also record checksums for signed artifacts. Retrieved public keys supplemented Gradle's exported keys; signature trust was narrowed to each exact artifact and every SHA-256 checked against the resolved bytes. Gradle verified the exported Signal signer key; GnuPG independently checked the other 332 signed artifacts.

Both production input-build attempts stage the same committed XML/keyring and record their SHA-256 in `gradle-verification.SHA256SUMS`, retained in the Actions artifact. They never generate metadata or downgrade strict verification. New dependencies, metadata or keys require a separately reviewed metadata update.

The native Gradle proof uses fresh source directories and separate Gradle user homes, seeded only with the generation step's downloaded module files (no verification, build, configuration or task caches). The wrapper extracts the pinned local ZIP. Both runs use `--offline --no-daemon --no-build-cache --no-configuration-cache --max-workers=4 --dependency-verification=strict` and the production reproducibility init script inside a `--network none` pinned container. Changing exactly one SHA-256 to 64 zeroes for `org.gradle.kotlin.kotlin-dsl:org.gradle.kotlin.kotlin-dsl.gradle.plugin:6.7.6` causes dependency verification to fail while resolving buildSrc's plugin. The untampered run executes `installDist` from source. On 2026-11-11 the tampered run exited **1** on that exact checksum mismatch, and the untampered run exited **0**, with **12 tasks executed**. The related Signal runtime suite passed **145 tests, 6 existing skips**. Evidence and full closure inventory are in `docs/verification/evidence/signal-gradle-d102/`.

This closes the build dependency verification gap for this source/toolchain and `installDist`; it does not publish or qualify the three final runtime archives, update output pins, or waive Signal G0/post-G0 gates. MAIN still owns those steps. No workflow was dispatched and no release or tag was created by this job.

## CHECK and fixture scope

Run `node scripts/check-release-assets.mjs` with `GH_TOKEN` in the process environment. It is read-only. It derives the twelve blocked app URLs from their source tables, includes every URL/alternate in `scripts/build-inputs.json`, and includes the new Rust manifest/components. GitHub release assets are resolved using authenticated, paginated release and asset metadata (including drafts and API asset-ID alternates); absent/draft/unpublished releases, absent/non-uploaded assets and size/digest metadata mismatches fail. Each URL is also probed anonymously with HEAD, falling back on HTTP 405 to a range GET whose body is cancelled. Non-GitHub build inputs require anonymous availability too. Failure of any configured URL fails the CHECK even if another alternate works.

The CHECK checks publication/availability, not a complete rehash of large binaries; package downloaders still enforce their committed hashes, and MAIN must verify draft bytes before publication. It does not inventory dynamic npm/Cargo dependency-manager traffic (D097/D101). D102 is covered separately by the committed strict Gradle verification metadata and native build proof above, not by this availability CHECK.

`scripts/check-release-assets.test.mjs` uses the in-repository `scripts/fixtures/release-assets.json` and injected fetches; it makes no network requests. `scripts/install-browser-rust.test.mjs` uses fake manifests/components/installers and rejects altered manifest/component bytes before executing an installer. Both tests are registered GATE in `ci/gate-tests.txt`. dbus-next reproducibility is checked by running its actual generator twice with `npm ci`, offline, from a prefetched cache and comparing the recorded shipped hash. All tests run in isolated network-none containers; no live app/data is involved.

Verification in this job: all 18 new fixture cases passed; the six-file related suite had **96 passes and one inherited failure**. `signal-release-prerequisites.test.mjs`'s whole-tree mutation-owner audit reports three existing `gh release` mutations in `build-browser-vendor.yml`. Comparing its findings with that file from starting commit `ca430795d` produced the identical three findings; this patch does not change them or waive the audit. The container runner supplies the audit's supported NUL-delimited tracked-file index because host worktree Git metadata is outside its mount.

Both consecutive offline `npm ci`/bundle runs reproduced the shipped hash; the two Linux vendored-notification Node tests and CI test-tier validator passed. A container provenance check matched every new Rust component URL/hash against the retrieved official manifest. The live authenticated release CHECK was not run by this job: MAIN must run it after its release actions. Passing fixture tests does not mean the draft/missing release blockers have been resolved.

## This re-review round

The memory qualification CLI now tries each reviewed source on HTTP 403/404, range failure and corrupt/truncated/oversized successful downloads. Transient failures retry at most three times per source; source changes discard partial bytes. Every completed file is size/hash checked inside the attempt before the target is renamed. Ten tiny, task-owned CLI fixtures exercise that behavior without contacting model hosts or live application data. The starting 6e280074b implementation failed nine of them; the corrected implementation passes all ten.

The workflow registration test asserts that both the release CHECK and Signal gate exist before comparing order. Isolated workflow copies prove that deleting the CHECK survives the old assertion, fails the corrected assertion, and that deleting the Signal gate or reversing the steps also fails. The checked-in release workflow is not mutated for these proofs.

`ci/checkahead-cli-diagnostics.tsv` inventories 52 added or restructured English diagnostic templates across the check-ahead changes from c1bb72379. They are maintainer build/qualification output, with no renderer or channel exposure.

The signing key's armor-header trailing space was removed only after verifying identical decoded OpenPGP packets, valid self-signatures, and a valid signature over the real pinned Linux Temurin JRE with both original and trimmed keys. The byte pin in `signal-java-inputs.py` and its regression test now use SHA-256 `52542b963fb4c1ee5607e3da4a794727e9ba3d3266988d7dff3a9d3425e88c67`.
