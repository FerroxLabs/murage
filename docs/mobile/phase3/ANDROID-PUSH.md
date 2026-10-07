# Android push: what the phone does with a message

`MurageMessagingService` (Plan 3b A3) gets data-only FCM messages and builds each notification itself.

- **Detail fetch.** It asks the door for the detail (`GET /api/mobile/push/<eventRef>` with the detail bearer) and waits at most 5 seconds. On any failure it shows the generic text: Tailscale off, a fast failure before the first unlock, a timeout, a status other than 200, or a body it can't read.
- **Replacing.** The notification's tag is the event's collapse key, so a newer revision of the same event replaces the old one.
- **Actions.** On Android 12 (API 31) and later, approvals get Approve and Deny, and both need the phone unlocked. A risky approval gets Deny and Open. Below API 31, and for questions, there is only Open.
- **Answering (A5).** Approve or Deny posts once to `POST /api/mobile/push/respond` with the respond token, which the phone can read only while it is unlocked. The notification is then replaced by a short notice: Approved, Denied, already answered, "Open Murage to allow this" (the host wants a step-up), or "Couldn't reach your Murage, open the app." when the host can't be reached or can't carry the answer out. Android 12 and later don't let the action open the app itself, so a tap on the notice does.
- **Taps.** A tap opens the computer the notification came from, on its chat. If that computer is no longer on the phone, the launcher says so and opens nothing.
- **Opening the app.** Each time a workspace comes to the front, the phone asks every computer for its pending list and clears notifications that were answered somewhere else.
- **Logs.** Logcat gets the method, the status code and error class names. It never gets a token, the eventRef, a title or a body.

## A force-stopped app gets nothing

If the person force-stops Murage (Settings, App info, Force stop), Android puts it in its stopped state. **No push arrives until they open the app again.** Then the held messages arrive together, and each fetches its detail as usual.

This isn't Doze. The Task 0 spike (`docs/mobile/phase0/FINDINGS.md`) showed that a high-priority data message still wakes an app whose process has died, even in deep Doze, and the fetch completes in about 100 ms. Only a force-stop blocks delivery.
