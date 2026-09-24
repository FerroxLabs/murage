# Full access stops

Full access stays fast but stops before three kinds of action. The line is
drawn by what the action touches, not by which command spells it
(`server/stop-line.ts`). No setting turns it off; the owner answers it on the
card or in chat.

## What stops

| Kind | Goes ahead | Stops |
| --- | --- | --- |
| Deleting | Inside the folder the bot works in (the turn folder, its own Murage workspace and thread folder, temp): build output, caches, files it made | A target outside that folder (home, Documents, Desktop, another disk, `~`, `/`); a target Murage cannot place (`$VAR`, `$(…)`, `xargs rm`, a relative path with no folder); deleting mail, files or records through a connected app; `DROP` / `TRUNCATE` / `DELETE FROM`; `git push --force`, `push --delete`, `branch -D`, `reset --hard`; a disk wipe |
| Paying | Reading charges, invoices, balances | Charges, payouts, refunds, purchases, transfers through a connected app, the Stripe CLI, or a POST to a payment API |
| Messaging | A reply in an existing conversation; a message to someone this bot has already written to; anything to the owner (their linked Telegram, Slack and Discord accounts and paired DMs) or to the person a channel conversation is with; a `gh` post to a repository it already posted to with the owner's say-so; a plain `git push` | The first message to a new person or group; anything public (posts, tweets, broadcasts); the first `gh issue`/`pr` comment, create or review, `gh release create` or `gh api` POST per repository; a message whose recipient Murage cannot read |

Covered spellings include `rm` (any flags), `rmdir`, `unlink`, `trash`, `shred`,
`git clean`, `git rm`, `find -delete` / `-exec rm`, `mv … /dev/null` or to the
Trash, `rsync --delete`, `bash -c '…'`, and code deletes (`shutil.rmtree`,
`fs.rmSync`) judged by the paths they name.

## How each level treats it

| Level | Outside the stop line | On the stop line |
| --- | --- | --- |
| Ask | Card | Card, saying what and why |
| Auto | Auto-approved unless destructive or a key | Card |
| Full access, owner at the desktop | Auto-approved unless a key (`.env`, `.ssh`, shell profiles, API keys) | Card |
| Full access, routine, webhook, channel | Judged as Auto on an unattended turn | Card (never a grant) |

Full access approvals fold into one quiet line per run of steps,
"Approved 12 steps (Full access)", which counts up and opens to list the
steps. It stays visible with Tool calls off. The decision log keeps one row
per step.

The card offers **Allow once**, **Allow for this task** (the same kind of action
in the same place: same folder subtree, same recipient, same payee, until the
task ends, at most 12 hours, gone on restart) and **Always allow**, whose key is
scoped the same way (`stop:delete:/Users/ada/Projects/site`,
`stop:message:bob@example.com`, `stop:pay:stripe:cus_123`,
`stop:public:github:owner/repo`), never the bare tool
name. When Murage cannot say where, only **Allow once** is offered. Telegram
shows **Allow for this task** on these cards only.

In chat the owner can say "you can delete anything in ~/Projects/site today";
the bot records it with `allow_for_task`. It is honoured only on a turn the
owner started and is at, only for a place the owner's own latest message
names, and a chat note says exactly what was allowed.

## Engines

Under Full access the harness sets `stopLine` on the turn, and each engine
sends its asks to Murage instead of skipping them:

| Engine setting | Under Full access |
| --- | --- |
| Claude `bypassPermissions` | `acceptEdits` with the permission broker; connected apps not pre-allowed |
| Codex `fullAuto` | unsandboxed, `approvalPolicy: untrusted` (also on a resumed thread) |
| ACP `fullAuto` (Grok, Fuigo, Droid, Cursor, …) | run as a normal instance for the turn |
| Antigravity `fullAuto` | `accept-edits` (print mode cannot ask, so no shell or mounted tools) |

Without Full access, each engine's own setting is unchanged.

## Driving it

Node suites, no network:

```sh
pnpm exec vitest run server/stop-line.test.ts server/stop-line-state.test.ts \
  server/full-access.test.ts server/full-access-options.test.ts server/auto-approve.test.ts --maxWorkers=2
# the engines' permission paths against their fake CLIs
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/codex.test.ts \
  server/drivers/acp/acp.test.ts server/drivers/antigravity.test.ts -t "stop line" --maxWorkers=2
# end to end through the real server with the fake ACP agent
pnpm exec vitest run server/full-access-api.test.ts server/full-access-options-api.test.ts --maxWorkers=1
pnpm exec vitest run server/index.test.ts -t "chat allowance" --maxWorkers=1
# the buttons
pnpm exec vitest run src/components/ApprovalCard.test.ts src/components/InboxRequest.test.ts \
  server/telegram-approvals.test.ts --maxWorkers=2
```
