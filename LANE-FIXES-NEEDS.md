# LANE-FIXES-NEEDS

Requests from the three-defects lane for files it does not own. Each one is a
change I could not make myself; the wording is ready to paste.

---

## 1. `src/components/SetupChecklist.tsx` (being deleted by another lane)

It still defines its own claim at line 102:

```ts
export const APPS_CLAIM = "hundreds of apps, including Gmail, Slack, Notion and GitHub";
```

**The canonical constant now lives in `src/components/ConnectedAppsLock.tsx`:**

```ts
export const APPS_CLAIM = "500+ apps, including Gmail, Slack, Notion and GitHub";
```

`ConnectedAppsLock.tsx` was chosen because it survives the first-run rewrite,
it is where the catalog is already described, and it imports nothing but
`@/lib/i18n` and `@/lib/cn`, so anything can import from it.

- If SetupChecklist.tsx is deleted: nothing to do, but `src/components/SetupChecklist.test.ts`
  imports `APPS_CLAIM` from it, and `src/e2e/setup-first-run.human.spec.ts:97`
  asserts "hundreds of apps, including Gmail, Slack, Notion and GitHub".
- If it survives: delete its constant and
  `import { APPS_CLAIM } from "./ConnectedAppsLock";` instead. Two copies of
  this sentence is the defect.

## 2. `src/locales/*.json` (7 files) — the last user-visible "Composio", and the old claim

These are the highest-traffic strings left. `connectedApps.lock.ownKey` is a
button on the connected-apps lock, so an eighty-year-old meets a company name
he never bought anything from.

`en.json`, with the same edit needed in `de/es/fr/hi/ja/pt-br/zh`:

| key | now | should be |
|---|---|---|
| `connectedApps.lock.ownKey` (331) | "Have your own Composio key? Add it under Advanced." | "Already have your own key? Add it under Advanced." |
| `connectedApps.flux.ctaByok` (338) | "Use my own Composio key (Advanced)" | "Use my own key (Advanced)" |
| `connectedApps.flux.notInBuild` (340) | "…Add your own Composio key in settings…" | "…Add your own key in settings…" |
| `connectedApps.lock.body` (329) | "Hundreds of apps, …" | "500+ apps, …" |
| `connectedApps.flux.ctaBody` (336) | "Hundreds of apps, …" | "500+ apps, …" |

Two more things about `connectedApps.lock.body` while you are in it: it
contains an em dash, which the copy rules forbid, and it is the only place
that still says "with a free daily allowance included".

Tests that assert these exact strings and must move with them:
`src/components/PluginsPanel.test.ts:390, 394, 404` and
`src/e2e/connected-apps-lock.human.spec.ts:102, 104, 131`.

**Heads-up:** `src/components/naming.test.ts` used to ban `/\d+\+ (?:more|apps)/`
in every `en` value, which would have refused "500+ apps". I narrowed that
assertion to `/\d+\+ (?:more|models)/`, so the locale change will pass. The
ban on stating a MODEL count is still there.

## 3. `shared/key-extract.ts:109` — the paste-key recognizer

```ts
label: "Composio project key",
```

This is what PasteKeys shows when it recognises a pasted key ("Recognized as
…"), so it is user-visible. It should read `"Connected apps key"`, which is
what the field in Tools & Connections is now called. (The brief expected the
offender to be a placeholder in `PasteKeys.tsx`; there is no "Composio" in
that file at this commit, it comes from here.)

## 4. `src/components/SettingsModal.tsx:65` — settings search keyword

```ts
{ id: "connections", label: "Tools & Connections", …, keywords: ["keys", "api", "composio", …] }
```

Typing the word is how someone who read an old forum post finds the row, so I
would keep `"composio"` as a hidden synonym and ADD `"connected apps"` and
`"apps"` beside it. Keywords are never rendered. If the lane owning this file
would rather have the word gone entirely, removing it costs only that search
path. The comment at line 54 names Composio too, which is fine (comments are
not copy).

## 5. `shared/help-index.ts:213, 261, 627` — in-app help

The help drawer still says "Composio project key" three times, including a
credentials table. Row 627 should read "Connected apps key" to match the field
it names, or the person cannot find the row the table points at.

## 6. `server/composio.ts:1034, 1069`

`throw new Error("No Composio project key configured")` reaches the renderer
on a failed connect. Suggested: "No connected apps key is saved." Same for
`docs/composio.md:10`, which names the setting as **Composio project key**.

## 7. `src/components/backups-section-ui.ts:284` — now inaccurate

```ts
["BACKUP_RECOVERY_KEY_UNKNOWN", "Murage doesn't know where your recovery key is in this window. Open Backups again, then save the copy."]
```

"in this window" described the defect I just fixed: the key's location now
survives a restart. That code is only returned when the location is genuinely
unknown, or when the file that was there is gone or is no longer a key.
Suggested: "Murage can't find your recovery key file. It may have been moved
or renamed. Choose your backup folder and key again, then save the copy."

Optional, same file's owner: `saveRecoveryKeyCopy` is offered whenever the
bridge exists. If you want the offer hidden rather than refused when no key is
known, main needs to expose `backupRecoveryKeys.lastKeyFile() !== null` in the
backup status. Say the word and I will add the main-process half.

## 8. Optional follow-up: `electron/backup-schedule-host.mjs`

The schedule already persists the bound key's full path (`b.keyFile`, in the
protected credential document, with a fingerprint it re-checks). That is the
authoritative answer to "where is the key these backups actually use", and it
is better than what I persist. It is not reachable from outside: `publicStatus()`
exposes only `path.basename(b.keyFile)`. If you add a `boundKeyFile()`
accessor, `createRecoveryKeyFlow` can prefer it over its own record and the
copy can never be made from a key the schedule is not using.
