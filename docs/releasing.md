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

### Local fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload, publish, and always verify
the published bytes against the published feed by downloading them back.
