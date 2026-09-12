# Murage 0.1.53 — Release Notes

**Base:** v0.1.52 as published (`a3d5e131`). **Contents:** `4bd295ab` (WIN1 merge) + `bf6b3cef` (HOTFIXTEST1) + the version bump. Written from `git log --no-merges a3d5e131..HEAD` on `release/v0.1.53`.

The body below is what the GitHub release carries verbatim (paste-ready copy in the session scratchpad as `release-body-0153.md`).

---

Murage 0.1.53 is a hotfix over 0.1.52. It carries three corrections to the
Claude engine driver and the turn settlement in the harness, plus the test
work that made the suite run green on Windows. Nothing else changed: the
only product files touched are `server/drivers/claude.ts` and
`server/index.ts`; every other change is to tests and test fixtures. The
bundled Fuigo stays 1.0.13. All three fixes apply on macOS, Windows and
Linux.

**Fixed**

- **Save and Restore answered "bot is writing" until a restart after the
  engine auto-retried, and a channel message that arrived during that turn
  was never delivered.** When the Claude CLI exited before accepting a
  turn, the automatic relaunch minted a new turn id, so the run, the
  folder-writer lease, the memory receipt and any queued channel routine
  kept waiting on a completion that never came: the bot stayed busy, the
  workspace refused every save with 423, and a Telegram or Discord message
  queued during the turn was never dispatched. The relaunch now keeps
  the id the original send returned, so the retried turn settles like any
  other. (`31ef3911`; pinned end to end by `bf6b3cef`, which drives a real
  harness through the retry, the refused save, the completing relaunch,
  the accepted save and the delivered channel reply.)
- **"a turn is already running on this thread" after Stop, then send.**
  Stop returns as soon as the kill is sent, but the CLI child still tears
  down its MCP children and flushes first (on Windows every Stop ends the
  child through an asynchronous taskkill). A message sent in that window
  reached the driver while the stopped child was still closing and was
  refused with an error card. A send that meets a stopped-but-not-yet-closed
  turn now waits for that close (bounded by the harness's own stopped-child
  deadline) and then launches. A turn that was not stopped is still refused
  as before. (`23087f25`)
- **A message sent or edited right after Stop was silently dropped.** The
  stopped child's late `turn.completed` was folded onto whatever run owned
  the thread by then, so the replacement run — still in setup — was
  released and its dispatch cancelled: the message sat in the transcript,
  the bot went idle, no error. Settlement now only touches the run bound to
  the event's own turn; an earlier turn's close leaves the replacement, its
  provider selection, its usage, its reply and its unread mark alone.
  (`3e75643e`, `20d5a6cb`, `0cb0662d`; three deterministic shapes in
  `server/direct-run-late-close.test.ts` — Stop then edit then resend, Stop
  then resend at once, and the retried pre-accept exit — fail on 0.1.52 as
  shipped and pass here.)

**Quality**

- **The vitest suite runs green on Windows.** The 0.1.52 CI record on the
  Windows runner (run 34657596577) had 53 red tests across 19 files. Four
  of them, all in `server/index.test.ts`, were the third defect above
  showing through (the "tells the assistant why it has no connectors"
  failure and its fallout). The other 49 were test-harness assumptions
  that only hold on POSIX: those tests and fixtures now follow Windows
  path, checkout and shell shapes, use the fake engine's canonical cwd
  key, tolerate an unwritable probe root, and assert on event order rather
  than elapsed time. No product change beyond the three listed above.
  (`da392f05`, `2042547a`, `ba65f40a`, `d915fd75`, `00efdbef`, `8ab65873`,
  `ed4508b3`)
- The fake Claude CLI gains a slow-exit-on-stop fixture so the Stop-to-close
  window is open on POSIX too, and a Telegram fetch preload lets the harness
  suite exercise a channel delivery without a network. Both are test-only.

**Unchanged from 0.1.52**

- Everything in the 0.1.52 notes still applies, including the open items
  listed there. Downgrading to 0.1.51 after running 0.1.52 or 0.1.53 is
  still not supported (saved-files table columns).
