# iOS companion — salvage archive

The iOS companion app was retired on 2026-09-02 with zero published releases, so
nobody was stranded. It is replaced by a PWA served over Tailscale. The plan is
`docs/plans/universal-client/plan-ios-retirement.md`; this directory is step A4
of `docs/plans/universal-client/MASTER-PLAN.md` §3 Phase A.

`ios/` is gone. Everything here was copied **verbatim** out of it first, because
after the deletion commit these files exist only in git history, where nobody
looks. Nothing in this directory is built, linted, typechecked, or tested. It is
reading material for whoever writes the browser client.

**Read these. Do not port them.** They are Swift. Read them, then write
TypeScript.

## What is here

| Path | What it is |
|---|---|
| `CompanionCore/` (14 `.swift`) | The client half of the wire contract. `Models.swift` is still the most complete written description of the harness's JSON anywhere in the repo. `Client.swift` is every call the phone was allowed to make. |
| `CompanionCoreTests/` (22 `.swift`) | The executable version of the above — failover ratchets, SSE edge cases, pairing-URL shapes, store folds. This is the spec for the PWA's route policy. |
| `CompanionCoreTests/Fixtures/` (13 `.json`) | Bytes a real harness actually sent, recorded by `scripts/capture-companion-fixtures.mjs`. That generator survives and now writes to `companion/test/fixtures/`; these are the last capture the Swift tests ran against. |
| `App/` (15 `.swift`) | Exactly the files §3 of the retirement plan reads: reconnect (`Session.swift`), pairing UX (`PairingView`, `PairingScanner`, `Discovery`), approval interaction (`ChatView`, `Island`, `Cards/`, `Composer/`), and the update rules (`Updates`, `QuickRepliesEditor`). |
| `ShareExtension/` (4 `.swift`) | Share-sheet type coercion and retry, for the Web Share Target work. §3.7 names `ShareItemLoader` and `ShareViewModel`; the other two came along because they are two small files and salvage mistakes are irreversible. |
| `screenshots/` (7 `.png`) | The 6 App Store screenshots, never submitted, kept because they show the island-approval and chat-approval interactions the PWA has to re-solve. Plus `agent-profile-ios.png`, which was sitting unreferenced in `docs/screenshots/` — it is a shot of the retired app, so it came here with the rest. |
| `assets/` | **Load-bearing, not nostalgia.** The whole `AppIcon.appiconset/` catalog (`icon-1024.png` + `Contents.json`), plus a flat copy of the icon. MASTER-PLAN Phase D row D-b sources every PWA icon from this file and cites it by its old `ios/App/Assets.xcassets/...` path. Measured: 1024², RGB, **no alpha**, ground `#100F15` — and it is the only opaque square 1024 icon in the repo. Phase D breaks without it, and no other brand asset substitutes. See `assets/README.md`. |
| `ats-decision-record.md` | `ios/project.yml:104-121` verbatim, plus what it meant and why A7 could safely undo it. |
| `shared-layer-contract.md` | The protocol half of the deleted `docs/ios-companion.md` — connectivity routes, pairing and device security, stream and state model. |
| `reference/` | Full verbatim originals: `ios-companion.md`, `ios/README.md`, `ios/TESTING.md`, `ios/project.yml`. |

## `Client.swift` is here on purpose

A5 (re-rooting `companion/src/routes.ts` on a checked-in TypeScript route
contract) was **not** done. Its input is `Client.swift`, which A6 deleted. It is
preserved verbatim at `CompanionCore/Client.swift` so that work is still
possible. `companion/test/routes.test.ts:36` still names
`ios/Sources/CompanionCore/Client.swift` as the allowlist's derivation — that
path is now a dangling pointer, and repointing it at this archive (or, properly,
at an extracted TS contract) is A5's job.

## What was deliberately not salvaged

`MausAvatar.swift` + `MausFaceData.swift` + `MascotState.swift` +
`SpeechBubble.swift` — the mascot already exists in React at
`src/components/EmberAvatar.tsx` with `src/lib/mascot.ts`. `Glass.swift`,
`CompanionLayout.swift`, `PlatformBridge.swift`, `Keychain.swift`,
`LiveActivities.swift`, `Notifications.swift`, `Widgets/`, `AppShared/` —
Apple-platform-only, no web analogue. `Package.swift`, `ExportOptions.plist`,
the `.xcassets` catalog beyond the 1024 icon, and the rest of `AppStore/` —
build and submission machinery for a submission that never happened.

## The one thing with no web equivalent

`App/Discovery.swift` is `NWBrowser` over `_murage._tcp`. Bonjour is unreachable
from a browser. The PWA loses that discovery path entirely and has to lean on
the pairing link carrying the endpoint list.
