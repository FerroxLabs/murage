# Agent notifications and proactivity QA

Murage treats **proactivity as an explicit trigger**, not as a hidden
heartbeat. A bot may continue within an active task through Auto mode, may be
started by a Routine or Webhook, and may coordinate peers when its engine and
profile allow that. This change does not add background polling that invents
work or sends messages without one of those configured paths.

## Notification policy

The harness is the single owner of interruption policy. A bot with
notifications disabled remains quiet. Otherwise it may emit:

- **Needs approval** or **has a question** when the task is blocked on the user.
- **Needs your hands** when a computer task requires a takeover.
- **Finished** only when there is a non-empty result to summarize.
- **Routine failed** when a scheduled or manual routine run cannot complete.

Every notification carries both the bot ID and the exact task thread ID. A
click must select that bot **and switch to that task**, including a routine's
detached task; opening whichever task happens to be active is a failure.

Desktop notifications are suppressed while the window already has focus. There
is currently no phone client. The iOS companion, which presented live and
replayed notifications against the same bot/task target, was retired before
release; the browser client that replaces it is not built yet. Whatever ships
there inherits the same contract — the notification carries the bot and the
exact task thread, and acting on it must land on that task.

## Automated coverage

| Contract | Test |
|---|---|
| Per-agent off means quiet; empty completions stay quiet; summaries are bounded | `server/notify.test.ts` |
| Browser click returns the exact bot/task target | `src/lib/notify.test.ts` |
| Store navigation selects the bot and switches the task | `src/state/store.test.ts` |
| Routine failure receipt and callback occur once | `server/routines.test.ts` |
| Real failed routine emits one `routine-failed` notification and no duplicate `done` | `server/notification-wiring.test.ts` |
| Paired-device route policy remains default-deny | `companion/test/routes.test.ts` |

**Known gap: no client-side coverage of notification target parsing.** The row
that used to sit above pointed at `ios/Tests/CompanionCoreTests/DecodingTests.swift`,
which covered target parsing and the detached-task decision on the phone. It
was deleted with the iOS companion. The server-side rows still prove the
notification carries the right bot and task; nothing currently proves a remote
client acts on it correctly. The browser-client track re-fills this.

## Manual release pass

Run these with two bots, notifications enabled on one and disabled on the
other:

1. Background the desktop window. Complete a normal task and confirm one
   result notification. Click it and verify the exact task opens.
2. Trigger an approval and a question. Confirm their copy, click targets, and
   that no duplicate completion notification appears before the task settles.
3. Run a routine manually, then create a controlled failing run. Confirm the
   receipt shows the detached task and the failure generates exactly one alert.
4. Repeat the above with notifications disabled for that bot; the chat and run
   receipt should update without a system alert.
5. _(No remote client today — the iOS companion was retired. Restore this step
   when the browser client lands: tap a live/replayed notification for a
   non-active routine task and confirm the client switches the server-side
   active task before navigating.)_
6. Exercise Auto mode, a Routine, and a Webhook independently. Verify each has
   a visible initiating user/configured trigger and that no unconfigured
   heartbeat starts work.

Live provider, OS-permission, and backgrounding behavior cannot be proven by
unit tests alone and remains part of the signed desktop release pass. Push
delivery to a closed remote client is not in scope for any current release —
there is no remote client.
