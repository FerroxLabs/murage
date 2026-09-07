# Murage private working build

Updated 2026-09-07. PRIVATE WORKING BUILD, not public release or RC.
Application source `e9320c2b`; version `0.1.47-private.6`; Fuigo `1.0.6`.
Later test-only/document changes do not change packaged application code.
No push/publication, installed-app replacement or production networking changes.

## Artifacts

Paths relative to `/Volumes/Mando/WaylandBots/murage-astra`:

| Platform | File | SHA256 |
|---|---|---|
| Mac arm64 | `release-private-e9320c2b/Murage-0.1.47-private.6-arm64.zip` | `3acff37a484ccc06739fc73e5755bb66d9a6ab987b93ac016ff8a7cad6044cf5` |
| Ubuntu x64 | `.planning/linux-private-e9320c2b/Murage-0.1.47-private.6-x86_64.AppImage` | `71438198a8df40eb0efbaf329db4f3b89c260570be54607c3e0a517bc4d01544` |
| Ubuntu DEB | `.planning/linux-private-e9320c2b/Murage-0.1.47-private.6-amd64.deb` | `8d06812a59f7f414c72295524c6592ebf49c7b4bc4a1d62c732e16f76bcc4380` |

## Evidence and remaining gates

| Work item | Status | Progress / pending work |
|---|---|---|
| Fuigo 1.0.6 | ✅ Done | Six artifact integrity/header checks, 11 focused tests, current Mac/Linux package checks passed. |
| Sidebar | ✅ Done | 53 unit and focused desktop/phone checks; readable names, quieter rows, group distinction. |
| Settings and Telegram UX | ✅ Done | Final browser continuation passed setup/copy/expiry/renewal/pairing/poll-stop/revoke/error checks. Chat label and settled-card backend checks passed. |
| Bots / Teams / Skills | ✅ Done | Separate discovery and metadata-backed purpose/outcomes/member descriptions; 26 unit and two browser checks passed. |
| Search | ✅ Done | Engine-first backup, explicit Firecrawl/Exa/Tavily, custody/API/browser checks. One live query per supplied key passed. Brave is API test only, not native integration. |
| Prose cleanup | ✅ Done | Authored explanatory copy updated; functional symbols, code, licenses and agent payloads preserved. Locale/focused checks passed. |
| Combined regression | ✅ Done | Full99684: 5,545 passed, three stale expectations failed, 20 skipped, one todo. Test-only corrections confirmed79/79; unaffected evidence reused. |
| Builds and desktop tests | ✅ Done | Frontend/server/docs passed; 190 Electron checks passed, one platform skip; contrast passed both palettes. |
| Signed Mac | ✅ Done | Ferrox Labs Developer ID deep/strict signature verification passed; actual packaged server81521 passed health/11paths/MCP drain. GUI opened on existing profile for Sean. |
| Linux package/lifecycle | ✅ Done | Metadata, packaged server and five isolated native lifecycle lanes passed. Local artifacts/logs exported and verified; owned remote checkout removed. |
| Linux updater | ⬜ Pending | Candidate-feed updater did not execute: development Electron install blocked by root-owned dependencies. No third correction attempt. |
| Mac notarization | ⬜ Pending | Known local AC_PASSWORD profile unavailable. Valid signing is not notarization; usable Apple credentials/profile needed. |
| Windows / Intel Mac | ⬜ Pending | Windows SSH unavailable; no current Intel Mac host. Native installer/GUI proof remains unverified. |
| Overall execution goal | ⏳ In progress | Private build available; public/platform gates and named follow-up remain open. |

## Install and use

Mac: extract ZIP to a separate private preview directory and open Murage.app.
Do not automatically overwrite `/Applications/Murage.app`. Build is signed but
NOT notarized; macOS may require an explicit user decision to open it. Never
reset the Keychain or disable Gatekeeper globally for this preview.

Ubuntu: use AppImage as a normal desktop user for non-installed preview. Make
that exact downloaded file executable before launching it. Install the DEB only
on an intended target machine, following `docs/linux-desktop.md`; do not install
on the shared buildbox. Native lifecycle proof is not DEB install/upgrade proof.

Search remains engine-first. Bots can call the free backup tool when native
search is unavailable/failed/limited; engine-internal searches are not transparently
intercepted. Paid providers run only when selected. Tested Exa/Tavily/Firecrawl
keys were saved encrypted in the desktop without changing provider selection.
Original owner-only key files remain intact. No extra paid queries while saving.

Telegram setup is under Settings > Channels. Restart requires re-pairing. Messages
share the Chief's current conversation. Ordinary tool permissions use owner-only
one-time buttons; richer reviewed proposals stay in-app. History/formatting and
controlled real Telegram denial have live proof; no command ran in that fixture.

## Known follow-ups and deferred scope

`SABLE-HANDOFF-CHECK.md` compares exactly three claims. The prior browser viewport/
click cause has existing fixes and native evidence. Residual role promotion gap:
server admission lacks the capability guard; Sidebar individual-to-leader path
is not fully gated. Read-only finding, not fixed or dismissed by this build.

Telegram groups, marketplace/hosted sharing, embedded engine login, advanced
recovery/isolated teams and extra channels remain deferred. BotMRR was inspected,
not bulk imported. No verified Murage npm/public-download availability promised.
Docs build succeeded with private GitHub release-feed404 warning; no public-site
access claim follows from that build.
