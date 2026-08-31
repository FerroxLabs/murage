---
name: create-verification-skill
description: "Generate a project-local verification skill: a scripted way to launch the user's app, drive one of its features the way a user would, and capture evidence — on whichever surface this bot actually has (browser, computer, phone, or plain Bash). Use when asked to create a verification skill, a control CLI, or a feature map, or when work on an app keeps ending without proof."
---

# Create a verification skill

A verification skill is how you prove your own work: launch the real app,
exercise a feature the way a user would, and capture evidence. Build it once
and every later turn — yours or another bot's — verifies in a few tool calls
instead of improvising. Write everything you generate for the next agent, not
for a human: it will be read cold by a bot that has never seen the app.

## 1. Pick the surface from the tools you actually have

- **Web app, or anything reachable by URL** → the built-in browser tools
  (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`,
  `browser_wait_for`, `browser_screenshot`). Refs from snapshots are the
  lever; screenshots are the evidence.
- **Desktop app** → the computer tools on this bot's computer. Prefer an
  isolated computer (cloud or Local VM) over the user's own desktop.
- **Physical Android app** → the phone tools, when mounted.
- **CLI, service, or library** → Bash in the workspace: build once, drive
  each run in its own process, use curl for services.

If the right surface tool is not mounted, say exactly that and name the
setting that adds it (the bot's Computer or Browser toggle). Never fake a
surface with a weaker one.

## 2. Interview the repo, not the user

Answer from the codebase; ask the user only what you cannot observe: how the
app starts locally (the repo's own dev command), how you can tell it is
ready (log line, port answering), seed data and test accounts, whether two
instances can run side by side. If the checkout does not start as-is, fix or
report that first — a skill written against a broken base teaches wrong steps.

## 3. Build the lever

When the surface is Bash-reachable, write a small control CLI into the
project (for example `scripts/control-<app>.mjs`) instead of leaving prose
instructions: subcommands like `doctor`, `launch`, `send`, `snapshot`,
`screenshot`, `wait-settle`, `cleanup`. Rules for the CLI: descriptive
errors that say what to do instead, `--dry-run` on anything destructive,
machine-readable output, rich `--help`. When the surface is the browser,
computer, or phone tools, those ARE the lever — the drive recipes belong in
the feature map instead of a wrapper script.

## 4. Generate the skill where it becomes real

Write the skill to `~/.openmausbot/skills/verify-<app>/` (the user-skills
folder; hot-loaded, no restart):

- `manifest.json` — `id` must equal the folder name (kebab-case), plus
  `name`, `version` "0.1.0", `description`, `defaultEnabled` true,
  `triggerTerms` (include "/verify-<app>" and the app's name), and
  `requiredCapabilities` naming the surface it needs (for example
  `["browserMcp"]`) so it never triggers on a bot that cannot run it.
- `SKILL.md` — frontmatter, then exactly these sections, each grounded in
  what the interview found, no placeholders: **Launch** (command + ready
  signal + teardown), **Doctor** (one read-only "is this instance worth
  driving?" check), **Drive** (real selectors, refs, routes, or commands
  from this app — stable handles, never coordinates), **Evidence** (what to
  capture and where it survives; real user path, action AND resulting
  state, side effects checked alongside what is visible), **Cleanup** (kill
  what you started, never by process name; cleanup must not eat evidence).
- `features/README.md` plus one file per major feature (top 3-5 to start),
  each with exactly four H2s: `Sub-features`, `How to get to it (user
  POV)`, `Driving it`, `Gotchas`. This map is compact shared memory — it is
  why the second verification costs a fraction of the first.

## 4b. Recordings are seeds

If the user has recorded a workflow with the skill recorder (or offers to
demonstrate one), treat the recording as ground truth for that feature's
`How to get to it (user POV)` section and its drive recipe — a
demonstration beats your exploration. The reverse also holds: when you
finish a feature-map entry, it upgrades any recorded skill for the same
flow with a Doctor check, evidence standards, and cleanup it did not have.

## 5. Prove it before you announce it

Run the generated skill end to end once: launch, doctor, drive ONE mapped
feature, capture evidence, clean up, then confirm the evidence still exists.
A generated skill that was never executed is a draft, not a deliverable.
Show the user the evidence when you report.

## 6. Offer the maintenance routine

Offer to keep the skill honest with a daily routine: propose it with
propose_routine (instructions: "run /maintain-verification-skill for
<app>"). The routine only exists after the user confirms the card — never
claim it is scheduled before that.

Prior art: this distills the verification practice from poteto's pstack,
adapted to this app's surfaces and skill format.
