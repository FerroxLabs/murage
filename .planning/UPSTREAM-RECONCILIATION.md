# Upstream reconciliation — active goal addition

Status: in progress. Added by Sean on 2026-09-05.
Release feed: https://github.com/milind-soni/openmausbot-releases/releases
Source repository: https://github.com/milind-soni/OpenMausBot

## Initial evidence

- Direct GitHub API confirms latest OpenMausBot v0.1.54, published
  2026-09-05T06:17:40Z. v0.1.52 was published 2026-09-04T21:06:10Z,
  v0.1.51 at 2026-09-04T19:30:00Z, and v0.1.50 at
  2026-09-02T23:06:17Z. No published v0.1.53 appears in the returned list.
  The web tool's cached release page stopped at v0.1.51 and is stale; do not
  use its latest label as the reviewed cutoff.
- Release-repository tags point to the release scaffold, not necessarily the
  application source. Use source-repository release tags and linked PR commits
  for the comparison; do not use the repeated scaffold SHA as source identity.
- Prior controlling plan docs/plans/UPSTREAM-SWEEP-2026-09-04.md reviewed the
  fork point 6140532e through a selective v0.1.50+ sweep: 46 candidates, with
  take/adapt/defer/reject decisions. This is not blanket v0.1.50 parity.
- Some v0.1.51 release-note entries already appear in that prior sweep (for
  example ACP handshake/null-load handling and first-launch window sizing).
  Verify landed source and tests before marking these covered.
- Murage's package version 0.1.44 is independent of imported upstream fixes.

## Pinned comparison boundaries

- Previous fetched/reviewed upstream main:
  `47971da6960b9e916441c62e9ff319e56e9b07fa` (PR #749, calmer first window).
  Its date is 2026-09-03T19:56:22Z; this matches the end of the prior sweep's
  listed candidates. It is a review cutoff, not proof every prior commit was
  imported. Landed equivalence remains item-by-item.
- Source v0.1.50: `509a34b23a6d13b7a523f77394b73392fa901c51`.
- Source v0.1.51: `fe711483af5528499f710255dac51b7f40665747`.
- Source v0.1.52: `7c0c4b7cea8e7478bbaa4058fba8e422d2b57f8e`.
- Source v0.1.54: `f85fb3208332810323ede12fbde587e310ba6d59`.
- Fetched source main: `db2dc71911b66d7bdc5a49cc3a9457e2465d4a31`.

There are 79 non-merge commits after the prior reviewed main through v0.1.54,
touching 228 files (25,499 insertions, 1,828 deletions). These are raw scope
counts, not 79 necessary ports. v0.1.50 through v0.1.54 has 91 non-merge
commits, including the overlap already considered in the old sweep.

Three non-merge changes on fetched main are not in published v0.1.54:
`eb1b4abc` macOS image paste; `a6c2b7a3` additive team imports/portable bot
backups; `72d389ff` team-map simplification. Review separately as unreleased
candidates. The recovery worker has been asked to compare the portable bot
backup change with our broader installation recovery requirements.

Release metadata/notes are captured in upstream-release-notes-20260905.json;
exact new commit list is upstream-post-review-commits.txt.

## Required ledger

Current reviewed implementation updates (not native/release acceptance):

- eb1b4abc clipboard adaptation: implemented locally; acceptance BLOCKED after
  two verification rounds.7 native-menu unit tests,27 attachment/draft units,
  10 Chromium fixture cases and joint typecheck passed. Items-first intake,
  duplicate-source avoidance, refusal feedback, selection semantics and delayed
  originating-draft retention are exercised; denied-storage regression corrected.
  Isolated old-setter negative control failed fixture startup before the target
  assertion, so it is missing evidence, not a demonstrated red control. Logs:
  clipboard-round1-menu.log,clipboard-round2-unit.log,clipboard-round2-browser.log,
  clipboard-round2-negative.log,task26-joint-round2-types.log. Real macOS Cmd-V,
  context-menu and Finder-file checks remain unperformed. Manual native fixture
  scripts/smoke-clipboard.mjs passed syntax only; it was not run and no system
  clipboard modified. Cycle closed; no third round without direction.

- 3e27620b reserved custom MCP environment increment: adapted and ACCEPTED by
  Astra on2026-09-06. Parser and direct Claude/Codex/ACP mounts reject protected
  names case-insensitively; built-in mounts and ordinary user variables preserved.
  Six suites:284 passed/1 skipped; isolated disabled-guard negative control:17
  expected failures; shared round2 typecheck passed. Logs:mcp-reserved-round1.log,
  mcp-reserved-round1-negative.log,task26-joint-round2-types.log. This does not
  complete row36's separate internal-turn capability lifecycle/integration gate.
- 49b0961e pending OAuth UI: adapted and ACCEPTED by Astra on2026-09-06. Pending
  account without cached URL checks status without duplicate authorization;
  cached Continue reused, alias prompt hidden, unreadable inventory retains
  accounts and blocks connection writes.6 unit +5 browser tests passed,
  screenshots reviewed and joint typecheck passed. Logs:oauth-pending-round1-unit.log,
  oauth-pending-round1-browser.log,task26-joint-round2-types.log. No live provider
  assertion and no canonical toolkit routing/first-account-alias claim.

- 52cd9563 Composio backend/cache/transport identity: adapted locally and
  ACCEPTED by Astra on2026-09-06. Same-backend session reuse remains valid;
  key/endpoint rotation, unknown sessions, late responses and512-entry eviction
  covered. Round1 existing tests/typecheck passed, one fixture URL corrected
  without weakening the production URL guard; round2 six identity tests passed.
  No live-service claim. Evidence:composio-identity-round1.log,
  composio-identity-round1-types.log,composio-identity-round2.log.
  Accepted file hashes:server/composio.ts
  aaf2624be4aba89a8fdf298db22fbdf06b8e2be11707a2fd63e6e49d40bcf53c;
  server/composio-identity.test.ts
  506b68b0fac6863c532fcfb9facd90668b9e93ec80452184d5622261e4415d59.
  OAuth UX/canonical toolkit naming remain separate existing ledger items.

- `cb1747d1` goal-mode draft persistence adapted in drafts.ts/Composer.tsx.
  Actual mounted taskA→taskB→taskA lost goal mode before fix; now preserves
  mode across navigation/reload, resets after send and restores on retry with
  the same send ID. Nine unit cases, 14 browser cases and a two-case goal/retry
  follow-up passed. Local typecheck passed. Logs: goal-draft-before.log,
  goal-draft-unit.log, goal-draft-browser.log, goal-retry-final.log.
- `4f84fce3` docs workflow input filters implemented and verified against the
  actual asset-sync script: screenshot and icon changes now trigger PR/push
  checks. Two red trigger tests before fix; all three tests pass after.

For each relevant change: release, PR/source SHA, dependency chain, affected
Murage paths, prior decision, current equivalent implementation/tests,
disposition, rationale, local port and verification evidence if selected.

The first selected adaptation is assigned: `81451d74` / PR #782, Windows
Tailscale executable paths and platform PATH delimiter. Root inspected the
actual diff and confirmed both gaps remain in companion/src/listener.ts.
The worker must preserve our richer existing listener tests and HTTPS
reconciliation; upstream's delimiter assertion alone does not reproduce the
Windows bug on macOS, so a controlled Windows-path regression is required.
Implementation and verification are in progress, not yet accepted.

Source main and v0.1.50/v0.1.51/v0.1.52/v0.1.54 were fetched into refs/audit/
without changing tags, main, origin or the working branch. Preserve the
existing decisions against enterprise licensing restrictions, public auth
surface imports, and wholesale Antigravity core replacement unless fresh
evidence justifies a clearly stated revision.
