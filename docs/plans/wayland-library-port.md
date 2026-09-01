# Porting the Wayland library into Murage — skills, assistants, teams

**Status:** plan, verified against code on both sides. 2026-09-01
**Approved scope:** all 2,106 skills, 28 specialists (Quiet Money included),
60 teams, built-ins minus the three Wayland-coupled ones, and Smart Trader
using only the 11 published `@ferroxlabs/tvcontrol` skills.

## The model

Three layers, and they nest:

```
Team           a collection of bots                    (60 of them)
  └─ Bot       an assistant profile: persona + engine  (28 specialists + built-ins)
       └─ Skills  what makes that bot good at its job  (2,106 available)
```

A team is not a thing with its own brain. It is a roster. Wayland says this
literally — `dev-shop` is `teammates: ["smith","patch","verdict","sentry"]`,
four ids pointing at four assistants that each carry their own skills.

## Where each layer lands in Murage

| Wayland | Murage | Verified at |
|---|---|---|
| Skill (`SKILL.md` + frontmatter) | skill directory: `manifest.json` + `SKILL.md` | `skill-library.ts:56-64` |
| Skill attached to an assistant | installed per bot, enabled per bot, symlinked into the engine's own skills dir | `skills.ts:595,605,442` |
| Assistant persona / role MD | bot profile + a package playbook | `bot-package.ts:105-111` |
| Assistant (`enabledSkills[]`) | bot + its enabled skill set | **needs one schema addition — see Gap** |
| Team (`teammates[]`) | team manifest `members[]` | `team-manifest.ts:84-92` |
| Standing company (scheduled) | team + a Murage routine | existing feature |

**The important mechanic:** Murage does not inject skill text into the prompt
for per-bot skills. `syncSkillLinks(botId)` symlinks the enabled ones into

```js
NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"]
```

inside the bot's workspace, and the engine CLI discovers them itself, on demand.
So a bot with 17 skills enabled pays **nothing** in context until one is used.
That is what makes 2,106 viable, and it is the same trick Wayland uses with its
index-plus-blob pack.

## The gap — one schema addition

`BotPackageAgent` carries `playbooks: [key]` but no `skills: [id]`
(`bot-package.ts:98-104`). So a package can describe an agent's persona but
cannot say which library skills it uses — which is exactly what an assistant
profile is.

Add `skills: z.array(key).max(200).optional()` to the agent schema, resolved at
import against the installed library. Everything else already exists.

Second, smaller: `installSkill(botId, source, files)` takes file contents inline
(`skills.ts:595`). It needs a sibling that installs by library id. `skill-fetch.ts`
already fetches skills from a remote source, so the shape has precedent.

## Why the skills do NOT go in `skills/`

Murage has two skill systems and only one is right here.

`skill-library.ts` is the **bundled** set: gated on `defaultEnabled` plus trigger
words, and the matched skill's full text is injected into the prompt
(`skill-library.ts:118-140`). Putting 2,106 there breaks either way — with
`defaultEnabled: false` they are inert and never selected; with `true` you get
thousands of trigger terms colliding and dumping instructions into every turn.

The library is a **catalog bots install from**, not a bundle every bot carries.

## Manifest conversion

Wayland skills are standard Agent Skills frontmatter, which is what Murage's
parser expects. The manifest is generated from the index entry:

```
id                   ← slug (must equal the directory name — skill-library.ts:38)
name                 ← name
version              ← metadata.version         (must match \d+\.\d+\.\d+)
description          ← description
triggerTerms         ← tags + category          (must be non-empty)
requiredCapabilities ← []
defaultEnabled       ← false
```

`requiredCapabilities` stays empty deliberately: selection requires every named
capability to be present (`skill-library.ts:127`), so an invented name would
silently hide the skill.

## Build order

1. **Schema**: `skills[]` on the package agent; `installSkill` by library id.
2. **Skill library**: convert 2,106 into skill directories with manifests.
   Dedupe slugs across categories. Skip any body that does not start with `---`.
3. **28 specialists** → bot packages. Role MD becomes the playbook; `enabledSkills`
   becomes `skills[]`.
4. **60 teams** → team manifests. `teammates[]` maps to `members[]` by key.
   The 7 standing companies additionally get a routine for their schedule.
5. **Built-ins**: 19 ship as-is, 7 need a brand-name pass, 3 held
   (`openclaw-setup`, `hermes-setup`, `concierge` — they are *about* Wayland's
   own infrastructure, so porting them means rewriting them).
6. **Smart Trader** last, since it needs the TVControl MCP server registered.

## Smart Trader — the IP boundary

**Inside, ships with Murage:** the TVControl MCP server plus its 11 published
skills — `chart-analysis`, `morning-prep`, `multi-symbol-scan`,
`multi-pane-analysis`, `learn-from-losses`, `replay-practice`,
`strategy-ab-test`, `strategy-report`, `pine-develop`,
`porting-pine-versions`, `rebuild-from-screenshot` — and the Smart Trader
prompt. Generic: how to use TVControl, no strategy, no advice.

**Outside, never in this repo or any build artifact:** RebelTrader Foundations
and Frameworks, REGIME-GATE, the TC-TIDE masterclass, and above all the
162-line Rebel Scanner in `~/dev/smarttrader`, which has never been published
and has no remote by design. Treat that directory as read-only reference.

The proprietary layer installs into a customer's bot after purchase through the
same `installSkill` / `setSkillEnabled` path as everything else — so a paid
pack needs no new architecture.

## Guardrails that come along for free

Smart Trader's own rules are worth keeping verbatim rather than paraphrasing:
never places an order, never gives financial advice, never presents a number it
did not read, and never says "connected" unless a call actually returned. The
three-state distinction — installed, running, answering — is the part that
prevents most support tickets.
