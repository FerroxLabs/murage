# Self-assembling assistant — implementation plan

Answer one question in plain language, get a fully configured, skilled Ember.
Curated profile first, custom assembly second, suggestion never silently applied,
everything local.

Working tree at commit `04f2ed79`. `server/store.ts`, `server/index.ts`,
`server/chief-of-staff.ts`, `server/drivers/agents-proxy.ts` and `src/**` were
**modified by another agent while this was written** — every `file:line` below was
re-anchored by grep at the end of the session, but treat line numbers the way
MASTER-PLAN §8 tells you to: re-anchor before editing. Symbol names are stable;
offsets are not.

Nothing in the repo was modified except this file. No git write command was run.

---

## 0. What I measured myself

Six things. Every one of them changes the plan.

### (a) The skills library — **the brief's numbers are right, one is better than claimed**

Ran the repo's own `parseFrontmatterScalars` / `parseSkillMd` (`server/skills.ts:194`, `:231`)
over every directory in `skills-library/`:

```
dirs                  2237
with SKILL.md         2237
with manifest.json    2237
parseSkillMd ok       2237      ← not 2,234. Zero failures.
desc mean chars       499.4     (median 493, p90 639, max 955)
full description index  1,168,227 bytes  ≈ 292k tokens
SKILL.md bodies total   57,401,193 bytes (54.7 MB)
```

**Confirmed: too big to inline, by two orders of magnitude.** Retrieve-then-rerank is
forced, not chosen. Corrected: it is 2,237/2,237 with a usable description, not 2,234.

### (b) SQLite FTS5 with `bm25()` is already available — **zero new dependencies**

This is the single most useful thing I found. `server/message-db.ts:15` already imports
`DatabaseSync` from `node:sqlite`. I checked whether the bundled SQLite has the FTS5
extension compiled in. It does:

```
node v22.23.1 / sqlite 3.51.3
CREATE VIRTUAL TABLE t USING fts5(...)  →  OK
SELECT bm25(t) ... WHERE t MATCH ?      →  OK, ranked
```

Then I built the real index over all 2,237 skills:

```
read + parse 2,237 SKILL.md   448 ms
total index build              473 ms
index file size              2,068,480 bytes (2.0 MB)
query latency                  0–1 ms
```

`package.json` has 13 runtime dependencies and none of them is a search engine
(`clsx`, `lucide-react`, `posthog-js`, `qrcode.react`, `react`, `react-dom`,
`react-markdown`, `remark-gfm`, `shiki`, `tailwind-merge`, `yaml`, `zod`,
`@trycua/cua-driver`). **Do not add one.** The retrieval layer is ~120 lines against a
built-in.

### (c) Lexical retrieval is a recall net, not a ranker — measured, and it is worse than it sounds

Real queries against the real index, top-10 by BM25:

```
"trading OR trade OR chart OR market" (porter stemmer)
  replay-practice, learn-from-losses, strategy-report, options-basics-trainer,
  copy-lens-platform-native, car-buying-guide, technical-specification,
  backend-architect, game-economy-designer, system-designer
                                          ^^^^ 5 of 10 are noise

"stock"
  stock-analysis-guide, cap-table-basics, inventory-manager, aquarium-keeper,
  knife-making, systems-thinker, ...
             ^^^ "stocking the tank", "stock removal" — porter stemming collisions
```

I tried dropping the porter stemmer to fix that. It fixes `stock` and **breaks
`charting`, which then returns zero rows**. Morphology is load-bearing; the noise is
the price. So:

**The shortlist must be assumed ~50% wrong, and the re-ranking model must be permitted
to return fewer skills than it was offered, including none.** Any design where the
model picks "the best N of the shortlist" ships an assistant with `car-buying-guide`
installed on a trading bot. This is the difference between the feature feeling
intelligent and feeling like autocomplete.

Union of 4 queries × 12 results → **43 distinct candidates**:

```
full descriptions   22,216 bytes  ≈ 5,554 tokens
truncated to 140ch   6,970 bytes  ≈ 1,743 tokens
```

That is the small-model budget answer, and it is in §7.

### (d) The catalog inlines comfortably — **confirmed**

Fetched the live catalog (`https://raw.githubusercontent.com/FerroxLabs/murage-teams/main/catalog.json`,
HTTP 200, 85,500 bytes on the wire, 68,846 bytes minified):

```
total entries                122      ✓ as claimed
members === 1                 58      ✓ as claimed
members > 1                   64
compact one-line projection of the 58 solo entries   14,219 bytes ≈ 3,555 tokens
compact one-line projection of all 122               27,692 bytes ≈ 6,923 tokens
```

Owner said ~13.5 KB / 3,400 tokens and ~26 KB / 6,600. **Confirmed, within 5%.**
Inlining the solo set is cheap. Inlining all 122 is affordable but only worth it for
multi-intent (§9), because a team is a different product action from an assistant.

### (e) The library's own search returns **zero results** for the words a user types

`src/components/TeamLibraryPanel.tsx:412-417` is a lowercase substring match over
`name + summary + category + skills.join(" ") + requires.apps.join(" ")`. I ran that
exact predicate over the real 122 entries:

```
query           hits
"trading"          0
"crypto"           0
"options"          0
"stocks"           0
"stock market"     0
"newsletter"       0
"writing"          0
"trade"            1   (smart-trader)
"charts"           1   (smart-trader)
"market"          14
```

**"trading" finds nothing. "crypto" finds nothing. "newsletter" finds nothing.** This
is not a nice-to-have improvement to discovery — the current discovery surface fails on
the most natural first word for the majority of its own catalog. It is the strongest
single justification for this feature and it took thirty seconds to measure.

### (f) 2,010 of 2,237 skills (89.9%) are unreachable from anywhere in the product

The catalog's 122 entries reference **241 distinct skill ids**, 227 of which exist in
the local `skills-library/`. That leaves **2,010 skills with no path to a bot at all** —
not through the library, not through the Skills panel, not through any agent tool.
They ship in the app (`electron-builder.yml:81-82` packages `skills-library` → Resources)
and they are dead weight today.

---

## 1. Claim-by-claim verdicts on the brief

| # | Claim as stated to the owner | Verdict |
|---|---|---|
| 1 | `server/team-library.ts:7` fetches `catalog.json` from `raw.githubusercontent.com` at runtime | **CONFIRMED.** `TEAM_LIBRARY_CATALOG_URL` is defined at `team-library.ts:7`; `fetchTeamCatalog` at `:152`; served by `GET /api/team-library/catalog` (`server/index.ts:6481-6487`), which returns **502** on any failure. Offline = the library panel is an error box. |
| 2 | `teams-library/` 748 KB and `library/` 336 KB are bundled | **CONFIRMED** (`du -sh`). Also `bot-library/` 268 KB, `skills-library/` 68 MB. |
| 3 | `library/assistants/` has 29 JSON files | **CORRECTED — 28.** The 29th is `.wayland-import.json`, the importer's own marker, explicitly excluded at `scripts/publish-profiles.mjs:50`. |
| 4 | `teams-library/teams/` has 59 dirs | **CORRECTED — 59 flat `.json` files**, not directories. |
| 5 | There is no local `catalog.json` | **CONFIRMED.** `find . -name catalog.json` (excluding node_modules) returns nothing. |
| 6 | The catalog has 58 one-person assistants out of 122 | **CONFIRMED exactly** — measured against the live file. Provenance: `scripts/publish-profiles.mjs` publishes 28 + 29 = 57 profiles; the 58th is `quiet-money-standing`, a standing/scheduled team with `members: 1`. |
| 7 | `server/skills.ts:470` sets `enabled: false` on installed skills | **CORRECTED — wrong line, and the substance is wrong too.** `:470` is the *legacy manifest migration* (`readManifest`), which strips workspace-authored enablement. The real install sites are `installSkill` → `server/skills.ts:739` and `installSkillFromLibrary` → `server/skills.ts:800`, both `{ enabled: false }`. **But see #8.** |
| 8 | A profile-installed skill arrives disabled — "the single biggest threat to the feature" | **CORRECTED — FALSE. It already arrives ENABLED.** `server/index.ts:6647-6657` (the `POST /api/teams/import` handler) calls `installSkillFromLibrary`, then immediately `setSkillEnabled(created.id, installed.name, true)`, with a comment saying exactly why. The threat does not exist. |
| 9 | The Skills panel empty state says installed skills "land switched off" | **CONFIRMED — and it is STALE COPY, not a policy.** `src/components/BotSkillsPanel.tsx:439-441`. It describes behaviour that was true through **0.1.44**, when `MURAGE_SKILL_LIBRARY` was declared but set and packaged by nobody, so "every team and profile a user hired installed zero skills" — `electron/harness-resources.mjs:1-12` says this in its own words. The env wiring landed; the copy did not. **This is a one-line fix, not a design decision.** |
| 10 | `src/components/BotSkillsPanel.tsx` has `remove` but no add/browse | **CONFIRMED for the UI.** The panel does list / filter / open / toggle / remove / show-more and nothing else (617 lines; the button set is at `:350`, `:374`, `:390`, `:487`, `:503`, `:520`, `:544`). |
| 11 | Routes exist at `server/index.ts:7620` and `:7640` | **CORRECTED, and this matters.** `POST /api/bots/:id/skills` (`server/index.ts:7628-7639`) **does** exist and **does** add a skill — but its body is `{ source: GitHub URL or owner/repo }` → `fetchSkillFromSource` → network. `PATCH .../skills/:name` (`:7646`) toggles, `DELETE` (`:7654`) removes. **There is no route anywhere that installs from the local `skills-library/`.** `installSkillFromLibrary` has exactly one call site in the whole server: `index.ts:6648`, inside team import. That is the gap — not "no add button", but "no local add path at all". |
| 12 | The intake card is `onboardingCard()` at `server/store.ts:640`, appended at `:1310` | **CORRECTED — `store.ts:678`, appended at `:1360`** (the file moved under the concurrent edit). |
| 13 | Nothing consumes the answer; the reply just becomes chat context | **CONFIRMED, precisely.** `src/state/store.tsx:1653-1658`: answering persists `{answered, dismissed}` via `PATCH /api/bots/:id/cards/:cardId` (`server/index.ts:7789-7807`) and then `POST /api/bots/:id/messages { text: answer }`. The answer becomes a literal user chat message that triggers an ordinary turn. No server code branches on `card.answered` — grep finds it only in tests. |
| 14 | The card is a plain-language question | **CORRECTED.** It is a **fixed 4-option quiz**: "Work & projects / Writing & research / Life admin / A bit of everything" (`server/store.ts:678-682`), with a "Type your own answer" free-text field underneath (`src/components/OptionCard.tsx:93-101`). The free-text field is the only part of it that is plain language, and it is the least prominent element on the card. |
| 15 | Dismissing is irreversible without deleting the bot | **CONFIRMED in the UI; CORRECTED at the API.** Three things dismiss it: the ✕ (`OptionCard.tsx:53-60`), answering it (`store.tsx:875`), and — silently — **any user text message at all** (`server/store.ts:1197` → `dismissOnboardingCard` at `:1230`). No UI can undo any of them. But `PATCH /api/bots/:id/cards/:cardId` accepts `{dismissed: false}` and the handler passes it straight through (`server/index.ts:7799-7805`). The route already exists; only the button is missing. |
| 16 | Agent tools are `ask_bot`, `create_bot`, `delegate_bot` | **CORRECTED — there are twelve.** `list_bots`, `ask_bot`, `delegate_bot`, `check_delegation`, `wait_delegation`, `create_bot`, `request_credential`, `list_routines`, `propose_routine`, `propose_routine_action`, `skills_list`, `skill_manage` (`server/drivers/agents-proxy.ts:188-372`). |
| 17 | `create_bot` already installs skills (`index.ts:6648` → `installSkillFromLibrary`) | **CORRECTED — FALSE.** `index.ts:6648` is inside `POST /api/teams/import`, not `create_bot`. The `create_bot` tool schema (`agents-proxy.ts:246-262`) accepts `name`, `role`, `instructions`, `section` — **no skills field at all**. `skill_manage` (`:338`) only *authors* a new SKILL.md and stages it behind a user confirmation card; it cannot install from the library either. **The last mile does not exist. The gap is retrieval AND the install tool.** |
| 18 | The default first-run bot ships with zero skills | **CONFIRMED.** `store.createBot` (`server/store.ts:~1330-1362`) seeds a greeting and the quiz card. `POST /api/bots` (`server/index.ts:7176`) takes no skills. Nothing installs anything. |

### One thing the brief missed entirely, and it is good news

`GET /api/teams/scout` (`server/index.ts:6509-6523`) already implements the exact
shape this feature wants — **"the agent proposes, the person imports", enforced by the
route split itself**, and the comment at `:6516-6517` says it is *"deliberately
offline"*. `scoutProject` + `suggestTeam` live in `server/project-scout.ts` (13.7 KB,
with tests). It reads a folder and returns `{ profile, suggestion }`, creating nothing.

**Do not invent a new interaction model. Extend this one.** It is already the
architecture the owner asked for, already local, already tested, and already shipped.

---

## 2. Local-first: exactly what is generated, what is committed

The inversion is required (owner constraint, and #1 above makes the panel a 502 box
offline). Here is what it costs, precisely.

### What is locally derivable — measured

I reconstructed a catalog from the on-disk sources (`teams-library/teams/*.json` +
`library/assistants/*.json` + `bot-library/builtins/*.json`) and diffed slugs against
the live one:

```
live catalog entries                    122
distinct local package/manifest sources 116
catalog entries with NO local source      6
local sources not in the catalog          0
```

The six are `100x-marketing`, `competitor-watch`, `engineering`, `inbox-follow-up`,
`reddit-lead-miner`, `seo-growth` — the OpenMausBot-derived teams whose attribution
`scripts/publish-profiles.mjs:161-163` is careful to preserve. **All six are
multi-member teams. All 58 solo profiles are locally derivable.** So a fully offline
catalog covers 116/122 entries and **58/58 of the profiles this feature actually
matches against.**

### Decision

| Artifact | Generated when | Committed? | Why |
|---|---|---|---|
| `library/catalog.json` (116 entries, `murage.catalog` v1, passes `parseTeamCatalog` unchanged) | build time, by a new `scripts/build-local-catalog.mjs` | **YES, committed** | A packaged app and a fresh clone must both work with the network unplugged. 68 KB of JSON. Committing it makes staleness reviewable in a diff instead of invisible. |
| The 6 OpenMausBot team sources | — | **Vendor them** into `teams-library/teams/`, preserving the README attribution, then the local catalog is 122/122 | 6 files. Anything else leaves a permanent "some teams only exist online" caveat that is worse to explain than to fix. |
| `skills-index.db` (FTS5, 2.0 MB) | **first run / library-fingerprint change**, into `DATA_DIR` | **NO** | 473 ms to build; committing a 2 MB binary that duplicates text already in the tree is churn, and a committed index can silently disagree with the shipped `skills-library/`. Building it from the shipped tree makes disagreement impossible. |
| Network catalog | runtime, **optional** | — | Becomes a refresh that *merges over* the local one and is allowed to fail silently. Never blocks. |

**The loader inversion**, concretely: `fetchTeamCatalog()` (`server/team-library.ts:152`)
gains a sibling `loadLocalCatalog()`, and `GET /api/team-library/catalog`
(`index.ts:6481`) serves local-first, kicks off a background refresh, and **stops
returning 502** — it returns the local catalog plus a `{ refresh: "stale" | "ok" |
"offline" }` field the panel can render as a quiet line, not an error. The remote
parse path (`parseTeamCatalog`) is unchanged and still gates anything that arrives from
the network.

A test in the shape of `electron/harness-resources.test.mjs` — which exists precisely
because a generated/packaged pair drifted silently once already — asserts
`library/catalog.json` is byte-identical to what `build-local-catalog.mjs` produces
from the current sources. Without that test this file rots in a month.

---

## 3. Skill enablement: the policy, and why the brief's fear was misplaced

The owner's position was "a curated bundle the user just accepted should arrive ON,
while ad-hoc user-added skills stay off-by-default", pending a check of the safety
machinery. **That is already exactly the implemented policy.** I checked the machinery
and it holds up.

- Curated bundle → **ON**: `index.ts:6647-6657`, install-then-enable, per skill, with a
  failure of either logged and skipped so one bad id cannot fail the import.
- Ad-hoc / fetched / agent-authored → **OFF**: `skills.ts:739`, `:800`; agent-authored
  additionally sits behind a staged review card (`skill_manage`, `agents-proxy.ts:338`).
- Enablement is not a free bit. `setSkillEnabled` (`skills.ts:803-815`) refuses to
  enable a skill whose stored `SKILL.md` no longer hashes to the reviewed content, and
  `skillListing` (`:675-687`) reports `enabled: entry.enabled && intact` — so tampering
  after review de-enables at read time, not at some later check.
- The manifest lives in protected state, not the workspace (`writeManifest`, `:523-526`,
  mode `0700`/`0600`), and `readManifest` (`:450`) fails closed rather than falling back
  to an agent-writable legacy file.
- Native discovery links (`NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills",
  ".grok/skills"]`, `skills.ts:528`) are a *projection* of the protected manifest, with
  `nativeLinkPointsToSkill` / `nativeLinkDirectlyTargetsOwnedSkill` (`:489`, `:506`)
  comparing link text rather than following resolved paths, so a user-replaced
  same-name link is never claimed or clobbered.

**Verdict: keep the policy, change the copy.** The one real defect is
`BotSkillsPanel.tsx:439-441` telling every user the opposite of what the product does.
A user who reads that sentence and then sees ten skills switched on concludes the app
is lying to them — which is a worse failure than either policy.

**Recommended copy** (Krug: the empty state should say what to do next, not narrate a
policy):

> *{botName} has no skills yet. Ask in chat what you want help with and Murage will
> suggest a set — you see them before anything is switched on. Skills you add yourself
> stay off until you read them here.*

**One genuine risk the brief did not raise.** A profile can carry a lot of skills:
`smart-trader` declares **11**, `coin` 11, `beacon`/`helm`/`lens`/`slate` 10 each; the
catalog references 277 skill paths across 122 entries. Accepting a suggestion can
therefore switch on eleven things at once. That is fine *if the card names them* and
*if one click undoes it* (§5, step P5/P8). It is not fine as a silent side effect of
answering a question — which is the Sutherland point: the visible, slightly costly
signal ("here are the eleven, here's what each does, one button") is what makes the
result feel expensive rather than automatic.

---

## 4. Provenance — the keystone

Today a bot configured from Smart Trader records **`installedPackage`** —
`{ id, name, release, requiredApps }` (`server/store.ts:503`, interface at `:522-527`),
set at `index.ts:6663-6669`. So the brief's "records nothing" is **CORRECTED: it records
identity and release, but nothing about the decision, and nothing at all when the bot
was assembled from loose skills rather than imported from a package.**

That existing field is the migration path. It is already persisted, already exported,
already documented as *"Listing provenance and connector intent retained for package
details and future re-export"*. Extend it; do not add a parallel one.

### Schema

```ts
/** How this bot came to be configured. Written by import and by the
 *  self-assembly intake; read by reconfigure, re-sync, reset and the
 *  "why do I have this?" line in the Skills panel. */
export interface BotProvenance {
  /** "library-package" | "assembled" | "manual" */
  kind: "library-package" | "assembled" | "manual";
  /** Verbatim, what the person typed at intake. Never edited, never
   *  re-summarised — it is the only record of what they actually wanted. */
  request?: string;
  at: number;
  /** Present for kind === "library-package". Supersedes installedPackage. */
  profile?: { slug: string; name: string; release: string; catalogSource: "local" | "remote" };
  /** Every skill this configuration put on the bot, with why. A skill the
   *  user later added by hand is absent, so reset knows what it owns. */
  skills: Array<{
    id: string;
    /** "profile" = came with the bundle; "matched" = chosen by the
     *  assembler for this request; "user" = added later by a person. */
    origin: "profile" | "matched" | "user";
    /** The retrieval query that surfaced it. Debuggable, and it is the
     *  honest answer to "why is this here?". */
    via?: string;
  }>;
  /** Set when the user edits away from the bundle, so re-sync can warn
   *  instead of silently reverting their work. */
  divergedAt?: number;
}
```

### Migration

`installedPackage` stays on `BotRecord` and keeps being written for one release, so
nothing that reads it breaks. On load, `Store` derives `provenance` for any bot that has
`installedPackage` and no `provenance`:

```
kind: "library-package"
profile: { slug: installedPackage.id, name, release, catalogSource: "remote" }
skills:  listSkills(botId).map(s => ({ id: s.name, origin: "profile" }))
at:      bot.createdAt
```

This is lossy — it cannot distinguish a profile skill from one the user added by hand
before the migration, so it labels them all `profile`. That is the safe direction:
`reset` will offer to remove a skill the user added, and the reset confirmation names
every skill it will remove, so the user catches it. Labelling them `user` instead would
make reset silently leave junk behind, which is unrecoverable rather than merely
annoying. Say this in the reset dialog for pre-migration bots: *"This bot predates
configuration history, so I'm not certain which skills you added yourself — check the
list."*

`store.ts` already has a load-time normaliser doing exactly this class of work for
`chiefScope` and `individual` (`:765-790`), so there is a pattern to follow and a place
to put it.

**Nothing else in this plan works without provenance.** Reconfigure, re-sync, reset,
"why do I have this skill", multi-intent, and the entire revealed-preference track in
§10 all read it. It is P1 for that reason, not because it is exciting.

---

## 5. Sequenced work plan

Effort in engineer-hours, including tests. MASTER-PLAN §4 records that the previous five
plans were **collectively ~40% under**, concentrated in unmapped UI components,
real dependency lists, and rig work for tests that had no harness. I have applied that
correction upward here rather than discovering it later — in particular, `server/comms.test.ts`
is called out in MASTER-PLAN §8 as needing *"a day of rig work before the first
assertion"*, and the intake tests have the same problem.

| ID | Work | Depends on | Hours |
|---|---|---|---|
| **P0** | **Local catalog.** `scripts/build-local-catalog.mjs` emits `library/catalog.json` from the three on-disk source dirs, validated through the existing `parseTeamCatalog`. Vendor the 6 OpenMausBot teams with attribution. `loadLocalCatalog()` in `team-library.ts`. `GET /api/team-library/catalog` serves local-first + background refresh, stops 502-ing. Sync test in the shape of `harness-resources.test.mjs`. Package `library/` via `extraResources` + extend `HARNESS_RESOURCE_DIRECTORIES`. | — | **14–18** |
| **P1** | **Provenance.** `BotProvenance` on `BotRecord`, load-time migration from `installedPackage`, written by the import path at `index.ts:6658-6671`, surfaced on `wireBot`. Store tests. | — | **10–14** |
| **P2** | **Copy + reversibility.** Fix `BotSkillsPanel.tsx:439-441`. Add "Bring back the setup question" to the bot menu (the `PATCH .../cards/:id {dismissed:false}` route already exists — this is a button and a reducer case). Make the free-text field the primary affordance on the intake card, options secondary. | — | **5–8** |
| **P3** | **Skill index.** `server/skill-index.ts`: build FTS5 over `SKILL_LIBRARY_ROOT` into `DATA_DIR/skills-index.db`, keyed on a cheap fingerprint (entry count + library-root mtime + a schema version). Lazy background build on first need. `searchSkills(queries: string[], limit)` returning deduped, BM25-ordered `{id, description}`. Field-weighted `bm25(s, 3.0, 1.0)`, porter stemmer (see §0c). | — | **16–22** |
| **P4** | **Local install route + agent tools.** `POST /api/bots/:id/skills/library { ids: string[] }` → `installSkillFromLibrary` + `setSkillEnabled(true)` for each, all-or-nothing per skill with per-id result reporting. Three tools in `agents-proxy.ts`, mounted **only on an intake turn**: `find_profile(need)` → returns matches from the inlined catalog; `search_skills(queries[])` → P3; `propose_assistant({profile? , skills[], name, role, instructions})` → **writes a suggestion card and returns; creates nothing.** Slug/id validation against the live catalog and library on the way out, so a hallucinated slug is a tool error the model can see and retry, never a 404 the user sees. | P0, P1, P3 | **26–34** |
| **P5** | **The suggestion card.** A new card kind (follow `skillRequest` on `OptionCardData`, `store.ts:63-65` — it is the closest existing precedent: durable, bot-authored, applies only on explicit confirm). Renders: profile name + one-line why, the skills with their descriptions, "Set this up" / "Not this" / "Show me the skills". Accept → `POST /api/teams/import` for a profile, or the P4 route for an assembled set; writes provenance either way. | P4 | **22–30** |
| **P6** | **Intake rewrite.** Replace the fixed 4-option quiz with one plain-language prompt. On first user message in a fresh bot's thread, run one intake turn with the P4 tools mounted and the 58-entry catalog (3.5k tokens) inlined. Falls back to an ordinary turn if the model declines or the tools fail. | P4, P5 | **18–24** |
| **P7** | **Browse.** A category-grouped catalog view in `TeamLibraryPanel` (25 categories exist in the data already — `Sell` 25, `Run` 16, `Write` 16, `Office` 14, `Build` 8, `Research` 8, `Publishing` 6…), a solo/team toggle, and **replace the substring filter at `TeamLibraryPanel.tsx:412-417` with an FTS5 query over the catalog** so "trading" stops returning zero. Second, smaller: a "browse skills" surface in `BotSkillsPanel` reading P3, so the 2,010 orphans (§0f) become reachable. | P0, P3 | **20–28** |
| **P8** | **Reconfigure / re-sync / reset.** Bot menu: "Change what this Ember does" (re-runs intake with provenance as context), "Update from the library" (diffs installed skills against the profile's current skill list; shows the diff; refuses silently to overwrite when `divergedAt` is set, warns instead), "Reset to how it arrived". | P1, P5, P6 | **16–22** |
| **P9** | **Local usage ledger.** Append-only `DATA_DIR/skill-usage.ndjson`: `{at, botId, skillName, event}`. Written where `syncSkillLinks` already knows a skill is live and where a turn records tool use. **Never leaves the machine** (see §10). | P1 | **8–12** |
| **P10** | **Multi-intent.** Intake may propose **two** assistants. Both are created as Individual Assistants (`individual: true`, `store.ts:481`; `isIndividualAssistant` `:570`) reporting to the workspace Chief. Needs the org model to have settled. | P5, P6, org model | **14–20** |
| **P11** | **Revealed preference.** After ≥14 days and ≥N recorded firings, offer "you keep asking about X — want me to add Y?" as a suggestion card. | P9 (+ real usage data) | **18–26** |

### Totals

| Slice | Hours |
|---|---|
| **Foundation — P0 + P1 + P2** | **29–40** |
| **The feature — P3 + P4 + P5 + P6** | **82–110** |
| **Completion — P7 + P8** | **36–50** |
| **Later — P9 + P10 + P11** | **40–58** |
| **Everything** | **187–258** |

At 30 focused hours a week: **6–9 weeks for one engineer** for the whole thing.

**The honest minimum that delivers the promise: P0 + P1 + P2 + P3 + P4 + P5 + P6 =
111–150 h, four to five weeks.** That is one question, one suggestion, one button,
fully offline, reversible, with provenance recorded.

**If only two weeks are available: P0 + P2 + P7's search fix.** That does not ship
self-assembly, but it makes the library work offline, stops the empty state lying, and
makes "trading" return Smart Trader. It is the highest ratio of perceived improvement to
hours in this document, and it is a prerequisite for everything else anyway.

---

## 6. Judged against the design bar

Explicitly, as required. Krug = "don't make me think; the cost of a click must never be
invisible and irreversible." Sutherland = "perceived value is set at the first moment;
small costly signals of intelligence beat features."

| Step | Krug | Sutherland |
|---|---|---|
| P0 local catalog | **Passes.** Removes a 502 error box the user cannot act on. | **Neutral-positive.** Nobody praises an app for working offline; everybody notices when it doesn't. |
| P1 provenance | **Passes indirectly.** It is what makes later clicks reversible. | **Strong.** "Configured from Smart Trader, 3 weeks ago, because you said you trade options" is a costly signal — it proves the app was paying attention. |
| P2 copy + un-dismiss | **Passes, and this is the biggest Krug win in the document.** The empty state currently teaches a falsehood on the highest-traffic screen. | **Strong.** First-moment value is set here. A dismissible card that does nothing sets it at zero. |
| P3 index | Invisible. | Invisible — but 0 ms search *feels* like the app already knew. Latency is the perceived-intelligence tax. |
| P4 tools | **Risk.** A tool that creates bots directly would be an invisible irreversible click. Mitigated by the `propose_*` naming and the route split copied from `/api/teams/scout` (`index.ts:6509-6513`). | **Neutral.** |
| P5 suggestion card | **The load-bearing screen.** Must name every skill, must have a visible "Not this", must be undoable after accepting. If accepting 11 skills is one unlabelled click, it fails both bars at once. | **The whole feature's value is set here.** Naming the eleven skills is the small costly signal. A spinner and "done!" is worth less than the same work shown. |
| P6 intake | **Passes.** One plain-language box beats a four-option quiz that maps to nothing. | **Strong.** "Answer one question, get an assistant" is the pitch. It has to actually be one question. |
| P7 browse | **Passes.** Krug's point about search: it only helps someone who knows what to ask. 2,237 skills with no browse is a wall. | **Moderate.** Browsing communicates scale — 2,237 is itself the signal. |
| P8 reconfigure | **Passes. This is the owner's actual complaint.** Dismiss-is-forever is exactly the invisible irreversible cost Krug names. | **Moderate.** Reversibility is the permission to try. |
| P9 ledger | Invisible. | Invisible now; the substrate for the strongest signal later. |
| P10 multi-intent | **Careful.** "That's a Trader and a Writer — set up both?" is honest and self-evident. Silently making one bot do both is the clever-not-self-evident failure. | **Strong.** Correctly declining to over-fit one bot reads as judgement, not limitation. |
| P11 revealed preference | **Passes if it is a suggestion.** Fails immediately if it acts. | **The strongest signal in the document** — and the one most easily ruined by firing too early or too often. |

---

## 7. Small local models

The deciding model may be small, local, and weak. Budgets, measured:

**Profile matching — comfortable.** 58 entries as compact lines = **3,555 tokens**
(§0d). Add ~400 tokens of instruction and the user's sentence. Total intake prompt
**≈ 4.2k tokens**, well inside any 8k-context local model. Output is one slug. This step
is safe on a small model.

**Skill re-rank — this is where a small model breaks.** Measured:

| Shortlist shape | Tokens |
|---|---|
| 43 candidates, full descriptions (mean 499 chars) | **5,554** |
| 43 candidates, descriptions truncated to 140 chars | **1,743** |
| 20 candidates, truncated to 140 chars | **≈ 810** |

**Recommended budget: ≤ 24 candidates, descriptions truncated to 140 characters,
≈ 1,000 tokens.** 140 chars is not arbitrary — the median description is 493 chars but
these are written lead-first ("Analyse a TradingView chart for trend and support
levels…"), so the first sentence carries the discriminating signal and the tail is
qualifiers. Verify this on a sample of 20 before committing to 140 (see §12).

**Total intake turn budget: ≈ 5.5k tokens across two tool calls.** Do not exceed it.

**Degradation ladder**, in order, each step strictly more honest than the last:

1. Profile matched with confidence → suggest the profile. No skill search at all. **This
   is the common case and it never touches the weak path.**
2. No profile, skills found → suggest an assembled set of ≤ 8, named.
3. Model returns nothing usable, or an invalid slug twice → **stop inferring.** Show the
   three highest-BM25 profiles as a browse strip: *"I'm not sure. Here are the closest —
   or browse the library."* This is the failure mode, and it is a perfectly good screen.
4. Index missing or model unavailable → the plain intake card, as today, plus the browse
   link. Never a spinner, never an error toast.

**Never let a small model free-text a skill id.** Every id it emits is validated against
the FTS5 table before the card is built (§8).

---

## 8. Failure modes, and the code that must handle each

| Failure | Handling | Where |
|---|---|---|
| **Nothing matches** | Ladder step 3. The card says "I'm not sure" and shows nearest neighbours. Never fabricate a match. | P5 |
| **Model returns a slug that does not exist** | `find_profile` and `propose_assistant` validate every slug against the loaded catalog and every skill id against the index **before returning**, and return a tool error naming the invalid ids. The model retries once. Twice → ladder step 3. **A hallucinated id must never reach the user as a 404.** | P4 |
| **Catalog stale** | Local catalog is versioned by its generator; the background refresh merges and the UI shows a quiet "updated N days ago". Never blocks, never errors. A remote entry that fails `parseTeamCatalog` is dropped, not fatal. | P0 |
| **Skill fails to install halfway** | Per-skill try/catch, exactly as `index.ts:6649-6656` already does. Partial success is reported on the card: "9 of 11 installed — Sam couldn't find `foo`, `bar`." **Do not roll back**; a bot with 9 of 11 skills is useful and a rollback loses the 9. Provenance records only what actually landed. | P4 |
| **Skill name collision** | `installPreparedSkill` (`skills.ts:1200`) already refuses a duplicate name with a readable error. Surface it verbatim; do not retry under a mangled name. | P4 |
| **Skill enabled but content changed** | Already handled: `setSkillEnabled` refuses (`skills.ts:808-810`) and `skillListing` reports it disabled with a warning (`:681-685`). Nothing new needed. | — |
| **Index build fails / disk full** | Feature degrades to profile-only (ladder step 1). Log once; never a modal. | P3 |
| **Index stale vs. shipped library** | Fingerprint check on every open; mismatch → rebuild in the background, serve the old index meanwhile. | P3 |
| **The 14 catalog-referenced skills missing locally** (`positioning-brief`, `campaign-sprint`, `experiment-review`, `change-detection`, `decision-brief`, `architecture-decision`, `implementation-plan`, `release-readiness`, `follow-up-triage`, `specific-follow-up`, +4) | These resolve on the *remote* repo but not in `skills-library/`. A local-only install of a team declaring them will log and skip, exactly as today. **Do not silently drop them from the local catalog** — the count on the card must match what lands, so the local catalog's `skills` array is filtered to locally-present ids at generation time and the README records the delta. | P0 |
| **Two intake turns race** (user sends twice fast) | The intake turn is keyed to the bot's first user message id; a second message while one is in flight is an ordinary turn. | P6 |
| **Bot deleted mid-suggestion** | Card is a message on the bot's thread and dies with it. Already how every other card behaves. | — |

---

## 9. Multi-intent

"I trade and I write a newsletter."

The honest answer is two assistants, and the org model already supports saying so:
`individual?: boolean` on `BotRecord` (`store.ts:481`), `isIndividualAssistant`
(`:570-571`), and `canReach` permitting Chief ⇄ individual in both directions
(`:603-604`). A bot created by this intake **is** an Individual Assistant and should be
flagged as one.

Rules, in order:
1. If one profile covers both plausibly → one assistant. Do not split for the sake of it.
2. If two profiles each cover one → **ask**: *"That's really two jobs. Set up a Trader
   and a Writer?"* with a "just one for now" option. Two Individual Assistants.
3. Never more than two from a single intake. Three is a team, and the right answer to a
   team is the team library, not this flow.

**Sequence P10 after the org model settles**, and take the settled shape from whatever
lands in `chief-of-staff.ts` rather than assuming it. That file is being edited right now.

---

## 10. Revealed preference — what to record NOW, ship LAST

The brief is right that this is the strongest signal and right that it must come last:
it needs usage data that does not exist, and building the consumer before the producer
guarantees a rewrite.

**Record now (P9). Ship the consumer later (P11).**

`DATA_DIR/skill-usage.ndjson`, append-only, mode `0600` alongside the existing protected
state (`skills.ts:523-526` is the precedent):

```
{"at":1756...,"botId":"...","skill":"chart-analysis","event":"enabled"}
{"at":1756...,"botId":"...","skill":"chart-analysis","event":"invoked"}
{"at":1756...,"botId":"...","skill":"chart-analysis","event":"removed"}
```

Three events, no content, no prompts, no message text. Retention 90 days, pruned on
open. That is enough to answer "which skills actually fire" and "which installed skills
never fired", which is the whole of P11.

**On "without shipping anything that phones home":** the repo already ships PostHog
(`src/lib/analytics.ts`, `posthog-js` in dependencies), initialised only when not
opted out (`analytics.ts:22` — *"an opted-out install must never call posthog.init(),
so no request"*). **This ledger must not go near it.** It is a local file read by local
code and it must be documented as such. The temptation to send an aggregate "which
skills are popular" event back is exactly the kind of thing that gets added in a
one-line PR six months from now; put a comment at the write site saying it must not.

Suppression rules for P11, because an over-eager version of this is worse than none:
- ≥ 14 days of history and ≥ 5 recorded firings before the first suggestion.
- At most one suggestion per 30 days per bot.
- A declined suggestion is never repeated for that bot.
- Always a card, never an action.

---

## 11. What NOT to build

- **A synonym table, a taxonomy, or a keyword map.** The owner already ruled this out
  and §0c/§0e support it: the failure of the current search is not missing synonyms, it
  is a substring match. FTS5 + the model's own world knowledge covers it, and a synonym
  table needs maintaining forever by someone who does not exist.
- **Embeddings or a vector index.** 2,237 items is far below the size where BM25 stops
  working, the model is doing the semantic step anyway, and every local-embedding option
  is either a network call or a 100 MB model shipped for a 2 MB problem. Revisit only if
  §12's re-rank precision test fails badly.
- **A new search dependency.** FTS5 is present and measured (§0b).
- **A separate "assistant catalog" format.** The 58 solo entries are already
  `murage.catalog` v1 and already install through `POST /api/teams/import`. A second
  format is a second thing to keep in sync.
- **A wizard.** One question, one suggestion, one button. A multi-step flow is the thing
  this feature exists to delete.
- **Auto-apply, even behind a setting.** It is one click saved and it costs the entire
  Krug argument and every future "why does my bot have this?" support conversation.
- **Rolling back a partial install.** §8.
- **Streaming the suggestion.** It arrives as a card or it does not arrive.
- **Making `create_bot` install skills.** The agent-facing `create_bot`
  (`agents-proxy.ts:246`) is used by the Chief of Staff to assemble teams. Giving it
  skill installation makes an agent able to enable capability on another bot without a
  human in the loop. Keep assembly behind the human-confirmed card.
- **A committed `skills-index.db`.** §2.

---

## 12. What would make this fail

Ranked. The first two are the real ones.

1. **The re-rank precision is not good enough and the assembled assistants are junk.**
   §0c measured that half a lexical shortlist is noise, on hand-written queries. If the
   model — especially a small local one — cannot reject the noise, then every custom
   assembly ships an Ember carrying `car-buying-guide`, and the feature's *first
   impression* is that the app does not understand you. This is a Sutherland-fatal
   failure: perceived value is set at that moment and does not recover.
   **Mitigation, and it must happen before P4 is written:** a fixed set of ~20 realistic
   intake sentences, run end to end through P3 + a real small model, scored by hand for
   precision@8. If precision@8 is below ~60%, **cut custom assembly and ship
   profile-matching only** (which §0d shows is the easy, safe path and covers the 58
   curated bundles). Profile-only is a complete, honest product. Bad assembly is not.

2. **Profile coverage is narrower than the pitch.** 58 profiles, categories heavily
   weighted to `Sell` (25), `Run` (16), `Write` (16), `Office` (14). A user who types
   something outside that shape falls through to assembly on turn one — the exact path
   with the precision problem. **Mitigation:** measure the fall-through rate on the same
   20 sentences. If more than ~half miss, the answer is more curated profiles, not
   better retrieval.

3. **Provenance is deferred "for now".** Every reversible, explainable, re-syncable
   behaviour reads it. Shipping P5/P6 without P1 produces exactly today's problem in a
   shinier wrapper: a configured bot that cannot say why. **P1 is not optional and it is
   not last.**

4. **The 40% estimate gap repeats.** MASTER-PLAN §4 says the previous five plans were
   collectively 40% under, concentrated in unmapped UI and missing test rigs. P5 (a new
   durable card kind) and P7 (`TeamLibraryPanel.tsx` is 868 lines) are the two items in
   this plan most likely to do it again. I have padded both; if either runs over by more
   than a third, re-plan rather than absorbing it.

5. **`server/index.ts` and `server/store.ts` keep moving.** They are being edited
   concurrently right now; `onboardingCard` alone has already moved 38 lines from where
   the brief placed it. P0/P1/P4 all touch both files. Land P1 early, in one small change,
   before the surface area grows.

6. **The empty-state copy never gets fixed** because it is "just copy". It is the
   highest-traffic screen in the product and it currently teaches users that the product
   does the opposite of what it does. P2 is 5–8 hours. It should be the first thing
   merged.

---

## 13. Unproven — nobody has run it

Marked UNVERIFIED rather than asserted, per house style.

1. **UNVERIFIED: FTS5 in Electron's bundled Node.** I measured `node:sqlite` FTS5 under
   Node v22.23.1 from the shell. `server/message-db.ts` already relies on `node:sqlite`
   in the packaged harness, so the module is present — but I did not confirm that
   Electron's build has FTS5 *compiled in*. **Test this before P3 is scheduled.** It is a
   ten-minute check and the whole retrieval design rests on it. If it is absent, the
   fallback is a hand-rolled inverted index over 1.1 MB of descriptions (add ~10 h).
2. **UNVERIFIED: 473 ms index build off a warm APFS SSD.** Cold cache, Windows, or a
   spinning disk could be seconds. Build it in the background on first launch and treat
   the index as optional until it exists.
3. **UNVERIFIED: 140-character description truncation preserves the discriminating
   signal.** §7's budget assumes it. Sample 20 and read them before committing.
4. **UNVERIFIED: precision@8 of the retrieve-then-rerank loop with a real small local
   model.** This is failure risk #1 and there is no substitute for running it.
5. **UNVERIFIED: whether the 6 OpenMausBot teams can be vendored** under their licence
   with the attribution `scripts/publish-profiles.mjs:161-163` preserves. Check the
   licence before assuming §2's "vendor them".
6. **UNVERIFIED: `library/` and `bot-library/` are not in `extraResources`.** Only
   `skills-library`, `skills`, `dist`, `dist-server`, `dist-companion` and the native
   trees are (`electron-builder.yml:73-90`). P0 must add `library/` and extend
   `HARNESS_RESOURCE_DIRECTORIES` (`electron/harness-resources.mjs:16-24`), or the
   packaged app ships a local catalog it cannot read — **which is precisely the 0.1.44
   `MURAGE_SKILL_LIBRARY` bug, in a new place.** That file's own header exists to stop
   this happening twice. It will happen twice unless P0 extends the test.
7. **UNVERIFIED: how the intake turn interacts with an engine that has no MCP tool
   support.** `chief-of-staff.ts:57` already has a "your current engine cannot contact
   teammates" branch, so there is a precedent for the honest message, but the intake path
   needs its own.

## 14. Tests that must exist before shipping

- `library/catalog.json` is byte-identical to the generator's current output. (The one
  test that stops §2 rotting.)
- `parseTeamCatalog(loadLocalCatalog())` succeeds — the local catalog goes through the
  same gate as the remote one.
- `GET /api/team-library/catalog` returns 200 with the fetcher stubbed to throw. (It
  returns 502 today.)
- `searchSkills` returns only ids that exist in `skills-library/`.
- `propose_assistant` with a fabricated slug returns a tool error, not a card.
- A suggestion card creates nothing until confirmed — assert bot count and skill count
  are unchanged after the card is written.
- Accepting a suggestion writes `provenance` with one entry per installed skill.
- A bot with only `installedPackage` gains a derived `provenance` on load.
- Reset removes exactly the skills whose `origin !== "user"` and nothing else.
- The intake tool set is **not** mounted on an ordinary turn.
- Un-dismissing the intake card restores it. (Route exists; no test does.)
- Partial install: 2 of 11 ids invalid → 9 installed, 9 in provenance, card names the 2.
