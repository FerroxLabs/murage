# Browser navigation readiness diagnostic — 2026-09-07

## Frozen contract

Reproduce or reject Sable's new early-empty navigation observation using the real Electron browser surface and authenticated host, an isolated local-controlled page, and quick/blank controls. Preserve private-network rejection and user data. Scope is new fixture/test/evidence files only; no production fix, external website dependency, click investigation, or commit. Stop after at most two diagnostic attempts and report a bounded recommendation.

## Result

**REPRODUCED.** A delayed client-rendered document returned empty `yaml` at 360 ms, despite `document.readyState === "complete"`, `isLoading() === false`, and `did-finish-load`/`did-stop-loading` at 7 ms. A later snapshot on the same URL at 2040 ms contained both links, without a reload, click, or DOM mutation by the harness.

Baseline HEAD: `b6bcb808d3c811be257f1f0c925d0af242e763c8` (existing dirty workspace). Production `electron/browser-surface.cjs` was not edited for this diagnostic. Native macOS Electron runs the actual browser host/surface, using production 350 ms settle and 8000 ms load wait defaults. Browser content is served by the isolated session's HTTPS protocol handler for `readiness.example.test`; fixture DNS returns a public address only for that exact synthetic host. No external fixture site is contacted. Temporary user/session data is removed on fixture exit.

| Case | Navigate returned | Browser state | Snapshot |
| --- | --- | --- | --- |
| Quick synchronous links | 482 ms | complete; not loading; two links | both links present |
| Truly blank body | 363 ms | complete; not loading; zero links | empty yaml |
| Links rendered by a 2000 ms timer | 360 ms | complete; not loading; zero links | empty yaml; both links present at 2040 ms |

Private-network control: `manager.navigate("readiness", "http://127.0.0.1/", "")` rejects with `Local and private-network` policy error. The handler observed only the three test document requests (favicon requests excluded from document-count assertion).

## Command and attempt budget

Run from `/Volumes/Mando/WaylandBots/murage-astra`:

```sh
rtk proxy pnpm exec vitest run electron/browser-navigation-readiness.electron.test.mjs
```

Attempt 1: failed in the diagnostic fixture because it asserted the host's `text` field. `sanitizeHostResult` deliberately removes this diagnostic duplicate field; the actual host result exposes `yaml`. The quick-page native control passed before this fixture error. Corrected the new fixture to assert empty `yaml`.

Attempt 2: PASS, 1 test, 3.78 s total, native child exit 0. Sentinel: `actual-host-navigation-early-empty-reproduced; private-network-block-preserved`. Budget exhausted; no further diagnostic run needed. This is a passing reproduction test for a current defect, not evidence of a product fix. Fixture stdout includes each case's timings, lifecycle events, page state, and first/later YAML.

## Cause and bounded recommendation

`navigate` awaits `loadSafe`/`webContents.loadURL` then `observe`. `observe` calls `settle` then snapshots. `settle` sleeps 350 ms and only waits for `did-stop-loading` if `isLoading()` remains true. Load completion does not mean a page's future timer/fetch-driven DOM work is finished. Here both load lifecycle events already fired and the delayed JS had not run. Adding another load-event wait alone would not fix this case. Network-idle alone would also miss this timer-only page.

The real host returns the same empty `yaml` for the genuinely blank and delayed pages. Surface diagnostic formatting converts an empty rich snapshot to `(empty page)`; the host strips that duplicate `text` channel. This run proves the empty structured observation, with source evidence for the surface text formatting. It does not directly exercise a separately running Sable/MCP client.

Recommended bounded change: add a bounded first-content retry for an initially empty navigation observation, and return explicit observation/readiness metadata when it remains empty at the deadline. Tell the consumer that no accessible content was observed yet and rendering completion is unknown; do not assert that every blank page is still rendering. Preserve fast responses for nonempty pages, cap blank-page delay, retain human-control and navigation cancellation behavior, and keep direct later snapshots usable. A DOM quiet interval can supplement observation but cannot establish application readiness before a delayed timer fires. Do not recommend a blanket network-idle gate or promise every arbitrary SPA is settled.

Regression acceptance for a future fix should cover delayed first content within the chosen budget, quick content without unnecessary delay, truly blank content with bounded/explicit unknown outcome, and existing privacy/control gates. That is proposed follow-on work, not implementation authorized by this diagnostic contract.

No evidence here proves this race caused the original coordinate/click bug. Sable's older click and viewport fixes were not reopened.
