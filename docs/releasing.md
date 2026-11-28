# Releasing

## README release checklist

Before publication, review the README in both `FerroxLabs/murage` and
`FerroxLabs/murage-releases`. Use “Latest release” linked to `/releases/latest`
instead of a hardcoded version in the download heading. Verify installer links,
bundled-engine information, setup requirements and known platform limitations
against the new artifacts. Desktop installers include standalone Fuigo and do
not require Node.js, npm, pnpm or a separate Fuigo installation. Keep developer
toolchain requirements separate. Never describe an unpublished candidate as the
latest public release. README review is required for every release.

For a normal release, run **Actions → Prepare next release → Run workflow**
and choose a patch, minor, or custom version. It opens or reuses a tiny
version-bump PR on `release/prep-<version>` and explicitly dispatches `ci.yml`
on that branch (GitHub-token commits do not start push CI);
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The **Actions → Release → Run workflow** button remains available for reruns
and recovery, and is still the only way to publish immediately. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, assembles a complete draft on
[murage-releases](https://github.com/FerroxLabs/murage-releases) with
generated notes, and — if you ticked **publish** — flips it live. Leave
publish unticked to review the draft notes first, then publish from the
GitHub UI.

The workflow refuses a version that is already published. A push-started run
releases only when `package.json` moves to a strictly newer canonical stable
`X.Y.Z` version. Equality skips the build; downgrades and invalid or missing
versions fail. It also refuses to start when the previous version cannot be
read. Manual Release runs still require
that the version is bumped on the ref you select. A release is also rejected if any installer, stable
download name, updater feed, blockmap, size, or digest is absent or
inconsistent — the complete asset set is named in `release.yml`, and anything
missing or extra fails the run rather than shipping a half release.

Each build job also builds, verifies and pins the GEPA memory worker for its
own target before packaging (the same steps as the `package-*.yml` workflows),
and the after-pack gate refuses to package without that receipt. The one
exception is the Intel Mac: `native/gepa/build-mac.py` builds only the runner's
own architecture, and the release runner is arm64, so `darwin-x64` is packaged
with an explicit `murageGepaManifests.darwin-x64=unavailable` opt-out. The app
treats that as unpinned and takes its documented "no GEPA worker" path (smart
search still works there, on the bundled model and ONNX Runtime WebAssembly); the gate still refuses an Intel package that somehow carries a worker
tree. The `*-gepa-evidence` artifacts hold each job's sanitized build
evidence and never merge into the release asset set.

GitHub lookup failures (including authentication, rate limits, and outages)
stop the workflow. A missing published tag is checked against authenticated
draft listings too. Prepare next release inspects an existing version branch:
its package version must match, and its open PR is reused if present. If the
branch exists without an open PR, the workflow creates the missing PR without
rewriting or pushing that branch. A mismatched version or API failure stops
preparation. The `release-version-patch` artifact is retained on the preparation
run for review: download and unzip it to inspect `release-version.patch`. The
`open-pr` job performs the branch/PR handoff automatically; reviewers review
and merge the linked PR. Do not apply the patch again to an existing PR.

Preparation uses only `GITHUB_TOKEN`. Only Release's `assemble` job may mutate
releases or release assets through an API, `gh release`, or electron-builder
publishing, and only that job may use `RELEASES_PAT`. Other jobs may call release
APIs only with GET, using `GITHUB_TOKEN` or no token and `contents: read`.
After the Signal prerequisite and version checks, `assemble` creates, verifies
and deletes a uniquely named
throwaway draft to prove token write access, then checks the candidate version
is still available. The read-only `preflight` job observes successful completion
of that probe in the same workflow run attempt before any platform build starts.
A failed probe stops builds. `assemble` then waits for successful `stage`, which
depends on CI and every platform job. No installer upload happens before that
barrier. Both waits are bounded and API failures stop the run.

## Draft assembly and publication boundaries

Assembly and publication are serialized per version. After the builds finish,
the upload helper binds the candidate to one numeric release ID and checks that
it is still a draft immediately before and after every upload. Uploads never
delete or overwrite an existing asset. An existing asset is reused only when
its uploaded state and size match the staged bytes and its SHA-256 digest, once
GitHub reports it, matches too. A different asset stops the run; use a new
version, or explicitly repair the draft while its workflow is stopped and then
rerun. Signed rebuilds may produce different bytes, so a rebuild is not
guaranteed to reuse an existing draft.

Publication waits for GitHub's own digest of every asset. GitHub computes
digests asynchronously, so the proof step polls for up to a minute. A wrong
name, an unfinished upload or a mismatched digest fails at once. If any digest
is still missing after the wait, the release is **held**: the proof step fails,
Publish does not run, and the draft is left untouched. To resume through
Actions, select **Re-run all jobs**. The probe, staging,
review record and artifacts are bound to one run attempt; rerunning only
`assemble` cannot consume a previous attempt's stage result. Existing matching
release uploads are still retained. To verify the retained draft directly, use
`node scripts/release-digests.mjs verify <version> <release-id> <assets-dir>`.
`scripts/release-guard.mjs publish` repeats the check right before it flips the
draft. Publishing from the GitHub UI skips this check, so verify first.

These checks are not an atomic GitHub transaction. Someone publishing through
the UI or another API client between a draft check and its upload can still
race the workflow: it detects publication afterward, but cannot undo an asset
already added. Do not publish a draft while assembly is running. For protection
enforced by GitHub at the write itself, enable
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
on `FerroxLabs/murage-releases`; publication then locks its assets and tag.
This repository change does not enable or verify that remote setting.

## Release notes are generated

The draft body is generated from the pull requests merged since the previous
release. `murage-releases` holds only assets, so the notes are generated
against **this** repository and handed over as a file; `.github/release.yml`
here decides the section each pull request lands in (label a PR `enhancement`,
`bug`, `documentation`, or `ignore-for-release`). Only a *new* draft takes the
generated notes — rerunning the workflow verifies existing identical assets
and uploads missing ones without touching edits you made while reviewing.

The docs changelog reads the published releases straight from
`FerroxLabs/murage-releases` and caches them for five minutes, so a published
release appears without a source commit.

## The updater feed is a contract

`app-update.yml` is baked into every packaged desktop app and is the only
thing that tells an installed copy where its updates come from. It is written
by `scripts/offline-update-metadata.mjs`, with `owner: FerroxLabs` /
`repo: murage-releases`. Both builder configurations keep `publish: null`;
packaging cannot upload a release. Changing it strands every
already-installed user with no error anywhere, so the mac, Windows, and Ubuntu
jobs each assert both halves on the packaged bytes, and
`scripts/verify-linux-package.mjs` re-checks them inside the `.deb` and the
AppImage. `murage-releases` must stay public: users' machines carry no token.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## CI must have passed on the commit

The `ci-gate` job refuses to cut a draft from a commit the `CI` workflow
(`ci.yml`) did not pass in full. `scripts/release-ci-gate.mjs` lists CI's runs
for the pinned SHA and passes only when the newest run's latest attempt
concluded `success` and the newest full run shows `required CI completion` and
every job it needs green. A scoped dispatch (`windows_only`, `vitest_file`,
`human_files`) skips that job, so it can confirm a fix but never proves a
commit: a scoped run alone is refused, and a red full run stays red until that
run is re-run or a new full run passes. A run re-run with `gh run rerun <id>
--failed` counts once it goes green. A push to main starts CI and Release
together, so a run still in progress is waited for (up to 4 hours; the builds
run beside it after the token probe, and staging waits on the verdict); no run at all is
refused after a ten minute grace; a failed, cancelled or skipped one is refused
straight away. The workflow has no Actions-write cancellation job; a CI failure
blocks staging and upload but does not cancel builds already running. Re-run
the failed CI jobs on the commit and re-run all jobs of the release to
continue.

The same gate needs the latest nightly green. CI's Vitest shards leave out
two tags (`vite.config.ts`): `nightly` (tests over 60 s on a hosted runner) and
`perf-budget` (tests that assert a wall-clock budget, run by the maintainers on
dedicated hardware). `nightly.yml` runs the `nightly` tag every night. The newest completed `Nightly` run
must have concluded `success`, on the pinned commit or one of its ancestors,
and be under 72 hours old; no waiver covers it. If it is red or stale, fix it,
dispatch `Nightly` on the release commit, and re-run the release.

### One-time CI waiver

When a CI failure has been reviewed and judged not to block a release, Sean
can approve a one-time waiver instead. Copy
`docs/releases/ci-waiver-template.md` to `docs/releases/ci-waivers/<version>.md`,
fill it in and commit it on a branch on top of the commit being released (a file
cannot name the commit that holds it), then run **Release** by hand from that
branch with `ref` set to the commit being released and `ci_waiver` set to that
path. The gate passes a red CI only when the run was started by hand (a
push-started release can never waive), the file is in the dispatch commit, that
commit descends from the pinned one, the file names the pinned commit and the exact failing full CI run for it (the
gate checks the run against GitHub), states `Critical: 0`, lists the reviewed
failure classes, and carries `Approved-by: Sean Donahoe on YYYY-MM-DD`. The
waiver is printed in the ci-gate job summary and recorded in the draft release
notes. Without `ci_waiver` the gate is unchanged.

## Rings: staged rollout (day 0, day 1, day 2)

Owners: MAIN runs every ring op; the rings build lane owns the publisher
(`scripts/release-rings.mjs` for the gates; `scripts/release-guard.mjs`
`ring-publish-internal` and `ring-op` for every GitHub write and the signing
key) and the client; MurageCloud owns the Cloud side (section 9 of
`designs/RINGS-DESIGN.md`). Every ring op is a `ring_op` dispatch of
**Release** (`release.yml`). A ring-op run builds nothing: `prepare` sets
`should_release=false`, so every build job is skipped and only `assemble`
runs the op. It is the only job holding `RELEASES_PAT` and the release key.
Both ring steps are fixed guard commands with a fixed env, admitted by
`scripts/release-capability-audit.mjs`; the guard imports the key into a
private keyring itself and removes it after the op.
`ring_op` with `publish` or `artifact_only` set fails at once.

The manifest is `rings/rings.json` + `rings/rings.json.asc` on the `rings`
branch of `FerroxLabs/murage-releases`. It is signed with the same key as the
Linux checksums (`RELEASE_GPG_PRIVATE_KEY`). Before writing, the op verifies
it with the shipped public key, using the client's own parser. Both files
land in one commit. Never edit that branch by hand: an unsigned or
hand-signed file is refused by every client, and it can block the next op.

### Never publish from the GitHub UI

`publish` (the `publish` input, `release-guard.mjs publish-prepared`) always
publishes as `prerelease=true, make_latest=false`. No shipped client and no
README button sees a prerelease. Only `ring_op=promote-all` with its gates
makes a release latest. Publishing by hand in the GitHub UI as latest skips
every ring. It is the one path this design cannot block. Don't do it.

### Placing the internal ring marker

Sean's Mac and the owner's Windows PC get updates on day 0. On each machine,
with Murage quit, create `update-ring.json` in the Murage user-data directory
with exactly `{"ring":"internal"}`:

- macOS: `~/Library/Application Support/Murage/update-ring.json`
- Windows: `%APPDATA%\Murage\update-ring.json`

No UI, no key. The file grants nothing but earlier updates of signed builds.
Delete the file to leave the ring. Nothing is ever sent anywhere: ring
membership is local only.

### Day 0: publish

1. Run **Release** with `publish=true` (as before). The release goes out as a
   prerelease. The same `assemble` job then runs `ring-publish-internal`: it
   checks that the release is published, not a draft, still a prerelease, and
   that `latest.yml`, `latest-mac.yml` and `latest-linux.yml` are uploaded
   with digests. Then it names the version for `internal` only.
2. On Sean's Mac and the owner's Windows PC: Settings > Updates > Check for
   updates, install through the normal Update button. Run the bannergate on
   Sean's store copy.
3. Post `BANNERGATE <sha> PASS`, `RING0-MAC <v> PASS` and
   `RING0-WIN <v> PASS` on the board. Each line must name the version.

### Day 1: advance beta

Run **Release** with `ring_op=advance-beta`, `ring_version=<v>`, and
`ring_receipts` set to the three board lines joined with ` | `. The op
refuses unless all of these hold:

- `internal` holds exactly `v`.
- No ring is halted.
- The run is on a later UTC date than internal's day 0, and at least 20 h
  after it.
- All three receipts name `v` and `PASS`.

"Get updates early" users then get `v`; everyone else does not.

### Day 2: promote to everyone

Run **Release** with `ring_op=promote-all` and `ring_version=<v>`. The op
refuses unless all of these hold:

- `beta` holds exactly `v`.
- The run is on a later UTC date than beta's day 1, and at least 20 h after
  it.
- No ring is halted.

It then flips the GitHub release to `prerelease=false, make_latest=true`,
checks that `releases/latest` is `v`, and names `v` for `all`. Pre-ring
clients get `v` through `releases/latest`. If the run fails after the flip,
run it again: each half checks its own state first, so the re-run only
writes the manifest.

Start the Cloud release for the same version only after this run is green
(section 9 contract).

**Hotfix waiver:** shortening the calendar is Sean's call per release. Put
his board line (it must contain `SEAN` and the version) in `ring_ruling`.
The calendar check is skipped, but the version checks are not. The run
summary prints the waiver.

**Bootstrap (first ring-aware release only):** no install can hold the beta
setting before that release exists, so day 1 is skipped.

1. Install the prerelease by hand on the two internal machines.
2. Place `update-ring.json`.
3. Run the bannergate.
4. On day 2, put `MAIN-RULING ... SEAN YES rings bootstrap <v>` in
   `ring_ruling`. The day gate then runs against internal's day 0.

The bootstrap release carries the rings code and nothing else.

All writing ring ops share one concurrency group, so they never overlap. Before
dispatching a ring op, check Actions: if another ring op is still pending, wait
for it. GitHub cancels an older pending run in the same group when a newer one
queues, and a cancelled halt shows as cancelled, not as done.

### Halt, resume, pin-latest

- **Halt:** `ring_op=halt`, `ring_version=<bad v>`,
  `ring_args="ring=<internal|beta|all> previous=<last good version>"`.
  `previous` must be a promoted release (published, not a prerelease, with
  its three update feeds); anything else is refused before signing. This halts that ring and every wider one: halting beta also halts all.
  Each halted ring holding the bad version is pinned to `previous`. If GitHub
  latest is already the bad version (after day 2), the same run pins GitHub
  latest back to `previous` and turns the bad release into a prerelease
  again. Clients that have not installed get nothing new, and a staged
  download is discarded at install time.
- **Resume:** `ring_op=resume`, `ring_args="ring=<ring>"`. This clears that
  ring's halt. Resume never advances; a fix ships as a new release through
  day 0.
- **Pin latest only:** `ring_op=pin-latest`, `ring_version=<bad v>`,
  `ring_args="previous=<good v>"`.
- Installs already on a bad version are never downgraded automatically
  (memory schema refuses older apps). Use a kill switch now, and a
  fix-forward release through day 0.

### Kill switches

Run `ring_op=kill` with
`ring_args='kill_id=<id> kill_versions=">=1.0.25 <1.0.26" kill_code=<code>'`.

- `kill_id` must be one of `shared/kill-switch-ids.mjs`.
- `kill_code` must be `kill-safety`, `kill-data` or `kill-perf`.
- Never free text: customers can see codes.

A kill only turns a feature off, and only for the versions in its range. A
kill ends when its range excludes the fixed version. Never remove a kill
while a version it covers is still any ring's target. Latency: the next
update check (up to 1 h, at launch, or Check for updates) plus up to 5 min of
GitHub raw cache.

### Daily resign

A daily schedule (06:17 UTC) runs `ring_op=resign`: seq+1, same content, a
new 72 h expiry. If it fails for 3 days, manifests expire. Ring-aware clients
then fall back to GitHub latest, and kills stay in force. A red scheduled
Release run means the resign failed: fix the key or token and re-run it.

### Build floor

Every platform job writes `electron/rings-floor.json` before packaging:
`release-guard.mjs rings-floor` stores the seq of the manifest live at build
time, or 0 before the first manifest. `rings-floor-check` fails the build if
the file is missing or malformed. A fresh install never accepts a manifest
older than its own build. A build fails if `raw.githubusercontent.com` gives
anything but the manifest or a 404 for both files.

## One-time setup: four secrets

Set these in **Murage → Settings → Secrets and variables → Actions**.

**Prepare next release** also needs **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**
enabled. That workflow only ever creates the version PR; it never approves it
and never merges it.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate, exported from the Mac that
currently signs releases:

```sh
# Keychain Access → My Certificates → your Ferrox Developer ID Application
# certificate (verify the legal name and Apple Team ID) → right-click →
# Export… → .p12 with a strong password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

### 3. `RELEASES_PAT`

A fine-grained personal access token that lets the workflow write to the
separate releases repo: **GitHub → Settings → Developer settings →
Fine-grained tokens** → repository access: only `murage-releases` →
permissions: **Contents: Read and write**. Set a long expiry and a calendar
reminder.

### 4. `RELEASE_GPG_PRIVATE_KEY` (and `RELEASE_GPG_PASSPHRASE`)

Signs `SHA256SUMS-ubuntu-x64.txt`, so a downloader can check the checksum file
and not just the files. Add the armored private key of a release-only GPG key:

```sh
gpg --quick-generate-key "Murage releases <releases@example.invalid>" ed25519 sign 2y
gpg --armor --export-secret-keys <KEYID> | pbcopy   # -> RELEASE_GPG_PRIVATE_KEY
# the key's passphrase, if it has one              -> RELEASE_GPG_PASSPHRASE
gpg --armor --export <KEYID> > murage-release-key.asc   # publish this public key
```

Linux updates verify `SHA256SUMS-ubuntu-x64.txt` and its detached `.asc` in-app
against `electron/release-key.asc`. The signed filename must match the version
and Linux artifact, the downloaded SHA-256 must match, and the version must be
newer than the running app. Murage checks the cached bytes again before restart
or Debian package handoff. Missing assets or a verification refusal remove the
download and offer “Download from murage.ai”.

`electron/release-key.asc` holds the Ferrox Labs release key (fingerprint
`40870F41FAFBF85D3878224479CD291197BF2D09`, made 2026-10-08, expires
2028-10-07). The labelled TEST key lives only in `scripts/fixtures/` for tests.
A new key means a new export here, confirmed with Sean independently of the
release host; the signing step refuses a signature the shipped key does not verify. Use a v4
Ed25519 legacy primary signing key (algorithm 22), signing binary checksum data
with SHA-256 or SHA-512. The verifier accepts that primary key, without subkeys.
Only the public export belongs in the repository. Its matching private key and
passphrase remain in the release secrets. `electron/**` packages the public key;
the app never downloads keys.

Every macOS, Windows and Linux job in `release.yml` runs
`node scripts/check-release-key.mjs` before packaging. Missing, malformed or
TEST keys stop the release. The committed TEST key deliberately keeps this gate
closed until the publisher key is supplied. Configure the matching signing
secrets and publish both checksum assets alongside the Linux artifacts;
an absent signing secret can omit the `.asc`, which the app refuses.
Check a download with
`gpg --verify SHA256SUMS-ubuntu-x64.txt.asc SHA256SUMS-ubuntu-x64.txt`, then
`sha256sum -c SHA256SUMS-ubuntu-x64.txt`.

### Build-provenance attestation

Release jobs do not create GitHub provenance attestations: the exact write-job
allowlist does not grant Linux `id-token: write` or `attestations: write`.
Platform signing, checksum signatures, package verification and release-asset
digest checks remain required. Do not expect `gh attestation verify` to find an
attestation for these builds.

### Local fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload, publish, and always verify
the published bytes against the published feed by downloading them back.

## Check engine versions every publish

Before each publish, check the shipped engine pins and the separately installed
engine versions used to qualify model defaults. Desktop bundles Fuigo and installs
Codex and Claude Code separately. Cloud home pins all three in
`deploy/cloud-home/build-image.sh`; check its hashes, `LICENSES.md`, qualification
script pins and `server/cloud-home/engine-cli-pins.test.ts` together. Do not infer a
bundled Codex version from a catalog comment. Record CLI model-support evidence before advancing an offline
default, preserve saved choices, and keep a live catalog authoritative. The
[1.0.19 model-default qualification](verification/model-defaults.md) records the
public-package evidence and verification limits for this change.

## Windows signing orchestration and extraction

Implementation and validators: win-sac-sign. Static enrollment, controller keys,
cloud adapters, protected runner admission and Windows collectors: MAIN. Existing
Azure signing identity and protected-environment approval: secure administration.

Preparation executes only the raw-input producers in the authenticated full
schema-3 plan. Its receipts retain that full parent digest; late app, backup and
NSIS inputs resolve from this driver's frozen events. `producer-bindings.json`
binds each late output to an absolute output and working directory, explicit
credential-free environment, input files and enrolled tools. Its
`nsisResources.root` must select the static `nsis-resources` tree. The driver
copies and signs that tree's declared PE images before embedding, and copies the
enrolled elevation helper before app preflight. Neither operation edits the
sealed original tools.

The static authority also enrolls an `extractor` tree containing `bundle.json`.
That lock pins the complete client, bootstrap, verifier and configuration file
set, the existing separate run-authorization and extraction-result keys, distinct
extraction and VM-control OIDC audiences and subjects, and the fixed Windows VM
recipe. The Linux bootstrap's capability is memory-only, single-use, nonce-bound and
installer-bound; its Unix socket is `0600`. Controller adapters must enforce the
fresh OS disk, standard account, per-user silent install, disabled launch and
guest networking, controller-only collection, expiry and destruction contract.
The controller hashes opaque installer/archive streams; it does not unpack them.

Extraction archives contain `installed/` and `transient/` namespaces. The Linux
client verifies the independent result signature, nonce, original build identity,
publication identity and archive digest before bounded materialization. Every
transient image must match a frozen signing record. Promotion additionally checks
the candidate's authenticated `transientFiles` set and `uninstaller` mapping
(`retainedPath`, `installedPath`, `sha256`). Both staging and publication perform
fresh extraction of their actual installer bytes.

`records.json` retains the complete source/final records. The candidate's
`signing.records` descriptor pins it; each record must match its graph event.
The authenticated signature capture is JSON `{schema:1, files:[...]}`, with each
record's canonical path, final `sha256`, `leafCertificateSha256`, current native
trust status, embedded-signature flag, publisher and timestamp flag. Promotion
checks the file/leaf pair and the common signed/preserved publisher policy.

After ZIP, ASAR, installed-payload and unchanged-tree checks, the driver writes its
complete receipt and metadata. MAIN's controller collects the output and signs
`signing/output.json` with the run-authorization key. That envelope contains the
full build `identity`, `receipt` descriptor/configuration/coverage and exact
`files` set under `release/` and `signing/`, excluding the envelope itself and
`signing/authority.json`. Qualification verifies that set against the protected
authority digest before running the existing package gates. Retained images use
`signing/retained/<canonical record path>`.

For a direct authenticated publication resume, `MURAGE_WINDOWS_BUILD_RUN_ID` and
`MURAGE_WINDOWS_BUILD_RUN_ATTEMPT` select the original build identity;
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` identify the current publication. They do
not relax Actions' existing same-attempt staging barrier. The supplied
receipt-write-failure mutant is in
`scripts/fixtures/windows-producer-mutants.json`.

The checked-in authority remains unenrolled. Portable tests and synthetic
controller/native doubles do not qualify real Windows trust, VM cleanup or SAC.
Production credentials stay blocked until the ruled Windows witnesses and
enforcing standard-user SAC proof exist.

The WIN-SAC collector ruling D2(1) permits exactly version `1.0.19`. Signing admission
checks the authenticated source tree's `package.json`; promotion rejects other
versions. The candidate-producing build precedes immutable witness enrollment;
`locked-build` is a separate witness rebuild and never rewrites enrolled inputs.
The native collector validation core and build/enrollment scripts are under
`infra/windows-signing/collector/`. Its measurement adapters are incomplete and
both collection entries refuse execution. See [MAIN's runbook](../RUN-ON-WINDOWS.md)
and [reserved decisions](../QUESTIONS-FOR-MAIN.md); this is not a runnable Windows
qualification deployment.

S4 proof additionally binds `tokenOpen` to `OpenProcessToken`, requested access
`40` (`TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY`), `succeeded:false`, and identical
`process`/`tokenOwner` objects containing numeric `pid` and decimal-string
`creationTime`. `successProcess` and `witnessProcess` use distinct PID/creation-time
pairs. Failure and success process `imageSha256` values match the installed
`Murage.exe`; `jobStarted` and `engineSpawned` are false and `refusalCode` is `EPOWER`.
The protected producer must authenticate real observations of the signed installed
candidate. No injection mechanism or continuous SAC adapter is accepted yet.

The remaining real-host checks have an executable
[witness pack contract](../scripts/windows-signing-witness/README.md). MAIN runs it
on the existing tagged Windows box with its sealed collector and independently
selected enrollment digest. It requires all 21 cases and cleanup, retains captures
outside the checkout, and leaves release HOLD in place. Pack validation does not
replace authenticated SAC evidence or either promotion gate.
