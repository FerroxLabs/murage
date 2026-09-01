# Retiring the iOS companion

Track owner: Sean. Status: plan only, no code written.
Repo under discussion: `/Volumes/Mando/WaylandBots/murage-app` (nothing in it was modified).

The whole finding in one line: **iOS is a leaf.** 130 files, 4.2 MB, and exactly
two references to it from the rest of the repo — both comments or a generator.
Nothing in the harness, the sidecar, Electron, the React app, the docs build,
`pnpm typecheck`, or `pnpm test` reads a line of Swift. It can be cut in one
commit without touching the remote-access layer at all.

---

## 0. What I proved rather than asserted

| Claim | How |
|---|---|
| The companion sidecar is whole with `ios/` absent | Copied `companion/ server/ shared/ src/` into a scratch tree with **no `ios/` directory**, symlinked `node_modules`, ran `./node_modules/.bin/vitest run companion/` → **13 files, 211 tests, all passed** — including `proxy.test.ts`, which spawns a real harness and drives it end to end. |
| The desktop pairing UI is whole with `ios/` absent | Same tree: `vitest run src/lib/phone-setup.test.ts src/lib/companion-pairing.test.ts src/components/CompanionSection.test.ts src/components/SidebarPhoneButton.test.ts` → **4 files, 61 tests, all passed**. |
| The allowlist 404s every static-asset path a PWA needs | `node --experimental-strip-types` against `companion/src/routes.ts`: `GET /`, `/index.html`, `/assets/index-abc.js`, `/manifest.webmanifest`, `/sw.js`, `/pair` all return `{"status":404}`. `GET /api/search` returns `null` (allowed). `PATCH /api/instances/:id` and `POST /api/cli-test` both 404. |
| `hosted` outranks `tailnet` | `companionEndpointCandidates(8810, ["100.121.5.6","192.168.1.42"], "macbook.tail1234.ts.net", "https://tunnel.example.com", "macbook.local")` → `0 hosted / 100 tailnet / 201 lan / 300 bonjour`. |
| Only two things outside `ios/` mention it | Repo-wide grep for `ios/`, excluding `.claude/worktrees`: `scripts/capture-companion-fixtures.mjs:6,28` and `companion/test/routes.test.ts:36`. That is the entire coupling. |

Scratch artefacts: `…/scratchpad/probe-routes.ts`, `…/scratchpad/probe-ep.ts`, `…/scratchpad/noios/`.

---

## 1. Inventory

### 1.1 `ios/` — 130 files, 4.2 MB, all deletable

| Group | Paths | What it is |
|---|---|---|
| Build spec | `ios/Package.swift`, `ios/project.yml`, `ios/ExportOptions.plist`, `ios/.gitignore` | SwiftPM + XcodeGen. Nothing else in the repo consumes them. |
| Core (no UI) | `ios/Sources/CompanionCore/` — 13 files: `Models.swift` (33 K), `Client.swift` (56 K), `Failover.swift` (20 K), `Store.swift` (18 K), `SSE.swift`, `Frames.swift`, `Endpoint.swift`, `ConnectionRegistry.swift`, `ChatPreferences.swift`, `SectionSelection.swift`, `Markdown.swift`, `Dictation.swift`, `AttachedMessageContent.swift` | The client half of the wire contract. **Highest salvage value in the tree.** |
| Tests | `ios/Tests/CompanionCoreTests/` — 21 `.swift` + 13 `Fixtures/*.json` | See §5. |
| App UI | `ios/App/` — 46 files including `ChatView.swift` (63 K), `Session.swift` (58 K), `MausFaceData.swift` (54 K), `MausAvatar.swift` (35 K) | SwiftUI. `Maus*` duplicates `src/components/EmberAvatar.tsx` (119 K), which already exists in React. |
| Extensions | `ios/ShareExtension/` (4 files), `ios/Widgets/` (2), `ios/AppShared/` (4), `ios/Shared/BotActivity.swift` | Share sheet, home-screen widget, keychain/config shared between targets. |
| Store metadata | `ios/AppStore/` — `RELEASE.md`, `privacy-answers.md`, `review-notes.md`, `en-US/*.txt`, 6 PNG screenshots | Never submitted. Zero published releases. |
| Docs | `ios/README.md` (12 K), `ios/TESTING.md` (15 K) | See §6. |

### 1.2 `companion/` — 26 files, **zero iOS-specific code**

Verified: the only mention of iOS anywhere under `companion/` is a comment
(`companion/test/routes.test.ts:36`) and the string `"iPhone"` used as a test
device name in `devices.test.ts`, `proxy.test.ts`, `control.test.ts`. There is
no Swift-shaped code, no Apple-specific header handling, no APNs.

The sidecar is the **shared remote-access layer**, not the iOS app's server.

### 1.3 CI

One job: `.github/workflows/ci.yml:149-172` — `ios: Swift tests + iOS build`,
`runs-on: macos-latest`, 20-minute timeout. It runs `swift test --package-path ios`,
`brew install xcodegen`, `xcodegen generate`, then a simulator `xcodebuild`.
It is a leaf job with no `needs:` and nothing needing it. `release.yml`,
`package-mac/win/linux.yml` and `electron-builder.yml` contain no iOS reference.

### 1.4 Docs

| Path | Lines | Fate |
|---|---|---|
| `apps/docs/content/docs/mobile/ios-companion.mdx` | 44 | delete |
| `apps/docs/content/docs/mobile/meta.json` | — | edit: drop `"ios-companion"` from `pages` |
| `apps/docs/content/docs/index.mdx:46` | 1 row | edit: the "Reach my bots from an iPhone" table row links to the deleted page |
| `docs/ios-companion.md` | 307 | delete (repo-internal build/test runbook) |
| `docs/ios-privacy.md` | 79 | delete (App Store privacy-nutrition source) |
| `docs/notification-and-proactivity-qa.md:38` | 1 row | edit: cites `ios/Tests/CompanionCoreTests/DecodingTests.swift` as QA evidence |
| `README.md:124` | 1 sentence | edit: "**Your phone.** The iOS companion puts the roster in your pocket…" |
| `AGENTS.md:12` | 1 field | edit: `manifests:` lists `Package.swift` |
| `CONTRIBUTING.md:38` | 1 line | keep — "requires Swift/Xcode tools" refers to the **macOS speech/recorder helpers** (`electron/build-speech-helper.mjs`, `electron/build-recorder-helper.mjs`), not iOS. Do not delete this line. |

`apps/docs/content/docs/mobile/android-control.mdx` is **not** the Android port.
It documents Murage driving a USB-attached Android phone as a bot capability
(`server/drivers/phone-proxy.ts`, `electron/android-device.mjs`,
`src/components/AndroidDevicePanel.tsx`, `scripts/prepare-android-tools.mjs`,
`pnpm build:android-tools` inside `package:prepare`). It stays.

### 1.5 Electron-side pairing / companion UI — **all of it stays**

| Path | Lines | iOS-specific? |
|---|---|---|
| `src/components/PhoneSetupFlow.tsx` | 1205 | Three English copy strings only: `:1061`, `:1136`, `:1141`. No iOS logic. Not in `src/locales/*.json` (grep for `iphone` returns 0 in every catalog), so changing them is not an i18n event. |
| `src/components/CompanionSection.tsx` | 13.5 K | zero |
| `src/components/SidebarPhoneButton.tsx` | 6 K | zero (`"iPhone"` appears only in its `.test.ts` as a device name) |
| `src/lib/companion-pairing.ts` | 12 K | two comments (`:125`, `:281`); one real coupling — `:315` builds `new URL("murage://pair")` |
| `src/lib/phone-setup.ts` | 14 K | zero |

### 1.6 Tailscale pairing work — **all of it stays**

`companion/src/listener.ts` (CGNAT 100.64/10 detection at `:54`, `tailscale status --json` shell-out at `:97-131`), `companion/src/endpoints.ts` (`tailnet` kind, priority 100), `src/lib/companion-pairing.ts` `companionPairingRoute(source, "tailscale")`, the "Pair over Tailscale" button in `PhoneSetupFlow.tsx:1058`. None of it is Swift-aware.

---

## 2. What must survive — the exact line

**iOS-specific** is: Swift source, the Xcode/SwiftPM build spec, App Store
metadata, and the `murage://` **pairing** scheme (`src/lib/companion-pairing.ts:315`).
That is all.

**Shared remote-access layer — untouched by this track:**

- `companion/src/devices.ts` — 32-byte `randomBytes` credential (`:189`) and device token (`:266`), SHA-256 at rest (`:71`), `timingSafeEqual` (`:78`, `:90`), 120 s TTL (`PAIRING_TTL_MS`, `:63`), 5-attempt cap, per-device revocation (`:332`).
- `companion/src/routes.ts` — the default-deny allowlist.
- `companion/src/proxy.ts` — the loopback-by-construction forward (`:7-13`) and the Origin 403 (`:240-241`).
- `companion/src/{endpoints,listener,mdns,control,state,wire,advertise-watch,connected-devices,origin,index}.ts` and all 13 test files.
- Every file in §1.5 and §1.6.

**Two invariants that only hold because the client was native.** Neither is
broken by this track; both are broken by the PWA, and both must be written
down here so the PWA track cannot inherit them by accident:

1. `companion/src/proxy.ts:240` refuses any request carrying an `Origin`
   header, on the stated grounds that "a browser has no business on it".
   A PWA is a browser. That refusal has to become a same-origin check, not a
   deletion.
2. `companion/src/routes.ts` is default-deny **and** the allowlist's stated
   derivation is "every request in `ios/Sources/CompanionCore/Client.swift`"
   (`companion/test/routes.test.ts:36`). Delete `ios/` and that derivation
   becomes a dangling pointer — the list still works but nobody can say why
   any given entry is on it. **This is the one real cost of the deletion.**
   Mitigation in §4, step 3.

---

## 3. What to salvage into the PWA

Read these before writing the equivalent. Do not port them — read them, then
write TypeScript.

### 3.1 The wire contract (read first, read all of it)

- `ios/Sources/CompanionCore/Models.swift` (33 K) — every harness response type, hand-decoded. This is the most complete written description of the harness's JSON that exists anywhere in the repo.
- `ios/Sources/CompanionCore/Frames.swift` — the SSE frame enum. Its load-bearing rule, from its own header: *an unrecognised `kind` decodes to `.unknown` rather than throwing*, so a client from last month keeps folding the frames it understands. The PWA's frame decoder must do the same.
- `ios/Sources/CompanionCore/Client.swift` (56 K) — every call the phone was allowed to make, in one file. This is the document `companion/src/routes.ts` was derived from. **Copy its route list into a TS contract before deleting it (§4 step 3).**

### 3.2 Offline / reconnect

- `ios/Sources/CompanionCore/SSE.swift` — a hand-written SSE parser, separated from I/O specifically so it is testable. Its header names the three bugs that cost time: multi-line `data`, `:` keepalive comments, and the optional space after the colon. The harness's own frame shape is documented there: `id: <streamId>:<seq>`, one `data:` line, blank-line terminated, `: keepalive` every 25 s. The browser's native `EventSource` handles most of this — read the file to know what it is handling for you, and what it is not.
- `ios/Sources/CompanionCore/Store.swift:29` — the cursor a reconnect resumes from; `:235` and `:410` — hydration vs. resumed-stream advance, and de-duplication of replayed frames.
- `ios/App/Session.swift:499` (reconnect resumes from cursor), `:585-592` (the `.hello(cursor, resumed)` frame and what to do when `resumed == false`), `:746` (dial a new address immediately rather than waiting for the next backoff tick).
- `ios/Tests/CompanionCoreTests/EventStreamTests.swift` and `SSETests.swift` — the executable version of all of the above.

### 3.3 Endpoint-candidate ranking and failover

- `companion/src/endpoints.ts` — **stays in the repo**; read it, don't salvage it. Note the ranking proven in §0: `hosted` 0 → `tailnet` 100 → `lan` 200+ → `bonjour` 300.
- `ios/Sources/CompanionCore/Failover.swift` (20 K) — the client-side walk. Its header states the security rule that must survive into the PWA verbatim: *a bearer credential cannot safely be sprayed onto whatever LAN happens to use the same private address later.* Hosted never grows a Tailscale fallback; an explicit Tailscale or local choice may still upgrade to hosted. `CandidateRotation` (`:18`) advances on address-shaped failure, promotes on success, and wraps rather than giving up.
- `ios/Sources/CompanionCore/Endpoint.swift`, `ConnectionRegistry.swift`.
- `ios/Tests/CompanionCoreTests/FailoverTests.swift` (18 K), `EndpointRefreshTests.swift` (11 K), `ConnectionTests.swift` (12 K) — the ratchet rules as tests. **These are the spec for the PWA's route policy.**

### 3.4 Pairing UX

- `ios/App/PairingView.swift` (18 K) — QR handoff, discovery, address entry, six-digit fallback, and the recovery paths between them.
- `ios/App/PairingScanner.swift` (7 K) — camera permission, denial, and recovery UI. The PWA needs the same states from `getUserMedia` + `BarcodeDetector`.
- `ios/App/Discovery.swift` (7 K) — `NWBrowser` for `_murage._tcp`. **No web equivalent exists.** Bonjour is unreachable from a browser; the PWA loses that discovery path entirely and must lean on the pairing link carrying the endpoint list.
- `ios/Tests/CompanionCoreTests/PairingTests.swift` (17 K), `ConnectionTests.swift:70-213` — every accepted and rejected `murage://pair?…` shape, including the token regex, the `hosts` filter, and the base64url `endpoints` blob.
- Desktop half already exists and stays: `src/components/PhoneSetupFlow.tsx`, `src/lib/companion-pairing.ts`.

### 3.5 Approval-card interaction

- `ios/App/ChatView.swift` (63 K) — the approval card in a transcript.
- `ios/App/Island.swift` (9 K) — the Dynamic-Island-shaped approval affordance. Its trick (a black rounded square that collapses behind the hardware island) has no PWA analogue, but the *state machine* — blocked → answered → collapsed — does.
- `ios/App/Cards/` — `AgentThoughtChamberView.swift`, `GitPRDiffCardView.swift`, `SQLResultTableView.swift`, `SkillExecutionReceiptView.swift`.
- `ios/App/Composer/` — `CommandSkillHUDView.swift`, `PredictiveActionChipsView.swift`, `TypingIndicatorView.swift`.
- `ios/Tests/CompanionCoreTests/ApprovalClientTests.swift` — the always-allow grant shape.
- `ios/App/QuickRepliesEditor.swift`, `ios/App/Updates.swift` (the "only chats doing something" rule: blocked → mid-turn → finished-and-unread, idle-and-read is not an update).

### 3.6 Transcript branching

- `ios/Sources/CompanionCore/Store.swift:217` — `versions(of:inThread:)`, the pure fold that resolves a message's sibling versions. **Port this exactly**; it is the algorithm, not a view.
- `ios/App/ChatView.swift:792-832` — the `n of m` stepper, and the rule that it is disabled while `bot.busy == true`.
- `ios/Sources/CompanionCore/Client.swift:1169-1175` — `POST /api/bots/:id/messages/:mid/edit` and `POST /api/bots/:id/active-branch`.

### 3.7 Share sheet → Web Share Target

- `ios/ShareExtension/ShareItemLoader.swift` (21 K) and `ShareViewModel.swift` (26 K) — the type coercion and retry logic for whatever iOS hands a share extension.
- `ios/Tests/CompanionCoreTests/ShareClientTests.swift` (10 K).
- The server side stays and is already idempotent: `POST /api/files?name=…&uploadId=<uuid>` with a 25 MiB cap, retry-safe on the same `uploadId` (see `server/index.test.ts:1583-1605`). Comment at `server/index.ts:6002` names the iOS share extension as the reason it exists — reword, do not remove.

### 3.8 Explicitly NOT worth salvaging

`ios/App/MausAvatar.swift` (35 K) + `MausFaceData.swift` (54 K) + `MascotState.swift` + `SpeechBubble.swift` — the mascot already exists in React at `src/components/EmberAvatar.tsx` (119 K) with `src/lib/mascot.ts`. `Glass.swift`, `CompanionLayout.swift`, `PlatformBridge.swift`, `Keychain.swift`, `LiveActivities.swift`, `Notifications.swift`, `Widgets/` — Apple-platform-only with no web analogue. `ios/AppStore/` — never submitted.

---

## 4. Sequencing

Sean's stated choice is retire now, so the default is earlier. Nothing below
has to wait for the PWA, because — proven in §0 — nothing outside `ios/` reads it.

**Step 1 — salvage before delete (same day, before any deletion).**
Copy, verbatim, out of the repo and into the PWA track's working notes:
`Sources/CompanionCore/*.swift` (13 files) and `Tests/CompanionCoreTests/*.swift`
(21 files). ~250 KB of text. This costs nothing and is irreversible if skipped,
because after the commit these files exist only in git history where nobody
will look for them. Do this first.

**Step 2 — one deletion commit.** §7's delete list, plus the CI job and the
doc edits. `pnpm typecheck && pnpm test` is unaffected (§0). CI loses one
`macos-latest` runner.

**Step 3 — re-root the allowlist, in the same commit.** This is the only step
that is not a deletion, and it is the one that must not be skipped.
`companion/src/routes.ts` exists to be a list derived from a real client, and
`companion/test/routes.test.ts:36` names `ios/Sources/CompanionCore/Client.swift`
as that client. Replace the comment with a checked-in contract — a TS array of
`[method, path]` extracted from `Client.swift` before it is deleted, living in
`companion/test/` and asserted against `denyReason` — so the allowlist keeps a
reason for each entry that survives the client that produced it. Without this,
the next person cannot tell a route the PWA still needs from one only the phone
ever called.

**Step 4 — fix the search defect now, not in the PWA track.**
`GET /api/search` is allowlisted (`companion/src/routes.ts:102`, proven allowed
in §0) and `server/message-db.ts:188` scans **every thread and every bot** when
no `threadId` is given (`const scope = threadId ? "thread_id = ? AND " : ""`).
The harness handler at `server/index.ts:6069` only validates `threadId` when one
is *present*. A paired token is a full-transcript grep tool.
**Recommendation: drop `{ method: "GET", path: /^\/api\/search$/ }` from the
allowlist in the deletion commit.** Rationale: retirement is the one moment
where the removal costs literally nothing — no client exists to call it — and
the PWA track then has to re-add it deliberately, with a scoping decision, in a
diff someone reads. That is precisely the discipline the file's own header
describes. The alternative (require `threadId` at the sidecar) preserves a
feature nobody can currently use and quietly keeps a half-fixed route on the
list. Take the removal.

**Step 5 — nothing waits for a real phone.** There is no "delete after Sean has
used the PWA" bucket. The one thing that would ordinarily sit there — the
`murage://pair` link scheme — is not deleted here at all (see below).

**What is NOT deleted in this track, and why:**

- `src/lib/companion-pairing.ts:315` keeps building `murage://pair?…`. Leave it.
  Between iOS retirement and the PWA there is no client at all, so the QR is
  inert either way; changing the scheme is a PWA-track decision (it will need an
  `https://…/pair#<token>` form, with the credential in the **fragment** so it
  never reaches a request line or a log). Changing it now would be churn with a
  guess baked in. Note that `murage://install` (`src/types/muragebox.d.ts:194`)
  is a separate, still-live use of the same scheme — the scheme itself is not
  retired.
- `scripts/capture-companion-fixtures.mjs` — keep, retarget. See §5.
- The whole `hosted` / cloudflared / managed-tunnel stack. See §8.

---

## 5. The fixture problem

**Verdict: no external dependency exists in Murage. The fixtures are safe to delete.**

The concern is real upstream — the Android build reaches into
`ios/Tests/CompanionCoreTests/Fixtures` — but the Android port is not adopted
(decision 3) and there is no Android source tree in this repo: no `android/`
directory, no `build.gradle*` anywhere outside `node_modules`.

I grepped every fixture basename across the whole repo (excluding
`node_modules` and `.claude/worktrees`). The distinctively-named ones —
`bots-paged`, `bots-full`, `thread-page`, `sse-frames`, `sse-hello`,
`options-card`, `pair-response`, `pair-rejected`, `bot-avatar-profile` — have
exactly three consumers between them:

- `ios/Tests/CompanionCoreTests/DecodingTests.swift:20` (`Bundle.module.url(…, subdirectory: "Fixtures")`)
- `ios/Tests/CompanionCoreTests/StoreTests.swift:9`
- `scripts/capture-companion-fixtures.mjs:28` (`const OUT = join(ROOT, "ios", "Tests", "CompanionCoreTests", "Fixtures")`) — the **generator**, not a consumer

`ios/Package.swift:24` (`resources: [.copy("Fixtures")]`) is what makes them
reachable at all, and it goes with the rest.

`config.json`, `instances.json`, `forbidden.json`, `unauthorized.json` matched
hundreds of unrelated files because those are ordinary words in this codebase.
Every one of those hits is a different file; none reads
`ios/Tests/CompanionCoreTests/Fixtures/`.

**Keep the generator.** `scripts/capture-companion-fixtures.mjs` drives a real
harness and records the bytes it actually sends — exactly the tool the PWA
needs for MSW handlers or vitest fixtures, and exactly the thing whose absence
lets a client drift from the server. Delete the Swift consumers; change `OUT`
(`:28`) to a new home (`companion/test/fixtures/` is the natural one, since the
sidecar is now the only thing between the harness and any client); rewrite the
header comment at `:6` which currently says "The fixtures in
`ios/Tests/CompanionCoreTests/Fixtures` are bytes the server…". Its
`Fixtures`-named test data at `:196` and `:229` (a room and a section it
creates on the live harness) can keep those names.

---

## 6. Docs

**The problem:** the docs `Mobile` section has two pages that mean opposite
things. `ios-companion.mdx` is *a phone controlling Murage*. `android-control.mdx`
is *Murage controlling a phone*. Delete the first and the section reads as if
Android is now the mobile client. That is worse than a missing page.

**Recommendation:**

1. Delete `apps/docs/content/docs/mobile/ios-companion.mdx`.
2. Rename the section: `apps/docs/content/docs/mobile/meta.json` becomes
   `{"title": "Devices", "icon": "Smartphone", "pages": ["android-control"]}`.
   `Mobile` with one page about USB debugging is a category error; `Devices` is
   what that page is actually about. Update the `"mobile"` entry in
   `apps/docs/content/docs/meta.json` to match the directory (rename the
   directory to `devices/` if the rename is done properly).
3. `apps/docs/content/docs/index.mdx:46` — the row
   `| Reach my bots from an iPhone | [iOS companion](./mobile/ios-companion.mdx) |`
   becomes a dead link. **Do not silently drop it.** Replace with a row that
   states the current answer: reaching bots from a phone is on the roadmap via
   the browser, over the tailnet. A missing row reads as "we never thought
   about it"; a stated one reads as a decision.
4. `apps/docs/content/docs/getting-started/installation.mdx` — verified clean,
   no iOS reference. No edit needed.
5. `apps/docs/content/docs/security/index.mdx:16` — "Paired phones use a
   default-deny API allowlist and per-device bearer tokens." **Still true and
   still the right sentence.** Keep it. The mechanism is not being retired.
   This is the load-bearing continuity: the security page describes the sidecar,
   not the app.
6. Delete `docs/ios-companion.md` (307 lines) and `docs/ios-privacy.md` (79).
   `docs/ios-privacy.md` is App Store privacy-nutrition source with no
   submission to feed. Nothing links to either from the docs site.
7. `docs/notification-and-proactivity-qa.md:38` — the QA matrix row citing
   `ios/Tests/CompanionCoreTests/DecodingTests.swift` as the evidence for
   "iOS target parsing and detached-task decision". Delete the row and note in
   the file that this behaviour currently has no client-side coverage — an
   honest gap the PWA track re-fills, rather than a row pointing at a deleted file.
8. `README.md:124` — rewrite the "**Your phone.**" sentence to describe the
   tailnet-reachable browser plan, or cut the bullet. Do not leave it.
9. `AGENTS.md:12` — drop `Package.swift` from the `manifests:` list.
10. **Do not touch `CONTRIBUTING.md:38`.** "requires Swift/Xcode tools" is about
    `electron/build-speech-helper.mjs` and `electron/build-recorder-helper.mjs`,
    which `swiftc` two macOS helpers into the packaged app. Unrelated to iOS.

---

## 7. The lists

### 7.1 Delete

```
ios/                                                  (entire directory, 130 files, 4.2 MB)
apps/docs/content/docs/mobile/ios-companion.mdx
docs/ios-companion.md
docs/ios-privacy.md
```

### 7.2 Edit

```
.github/workflows/ci.yml                 remove the `ios:` job, lines 149-172
apps/docs/content/docs/mobile/meta.json  drop "ios-companion"; retitle Mobile → Devices
apps/docs/content/docs/meta.json         follow the section rename
apps/docs/content/docs/index.mdx:46      replace the dead "Reach my bots from an iPhone" row
docs/notification-and-proactivity-qa.md:38   drop the row; record the coverage gap
README.md:124                            rewrite the "Your phone." bullet
AGENTS.md:12                             drop Package.swift from manifests
scripts/capture-companion-fixtures.mjs:6,28  retarget OUT to companion/test/fixtures/; rewrite header
companion/test/routes.test.ts:36         replace the Client.swift reference with the checked-in contract (§4 step 3)
companion/src/routes.ts:47               header says "Every request the iOS app makes" — restate
companion/src/routes.ts:102              REMOVE the GET /api/search entry (§4 step 4)
server/index.ts:6002                     reword the "iOS share extension" comment; keep the route
src/components/PhoneSetupFlow.tsx:1061,1136,1141   "iPhone" → "phone"
src/lib/companion-pairing.ts:125,281     comments naming iOS behaviour
```

### 7.3 Keep — untouched by this track

```
companion/                               all 26 files: src/{devices,routes,proxy,endpoints,listener,
                                         mdns,control,state,wire,origin,index,advertise-watch,
                                         connected-devices}.ts and all 13 tests
src/components/PhoneSetupFlow.tsx        (copy edits only)
src/components/CompanionSection.tsx
src/components/SidebarPhoneButton.tsx
src/lib/companion-pairing.ts             (comment edits only; murage://pair stays for now)
src/lib/phone-setup.ts
scripts/capture-companion-fixtures.mjs   (retarget, do not delete)
server/index.ts:6002 (POST /api/files)   the share-upload route and its uploadId idempotency
apps/docs/content/docs/security/index.mdx:16
CONTRIBUTING.md:38-39                    Swift = macOS speech/recorder helpers, not iOS

# Android *control* — a bot capability, unrelated to the unadopted Android port
server/drivers/phone-proxy.ts
electron/android-device.mjs, electron/android-device.test.mjs
src/components/AndroidDevicePanel.tsx
scripts/prepare-android-tools.mjs        (invoked by pnpm package:prepare)
apps/docs/content/docs/mobile/android-control.mdx
```

---

## 8. The one thing this plan deliberately does not decide

`companion/src/index.ts:150-151` creates **two listeners sharing one proxy
handler**:

```ts
const companion = createServer(proxy);
const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null;
```

`PRIVATE_ORIGIN` (`:54`) is a unix socket / named pipe that the bundled
`cloudflared` managed tunnel fronts (`electron/managed-companion-tunnel.mjs`,
`electron/managed-companion-guardian.mjs`), and `endpoints.ts` ranks the
resulting `hosted` endpoint **ahead of tailnet** (proven, §0). Anything added to
that proxy handler is public by default.

Under decision 1 — tailnet only, no public ingress, ever — this stack is out of
scope by construction. But it is **not iOS-specific**, so removing it does not
belong in the iOS deletion commit, and folding it in silently would make a
large, security-relevant change look like cleanup.

**Recommendation: a separate commit, landing before the PWA, that removes the
hosted/managed-tunnel path** — `electron/managed-companion-tunnel.mjs`,
`electron/managed-companion-guardian.mjs`, `electron/companion-account-service.mjs`,
`scripts/prepare-cloudflared.mjs` (and `build:cloudflared` from
`package:prepare` and `dev:desktop`), the `hosted` kind in
`companion/src/endpoints.ts`, `MURAGE_COMPANION_HOSTED_URL`, `PRIVATE_ORIGIN`
and `managedOrigin`, and the "automatic" mode in
`src/lib/companion-pairing.ts:companionPairingRoute`. Rationale: leaving it in
place means the PWA's first static route is one config flag away from the open
internet, and the Wayland `tailscale funnel` bug is exactly that mistake made
once already. Removing it makes `tailnet` the top-ranked endpoint by
construction rather than by policy.

I did not scope that removal in file-by-file detail — it touches the Cloudflare
control plane (`cloudflare/control-plane/`) and the Electron account service,
and it deserves its own pass. Flagging it, with a recommendation, is as far as
this track should go.

---

## 9. What I could not determine

- Whether the `hosted` removal in §8 breaks anything in `cloudflare/control-plane/`
  that is also used for something other than the companion tunnel. I read enough
  to know the coupling exists; I did not trace it.
- Whether any App Store Connect record exists that needs withdrawing. The repo
  has metadata (`ios/AppStore/`) but no evidence of submission, and Sean's
  premise is zero published releases. Off-repo state I cannot see.
- Whether the six PNG screenshots in `ios/AppStore/screenshots/` are wanted as
  design reference. They show the island-approval and chat-approval interactions
  the PWA has to re-solve (§3.5). Trivial to keep, so: **copy them out in step 1
  along with the Swift**, then delete with the rest.
