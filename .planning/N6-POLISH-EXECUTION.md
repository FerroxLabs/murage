# N6 bounded code blocks and shortcut reference

Baseline8d59533e, branchwork/0149-polish. Own ChatMarkdown/code-block helper/tests and new KeyboardShortcutsDialog/helper/tests only; root owns Tools/App/store exposure. Files/Startup work excluded. Fuigo synthetic-auth fixture remains awaiting approval; no probe in this package. Accounting accepted separatelyd84fcc01 and integrated by root85a8a22b.

Upstream948 head583645928f6ff57110db38d1bd44e5a6d6136a36 and946 headffde6cb894e336795445254a497e28585c8dcda8 read with Apache2.0 licenses. Adapt only missing code header/name/count/wrap/async-copy controls and searchable shortcut reference. Preserve currentShiki/cache/Markdown safety and unrelated links/artifacts. Existing app design tokens retained under previously read ijfw-design; no new design system/dependency.

Frozen acceptance: codecopy receives exactCodeBlock string includingCRLF/blanklines; success only afterclipboardconfirmation, failuretruthful; wrapping doesnotchangebytes; language/count accurate; light/darkhighlight and narrowlayout visuallyverified. Shortcut reference onlydocuments actualexistinghandlers with context/platformkeys, no ?/Cmd+/globalhotkeys added. Native dialog keyboard/focus/Escape/backdrop/search/empty state; rootToolsentry integration mustbe recorded. Handler evidence: App.tsx76-95 N/1-9; CommandPalette.tsx30 ModK; ChatView1097/GroupView938 ModF; Composer key handlerEnter/ShiftEnter/ArrowUp andmenuEnter/Tab; SidebarSectionHeader Alt arrows; GroupView1182 bulletinModEnter. Bracket-navigation binding omitted fromcommonreference pending real-platform key semantics; not reimplemented.

Checks max2rounds,0used beforeedits: focusedhelper/SSR tests, typecheck, isolated actualCodeBlock/ChatMarkdown/shortcut-dialog browser checks with syntheticclipboard (exactbytes, rejection, wrap), light/dark/mobile snapshots, keyboardfocus/search/close. R2 onlyeligiblecorrections androotintegration; no broadtest suite/newhotkey handlers. No liveprofiles/providercalls. Commitacceptedownedsource, no push.

## Account-switch handoff — 2026-09-09

Implementation remains uncommitted on work/0149-polish at baseline8d59533e. R1 completed: focused Vitest6/6 PASS (session73553 terminal); typecheck PASS (session12649 terminal exit0); Playwright4/6 PASS,2FAIL (session45441 terminal exit1). No check process remains active. R2 remains unused; no correction applied yet. Browser receipts/traces/screenshots retained in .planning/N6-polish-browser/. No accepted/integrated/released claim.

Both shortcut cases fail at spec line56, exact-text locator for `Search and switch conversations`. Complete error-context snapshots show the requested row is present after `command`/`ctrl k` search, but its dt also contains `Command palette`; this is an unsuitable exact-text locator, not evidence that filtering failed. Small supported next correction: assert the semantic term including its context (or a scoped row), retaining the same search/visibility requirement. Remaining focus-trap/Escape-return assertions were not reached. R2 should confirm those two cases and root Tools entry integration; reuse unaffected four browser and six unit passes. Visual PNGs are captured but still need inspection. Do not restart R1 or consume extra rounds by renaming the package.

Owned source SHA256 at handoff:
- ChatMarkdown.tsx: 3aa9cbeb751a97f47c87c55e278a4687f7e0c0e9d4f4f6bf4f332acf662ec5be
- KeyboardShortcutsDialog.tsx: 1c285b81c0a2b33648e6c4a3645b46559246a7b4101e5b9f653939665e58a4f9
- code-block.ts: a9d903c7e88a7ac24092c16efea6ff0c35ad6699f98b911c266c6192cb20cc4b
- keyboard-shortcuts.ts: 451990f17a01c65bee9bae2417fcc8ceaaa998bff9c8ecb9142ed0d98560dad0

Root seam: KeyboardShortcutsDialog accepts open, onClose, optional returnFocusRef:{current:HTMLElement|null}; root owns Tools button/state/mount. No new global listener. Preserve all listed untracked helper/tests/config/spec files and receipts. Fuigo native candidate remains separately blocked pending synthetic local-provider approval; Windows signed native gate remains pending the final combined artifact, with its expired VM stopped.

Root authorized continuation: corrected the two shared shortcut fixture locators to the actual semantic term including Command palette context and added exact platform key assertions (Command/Ctrl + K). R2 not run; awaiting root Tools integration head. Candidate commit explicitly requested for integration, not accepted status. No new audit/critique under the frozen bounded check set. R2 is limited to affected shortcut cases and integrated Tools open/focus/Escape in light/dark; reuse R1 unaffected passes. Fuigo approval still pending; no probe.
