# Settings → Skills, the reader, and import: implementation plan (2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Skills screen in Settings where the owner searches every skill, reads any of them with its scan result, switches it on per bot, and imports a skill from a file, folder, zip or link into their own collection.

**Architecture:** A small server store, `server/skill-collection.ts`, keeps imported skills under `DATA_DIR/skill-collection/` with Skill Guard's scan. One route module, `server/skills-api.ts`, answers `/api/skills*` for both collection and library skills, and switches skills on for bots through Plan 1's gate (`installSkill` + `setSkillEnabled`). The renderer gets `SkillsSettings` (the screen), `SkillReader` (shared with plan 3), `SkillImportDialog`, and a client in `src/lib/skills-api.ts`.

**Tech Stack:** TypeScript, React, Tailwind classes as in `SettingsPrimitives.tsx`, `ChatMarkdown` for rendering, yauzl for zips, vitest, Playwright human specs.

**Spec:** `docs/superpowers/specs/2026-09-23-skills-overhaul-design.md` (screens "Settings → Skills", "The reader", "Import skill"; D1, D2, D6).

## Global Constraints

- The Plan 1 constraints (license headers, copy rules, two typechecks, baseline suite, no live data dir).
- Routes are desktop-only, like every skill route (`requestSurface(...) !== "desktop"` answers 404).
- Imports are bounded: at most 30 files, 256 KB per file, 2 MB in total; zips at most 64 entries and a compression ratio of 100; paths are relative, with no `..`, no absolute paths, no drive letters.
- An imported skill lands switched on for no bot. Blocked imports are kept so the owner can read and delete them.
- Plain-words copy: "Your skills", "Library", "Import skill", "Use with", "No red flags found", "Needs a look", "Blocked", "Checking…", "Use it anyway", "Delete".

## Review Focus

1. **The same skill name in the library and in Your skills.** Expected: both show, each labelled by where it came from; switching one on for a bot that already has the other says so plainly instead of failing silently. Test in Task 3.
2. **A zip whose SKILL.md sits in a subfolder** (`my-skill/SKILL.md`), as GitHub's "Download ZIP" makes. Expected: found and imported with paths relative to that folder. Test in Task 2.
3. **Deleting a skill that bots use.** Expected: Delete names the bots first; after one confirm the skill is removed from them too. Test in Task 3.
4. **Search with no results, and a library index that is still building.** Expected: "No skills match" and "The library is still loading" respectively, never an empty blank screen. Test in Task 6.
5. **A very long skill** (200 KB of markdown). Expected: the reader stays responsive. Test in Task 5.

---

### Task 1: The collection store

**Files:**
- Create: `server/skill-collection.ts`
- Test: `server/skill-collection.test.ts`

**Interfaces:**
- Produces:
  - `interface CollectionSkill { name: string; description: string; source: { kind: "file" | "folder" | "zip" | "link"; label: string }; importedAt: string; files: string[]; scan: SkillScan }`
  - `listCollection(): CollectionSkill[]`
  - `getCollectionSkill(name: string): (CollectionSkill & { text: string; contents: Array<{ path: string; content: string }> }) | null`
  - `importCollectionSkill(files: Array<{ path: string; content: string }>, source: CollectionSkill["source"], options?: { replace?: boolean }): CollectionSkill | { error: string; code: "invalid" | "too-big" | "exists" }`
  - `deleteCollectionSkill(name: string): boolean`
  - `normalizeSkillFiles(files): { files: Array<{ path: string; content: string }> } | { error: string; code: "invalid" | "too-big" }` (finds the shallowest SKILL.md, re-roots paths at its folder, enforces the bounds)

Storage: `DATA_DIR/skill-collection/<name>/` holding the files, and `DATA_DIR/skill-collection/collection.json` holding the records (written atomically: temp file then rename, mode 0600; directories 0700). An import writes into `DATA_DIR/skill-collection/.incoming-<uuid>/` and renames into place, so a half-written skill is never listed.

Tests (vitest, `DATA_DIR` is the per-run test directory): import a clean skill and read it back with its text and scan; a second import with the same name answers `code: "exists"` and replaces with `replace: true`; a Blocked skill imports and lists with `verdict: "blocked"`; path traversal (`../x`, `/etc/x`, `C:\\x`) is refused as `invalid`; 31 files or a 300 KB file is `too-big`; a folder whose SKILL.md is at `pack/my-skill/SKILL.md` is re-rooted; non-text files are skipped and named; delete removes files and record.

- [ ] Write the failing tests, run (FAIL), implement, run (PASS), commit `Skills: a collection store for imported skills`.

### Task 2: Import sources (link and zip)

**Files:**
- Create: `server/skill-import-sources.ts`
- Test: `server/skill-import-sources.test.ts`

**Interfaces:**
- Produces:
  - `readSkillZip(bytes: Buffer): Promise<Array<{ path: string; content: string }> | { error: string; code: "invalid" | "too-big" }>` (yauzl `fromBuffer`, bounds from Global Constraints, stored or deflate only, no encrypted or special entries, UTF-8 text entries only; binary entries are skipped by name)
  - `fetchSkillFromLink(link: string, fetcher?: typeof fetch): Promise<Array<{ path: string; content: string }> | { error: string; code: "invalid" | "unreachable" }>` wrapping `fetchSkillFromSource` from `server/skill-fetch.ts` (first skill found; a repo with several answers the first and says how many more there were in `error` only when none can be picked)

Tests: a zip built in the test with `yazl` (already a dependency) containing `my-skill/SKILL.md` and `my-skill/notes.md` reads back both, re-rooted by Task 1's normaliser; an encrypted flag, a symlink entry, a 200:1 bomb and 65 entries are refused; a link with a stub fetcher returns files; a non-GitHub link is `invalid`; a fetch failure is `unreachable`.

- [ ] Write the failing tests, run, implement, run, commit `Skills: import from a zip or a link`.

### Task 3: The `/api/skills` routes

**Files:**
- Create: `server/skills-api.ts`
- Modify: `server/index.ts` (one delegation line before the per-bot skill routes)
- Test: `server/skills-api.test.ts` (real harness, like `server/skill-guard-api.test.ts`)

**Interfaces:**
- Consumes: Task 1, Task 2, Plan 1 (`installSkill`, `setSkillEnabled`, `removeSkill`, `listSkills`, `currentSkillScan`), `searchSkills`, `skillsByFacet`, `browseFacets`, `checkLibrarySkill`, `SKILL_LIBRARY_ROOT`, `skills-library/scan-verdicts.json`.
- Produces (all desktop-only):
  - `GET /api/skills?q=&category=` → `{ yours: SkillSummary[]; library: SkillSummary[]; categories: Array<{ name: string; count: number }>; libraryReady: boolean }` where `SkillSummary = { ref: string; name: string; description: string; kind: "collection" | "library"; verdict: SkillVerdict; usedBy: Array<{ botId: string; botName: string; enabled: boolean }> }`. `yours` lists every collection skill plus every library skill installed on at least one bot; `library` is search results (or the category's list), at most 50; with no query and no category, `library` is empty and `categories` carries the top 12 browse facets.
  - `GET /api/skills/:ref` → `SkillSummary & { text: string; files: string[]; scan: SkillScan }`. `ref` is `collection:<name>` or `library:<id>`.
  - `POST /api/skills/import` body `{ link: string } | { files: Array<{ path: string; content: string }>; kind: "file" | "folder" } | { zip: string /* base64 */ }`, optional `replace: true` → `201 { skill: SkillSummary & { scan } }`; `409 { code: "exists" }`; `400 { code: "invalid" | "too-big", error }`; `502 { code: "unreachable", error }`.
  - `PUT /api/skills/:ref/bots/:botId` body `{ on: boolean; acknowledged?: string }` → `200 { skill: SkillListing }`, `409 { code: "blocked" | "needs-review" | "name-taken", error, scan? }`. Switching on installs the skill onto the bot if it is not there (`installSkill(botId, "collection:<name>", files)` or `installSkillFromLibrary`) and then calls `setSkillEnabled(botId, name, true, { acknowledged })`. A bot that already has a different skill with that name answers `name-taken`: "This bot already has a different skill called X."
  - `DELETE /api/skills/collection/:name` → `200 { removedFrom: string[] }`; when bots use it and the body lacks `{ fromBots: true }`, `409 { code: "in-use", bots: string[] }`.

Tests: import a zip, list it under `yours`, read it, switch it on for a bot, see `usedBy`; a Needs a look import needs the acknowledgement; delete while in use answers `in-use`, then succeeds with `fromBots: true` and the bot no longer lists it; search `invoice` returns library hits; a phone surface gets 404.

- [ ] Write the failing tests, run, implement, run, commit `Skills: one set of routes for your skills and the library`.

### Task 4: The client and verdict pieces

**Files:**
- Create: `src/lib/skills-api.ts`, `src/components/skills/VerdictBadge.tsx`
- Test: `src/lib/skills-api.test.ts`

**Interfaces:**
- Produces: `listSkills(q?, category?)`, `readSkill(ref)`, `importSkill(input)`, `setSkillForBot(ref, botId, on, acknowledged?)`, `deleteCollectionSkill(name, fromBots?)` (all via `api()`), `verdictLabel(verdict): "No red flags" | "Needs a look" | "Blocked"`, `findingLines(scan): string[]` (unique messages), and `<VerdictBadge verdict=… />` (check, warning and stop icons from lucide; colours from the existing `text-success`, `text-warning`, `text-danger` tokens).

Tests: `verdictLabel` for each verdict; `findingLines` dedupes and keeps order; each client call hits the right method and path (fetch stub).

- [ ] Write the failing tests, run, implement, run, commit `Skills: client and verdict labels`.

### Task 5: The reader

**Files:**
- Create: `src/components/skills/SkillReader.tsx`
- Test: `src/components/skills/SkillReader.test.ts` (static markup, like `BotSkillsPanel.test.ts`)

**Interfaces:**
- Props: `{ skill: SkillDetail; bots: Array<{ id: string; name: string }>; mode: { kind: "settings" } | { kind: "bot"; botId: string }; onChanged(): void; onBack(): void }`.
- Renders: back link; name, verdict badge and source ("Library" or "Imported from a zip" etc.); findings as sentences (evidence behind a "Show the line" disclosure); the instructions via `ChatMarkdown`; other files as a list; in settings mode a "Use with" list of bots with a `Switch` each (disabled with "This bot's engine can't use skills" for bots whose engine has no workspace, using the same check the bot window uses); in bot mode one "Add" button. Needs a look shows an inline confirm panel (findings + "Use it anyway" + "Cancel") before the switch or Add goes through, sending the acknowledgement. Blocked shows "This skill was blocked by the safety check and can't be switched on." and no switch or Add. Imported skills have Delete, with the in-use confirm.
- Long text: `ChatMarkdown` renders at most the first 60,000 characters with a "Show all" button.

Tests: markup per verdict (switches present, confirm copy, Blocked has no switch); bot mode shows Add; findings deduped; a 200 KB skill renders under 200 ms and shows "Show all".

- [ ] Write the failing tests, run, implement, run, commit `Skills: the reader`.

### Task 6: The Settings screen and import dialog

**Files:**
- Create: `src/components/skills/SkillsSettings.tsx`, `src/components/skills/SkillImportDialog.tsx`
- Modify: `src/components/SettingsModal.tsx` (a `skills` section, icon `BookOpen`, desktop-only, keywords `skills, import, scan, library, instructions`), `src/state/store.tsx` (`AppSettingsSection` gains `"skills"`), `src/locales/en.json`
- Test: `src/e2e/skills-settings.human.spec.ts` + `src/e2e/skills-settings.config.ts` (fixture server like `search-settings`)

**Behaviour:**
- One screen: search box (focused), "Your skills" list, then "Library" with a line of up to 12 category links; results replace the line when searching. Each row: name, verdict badge, "Used by Sable, Ember" or "Not used yet", chevron. Clicking opens the reader in place; Back returns with the search kept.
- Empty states: "No skills match “x”." and "The library is still loading." (from `libraryReady: false`).
- "Import skill" opens a small dialog: a drop zone ("Drop a skill's file, folder or zip here") with a "Choose…" button, and "or paste a link". Folders are read with `webkitGetAsEntry`; a single `.md` file becomes `SKILL.md`; a `.zip` is sent as base64. States: "Checking…", then the verdict and "Open it" / "Done". `exists` asks "You already have a skill called X. Replace it?".

Spec (browser): open Settings → Skills; search; open a library skill and read it (two clicks); import a fixture zip and see its verdict; switch it on for a bot; a Needs a look import shows the confirm; a Blocked import has no switch; empty search message.

- [ ] Write the spec, run (FAIL), implement, run (PASS), commit `Skills: a Skills screen in Settings, with import`.

### Task 7: Verify

- [ ] Two typechecks clean; `npx vitest run skill` all pass; the full suite matches the baseline; the new browser spec passes; copy check (no em dashes, no "safe") on new strings. Commit fixes; report.
