# Release credential boundary

Exactly three jobs have write permissions, each with an exact permission map:

| Workflow/job | Permissions | Allowed mutation |
|---|---|---|
| `release.yml/assemble` | contents: write; actions: read | Release guard: early throwaway token probe, notes, installer draft/upload, digest proof, optional publish |
| `prepare-release.yml/open-pr` | contents: write; pull-requests: write; actions: write | Create only `release/prep-*`, open/reuse its PR, dispatch `ci.yml` |
| `cla.yml/record` | contents: write | Update only `signatures/cla.json` on `cla-signatures` for the exact signature comment by the API-verified PR author |

Only `assemble` receives `RELEASES_PAT`. The other two writers use only
`GITHUB_TOKEN`. Every workflow defaults to read-only permissions. Arbitrary
write scopes on another job, extra scopes on an allowed writer, reusable
writers, non-allowlisted actions and arbitrary writer shell steps fail the
parsed-YAML capability audit. Each writer checks out trusted source without
persisted credentials and sets up Node using full-SHA allowlisted actions.
Administrative steps are fixed reviewed entrypoints with exact inputs.

`assemble` starts after preparation and runs the token-write probe before
platform builds. Read-only `preflight` polls that successful step on this exact
run attempt. Platforms depend on preflight; `stage` depends on all platforms
and CI. The guard waits for stage success, then downloads attempt-named verified
assets and the CI waiver record into separate data directories. It verifies
the waiver record's source SHA before adding it to notes. No downloaded data
is extracted into the code or dependency tree. Bootstrap uses a pinned package
manager, frozen dependencies and no lifecycle scripts. Probe, upload and
publication retain the unchanged Signal prerequisite. Null G0 still refuses
release with `G0_REQUIRED`.

Preparation retains its reviewable patch as an extra artifact. It inspects an
existing branch's package version, reuses the open PR, and never rewrites that
branch. CLA manual dispatch takes `pr_number` and fetches the author from the
API. Rerun the original PR CLA check after recording to refresh its required
result; manual dispatch reports its own verification. See [releasing](releasing.md)
and [CLA](../CLA.md) for the operator procedures and re-run rules.

The former Actions-write cancellation job and Linux provenance-attestation
step are removed to satisfy the exact allowlist. Signing, checksum signatures,
CI/package/staging checks and release digest verification remain in place.

The audit parses every tracked workflow and local action, resolves local uses,
and checks reusable callers/callees and all explicit secret references.
Unknown, dynamic, whole-context or inherited secrets fail closed. The lexical
mutation scan is secondary lint, including the reviewer's multiline URL/curl
fixture; it is not the credential boundary. Fixed administrative command bodies
are reviewed source, just as release-guard is; the audit does not claim to
prove arbitrary program semantics.

## Workflow permissions

Omitted scopes are `none`. Job scopes below replace the workflow map.

| Workflow | Top-level permissions | Job overrides |
|---|---|---|
| ci.yml | contents: read | none |
| cla.yml | contents: read | `record`: contents: write |
| docs.yml | contents: read | none |
| flux-contract-daily.yml | contents: read | none |
| fuigo-intel-qualification.yml | contents: read | none |
| fuigo-linux-package-qualification.yml | contents: read | none |
| gepa-intel-qualification.yml | contents: read | none |
| mac-notification-authorization-preflight.yml | contents: read | none |
| memory-timing-nightly.yml | contents: read | none |
| native-addon-msvc.yml | contents: read | none |
| nightly-perf.yml | contents: read | none |
| nightly.yml | contents: read | none |
| package-linux-service-qualification.yml | contents: read | none |
| package-linux.yml | contents: read | `verify-published`: contents: read, actions: read |
| package-mac-qualification.yml | contents: read | none |
| package-win.yml | contents: read | `stduser`: contents: read, actions: read |
| prepare-release.yml | contents: read | `open-pr`: contents: write, pull-requests: write, actions: write |
| recovery-snapshot-qualification.yml | contents: read | none |
| recovery-transport-qualification.yml | contents: read | none |
| release.yml | contents: read | `ci-gate`: contents: read, actions: read; `preflight`: contents: read, actions: read; `assemble`: contents: write, actions: read |
| scale-budget.yml | contents: read | none |
| seed-tool-cache.yml | contents: read | none |
| signal-runtime-input-check.yml | contents: read | none |
| signal-runtime-inputs.yml | contents: read | none |
| windows-presence-guard-preflight.yml | contents: read | none |

## Every explicit secrets.* use

39 occurrences. Step indexes are zero-based parsed YAML paths. The release PAT
appears only in guard step environments. Mac/Apple, Azure and GPG credentials
sign packages; Flux and build host credentials reach test infrastructure. No live
secret value is read by the audit. The built-in token uses `github.token` and
the permission map above. Local composite actions contain no secret references.

| Workflow | Parsed location | Secret |
|---|---|---|
| flux-contract-daily.yml | `jobs.contract.steps.5.env.FLUX_CONTRACT_KEY` | `FLUX_CONTRACT_KEY` |
| flux-contract-daily.yml | `jobs.contract.steps.6.env.FLUX_CONTRACT_KEY` | `FLUX_CONTRACT_KEY` |
| gepa-intel-qualification.yml | `jobs.intel-helper.steps.6.env.MAC_CERT_P12_BASE64` | `MAC_CERT_P12_BASE64` |
| gepa-intel-qualification.yml | `jobs.intel-helper.steps.6.env.MAC_CERT_PASSWORD` | `MAC_CERT_PASSWORD` |
| nightly-perf.yml | `jobs.perf-budget.steps.4.env.BUILD_HOST_SSH_KEY` | `BUILD_HOST_SSH_KEY` |
| nightly-perf.yml | `jobs.perf-budget.steps.4.env.BUILD_HOST_NAME` | `BUILD_HOST_NAME` |
| package-mac-qualification.yml | `jobs.mac.steps.11.env.MAC_CERT_P12_BASE64` | `MAC_CERT_P12_BASE64` |
| package-mac-qualification.yml | `jobs.mac.steps.11.env.MAC_CERT_PASSWORD` | `MAC_CERT_PASSWORD` |
| package-mac-qualification.yml | `jobs.mac.steps.18.env.APPLE_API_KEY_P8_BASE64` | `APPLE_API_KEY_P8_BASE64` |
| package-mac-qualification.yml | `jobs.mac.steps.18.env.APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` |
| package-mac-qualification.yml | `jobs.mac.steps.18.env.APPLE_API_ISSUER_ID` | `APPLE_API_ISSUER_ID` |
| package-mac-qualification.yml | `jobs.mac.steps.22.env.APPLE_API_KEY_P8_BASE64` | `APPLE_API_KEY_P8_BASE64` |
| package-mac-qualification.yml | `jobs.mac.steps.22.env.APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` |
| package-mac-qualification.yml | `jobs.mac.steps.22.env.APPLE_API_ISSUER_ID` | `APPLE_API_ISSUER_ID` |
| package-win.yml | `jobs.package.steps.12.with.azure-tenant-id` | `AZURE_TENANT_ID` |
| package-win.yml | `jobs.package.steps.12.with.azure-client-id` | `AZURE_CLIENT_ID` |
| package-win.yml | `jobs.package.steps.12.with.azure-client-secret` | `AZURE_CLIENT_SECRET` |
| package-win.yml | `jobs.package.steps.14.env.AZURE_TENANT_ID` | `AZURE_TENANT_ID` |
| package-win.yml | `jobs.package.steps.14.env.AZURE_CLIENT_ID` | `AZURE_CLIENT_ID` |
| package-win.yml | `jobs.package.steps.14.env.AZURE_CLIENT_SECRET` | `AZURE_CLIENT_SECRET` |
| release.yml | `jobs.mac.steps.10.env.MAC_CERT_P12_BASE64` | `MAC_CERT_P12_BASE64` |
| release.yml | `jobs.mac.steps.10.env.MAC_CERT_PASSWORD` | `MAC_CERT_PASSWORD` |
| release.yml | `jobs.mac.steps.27.env.APPLE_API_KEY_P8_BASE64` | `APPLE_API_KEY_P8_BASE64` |
| release.yml | `jobs.mac.steps.27.env.APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` |
| release.yml | `jobs.mac.steps.27.env.APPLE_API_ISSUER_ID` | `APPLE_API_ISSUER_ID` |
| release.yml | `jobs.windows.steps.13.with.azure-tenant-id` | `AZURE_TENANT_ID` |
| release.yml | `jobs.windows.steps.13.with.azure-client-id` | `AZURE_CLIENT_ID` |
| release.yml | `jobs.windows.steps.13.with.azure-client-secret` | `AZURE_CLIENT_SECRET` |
| release.yml | `jobs.windows.steps.18.env.AZURE_TENANT_ID` | `AZURE_TENANT_ID` |
| release.yml | `jobs.windows.steps.18.env.AZURE_CLIENT_ID` | `AZURE_CLIENT_ID` |
| release.yml | `jobs.windows.steps.18.env.AZURE_CLIENT_SECRET` | `AZURE_CLIENT_SECRET` |
| release.yml | `jobs.linux.steps.33.env.GPG_PRIVATE_KEY` | `RELEASE_GPG_PRIVATE_KEY` |
| release.yml | `jobs.linux.steps.33.env.GPG_PASSPHRASE` | `RELEASE_GPG_PASSPHRASE` |
| release.yml | `jobs.assemble.steps.3.env.GH_TOKEN` | `RELEASES_PAT` |
| release.yml | `jobs.assemble.steps.7.env.GH_TOKEN` | `RELEASES_PAT` |
| release.yml | `jobs.assemble.steps.8.env.GH_TOKEN` | `RELEASES_PAT` |
| release.yml | `jobs.assemble.steps.9.env.GH_TOKEN` | `RELEASES_PAT` |
| scale-budget.yml | `jobs.budget.steps.1.run` | `BUILD_HOST_SSH_KEY` |
| scale-budget.yml | `jobs.budget.steps.1.run` | `BUILD_HOST_NAME` |
