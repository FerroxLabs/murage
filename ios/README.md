# OpenMausBot companion (iOS)

Your bots keep running on the laptop. This is the phone you watch them from,
answer their approvals on, and send them the next thing.

The laptop stays the only machine that owns agent processes, credentials,
transcripts and computers. The phone owns nothing — it is a second client on the
same harness the desktop app talks to, over the companion listener described in
[`docs/ios-companion.md`](../docs/ios-companion.md).

## Status

Built, run, and verified on an iPhone against a real harness: Bonjour discovery,
pairing, the roster, sending, and — the one that matters — an approval raised by
a bot on the Mac, answered on the phone, with the bot carrying on.

It was written in an environment with no Swift toolchain, so the first run on a
Mac was also the first compile. Three bugs came out of that, all in the same few
lines between "URLSession has bytes" and "the app has frames", and all invisible
to the parser tests because the parser was never the thing that was wrong:

1. `timeoutInterval = .greatestFiniteMagnitude` — reads as "never time out",
   actually produces a request that opens and delivers nothing, because
   URLSession turns a timeout into a deadline by adding it to the current time.
2. Keeping only the derived line iterator while letting `URLSession.AsyncBytes`
   go out of scope. AsyncBytes cancels its data task when released, so the
   connection died the moment the first frame was returned.
3. Reading with `bytes.lines`, which folds consecutive newlines into one
   separator and therefore never reports the blank line that terminates an SSE
   event. Zero frames, no error, a healthy-looking connection at both ends.

`EventStreamTests` exists to catch that class — it is the only test here that
drives a real `URLSession`. [`TESTING.md`](TESTING.md) is the runbook, and its
"If the phone sits on Connecting…" section is what actually isolated bug 3.

## Layout

```
ios/
  Package.swift                  CompanionCore + its tests
  project.yml                    XcodeGen spec for the app target
  Sources/CompanionCore/         no UI, no Apple frameworks beyond Foundation
    Models.swift                 the harness's wire types
    Frames.swift                 SSE frames, unknown kinds absorbed
    SSE.swift                    line parser + URLSession event stream
    Client.swift                 every call the phone is allowed to make
    Store.swift                  the fold: frames → state
  Tests/CompanionCoreTests/
    Fixtures/                    captured from a real server — do not hand-edit
    DecodingTests.swift          the contract with the harness
    SSETests.swift               the parser, which is where this goes wrong
    StoreTests.swift             the fold
  App/                           SwiftUI, and everything that needs a device
    CompanionApp.swift           entry; owns when the stream lives and dies
    Session.swift                connection, lifecycle, actions
    Discovery.swift              NWBrowser for _openmausbot._tcp
    Keychain.swift               the device token
    MausAvatar.swift             the mascot face, in the desktop's palette
    PairingView.swift            find a computer, type the six digits
    ChatListView.swift           roster, with "waiting on you" pulled to the top
    ChatView.swift               transcript, approval cards, composer
    SettingsView.swift           status, and unpair
```

## Building

The core needs nothing but a Swift toolchain:

```sh
cd ios
swift test
```

The app needs Xcode. The `.xcodeproj` is generated rather than committed:

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenMausCompanion.xcodeproj
```

**Re-run `xcodegen generate` after pulling any change that adds a file to
`App/`.** The spec says `sources: App`, but XcodeGen resolves that to explicit
file references when it generates, so a new file is simply absent from the
target until you regenerate — and the build fails with `Cannot find 'X' in
scope`, which reads like a code error and is not one.

If you'd rather not install XcodeGen, make an iOS App target by hand, add the
`App/` folder and the local `CompanionCore` package, and copy the Info.plist
keys out of `project.yml` — `NSLocalNetworkUsageDescription` and
`NSBonjourServices` especially. Without them `NWBrowser` returns no results at
all, *silently*, which looks exactly like "no computers on this network".

## Regenerating the fixtures

Whenever the companion API changes:

```sh
node scripts/capture-companion-fixtures.mjs   # from the repo root
```

It boots a real harness against a throwaway home directory, drives the real
pairing handshake over the real network socket, and writes down what came back.
Commit the diff — a change there is a change to the contract, and reviewing it
is the point.

## What the phone may and may not do

Enforced server-side by `remoteDenial()` in `server/index.ts`, and mirrored here
by simply not having the methods:

| Allowed | Refused |
|---|---|
| Read bots, rooms and transcripts | Write API keys (`PUT /api/config`) |
| Send messages | Manage pairing or revoke devices |
| **Answer approvals and questions** | Drive the Local VM |
| Interrupt a bot, mark chats read | Reach `/api/internal/*` |
| Fetch screen images on demand | Load the packaged desktop UI |

Companion settings stay on the computer on purpose: losing the phone must not
mean losing the ability to lock it out.

## Design notes

- **Zero third-party dependencies.** SSE over `URLSession.bytes.lines` is a
  page of code; Keychain, `NWBrowser` and notifications are all first-party.
- **Thin client.** The harness already folds provider events into settled
  messages, so this listens to `message` / `message.patch` / `bot` and skips
  `runtime` entirely. Token-by-token streaming is a later nicety, not a
  prerequisite.
- **`screens=off`.** The harness would otherwise push a base64 desktop capture
  every few seconds to a device on cellular.
- **Reconnect by cursor.** The stream is resumable: hold the `<streamId>:<seq>`
  cursor, and on reconnect the server replays what was missed or says
  `resumed: false`, which is the signal to hydrate. Lifecycle — not the parser —
  is the hard part of a phone client, which is why the stream is torn down
  deliberately on backgrounding rather than left for iOS to kill.
- **No optimistic state.** Actions call the harness and let the event stream
  deliver the result. A phone that draws its own version of what just happened
  is a phone that disagrees with the laptop.
- **Messaging-app shape, not settings-list shape.** Mascot faces at roster size,
  the bot's role as a chip beside its name, timestamps that say "Yesterday"
  rather than a date, and a gap-based separator in the transcript instead of a
  stamp on every message. The palette in `MausAvatar.swift` is copied verbatim
  from `src/lib/mascot.ts`: a bot the user knows as "the orange one" should be
  the same orange on both screens.
- **Return sends, Shift+Return breaks the line**, via `.onKeyPress`. Returning
  `.ignored` for the shifted case hands the keypress back to the text field,
  which is the only thing that can insert the newline once Return is claimed.
  Software keyboards have no Shift+Return, so there `.onSubmit` sends.
- **No affordance without a feature behind it.** The reference design this was
  modelled on has a composer mic and a "+" for new chats; there is no dictation
  here and creating bots belongs on the computer, so neither is drawn. Search
  is real and filters the roster.

## Not in this version

Foreground only, same network only. No push (the app must be open to hear
anything), no Tailscale guidance yet, no token-by-token streaming, no computer
panel, no voice. Those are phase 4 in the architecture doc.
