# G-NL: wipe-only No limits

Sean's ruling **2026-11-12 02:05Z** supersedes the 11-11 r2 rulings and
older deny-list designs: “keep only the wipe check, everything else is NO LIMITS”.

At No limits, owner, owner-channel, bot and routine permission requests run
without a card except for the wipe/catastrophe list. Outside content, key rows,
protected paths, sensitive paths, home globs, reader failures, cuts, missing
arguments/grants, own tools, stop lines and stored Murage refusal rules do not
raise permission cards. Actual questions still wait for the person's answer.

The wipe check runs on every request, including tainted and unreadable input.
Visible home/work/project wipes, disk/volume erasure, database destruction,
Git history destruction, backup deletion and the existing catastrophe rows
must card. Reader failure alone must run. Quoted documentation and file bodies
remain data; fake replay commands are never executed.

The owner default is No limits when either the workspace chief or
`newBots.permissionLevel` is No limits; a lower new-bot default cannot mask the
chief's choice. Bots without an explicit lower choice
resolve that default at decision time. Owner edits have `permissionExplicit`
and/or a permission revision. Legacy Ask/Auto defaults without such evidence
inherit; legacy Full access remains a lower affirmative choice. Routine load
similarly marks unproven legacy Ask/Auto ceilings as inherited. New routines
store no ceiling unless one was chosen. Resolved handoff ceilings keep their
lower level. Settings reports following counts, lists explicit lower choices,
and offers **Use No limits for all**.

Run inside the required network-none job container:

```sh
node node_modules/vitest/vitest.mjs run server/no-limits-truly.test.ts server/no-limits-inheritance.test.ts server/decision/no-limits-truly.test.ts
node --experimental-strip-types scripts/no-limits-live/truly-proof.mjs NEW_EVIDENCE_DIRECTORY
node node_modules/vitest/vitest.mjs run server/no-limits-symlink-r31.test.ts server/decision/no-limits-x2-full-access.test.ts server/decision/no-limits-y3b-full-access.test.ts
```

The live replay launches its own `control-murage` fixture and records Doctor,
HTTP commands, native fake-engine events, SSE/transcripts and card counts.
It closes that exact child; no live app/data or billable provider is used.
The Full access portions of the established twins must remain byte-identical.
Unproven origins retain the base decision behavior; wipe-only relief requires an admitted origin.

Sean's **2026-11-12 ~02:50Z** ruling includes webhooks and other unattended
turns on a bot whose effective level is No limits. MAIN's guest-thread rule
still applies: another person's DM/group/chat uses the bot's explicit owner
choice, or Ask without one. Only owner threads inherit the owner's default.
The owner's channel-messages-off choice always wins for owner-channel turns.
`server/no-limits-origin.ts:noLimitsAppliesTo` is the shared origin predicate.

The terms warning is enforced when choosing No limits. A stale stored terms
version does not downgrade individual calls or create Full access cards.

Ordinary `git reset --hard`, force-with-lease, feature-branch deletion,
`.git/index.lock` deletion and deletes inside backup/.git-like paths run.
Whole repository .git deletion, backup-root deletion, force pushes to main or
master without lease, filter-branch/filter-repo, and reflog-expire plus gc-prune
card. Cuts/unread input require an executable wipe pattern; bare verbs and
non-command summaries remain data.

The routine editor defaults to **Follow bot**. Persisted inherited defaults
stay inherited when renamed; choosing a lower level explicitly preserves that
ceiling. Returning the selector to Follow bot restores inheritance. The routine
sheet distinguishes inherited No limits from an explicit lower level.
