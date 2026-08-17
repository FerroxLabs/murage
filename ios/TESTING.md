# Testing the companion locally

All four stages have been run end to end on a Mac and an iPhone. Keep this as
the runbook for the next person, the next machine, and anything Layer 4 adds.

Stages, cheapest signal first. Each one is worth completing before starting the
next — a Swift compile error found in stage 1 costs a minute, the same error
found while chasing a Bonjour problem on a phone costs an hour. Stage 5 is the
way out when the network itself is the problem.

## What you need

| Stage | Needs |
|---|---|
| 1 — core tests | a Mac with Xcode command line tools (`xcode-select --install`) |
| 2 — desktop half | + Node 24+, pnpm, and one agent CLI (`claude`, `codex`, or `grok`) signed in |
| 3 — app builds | + full Xcode |
| 4 — end to end | + an iPhone on the same Wi-Fi as the Mac |
| 5 — off this network | + Tailscale on both, same account |

Stages 1 and 2 are worth doing even if you never get to a phone: stage 1 is
where the Swift errors are, and stage 2 exercises the companion listener the
desktop app now ships.

---

## Stage 0 — get the branch

The work is on `upstreaming/9-ios-app` in `mnthr7/OpenMausMobile`.

Fresh clone:

```sh
git clone https://github.com/mnthr7/OpenMausMobile
cd OpenMausMobile
git checkout upstreaming/9-ios-app
```

Or, if you already have the repo:

```sh
cd OpenMausMobile
git fetch origin upstreaming/9-ios-app
git checkout upstreaming/9-ios-app
git pull origin upstreaming/9-ios-app
```

Sanity check — `ios/` and the companion sidecar should be present:

```sh
ls ios/Sources/CompanionCore companion/src/devices.ts companion/src/mdns.ts
```

---

## Stage 1 — the core compiles and its tests pass

No Xcode, no simulator, no phone. This is the stage that finds the most and
costs the least, because **none of the Swift has ever been compiled**.

```sh
cd ios
swift build       # expect errors; they are the point
swift test
```

Expect real errors. They should be small and local — a wrong label, a missing
`@ViewBuilder`, an optional that needs unwrapping — because the shapes were
written against real captured bytes rather than guessed. `Sources/` is the only
thing `swift test` touches; `App/` is not in the package and is not compiled
until stage 3.

A trailing `Test run with 0 tests in 0 suites passed` is expected and not a
problem: that is swift-testing finding none of its own tests, because these are
XCTest.

**What passing means.** The decoding tests read
`Tests/CompanionCoreTests/Fixtures/*.json`, which were captured from a real
running harness. Green means the client agrees with what the server actually
sends — not with anyone's memory of it.

If a decoding test fails while the others pass, suspect the fixture is stale
before suspecting the model: re-capture with
`node scripts/capture-companion-fixtures.mjs` from the repo root and read the
diff.

---

## Stage 2 — the desktop side, on its own

Prove the harness half works before a phone is in the picture.

```sh
pnpm install
pnpm dev:server           # 127.0.0.1:8799
pnpm dev                  # 127.0.0.1:5199
pnpm dev:desktop          # Electron
```

In the app: **Settings → Companion**. Turn it on. You should see either

- *"Your phone will find this computer as …"* — Bonjour is advertising, or
- *"Listening on 192.168.x.x:8810 — enter that on your phone."* — it is not.

Both are workable; the second just means typing an address. Then **Start
pairing** and check the six-digit code counts down and cancels cleanly.

Verify from a second terminal that the socket is real and refuses strangers:

```sh
curl -s http://192.168.x.x:8810/api/bots            # expect 401 + "pair this device…"
curl -s http://127.0.0.1:8811/state | jq            # addresses, pairing, devices, discovery
dns-sd -B _openmausbot._tcp                         # macOS: should list the service
```

### If discovery says it is not advertising

This is the likeliest snag on macOS, and it is not a bug in the phone.

- **Port 5353 is owned by mDNSResponder.** The harness asks for `SO_REUSEADDR`
  and normally shares it fine, but if something else grabbed it exclusively the
  advertisement cannot start. `sudo lsof -i :5353` shows who.
- **The firewall is prompting.** System Settings → Network → Firewall. Incoming
  connections to `node`/OpenMausBot must be allowed, or the phone reaches
  nothing on 8810 even with a correct address.
- Neither blocks testing: use the typed address instead. Discovery failing is
  designed to be a fallback, not a dead end — that is worth confirming too.

---

## Stage 3 — the app builds

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenMausCompanion.xcodeproj
```

Build for the simulator first — it is a faster loop for compile errors.

**Re-run `xcodegen generate` whenever a pull adds a file to `App/`.** The
generated project lists source files explicitly, so a new one is missing from
the target until you regenerate, and the build fails with `Cannot find 'X' in
scope` — which looks like a code error and is not one.

### If the app is letterboxed inside black bars

Everything drawn oversized, content floating in the middle of the screen, black
above and below: that is iOS compatibility scaling, and it means the built
Info.plist has no `UILaunchScreen` key. Check the built product rather than the
spec — `plutil -p` the Info.plist inside the .app — because
`INFOPLIST_KEY_UILaunchScreen_Generation` is *silently ignored* for a target
that supplies its own Info.plist, which is how this shipped the first time.

Then switch to a **real device**. The simulator shares the Mac's network stack,
so Bonjour there proves less than it appears to, and the local-network
permission prompt behaves differently. Signing needs a free Apple ID team; no
paid account is required to run on your own phone.

---

## Stage 4 — the thing actually working

On the phone, in order:

1. **Pair.** The computer should appear by name. Tap it, type the code.
   - If the list stays empty, check in this order:
     1. **Local Network permission.** iOS asks once, and a denial is
        permanent and silent. Settings → OpenMausBot → Local Network. If the
        toggle is not even there, the prompt never fired — which points at the
        Info.plist. Deleting the app and reinstalling resets the decision and
        asks again.
     2. **The built Info.plist** actually carries
        `NSLocalNetworkUsageDescription` and `NSBonjourServices`. Without them
        `NWBrowser` returns nothing at all, silently, and it looks exactly like
        an empty network: `plutil -p` the Info.plist inside the built .app.
     3. **The phone and the Mac are on the same Wi-Fi.** Check the actual
        SSID on both, not just "is Wi-Fi on" — one device on the guest network
        and the other on the main one is the single most common cause, and the
        two look identical from the phone. Bonjour is multicast: it does not
        cross subnets, and guest networks usually isolate clients from each
        other on top of that, which blocks the typed address too. Cellular
        carries no Bonjour either, so a phone that fell back to 5G finds
        nothing. Settings → Wi-Fi → ⓘ shows the phone's IP; if it is not on
        the same /24 as the Mac, that is the answer.
   - Then use the typed address as a fallback and keep going. Pairing by
     address exercises everything except discovery.
   - **If the typed address does not work either**, stop diagnosing the
     network and go to stage 5. When both devices are demonstrably on the
     same SSID and neither discovery nor a typed address gets through, the
     network is isolating its clients and there is nothing to fix on either
     machine.
2. **The roster loads**, matching what the desktop shows.
3. **Send a message** from the phone. It should appear on the desktop too — same
   harness, two clients.
4. **The approval.** This is the whole product. Ask a bot to do something that
   needs permission (`run \`ls\` in my home directory` is enough for most
   engines). The card should reach the phone; answering it there should
   unblock the bot on the laptop.
5. **Reconnect.** Background the app for a minute while the bot keeps working,
   then come back. The transcript should catch up *without* a visible reload —
   that is the resumable stream doing its job. Watch the harness log to confirm
   it replayed rather than re-hydrated.
6. **Revoke.** Remove the device in Settings → Companion on the computer. The
   phone should land on "This phone was unpaired" rather than silently failing.

---

## Stage 5 — off this network, via Tailscale

Everything above assumes the phone and the Mac can reach each other directly.
Sometimes they cannot, and no amount of checking the SSID fixes it: a guest
network that isolates its clients will let both devices online, show them the
same network name, and still drop every packet between them. Bonjour finds
nothing and the typed address times out, which reads exactly like a broken app.

Tailscale makes that class of problem go away rather than diagnosing it. Both
devices join a private network of your own and get an address in `100.64.0.0/10`
that does not depend on which Wi-Fi either of them is on — or on Wi-Fi at all,
so this is also how the phone reaches the Mac over cellular.

1. **On the Mac:** install Tailscale (`brew install --cask tailscale`, or the
   App Store build) and sign in.
2. **On the phone:** install Tailscale from the App Store, sign in to the *same*
   account, and turn the VPN on.
3. **In OpenMausBot → Settings → Companion:** with the toggle on, the panel now
   prints the tailnet name — something like `macbook.tail1234.ts.net:8810`, with
   the LAN address listed separately underneath. If it still only shows a
   `192.168.x.x` address, the sidecar could not find the Tailscale CLI — it
   asks once at startup, so turn the Companion toggle off and on again (or
   restart `pnpm companion` if running it by hand) after Tailscale is up.
4. **On the phone:** pair by typing that name. Discovery does not help here —
   Bonjour is multicast and a tailnet does not carry it — so the typed address
   is the path, and it is the one path that works from anywhere.

**Use the name, not the address.** Both reach the harness, but only the name
gets past App Transport Security. iOS exempts local networking, and `100.64/10`
is CGNAT space rather than one of the private ranges that exemption covers, so
a plain-HTTP request to a bare tailnet address is refused by the OS before it
reaches the network. `ios/project.yml` exempts `ts.net` by name instead. The
symptom if you use the address anyway is a connection that fails instantly with
a policy error rather than a timeout.

Once paired over a tailnet, nothing else changes: the same stream, the same
approvals, the same reconnect behaviour. It is the same listener on the same
port — only the route to it is different.

---

## What is expected not to work

Not built yet, so not bugs:

- **Nothing arrives while the app is closed.** No push until APNs.
- **No voice, no routines.**

(Two entries that used to sit on this list have since shipped: replies stream
token by token as the provider emits them, and each bot has a computer panel —
open it from the chat and frames arrive for exactly as long as it is on
screen.)

## If the phone sits on "Connecting…"

The two sides now say what they think is happening, and comparing them is
usually the whole diagnosis:

- **Harness log** (the `pnpm dev:server` terminal): `companion stream opened`
  when a phone's event stream connects, and `companion stream closed` when it
  goes. No "opened" line means the request never arrived.
- **Xcode console**, subsystem `com.openmausbot.companion`: `opening stream`,
  then `stream live, resumed=…`, then `hydrated N bots`. Whichever of those is
  missing is where it stopped.

Opened on the server but never live on the phone means the bytes are not
reaching the client. Never opened means the request never left it. A repeating
`opened` / `closed` pair on the server with `stream failed: cancelled` on the
phone means the client is tearing its own connection down — that was a real bug
(`URLSession.AsyncBytes` cancels its task when the sequence is released), and
`EventStreamTests` now guards against its whole class.

## Reporting back

For Swift errors, the compiler's own output is the most useful thing — file,
line, and message. For runtime problems, the harness log is usually more
informative than the phone: it is where the pairing, auth and stream decisions
are actually made.
