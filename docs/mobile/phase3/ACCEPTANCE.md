# Plan 3b E1: device acceptance on Sean's real Murage

**Closed 2026-09-29 by Sean.** Phones: iPhone (iOS 27) and Samsung S25 Ultra (Android 16), both paired to Sean's Mac through the door. Desktop test builds `0.1.60-mobile.4` to `0.1.60-mobile.7` were installed with his OK; the final build is `0.1.60-mobile.7`, from `9679ae69`.

| Step | Phone | Seen | Result |
|---|---|---|---|
| Pair and enrol | both | Paired by QR; push bindings present on the host, the door and the relay | Pass |
| Rich notification while locked | both | "<bot> needs approval" with the command | Pass |
| iPhone Deny (lock screen) | iPhone | Logged `user-denied` for the command | Pass |
| iPhone Approve (lock screen, Face ID) | iPhone | The bot ran it; the result showed on both phones | Pass |
| Answered on another device | Samsung | The notification became "Answered on another device." | Pass |
| Risky request | both | `rm -rf` offered only Deny and Open; Allow inside the app worked | Pass |
| Answered on desktop | Samsung | Became "Answered on desktop." | Pass |
| Android Approve (lock screen) | Samsung | `notice=approved` on the phone, `user-approved` on the host | Pass |
| Tap opens the right chat | both | A tap opens the bot's chat in place (earlier builds: see fixes) | Pass |
| App killed plus deep Doze | Samsung | Delivered with real text; the tap opened the chat | Pass |
| At the desk | both | No push while Sean uses the Mac, even with Murage behind other windows (mobile.7) | Pass |
| Team order | both | Same team order as the Mac (mobile.5 onward) | Pass |
| Computer and Browser panels | iPhone | "On your Mac" empty state, no dead controls or raw errors (mobile.7) | Pass |
| Call a bot | iPhone | Hears Sean, answers aloud, takes turns | Pass, with follow-ups |

Not run: Tailscale off, quiet hours, sign out a phone, reboot before first unlock, two workspaces. These were covered by earlier device runs on the isolated host or by tests, and are not blocking.

## Fixed during E1 (all reviewed)
- `b045d684`, `3f619518`, `99533d67`, `216ad1b4`: notification taps (a fragment-only reload, the page answering "handled", and the iOS notification delegate).
- `bf4b609b`, `ed257acb`, `b788b241`, `590f34dd`, `4ef125d1`: desk presence (the desktop proof, a flapping signal, and "at the desk" meaning the Mac is in use).
- `605c1d1b`, `012b8f5c`: sidebar team order kept on the computer and filtered for phones.
- `7e3220e8`, `89fca990`, `1af501c3`, `04c8ceaa`, `9679ae69`: the phone's Computer and Browser panels, the "Messaged @X" chip, and distinct error codes.

## Open follow-ups (not blocking)
- In a call from the phone, the user's own words are not shown as text; the reply audio is sometimes rough or crackly. Investigation: `.superpowers/sdd/2026-09-27-plan-3b-push-native/voice-call-investigation.md`.
- Plan 4:
  - the approval bar wraps "Allow once" alone on a phone;
  - avatars are slow on first pair;
  - the Samsung is listed as "Chrome on Android";
  - a misleading "Secure access is not available" line;
  - Computer status polling still runs behind the phone's empty state.
