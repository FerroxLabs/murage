# Murage takeover — approved five-stage programme

User authorization: "Proceed ... creating it as a goal 1-5 and do it all" (2026-09-05).
Base: b445ff373edaefdd11f75e777a7cc8c46a137cac. Working branch: codex/murage-reliability.
Approved brief/research: ../notes/murage-audit-2026-09-05 (relative to the workspace parent; absolute /Volumes/Mando/WaylandBots/notes/murage-audit-2026-09-05).

## Constraints and verification contract

- Sean's latest verification constraint: no more than TWO verification rounds per change set. During verification, fix only Critical and High findings (including build-blocking failures). Record Medium/Low findings without extending the loop. Report unresolved findings after round two; do not reset the counter by renaming the same change set. This limits verification work, not the already approved implementation scope.

- Single user, their local machine or private VPS, private Tailscale access.
- No main advancement, push, release, publication, live networking or production-droplet changes without separate authorization.
- Preserve Fuigo's intentional inherited global/project context; changes inside Fuigo belong to its separate owner.
- Preserve the established Murage visual language; improvements use existing skins, semantic tokens and components.
- Code/tests run in this dedicated worktree or explicit disposable fixtures. Never use the user's live data for mutations.
- Record actual test exit status and logs. A behavioral fix needs a relevant failing test/probe or negative control; source presence is not runtime proof.
- Completion requires customer-facing acceptance evidence. Untested native platforms remain open gates.

## Stage 1 — Reproducible integrated baseline

1. [GPT-6] Capture pinned Node-24 full test baseline in a separate snapshot; verify all declared dependencies and record environment and skips. Paths: package.json, vite.config.ts, verification logs. Verify: complete runner result, not a partial log.
2. [GPT-6] Repair test-resource/environment isolation and stale UI expectations. Paths: server/testing/, src/e2e/, affected tests, catalog fixtures. Verify: clean checkout works without user keys, agents, untracked teams or live ports; exact approved user behavior asserted.
3. [GPT-6] Consolidate CI gates and bounded process cleanup, including installer tests. Paths: package.json, .github/workflows/ci.yml, installer/test/. Verify: full suite terminates and reports every required suite accurately.

## Stage 2 — Runtime, authority and recovery

4. [GPT-6] M01: contain malformed request parsing across harness, webhook and companion control. Paths: server/index.ts, server/webhook-ingress.ts, companion/src/control.ts and focused tests/helper. Verify: raw malformed request returns 400 and the same process continues normal requests.
5. [GPT-6] M02/M03: unify execution-policy writer authorization and explicit dev-secret sharing. Paths: server/index.ts, server/sse-visibility.ts, launchers, installer/, fixture bootstrap. Verify: direct uncredentialed writers fail; desktop/headless operator and scoped phone confirmations remain functional.
6. [GPT-6] M04: prevent narrow remembered shell grants expanding through operators/substitutions. Paths: server/auto-approve.ts and tests/approval copy. Verify: benign grant remains useful; chained/alternate execution cannot inherit it.
7. [GPT-6] M05: legacy routine cards require fresh content-bound review without disabling legitimate remote confirmations. Paths: server/routine-requests.ts and tests. Verify: legacy, tampered, duplicate, foreign-owner and cancellation cases.
8. [GPT-6] M08/M20: preserve unreadable/corrupt persisted state and expose recovery. Paths: server/store.ts, config/persistence helpers, recovery UI as needed. Verify: malformed schema, partial JSON and access errors preserve bytes and prevent empty-state overwrite.
9. [GPT-6] M10: surface handshake recovers from temporary HTTP errors and server restarts. Paths: src/lib/surface.ts, live-events integration and tests. Verify: no sticky remote downgrade, no permanent-refusal retry storm.

## Stage 3 — Existing customer fixes and Fuigo contract

10. [GPT-6] HTTPS/listener reconciliation and secure-context-compatible sends. Paths: companion/, electron/companion*, src/components/Composer.tsx, src/state/store.tsx, shared ID helper. Verify: all supported paths send/retry; proxy conflicts remain untouched; useful degraded states.
11. [GPT-6] Capability-aware remote controls and honest save states. Paths: PluginsPanel, RoutineCalendarPage, SettingsModal and request helpers. Verify: visible operations work or explain prerequisites; error responses never become saved configuration.
12. [GPT-6] MCP initialize sequencing, goal wait overflow, role and identity remnants. Paths: server/mcp-probe.ts, server/index.ts/config helper, role components, docs/releasing.md. Verify: focused false-handshake/overflow/role checks and syntax/type gates.
13. [GPT-6] Prove twelve Murage agent tools survive Fuigo inheritance. Paths: server/drivers/acp/fuigo.ts/core.ts, agents-proxy, integration tests/docs. Verify: safe real tool call returns through the harness under inherited configuration; approval/cancel and collision handling; no Fuigo wholesale isolation.

## Stage 4 — Private VPS and release readiness

14. [GPT-6] Complete headless package/bootstrap/pair/revoke/admin journey and owned-process lifecycle. Paths: installer/, companion/, build scripts. Verify: clean disposable environment, non-default ports, spaces, reboot/start-stop, no lingering descendants.
15. [GPT-6] Complete versioned installation backup/restore and migration. Paths: persistence service, installer commands, desktop recovery UI. Verify: consistent database state, safe credential reauthentication, relationships retained, no replay of consequential completed actions.
16. [GPT-6] Close release mutation/semver/API-error/rerun guards. Paths: release and prepare-release workflows, pure helper/tests. Verify: published state transition refuses uploads, auth failure differs from not-found, downgrade/undefined rejected; no workflow actually published.
17. [GPT-6] Validate candidate packages/native capability matrix. Paths: package config/scripts/docs, native tests. Verify: signed or locally staged candidate on actual supported macOS/Windows/Linux environments, updates/rollback; report absent environments honestly.
18. [GPT-6] Conditional optional-broker metering hardening only if retained in selected product. Paths: broker and service configuration. Verify: stable anti-abuse identity, bounded accounting failure; no SaaS/multi-tenant runtime expansion.

## Stage 5 — Performance and practical power

19. [GPT-6] Bound SSE/log/transcript resources and measure concurrency. Paths: event bus/native logs, server SSE, transcript storage/search. Verify: slow consumers, image-heavy output and large histories stay within documented resource budgets.
20. [GPT-6] Safe shared-working-folder restore and optional isolated team workflows. Paths: checkpoints/working-directory leases and related UI. Verify: canonical-path aliases and concurrent writers cannot corrupt each other; restore preview/undo remain useful.
21. [GPT-6] Unified readiness/recovery and searchable decision explanations. Paths: health/capability/diagnostics API, existing settings/inspector UI. Verify: errors route to correct action, credentials redacted, keyboard and mobile use.
22. [GPT-6] Evidence-backed completion and scoped autonomy budgets. Paths: goal/routine receipts, task policy, usage and control UI. Verify: deliverables/checks/uncertainty visible; budget inheritance/stop and unknown-cost behavior honest.
23. [GPT-6] Reusable successful outcome workflows and durable handoff/reconciliation. Paths: existing skill/team/playbook/package and task recovery systems. Verify: versioned template round trip, missing prerequisites, resumed tasks do not silently duplicate external actions.
24. [GPT-6] Complete critical localization journeys and external-channel support register/working integration. Paths: src/locales, critical UI, Murage-side Fuigo channel integration/docs. Verify: actual supported channels route identity/approvals/replies correctly; unsupported cases explicit; no inferred native channel support.
25. [GPT-6] Final full verification and local handoff. Verify all stages against customer brief, re-run meaningful regression/native gates, record remaining environment dependencies, provide exact local branch and evidence. No push/publication implied.

## Added goal requirement — upstream release reconciliation

Sean added this requirement on 2026-09-05, referencing
https://github.com/milind-soni/openmausbot-releases/releases.
It is part of whole-program completion, not a replacement for stages 1–5.

26. [GPT-6] Verify Murage's actual imported upstream baseline, then review
    every relevant released change since that baseline, including overlap with
    the prior selective v0.1.50+ sweep. Pin release/source SHAs and review time;
    distinguish released code from later unreleased main. Build a source-backed
    disposition ledger: already implemented, equivalent local fix, already
    planned, port/adapt now, defer with reason, or reject with reason. Inspect
    actual diffs and dependency chains, not release titles alone. Apply selected
    changes locally with meaningful regression evidence while preserving
    Murage's authority gates, private deployment model, Fuigo inheritance,
    identity, redistribution rights and separate engine ownership. No blanket
    merge, automatic version bump, push or release. Recheck the release feed
    before the final candidate is sealed; document the reviewed cutoff.

Task 25 cannot complete until this added requirement and all selected ports
have been reconciled against the final candidate. The initial cached release
page showed v0.1.51, but the direct GitHub API confirms v0.1.54 is latest,
published 2026-09-05T06:17:40Z. The prior plan was explicitly a selective
v0.1.50+ sweep, so package.json 0.1.44 is not evidence of upstream coverage.

## Execution strategy

First repair wave: request-boundary containment, remembered-shell grants, and surface-handshake recovery are independent file scopes and may run in parallel; the root owns baseline execution and integration. All server/index.ts policy edits after the boundary fix are serialized. UI design adjustments preserve current Murage skins; no new style selection is needed for corrective work.

Each task state, owner, evidence and remaining gate is tracked in STATE.md and the IJFW blackboard. Whole-goal completion is separate from finishing any single stage.
