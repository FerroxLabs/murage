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
and choose a patch, minor, or custom version. It opens a tiny version-bump PR;
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
treats that as unpinned and takes its documented "no local semantic runtime"
path; the gate still refuses an Intel package that somehow carries a worker
tree. The `*-gepa-evidence` artifacts hold each job's sanitized build
evidence and never merge into the release asset set.

GitHub lookup failures (including authentication, rate limits, and outages)
stop the workflow. A missing published tag is checked against authenticated
draft listings too. Prepare next release inspects an existing version branch:
its package version must match, and its open PR is reused if present. If the
branch exists without an open PR, the workflow creates the missing PR without
rewriting or pushing that branch.

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
Publish does not run, and the draft is left untouched. To resume without
rebuilding, re-run the failed assemble job (the build artifacts are reused and
retained uploads are kept), or verify the retained draft directly with
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
from `electron-builder.yml`'s `publish` block, which must stay
`owner: FerroxLabs` / `repo: murage-releases`. Changing it strands every
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

The first job refuses to start a release from a commit the `CI` workflow
(`ci.yml`) did not pass. `scripts/release-ci-gate.mjs` lists CI's runs for the
pinned SHA and exits only when the newest attempt concluded `success`. A push
to main starts CI and Release together, so a run still in progress is waited
for (up to 75 minutes); no run at all is refused after a ten minute grace; a
failed, cancelled or skipped one is refused straight away. Re-run CI on the
commit (Actions, Re-run all jobs) and re-run the release to continue.

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

Replace the labelled TEST public key in `electron/release-key.asc` with Sean's
release-only Ed25519 OpenPGP public key export, including its armor CRC24.
Confirm its fingerprint with Sean independently of the release host. Use a v4
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

The Linux job attests the `.deb`, the `.AppImage` and `SHA256SUMS-ubuntu-x64.txt`
with `actions/attest-build-provenance` (pinned by full commit SHA, v4.2.2). Check a
download with `gh attestation verify Murage.AppImage --repo FerroxLabs/murage`. The
macOS and Windows jobs are not attested yet, and cosign is not used.

### Local fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload, publish, and always verify
the published bytes against the published feed by downloading them back.
