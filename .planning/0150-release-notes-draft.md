# Murage 0.1.50 release notes draft

Draft for final sign-off only. Application source: `15c3cbd64056a7288777739f5dd244ca4365ea0b`. This document is not a publication announcement or a claim that the complete release is qualified. No README, release, feed or public artifact has been changed by this draft.

## Candidate changes

### Engines and reliability

- **Fuigo 1.0.10 is bundled.** The desktop engine does not require a customer Node.js or npm installation. Provider account access remains separate.
- **Fuigo updates independently of Murage.** Verified native packages can be selected as managed engines, updated, rolled back to the previous verified version, or switched back to the bundled engine. Busy-work and changed-selection checks protect the current selection. The full production manager path has native Windows x64 and Linux x64 proof, in addition to retained macOS arm64 and Intel proof. Windows qualification used a genuine Limited user and the original AppContainer isolation checks. This is not a claim that the final installed application has completed every delivery gate.
- **Claude background task notices no longer finish the parent reply prematurely.** The reproduced task-notification defect was corrected in `4f35f486`; the focused confirmation recorded 80 passes and one existing skip, with types passing. This fix is specific to parent-turn authority across background notices.
- **Windows recovery helper signing is enforced.** The packaged recovery executable now uses the existing signing path and final Ferrox signature validation. The corrected private installer build passed actual Windows signature checks for the app, recovery helper, Fuigo, updater launcher and installer. The updater launcher's final signed bytes also match its packaged manifest.
- **Clearer ACP diagnostics and cancellation handling.** Diagnostics identify the failed request, and requested process exits are distinguished from unexpected exits. These improvements do not establish a fix for either customer incident listed below.

### Work, files and controls

- **First-run onboarding:** outcome-led starting points, explicit engine selection, a reviewed starter crew and interrupted-setup protections. Existing workspaces are preserved rather than automatically populated again.
- **Clearer exports:** contextual bot/team selection with accurate role descriptions and supported assets; conversation Markdown export is a separate explicit action. Sharing definitions does not implicitly export credentials, conversations or private memory.
- **Inbox and saved Files:** retained navigation returns to the exact source message and report card. Saved download bytes, sibling-thread state and same-profile restart were checked. Interrupted reply animations no longer leave saved reports without their normal rendering. A path mentioned in chat is not automatically a registered deliverable.
- **Threads, accounts and settings:** retained task-specific model/account/approval controls and Stop targeting; grouped bot preferences; named Claude account controls that preserve existing login files; scoped memory with retained cross-engine/restart evidence. Real account sign-in and OS credential custody are not implied by fixture results.
- **Confirmed file watches:** watch an explicitly selected file inside an approved bot folder. Bounded reads use the existing scheduler and durable Inbox results; unchanged reads stay quiet and restart deduplication is retained. This slice does not perform arbitrary web monitoring or start a model turn.
- **Flux and connected workspaces:** one canonical connection and explicit credential choices preserve existing aliases and session identities. Isolated remote-window pairing, connected rendering, renewal, revocation and local-session preservation retain their scoped proof. Hosted cloud provisioning or deployed-service readiness is not claimed.
- **Guarded recovery:** snapshot capture, separate restore and explicit review preserve the original source data. Native same-user UAC evidence is retained separately; final installed app/helper behavior remains part of the Windows delivery gate.
- **Interface clarity:** retained keyboard/shortcut controls, peer portraits and waiting states, stale browser-profile protection, and scoped dialog/account translations. Translations are agent-authored and are not a claim of complete human-reviewed localisation.

These groups summarize accepted implementation and bounded evidence already recorded for the candidate. They do not reopen feature scope or substitute for final packaged-platform checks.

## Known limitations and pending sign-off

- The customer `-32603` engine errors and unexpected exit `1073807364` remain unresolved. Do not describe the Claude background-notification fix, improved ACP diagnostics, or cancellation checks as fixing those incidents.
- The original Mac shutdown delay remains unresolved. The original `f320` attempts exceeded credential-write drain. Later unchanged-app diagnostics traced optional Composio registration into safeStorage initialization and exited after encryption was rejected; that did not reproduce or correct the original intermittent delay and did not prove credential custody. A separate packaged smoke pass must not silently close this limitation.
- Windows source `15c3cbd6` has a signed, hash-verified installer and ZIP. Upgrade postconditions, preserved data, uninstall exit0, reinstall exit0, fresh-profile launch, actual reboot and post-reboot launch/normal close passed. The installed signed Fuigo completed the source-matched scripted useful-read/final, handled missing-read and cancellation checks with zero external model calls. The original upgrade installer's exit code was missed by the observer and remains an explicit evidence gap, not an inferred exit0. Guest cleanup confirmed no owned processes and unchanged original/backing identities; QEMU required termination after a graceful-powerdown wait.
- Source-matched Mac and Linux artifacts have passed their scoped gates: Mac run `34473310308` includes Developer ID signing, four accepted notarizations, stapling, native arm64/Intel window and graceful-quit checks, and 11 locally verified manifest entries. Linux run `34473310353` includes packaging, metadata, five lifecycle lanes and both locally verified installer hashes. Both use `15c3cbd6`. These passes do not waive the separate incident or Windows lifecycle gates. Older `f320`, `f164` and `11549fff` artifacts are historical evidence, not this final source cohort.
- Intel updater proof does not establish an Intel GUI package or semantic-memory runtime. Linux/Windows ARM64 package support is not claimed.
- No public publication, public-feed update, customer upgrade or complete release-readiness claim is made here. Resolve the current native artifact dispositions before approving public copy.

## Proposed README changes, not applied

Apply these only to the final approved source/publication documentation. Re-read the current files before editing because the public downloads README has already advanced beyond the stale source README.

### Source repository README.md

Replace the current download heading line linking “Murage 0.1.47” to `releases/tag/v0.1.47` with exactly:

```markdown
**[Latest release and release notes](https://github.com/FerroxLabs/murage-releases/releases/latest)**
```

Keep the existing stable asset URLs unchanged:

| Platform | Stable public download target |
|---|---|
| macOS Apple Silicon | `https://github.com/FerroxLabs/murage-releases/releases/latest/download/Murage.dmg` |
| macOS Intel | `https://github.com/FerroxLabs/murage-releases/releases/latest/download/Murage-intel.dmg` |
| Windows x64 | `https://github.com/FerroxLabs/murage-releases/releases/latest/download/Murage-setup.exe` |
| Ubuntu 24.04 x64 | `https://github.com/FerroxLabs/murage-releases/releases/latest/download/Murage-amd64.deb` |
| Ubuntu portable | `https://github.com/FerroxLabs/murage-releases/releases/latest/download/Murage.AppImage` |

Replace the blanket “Ubuntu installation and upgrade checks passed for this release” sentence with version-neutral wording:

```markdown
See the [latest release notes](https://github.com/FerroxLabs/murage-releases/releases/latest) for platform verification, signing and known limitations. [Ubuntu checksums](https://github.com/FerroxLabs/murage-releases/releases/latest/download/SHA256SUMS-ubuntu-x64.txt) are provided alongside the downloads.
```

Remove stale current-version framing elsewhere without asserting that limitations were fixed: replace “In 0.1.47” around delegation/default-memory descriptions with the relevant current behavior and release-notes reference; retain the actual limitation until its evidence supports removal. The Intel-memory limit must remain explicit if the final package still lacks that runtime. Existing `0.1.47` screenshot/asset filenames are historical identifiers, not current-version promises; do not rename or fabricate new screenshots for this release.

### Public downloads repository README.md

Its current “Latest release and release notes” link and stable asset URLs are already correct. Do not replace them with a hardcoded `v0.1.50` tag. After the approved 0.1.50 publication, replace the current “Windows 0.1.49 ... Fuigo 1.0.8 remains bundled” paragraph with:

```markdown
See the [latest release notes](https://github.com/FerroxLabs/murage-releases/releases/latest) for bundled engine versions and platform-specific fixes. The reported `-32603` engine errors and unexpected exit `1073807364` remain under investigation.
```

The versioned 0.1.50 release notes should state “Fuigo 1.0.10 is bundled” after the exact published assets are verified. Keep signing/notarization and installation claims limited to the artifacts and gates that actually passed. No private temporary-path download links belong in either public README.

## Evidence anchors for the reviewer

- Exact source: [15c3cbd6](https://github.com/FerroxLabs/murage/commit/15c3cbd64056a7288777739f5dd244ca4365ea0b), including Claude fix [4f35f486](https://github.com/FerroxLabs/murage/commit/4f35f48616282822951f2d903e0cffb370fa41bd) and unified updater `9eeb5e03`.
- Windows lower-level and full-manager D2: genuine-Limited candidate `4dc37b21`, original isolation canaries plus full ACP and install A 1.0.9, update B 1.0.10, rollback A and bundled fallback. Guest export and exact source hashes are recorded by the native owner.
- Linux full manager: [run 34468176872](https://github.com/FerroxLabs/murage/actions/runs/34468176872), source `576035a1`; earlier lower-level pass [34461913135](https://github.com/FerroxLabs/murage/actions/runs/34461913135) is retained separately.
- Signed Windows artifact: [run 34471681869](https://github.com/FerroxLabs/murage/actions/runs/34471681869). Installer SHA256 `46d67a86c3e5698c1a986b08ad31fd8ef262c8217aa7c1442b652097c925e5b7`; ZIP SHA256 `7c4df032cbcc6ef2a2e362f95011c16cb734137c1e49ab281f9a61d756cf8308`. Both local sizes/hashes match CI. Final signatures and payload identities are retained under `/private/tmp/murage-0150-build-recovery-fdatWt/windows-signing-confirm-evidence` and the sibling `windows-signing-confirm-payload` directory.
- Retained feature descriptions and bounded evidence: exact-source `docs/verification/0150-private-preview.md` and `.planning/0150-candidate-manifest.json`. Their historical platform statuses are superseded only by the specific newer receipts above and the coordinator addendum, not by this draft.
- Current execution handoff: `0150-build-recovery-addendum.md` alongside this draft. Refresh its pending artifact/native outcomes before final sign-off. No checks or publications were triggered for this documentation draft.
