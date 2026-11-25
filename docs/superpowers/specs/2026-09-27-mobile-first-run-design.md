# Murage phone app: first run ("Don't Make Me Think")

Status: flow approved by Sean in chat on 2026-09-27. He asked us to "keep rocking" on the rest and test it when he's back.
Parent spec: `2026-09-25-murage-mobile-design.md` (rev 3). This spec only changes first run.

## Goal

Someone who has Murage running on their computer installs the phone app and opens it. They reach their chat in under 2 minutes, without reading instructions or understanding networks. Every screen has one obvious action. The app works out what's missing instead of asking.

## Scope (v1)

- **Desktop only.** Murage Cloud gets its own fork later, reusing these screens. No Cloud choice is shown until Cloud exists.
- Our own routing and Murage accounts will come later and may replace Tailscale. The Tailscale steps below sit behind one "is the computer reachable" check, so they can be swapped out without touching the rest of the flow.

## The flow

1. **Splash.** The phone's own launch screen shows the Murage mark on the brand canvas. It appears instantly, with no artificial delay. It already exists on both platforms (iOS `LaunchScreen.storyboard`, Android `Theme.SplashScreen`). Check that both show the Murage mark on the canvas colour.
2. **Welcome.** This only shows when there are no saved computers.
   - Title: "Murage on your phone"
   - Body: "Talk to your team from anywhere. First, is Murage running on your computer?"
   - Primary button: "Yes, let's connect". It goes to "Get your code ready" (step 3).
   - Secondary: "Not yet". This shows: "Set up Murage on your computer first. When it's running, come back here." with one button, "It's running now", which goes back to the Welcome screen.
3. **Get your code ready** (added 2026-09-27, after the first device run). On Android, Google's scanner covers the whole screen, so a hint behind it never shows; where the code is gets said before the camera opens.
   - Title: "Get your code ready". Body: "On your computer, open Murage, then Settings, then Phone and other devices. Turn it on and a code appears."
   - A picture of that desktop page (the switch and the code circled), bundled with the app in light and dark, with alt text. `apps/mobile/scripts/desktop-phone-shot.mjs` redraws it; `desktop-shot.test.ts` fails when the page's words change without it.
   - Primary: "I see the code, scan it", which opens the camera. Secondary: "Type the code instead".
4. **Scan.** The scanner screen's hint (behind Android's scanner, and over the iPhone's camera) reads: "On your computer, open Murage, then Settings, then Phone and other devices. Point your camera at the code." "Type the code instead" remains available.
5. **Connecting.** "Connecting to your computer…". The app probes the scanned computer and decides what to do:
   - **Reachable:** open the workspace. The pairing page signs in by itself (see "Door change"). Land in the chat.
   - **Unreachable, and Tailscale is off** (`tailscale.connected === false`):
     - Screen: "Turn on Tailscale", body "Your phone reaches your computer through Tailscale."
     - Primary: "Open Tailscale".
     - The screen watches Tailscale: on app resume, and every 2 s while it is showing. When `connected` becomes true, it retries the pairing by itself with the credential it already holds.
   - **Unreachable, and Tailscale is missing:**
     - Android (`installed === false`): screen "Get Tailscale", body "Your phone needs Tailscale to reach your computer. Get it, sign in with the same account as your computer, then come back." Primary: "Get Tailscale" (store). Then the same automatic watch as above.
     - iPhone (installed is unknown and connected is false): this is the same "Turn on Tailscale" screen, plus a secondary "I don't have Tailscale yet" that opens the App Store page.
   - **Unreachable, and Tailscale is on:** "Your phone can't see your computer". Body: "Check that Tailscale on your phone is signed in to the same account as your computer (it's shown on your computer under Settings, then Phone and other devices), and that your computer is awake." Primary: "Try again". Secondary: "Scan again".
6. **Done:** the chat.

First-run screens show "Step n of 4": Welcome and Not yet 1, Get your code ready 2, Scan 3, Connecting and every Tailscale or can't-see screen 4. Adding another computer shows no steps.

The pairing credential stays in memory only, as today (the P22/P23 rulings). If the phone kills the app while the person is in the Tailscale app, they scan again. That is acceptable, and the Welcome screen leads back to the scan through Get your code ready.

## Door change (companion, `/enter`)

The single tap on the pairing page is there to stop link-preview crawlers. They render the page and would burn the one-time code. Inside the Murage app, the scan was already the deliberate act. So the `/enter` page **signs in by itself when both of these hold**:
- the user agent carries `MurageApp/`;
- the fragment carries `&installId=`, which only the app appends.

A camera-app scan, or any other browser, still gets the tap. A spoofed user agent gains nothing: whoever has the link can already sign in with it.

## Desktop change (Settings, then Phone and other devices)

- **The page and its Settings tab are called "Phone and other devices"** (it was "WebUI" under a "Phone" tab).
- **One switch, "Turn on".** It asks the existing tailnet question once, then starts the browser door and asks for `tailscale serve` together. Without Tailscale on the computer the door still turns on and the problem line says what is missing. Once it is on, the code opens by itself. "Allow remote access" keeps its own switch under Status, to turn it off or try it again; a code never waits for it. Off turns both off.
- **The "Sign in on another device" card (QR and code) is at the top** while it is on; the status and paired devices sit below it.

- **Show the computer's Tailscale account.** Read it from `tailscale status --json`: the Self user's LoginName via `User[Self.UserID]`. Show "On your phone, sign in to Tailscale as <login>". If it can't be read, show nothing extra.
- **Wording:** the scan copy mentions the Murage app. Example: "Scan it with the Murage app on your phone, or with your phone's camera." Keep the browser path. Do not add store words; the existing test that forbids "app store" stays.

## Words

All new strings follow the copy rules: no em dashes, no "safe" or "safety", no price talk. The mobile copy-rules test covers them.

## Tests

- Launcher: every branch of the diagnosis; the auto-advance when `connected` flips to true; the credential kept in memory only; the Welcome "Not yet" loop; Welcome leading to Get your code ready with no native call, and the camera opening from there.
- Door: auto-submit only when both conditions hold; the tap everywhere else. This covers a crawler-style user agent, a camera scan, and the app user agent without `installId`.
- Desktop: login shown when readable, absent otherwise; the switch turning both halves on and off, and a failure in either half still showing what is running.
- On device: Sean tests the whole flow on both phones from a fresh install. That includes Tailscale off, and Tailscale uninstalled on Android.
