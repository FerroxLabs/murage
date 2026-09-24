# Skills, templates and scanning: overhaul design

Date: 2026-09-23. Status: design, awaiting owner review. Target: after 0.1.59.

## Why

Skills are a core feature and today they are hard to find, impossible to read
before adding, hard to import, and barely checked:

- Skills are reached through the Library window (Bots, Teams, Skills tabs),
  which people meet as a template screen. The Skills tab is 2,237 skills
  behind topic pills; a row shows a name and one sentence.
- A library skill cannot be read before it is added.
- "Add a skill" in the bot window opens the library *behind* the bot window
  (the bot window is a `showModal()` dialog in the browser's top layer; the
  library is a portal at `z-50`), so the owner has to close the bot window.
- A single skill cannot be imported from a file, folder or zip. The GitHub
  import route exists but nothing in the app calls it.
- Scanning is three warn-only checks (`scanSkillText`). Library skills are
  switched on without review; package skills are not scanned at all.
- The menu has "New Bot" and "New Bot from Template" side by side, and "New
  Team" only groups existing bots.

## The one rule

**Don't make me think.** Every screen here is judged by whether an owner who
has never read a manual understands it at a glance: plain words, one obvious
next step, no jargon (no "manifest", "SKILL.md", "frontmatter", "quarantine"
in the interface), no em dashes, never the word "safe".

## What success looks like

1. Any skill's contents are readable within two clicks of opening Settings.
2. A skill is added to a bot without leaving or closing the bot's window.
3. Importing a skill from a file, folder or link takes at most three steps and
   always ends with a scan verdict in plain words.
4. No skill with a critical finding can be switched on for any bot, by any
   path (library, import, package, team, or a bot writing its own skill).
5. Making a bot or team from a template starts from one menu item each and
   finds a fitting template by describing the job in a sentence.

Out of scope: how skills reach a running turn (procedure pins, the
`.claude/.agents/.grok` skill links, the prompt index). That pipeline stays
as it is; this design only changes how skills are found, checked, imported
and attached.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| D1 | Imported skills land in the owner's own **Your skills** collection in Settings, are scanned once there, and are switched on per bot. |
| D2 | Three verdicts: clean (owner review 2026-09-24: shown as a small shield labelled "Checked, nothing risky found", or "Built-in" for library skills; the word "No red flags" felt noisy), **Needs a look** (switch on only after seeing the findings and confirming once), **Blocked** (cannot be switched on; read or delete only). |
| D3 | The built-in library is scanned before it ships. Library skills that come out Blocked are removed from the library. |
| D4 | The scanner starts from Ferrox Labs' Skill Guard (the Wayland desktop app's TypeScript scanner, brought in under Murage's AGPL-3.0-or-later license) plus Murage's own invisible-character check, plus the static pattern tables of NVIDIA SkillSpector (Apache-2.0, credited). SkillSpector's code-flow and YARA analysis come later as a deep scan (see Later phases). |
| D5 | One **New Bot** and one **New Team** menu item, each opening a describe-first chooser. "New Bot from Template" and the Library window's Bots and Teams tabs go away. |
| D6 | **Settings → Skills** is one screen: search, Your skills, then the library; click a skill to read it, see its scan result and switch it on per bot; an Import skill button. The topic pills go away. |
| D7 | In the bot window, **Add skill** opens the same search and reader *inside* the bot window, with one Add button. Needs a look shows its findings with one confirm step; Blocked has no Add button. |

## Screens

### New Bot / New Team chooser

```
┌ New Bot ───────────────────────────────────────────────┐
│ What should it do?                                     │
│ [ chase unpaid invoices and follow up with clients  ]  │
│                                                        │
│  Best matches                                          │
│  ● Collections Assistant   Chases overdue invoices ›   │
│    Accounts Clerk          Books, reconciles, reminds ›│
│    Inbox Triage            Sorts and drafts replies  › │
│                                                        │
│  or browse:  Sell 25 · Write 17 · Run 16 · Office 14 · │
│              Research 9 · Build 9 · more…              │
│                          Start blank →   Open a file → │
└────────────────────────────────────────────────────────┘
```

- The input has focus when the chooser opens. Typing shows the three best
  matches, using the existing `/api/library/suggest` intake and catalogue
  search. An empty box shows the category line only, never all templates.
- A category opens a plain list of that category.
- Clicking a template shows a preview in the same box: what it does, the
  skills it comes with, the apps it needs connected ("Needs Gmail"), and one
  **Create** button. Back returns to the list with the query kept.
- A template the owner already has shows **You have this**; Create still
  works and says it will make a second copy.
- **Start blank** makes a blank bot as "New Bot" does today. **Open a file**
  opens the existing `.murage` package import (today's Library Import tab).
- New Team is the same box with team templates; Start blank becomes
  **Pick from my bots** (today's New Team dialog).

### Settings → Skills

```
┌ Skills ───────────────────────────────── [ Import skill ] ┐
│ 🔍 Search skills                                          │
│ YOUR SKILLS                                               │
│  Invoice Chaser   ✓ No red flags   Used by Sable      ›   │
│  Web Scraper      ⚠ Needs a look   Not used yet       ›   │
│ LIBRARY   Sell · Write · Research · more…                 │
│  Meeting Notes    Turns calls into action items       ›   │
└───────────────────────────────────────────────────────────┘
```

- Your skills lists imported skills and any library skill switched on for at
  least one bot, with its verdict and which bots use it.
- The library shows search results, or a category's list; never all 2,237.
- Clicking any skill opens the **reader** (below) in the same screen.

### The reader (shared)

- The skill's instructions as a normal page (rendered markdown), with the
  list of other files it carries.
- The scan result in plain words: "No red flags found", or each finding as a
  sentence ("Sends data to an outside website", "Tells the bot to ignore its
  instructions") with the matching line shown on request.
- In Settings: **Use with** and a switch per bot. In the bot window: one
  **Add** button.
- Needs a look: switching on (or Add) first shows the findings and a single
  "Use it anyway" confirm. Blocked: no switch and no Add button; a line says
  why, and imported skills offer Delete.
- Imported skills offer **Delete**. If bots use it, Delete says so and
  removes it from them too, after one confirm.

### Import skill

1. **Import skill** opens a small box: drop a file, folder or zip, or paste a
   link (GitHub folder or file).
2. "Checking…" while it is read and scanned.
3. The verdict in plain words, then the skill appears in Your skills,
   switched on for no bot. Blocked imports are kept (readable, deletable) so
   the owner can see what was caught.

### In the bot window

- The Skills section lists this bot's skills with their switches, as today.
- **Add skill** swaps the section for the picker (search, list, reader)
  rendered inside the bot window's own dialog, not a portal, so it is never
  behind it. Add returns to the list with the new skill on.
- The sidebar bot menu's "Add a skill" opens the bot window at this picker.

## Architecture

### Scanner: `server/skill-guard/`

- `spector-patterns.generated.ts`: the static pattern tables of NVIDIA
  SkillSpector (Apache-2.0), converted at a pinned commit by a script and
  credited in NOTICE. Each pattern keeps its confidence score; a critical
  finding blocks only at high confidence.
- `rules.ts`: Skill Guard's seven rules (credential access, network
  exfiltration, shell execution, filesystem writes, instruction override,
  obfuscation, index poisoning) plus Murage's invisible and bidirectional
  Unicode check. Rules read the instructions, the description and trigger
  terms, and every text file the skill carries.
- `scan.ts`: `scanSkill(files) → { verdict, findings[], contentHash,
  scannerVersion, scannedAt }`. Any critical finding is Blocked; any other
  finding is Needs a look; none is No red flags. Findings carry a severity,
  a plain-words message and at most 120 characters of evidence.
- Pure functions, no network, no model. (Skill Guard's optional model pass
  is left out of this work; it can come later as an opt-in second look.)
- The verdict is bound to `contentHash`; any change to the files means a
  fresh scan.

### Your skills collection

- Files in `DATA_DIR/skill-collection/<name>/`, one record per skill in
  `DATA_DIR/skill-collection/collection.json`: name, description, source
  (`file`, `folder`, `zip`, `link`), sha256, importedAt, and the scan.
- Import reuses today's validation: the name rule, frontmatter parse, size
  caps (30 files, 256 KB each), no symlinks, no path traversal.
- Switching a skill on for a bot copies it through the existing
  `installSkill` path, so the per-bot integrity hash, revisions and task
  pinning keep working unchanged. The bot's record gains
  `origin: "collection"`.
- A bot keeps the version it was given. Re-importing a newer version
  updates the collection; bots move to it when switched off and on again
  (a "newer version" prompt is later work).

### The library

- A build step (`scripts/scan-skill-library.mjs`) scans all library skills
  and writes `skills-library/scan-verdicts.json`. A test fails if any
  shipped library skill is Blocked, or if a verdict is missing or stale
  against its content hash.
- Needs a look library skills stay, and get the confirm step like any other.

### Every install path goes through the gate

One server function, `admitSkill(files, acknowledged?)`, runs the scan and
refuses Blocked, or Needs a look without an acknowledgement matching the
current `contentHash`. It is called by: switching on from Settings, Add in
the bot window, the library add route, the GitHub route, `.murage` package
import, team import, and a bot's own staged skill (`skill_manage`).

Existing installed skills are scanned once on upgrade. A Blocked one is
switched off and the bot says so in its own chat, naming the skill and why
(inbox rows only come from request, connection, run and error messages).

### Routes (desktop only, like today's skill routes)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/skills?q=&category=` | Your skills and library results, with verdicts and which bots use each |
| GET | `/api/skills/:ref` | One skill: text, files, scan, bots (`ref` = `collection:<name>` or `library:<id>`) |
| POST | `/api/skills/import` | A link, or uploaded files (the app sends dropped files as a bounded list) |
| PUT | `/api/skills/:ref/bots/:botId` | `{ on, acknowledged? }` switch on or off for one bot |
| DELETE | `/api/skills/collection/:name` | Delete an imported skill (and remove it from bots after confirm) |

The existing per-bot routes stay for the bot window's list and history.

### Components

- `NewFromTemplateDialog.tsx` (mode `bot` or `team`), replacing the Library
  window's Bots and Teams tabs and the "New Bot from Template" menu item.
- `SkillsSettings.tsx`: the Settings section (`AppSettingsSection` gains
  `skills`).
- `SkillPicker.tsx` (search, list) and `SkillReader.tsx` (reader, scan,
  switches or Add), used by both Settings and the bot window.
- `SkillImportDialog.tsx`.
- `TeamLibraryPanel.tsx` is retired once nothing opens it.

## Errors, in the owner's words

- A link that is not a skill: "That link doesn't point to a skill. A skill is
  a folder with a SKILL.md file in it."
- Too big: "This skill is too big to import (over 30 files or 256 KB per
  file)."
- A link that can't be reached: "Couldn't reach that link. Check it and try
  again."
- A name already in Your skills: "You already have a skill called Invoice
  Chaser. Replace it?"
- A bot the skill can't reach (API-only engines have no workspace): the
  switch is disabled with "This bot's engine can't use skills."

## Testing

- Scanner: Skill Guard's existing rule tests, ported, plus the invisible
  character cases and one fixture per rule for each verdict.
- Gate: each install path refuses Blocked and unacknowledged Needs a look,
  and accepts after acknowledgement; a changed file invalidates it.
- Library: the verdicts file is complete, current, and has no Blocked entry.
- Routes: import from link (stubbed), zip and folder; switch on and off;
  delete with and without users.
- Browser specs, one per success criterion: read a skill in two clicks from
  Settings; add a skill from the bot window without closing it; import in
  three steps with a verdict shown; a Blocked skill has no switch; New Bot
  finds a template from a sentence and creates it; New Team does the same.
- Copy check: no em dashes and no "safe" in any new string.

## Build order

1. Scanner and the install gate (no UI change; protects every path first).
2. Settings → Skills with the reader and import.
3. Add skill inside the bot window.
4. New Bot / New Team chooser, then retire the Library window.

Each step ships working on its own.

## Later phases (agreed, separate plans)

1. **MCP guard.** Scan every connected MCP server's tool names and
   descriptions with the same pattern engine (tool poisoning), and pin a
   fingerprint of its tool list when the owner approves it; a changed list
   on a later connect is held until the owner looks again (rug pull).
2. **Second opinion.** An opt-in "Get a second opinion" on Needs a look,
   run on the owner's Flux key or the bot's own engine; never required, and
   the static verdict stands when it fails.
3. **Code in skills.** When skills may carry scripts: YARA signatures
   (malware, webshells, miners) through a WebAssembly build, and code-flow
   (taint) analysis through a pinned SkillSpector deep scan.
