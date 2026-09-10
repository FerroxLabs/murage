# 0.1.50 critical localisation closure — bounded proposal

## Approved eight-key implementation contract

Coordinator authorizes InboxDialog/FilesDialog eight-key wiring, English plus
seven existing packs, focused key tests and isolated real-dialog error-state
fixture only. Faithful agent translations; no human-review claim. Preserve
server error messages, file-retention guarantee, existing navigation and body
copy. One locale owner here, no other components changed. R1 frozen: explicit
Node24 print; Vitest existing i18n + new dialog-localisation key tests; tsc -b and
server types; dedicated Playwright fixture at390/820/1440 using real dialogs,
stubbed child trigger surfaces and synthetic store/API to exercise local errors;
German screenshots/keyboard/overflow checked. Fixture establishes component
localisation, not server or whole-page readiness. All seven translations checked
for exact eight-key completeness and placeholder parity. R2 only eligible
corrections and invalidated checks; stop after two rounds. No Lighthouse or broad
accessibility audit added to this copy-only package. Stop at scoped passing commit,
no push. Original proposal below retained as context.

R1: explicit Node24.20.0 printed; existing i18n + eight-key/all-seven-pack tests
PASS12/12 (2 files,09:58:58). Client types65082 and server types25331 exit0.
Playwright failed before collection because the fixture imported JSON without a
Node24 import attribute; no UI tests ran and no product defect was shown.
Correction1 uses readFileSync/JSON.parse for fixture expectations only. R2
focused browser confirmation process47802 started; no product edits, broader
reruns or user-preview access. Isolated Vite fixture owns its temporary cache.

R2 process47802 exit0: 3/3 Playwright cases PASS4.6s, each exercises eight local
error paths at390/820/1440 with German accessible titles and keyboard Enter/Escape.
All six screenshots in `.planning/dialog-localisation-browser/` inspected: local
errors wrap inside dialogs, retained-file guarantee visible, focus outline visible.
No page errors or horizontal dialog overflow. Fixture deliberately stubs child
body/store/API/native callbacks; this proves actual dialog local-error rendering,
not backend/native behavior or complete Inbox/Files screen design. Temporary cache
and Vite process cleaned by fixture. Existing12tests and both type passes retained;
fixture-only JSON import correction1, rounds2/2 consumed. ACCEPTED scoped eight-key
slice, ready for authorized commit. Translations are agent-authored, not human
reviewed. No whole-app localisation, Lighthouse/axe, all-language visual fit or
server-error translation claim. Source hash metadata unchanged; no generator run.

Contract: inspect only Onboarding, InboxDialog, FilesDialog, BotSettingsDialog,
ClaudeAccountsSettings and TaskPicker, plus the existing catalog conventions
needed to map their action/error strings. Own this record only. No component or
locale edits, translation generation, broad copy audit or tests. Acceptance is a
concrete small candidate and explicit translation dependencies, not language
coverage. Stop at coordinator handoff. Checks/rounds: none started.

## Current convention and evidence

`src/lib/i18n.ts` exports `t(LocaleKey, params)`; keys come from `en.json`, partial
packs fall back to English, and `{name}` interpolation preserves missing tokens.
Registry includes seven non-English packs: de/es/fr/hi/ja/pt-br/zh (pt aliases
pt-br). Preserve all existing translations and source hashes. None of these six
components currently imports `t`; their local action/error text is hardcoded.
Server-provided `Error.message` is also passed through in several catches; moving
local fallback text into catalogs alone cannot localize arbitrary server errors.

## Required action/error gaps in the six-file scope

| Surface | Concrete evidence | Candidate keys needing translated resources |
| --- | --- | --- |
| Onboarding | :75 workspace error/reconnect/Check again; :81 Start empty/Import existing; :87 Continue/Maybe later; :96 Check engines again; :97 Preview my crew; :100 engine readiness failure | `onboarding.workspaceError`, `onboarding.reconnect`, `onboarding.startEmpty`, `onboarding.importExisting`, `onboarding.continue`, `onboarding.later`, `onboarding.checkEngines`, `onboarding.previewCrew`, `onboarding.engineNeedsCheck` |
| InboxDialog | :22/:27 source-open error; :30 unavailable conversation; :33 retry fallback; :36 Inbox accessible label | `source.openError`, `inbox.conversationUnavailable`, `inbox.openResultError`, `inbox.title` |
| FilesDialog | :14 source unavailable with retained-file guarantee; :18/:22 source-open error; :26 fallback; :31 Files label; :35 working-folder error; :36 native-action error | `files.sourceUnavailableRetained`, shared `source.openError`, `files.title`, `files.workingFolderError`, `files.nativeActionError` |
| BotSettingsDialog | :22 pending-operation notice; :23 discard confirmation; :42–54 dialog/search/section/clear labels; :62 unsaved notice | `botSettings.waitForSave`, `botSettings.discardConfirm`, `botSettings.title`, `botSettings.close`, `botSettings.search`, `botSettings.sections`, `botSettings.section`, `botSettings.noMatches`, `botSettings.clearSearch`, `botSettings.unsaved` with `{fields}` |
| ClaudeAccountsSettings | :35 add/remove/save notices; :47 copied notice; :52–53 refresh/add; :61 auth status; :68 account-specific copy; :70 remove confirmation; :75 create/save/cancel | `claudeAccounts.added`, `claudeAccounts.removedRetained`, `claudeAccounts.saved`, `claudeAccounts.copied` with `{name}`, `claudeAccounts.refresh`, `claudeAccounts.add`, `claudeAccounts.auth.*`, `claudeAccounts.copySignIn` with `{name}`, `claudeAccounts.removeConfirm`/`confirmRemoval` with `{name}`, `claudeAccounts.cancelRemoval`, `claudeAccounts.create`, `claudeAccounts.save`, `common.cancel` |
| TaskPicker | :180 download-start notice; :182 export error; :213 All threads; :262–268 search/count; :286 rename; :350 delete; :366 export action; :369 export boundary; :382 New task | `tasks.downloadStarted` with `{filename}`, `tasks.exportError`, `tasks.allThreads`, `tasks.search`, `tasks.matching` with `{count}`, `tasks.rename`, `tasks.delete`, `tasks.exporting`, `tasks.exportMarkdown`, `tasks.exportBoundary`, `tasks.new` |

This is a critical-action map, not an exhaustive prose inventory. Imported
onboarding choice copy and bot-settings section labels/search terms are outside
the six-file ownership. Full surface coverage would require explicitly assigning
those dependencies, plus Inbox/Files body components; this proposal does not
claim those are localized.

## Smallest next candidate

Recommended useful slice: local InboxDialog/FilesDialog navigation failures and
accessible titles. Patch only these two components, English catalog, and the
seven existing locale packs through ONE assigned locale owner. Add eight keys:
`source.openError`, `inbox.conversationUnavailable`, `inbox.openResultError`,
`inbox.title`, `files.sourceUnavailableRetained`, `files.title`,
`files.workingFolderError`, `files.nativeActionError`. Reuse `source.openError`
for Files' generic open fallback (same outcome; preserve the distinct retained
file guarantee). Supply reviewed translations before claiming non-English
coverage. Cataloging English alone provides fallback, not completed translation.

Zero-resource exact reuse is limited: Onboarding :75 can use existing
`common.checkAgain`, verified present in all seven packs. Existing
`common.copy`/`setup.copyCommand` cannot replace account-specific copy text without
losing the account identity; do not silently shorten it. Feature-specific
`searchSettings.saving` is not a suitable shared semantic key for account saving.
One reused button is possible but does not close any complete critical journey.

Proposed checks AFTER the coordinator freezes implementation acceptance:
explicit Node24 `node_modules/vitest/vitest.mjs run src/lib/i18n.test.ts`, explicit
Node24 `node_modules/typescript/bin/tsc -b`, and catalog placeholder/key checks for
the eight keys across the seven packs. Existing i18n tests cover fallback and
known/nonempty keys, but do not prove complete translations or component wiring;
add only targeted assertions for these keys if that slice is assigned. A focused
isolated visual/error-state check must be specified by the UI owner before a
visual completion claim. Do not rerun old capped onboarding/accounts/export UI
packages merely for this proposal. No checks run and no candidate implemented.
