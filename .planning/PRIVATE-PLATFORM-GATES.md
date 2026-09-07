# Private candidate platform gates — 2026-09-07

Contract: read-only readiness checks for signing and native platforms, with this record as the sole owned file. No source changes, build dispatch, publication, main advance, app replacement, provisioning, or network/trust changes. Acceptance is an accurate disposition of available capabilities and missing proof, not all-platform acceptance. One initial access attempt per host; parent explicitly authorized one changed-hypothesis Hetzner retry using the actual configured alias. No verification budget reset. Parent owns the final frozen candidate and package verification rounds.

Source observed: HEAD `1a5a3c0dd6e39814dfca1a779990c51b6f39ed4f`, dirty worktree, package version `0.1.46`. This is source identification only; ongoing edits mean it is not the final candidate manifest. Existing unrelated files preserved.

| Work item | Status | Progress / pending work |
|---|---|---|
| Mac signing capability | ✅ Done | `security find-identity -v -p codesigning` reports one valid Developer ID Application identity, Ferrox Labs, LLC, team `PX6SP9GPWJ`. Identity presence is verified; candidate signing is not. |
| Local notarization capability | ⬜ Pending | Standard Apple API and Apple-ID notarization environment variables absent. `docs/releasing.md:137` names `AC_PASSWORD`; exact generic-password metadata lookup for service `com.apple.gke.notary.tool`, account `AC_PASSWORD`, did not find an item. This lookup does not prove all notary profiles absent. No credential value read or submission performed. |
| CI credential names | ✅ Done | Read-only `gh secret list --repo FerroxLabs/murage --json name` confirmed `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, three `APPLE_API_*` names, three `AZURE_*` names, and `RELEASES_PAT`. Names establish configuration presence only, not validity or successful signing. |
| Mac arm64 final candidate | ⬜ Pending | Local signing and packaging tools can build a private candidate. Required candidate signature verification, notarization/stapling if required, packaged smoke, and isolated GUI launch/quit remain parent-owned gates. |
| Mac Intel native acceptance | ⬜ Pending | Config supports x64 DMG/ZIP, but a cross-built artifact is not Intel runtime acceptance. Need the exact candidate on a native Intel Mac for required GUI/permission checks. No Intel host verified here. |
| Linux host access | ✅ Done | Actual configured `hetzner-dsm` alias succeeds with strict host checking: Ubuntu 24.04.4 x86_64, 820 GiB available on `/var/tmp` filesystem (51% used), `/usr/local/bin/node`, `/usr/local/bin/pnpm`, `/usr/bin/xvfb-run` present. Exact-candidate build/native proof remains pending. |
| Windows desktop access | ⬜ Pending | Single `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes seandesktop 'cmd /c ver'` timed out connecting to port 22. Need SeanDesktop reachable with its existing SSH access, or another already authorized native Windows desktop. |
| Windows signing/native installer | ⬜ Pending | Local Azure environment variables absent; matching CI secret names present. Native build, valid Authenticode, installer launch/update/uninstall and required elevation behavior need Windows execution against the exact candidate. No build dispatched. |
| Overall execution goal | ⬜ Pending | Platform/signing readiness assessed; final private candidate acceptance remains unverified. Available identity and CI configuration do not close missing native/signature gates. |

## Current packaging and workflow capabilities

`electron-builder.yml` targets macOS arm64/x64 DMG and ZIP, Windows x64 NSIS and ZIP, and Linux x64 DEB and AppImage. Mac hardened runtime is enabled; automatic notarization is explicitly disabled in builder configuration because the release workflow handles it. Windows config names Azure Trusted Signing account `ferrox-labs-signing`, certificate profile `ferroxlabs`, publisher `Ferrox Labs, LLC`.

`package:mac`, `package:win`, and `package:linux` use `--publish never`; however builder metadata still points at the public `FerroxLabs/murage-releases` update feed. A private build must remain isolated and must not use that feed as permission to publish or exercise a production update.

`.github/workflows/package-win.yml` is artifact-only, runs on `windows-latest`, packages with Azure secrets, checks packaged resources/update metadata, and starts the actual packaged server. These checks do not establish interactive Windows 11 installer/elevation acceptance. `.github/workflows/package-linux.yml` targets Ubuntu 24.04 x64, with package and separate installed-update verification paths; published-feed verification is not appropriate to a private candidate without a separately authorized fixture.

`.github/workflows/release.yml` includes Mac pre-notarization strict signature verification and matching bundled cloudflared team, notarization Accepted checks, and Windows valid-signature/allowed-publisher gates. It also performs release operations: do not dispatch it for this private request merely to obtain signing. The artifact-only Windows workflow needs a reachable committed candidate ref; the current dirty private source is not such a ref. Publishing/pushing a ref was not performed or inferred.

## Historical evidence and its limits

`.planning/MVP-PRIVATE-HANDOFF.md` records candidate `7ba8095c`, private `0.1.47-mvp.2` arm64 ZIP SHA256 `4750940044211033caddab746fe66c22ea3e7a091035cb94baeeddfef0519366`: packaged server/resource smoke and isolated native launch/quit passed. It explicitly records ad-hoc signing and no notarization. That artifact is not the current dirty candidate.

`.planning/STATE.md:1868` records older Linux manifest `597c1b0aa01bfcb008646867c21fa2384a2dfdf591963f84b0b961a92d1f7be5`, production build and packaged-server smoke on Hetzner; no native GUI proof. The old 75 GiB free-space figure is superseded by today's 820 GiB result; old scratch ownership and tool versions were not refreshed.

Initial access followed the historical override: `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o HostName=100.81.158.63 -o HostKeyAlias=95.216.244.213 hetzner-dsm ...`. It failed host-key lookup, not application readiness. Parent authorized testing the distinct actual alias configuration. `ssh -G hetzner-dsm` reports hostname `95.216.244.213`, user `root`, port `16666`, no HostKeyAlias. `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes hetzner-dsm ...` then succeeded. No known-hosts entry or trust setting changed. Do not repeat the historical override or label the successful configured route as confirmed Tailscale routing.

`.planning/vultr-windows-readiness.md` records prior Windows Server availability, which is not Windows 11 desktop proof. This task neither refreshed cloud availability nor provisioned a machine. No resource cleanup debt was created.

## Precise next authorized steps

1. Parent freezes the candidate identity, required package checks and remaining round budget. Local Mac packaging/signature checking is feasible using the verified identity; successful signing must still be observed.
2. Establish a usable local notary profile or authenticated notarization path without exposing secrets, then submit/staple only if included in the private artifact contract. Missing environment variables alone must not be reported as unavailable notarization.
3. Use the actual configured `hetzner-dsm` alias to transfer the frozen candidate into new isolated scratch; verify source hashes and precise tool versions before Linux build/native package checks. Access and OS/disk/tool presence are currently established; preserve shared workloads.
4. Restore native Windows desktop access. CI signing credentials can support an authorized committed-ref artifact build, but do not substitute for interactive desktop acceptance. Do not dispatch public-release automation or create a remote ref without authority.

Disposition: readiness record complete; required candidate/platform gates pending. No credentials printed, no app launched, no external mutation, no commit, and no third verification round introduced.
