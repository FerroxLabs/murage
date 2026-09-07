# Telegram permission callback — live controlled fixture

2026-09-07, candidate 1a5a3c0d plus syntax-only strip-mode constructor correction.
Real Telegram bot/paired owner; isolated fake Claude process, no command executor.

Request: `telegram-fixture-deny-1`; fixture bot `735aeaa0-37de-4b59-88d9-8dbe6bc2138a`;
thread `49882613-52c2-4a69-af07-39d79c757a3a`.

- 00:59:34.468 UTC: real provider broker emitted `request.opened`, permission/Bash.
- Owner screenshot shows the exact fixture summary and Allow once / Deny buttons.
- 01:07:55.560 UTC: provider emitted `request.resolved`, same request and turn,
  `behavior: deny`, `source: user`, provider instance `verification`.
- 01:07:55.571 UTC: decision ledger recorded `user-denied` for the same card.
- Subsequent click returned expired/changed/already-answered; no second resolution.
- Native broker socket read 64 bytes. Initial REPL variable did not capture the
  receipt correctly; provider event and decision ledger are the authoritative proof.

Conclusion: owner button -> real Telegram callback -> exact current permission ->
provider denial works. No shell command ran. Live Allow-once execution was NOT tested;
allow/deny/expiry/replay/wrong-owner cases have focused automated evidence.

UX follow-up: consumed buttons remain visible and generic replay notice makes a
successful first decision look unsuccessful. Mark resolved card and remove buttons
in a separately approved change; don't weaken replay rejection.
