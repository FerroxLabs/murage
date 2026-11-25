# Murage 1.0.8: graduate Experimental

Sean authorized implementation on 2026-10-26 in this worktree only. Outcome: built-in browser and Teach a skill default on when their saved switches are absent, retain explicit off, and live in Devices / browser settings and Skills instead of Experimental. Preserve the per-bot browser gate, browser floor, desktop-only recorder, cloud computer-only controls, and every other feature flag. Update affected help and release copy. No live data, network, commits, pushes, ref changes, test execution, Node tooling, type checks or builds on this machine. Claude owns review, isolated Hetzner checks, build and commit.

Acceptance is frozen: (1) missing config and untouched existing config enable both features, (2) explicit false persists and remains off if representable, (3) per-bot false still withholds browser access, (4) Cloud hides recorder controls and entry points, (5) existing browser-floor coverage exercises a default-on browser turn, (6) regular Settings controls and search/deep links replace the empty Experimental section, (7) affected help describes the current homes. Runtime and visual acceptance remain pending the Claude gate.

Planned checks on the build box: server config/persistence tests; renderer feature-flag and recorder/store coverage; browser per-bot and browser-floor suites including the isolated turn fixture; Settings navigation, search, cloud and control-interaction tests; help/copy consistency; repository type checks and build. Visually inspect Devices, Skills and Cloud with isolated data. Local work is limited to source inspection and diff review, with no execution of these checks.

## Current state

- Implementation: source changes and regression tests written. No pre-existing lane record was present; this is the single execution record. Base commit: `a9182c38a26cd30ef762e5e130a4691553a476d8`. Changes remain uncommitted in this worktree.
- Persistence evidence: optional booleans in `server/config.ts`, stored parsing without boolean defaults, and sparse merging in `saveConfig` preserve absence versus explicit false. The current Settings handler PATCHes only the chosen switch. No migration is needed.
- Verification rounds: 0/8. Unsuccessful corrections: 0/8. Tests/builds have not run.
- Local review: read affected callers, persistence paths, cloud classification and fixture protocol; reviewed the source diff and React hook dependencies. `rtk proxy git diff --check` passed. This is source review only, with no compile, runtime or visual claim.
- Next action / owner: Claude reviews the candidate, runs the listed checks and build on Hetzner, performs the isolated visual check, and owns any commit. No runtime processes or temporary fixtures were launched here.
- Stop condition: completed source and tests handed to Claude with exact pending checks; do not claim build, runtime or visual passes from this machine.

## Result and boundaries

- `features.browser` and `features.skillRecorder` now resolve absent to on, explicit false to off, in server and renderer. The schemas and sparse config merge continue to preserve the distinction. Other feature defaults and `server/browser-floor.ts` are unchanged.
- Browser switch: Settings > Devices > Built-in browser, beside browser profiles. Recorder switch: Settings > Skills > Teach a skill. Both are searchable normal cards. The empty Experimental card is gone; its legacy section id redirects to the recorder card so old links still land.
- Cloud keeps the Skills page but hides its computer-only recorder card and search result. The recorder's menu, page and calendar return require a local desktop; the reducer also rejects Cloud recorder navigation.
- Updated the Settings help, shipped help projections, all eight language packs and the affected source hashes. No browser/recorder Experimental wording was present in the current What's New components or release notes, so those files needed no edit.
- Recovery boundary for Claude: `server/installation-restore-preparation.ts:184` deliberately writes both switches false while disabling restored execution. These stored off overrides remain off. This is separate from ordinary startup/config defaults, which do not write false; this lane does not alter recovery policy.
- Generated help entries were aligned with their changed sources without running Node generators. The existing generation-consistency tests still need to run on the build box.

## Files changed

- Defaults and availability: `server/config.ts`, `src/lib/feature-flags.ts`.
- Settings and navigation: `src/components/SettingsModal.tsx`, `src/lib/settings-card-registry.ts`, `src/lib/settings-pages.ts`, `src/lib/cloud-settings.ts`, `src/components/Sidebar.tsx`, `src/App.tsx`, `src/state/store.tsx`.
- Help and copy: `apps/docs/content/docs/features/settings-guide.mdx`, `shared/help-index.ts`, `shared/help-capabilities.ts`, `src/locales/{en,de,es,fr,hi,ja,pt-br,zh}.json`, `src/locales/source-hashes.json`.
- Tests: `server/config.test.ts`, `server/index-2.test.ts`, `server/browser-unavailable-turn-api.test.ts`, `server/browser-floor-builtin.test.ts`, `src/lib/{feature-flags,browser-is-the-place,cloud-settings,settings-card-registry}.test.ts`, `src/components/{WorkspaceFeatureRow,SettingsL4Pages,SettingsShell,SidebarNav}.test.ts`, `src/state/store.test.ts`, `shared/help-search.test.ts`.
- Execution record: this file.

## Claude gate, not run here

Run from the candidate on the isolated Hetzner build box, with the repository's test setup and fake providers. These are the named checks from the contract, made explicit for handoff:

```sh
rtk pnpm exec vitest run server/config.test.ts server/index-2.test.ts server/browser-unavailable-turn-api.test.ts server/browser-extension-setup-api.test.ts
rtk pnpm exec vitest run server/browser-floor.test.ts server/browser-floor-builtin.test.ts server/browser-floor-facts.test.ts server/browser-floor-recipients.test.ts server/browser-floor-cls.test.ts server/browser-floor-negative-corpus.test.ts server/browser-extension-floor-flow.test.ts server/drivers/unified-browser-proxy-mounted.test.ts
rtk pnpm exec vitest run src/lib/feature-flags.test.ts src/lib/browser-is-the-place.test.ts src/lib/cloud-settings.test.ts src/lib/settings-card-registry.test.ts src/lib/settings-pages.test.ts src/lib/settings-sections.test.ts src/components/WorkspaceFeatureRow.test.ts src/components/SettingsL4Pages.test.ts src/components/SettingsShell.test.ts src/components/SettingsSurface.test.ts src/components/SettingsSearch.test.ts src/components/SidebarNav.test.ts src/state/store.test.ts
rtk pnpm exec vitest run shared/help-search.test.ts shared/help-capabilities.test.ts shared/help-coverage.test.ts src/locales/locale-copy.test.ts
rtk pnpm typecheck
rtk pnpm build
```

The browser-turn fixture now leaves the workspace browser switch absent. The new floor case starts an active fake-provider turn, launches the browser proxy from that turn's actual mount, reads a declared consent-button fixture through the real server route, and expects an owner handoff with only `agent_browser_get_html` reaching the page relay. The per-bot case separately expects no mount with browser off and a mount after turning that bot on. Existing built-in floor fixtures also use the default config. These are authored tests, not execution evidence, and their fake page relay does not qualify a native browser.

Visual check: desktop Skills and Devices show the two controls on with an absent config; each can turn off and back on without changing the other. Search opens the right normal card. About has no Experimental card. A Cloud window keeps Skills browsing but has no recorder card, search result, menu entry or recorder page. A phone has no recorder. Check a bot's browser-off switch still withholds its browser while the workspace default is on. Use only isolated fixture data per `docs/verification/README.md`.
