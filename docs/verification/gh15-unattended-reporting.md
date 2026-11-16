# GH15 Windows unattended reporting

The original umbrella issue's startup/skill-junction complaints are separate
from unattended reporting. `issues-107.md` and `TRIAGE-1011.md` trace the latter
to murage-releases #7(a), #7(b), and #9. There is no recorded later
reporter-specific failure or new original log in the supplied evidence.

## Existing implementations found before building

- #7(a): the old Windows path skipped the environment check as U20, holding
  each command. Commit 2408a5c340 implements PowerShell environment capture and
  comparison and Windows literal-launcher handling. It is an ancestor of
  7c9ce6fe. `server/engine-env.ts` now validates the nonce, provider, working
  directories, names and handed values; it retries a slow probe once using the
  Windows budgets. `server/engine-env.test.ts`, `win-pwsh-env-1018.test.ts`, and
  `full-access-env-unchecked-108.test.ts` exercise these paths and the routine
  waiver separately. Auto and Ask retain their existing boundaries.
- #7(b): commit fe0c2980bc is also an ancestor of 7c9ce6fe. The exact
  `codex/apply_patch` edit identity is recognized in
  `shared/app-action-grant.ts`, and `acpApplyPatchCall` reads its destinations.
  `server/drivers/acp/issue-perms-1010.test.ts` names the original issue and
  exercises real fake-ACP frames for both fuigo/tool and x.ai/tool stamps.
- #9: `resolveCall` resolves unstamped ACP MCP identities against the loaded
  mounts. `server/own-tools-unasked.test.ts` verifies own tool identity without
  granting a foreign tool the same name. No older No limits decision path is
  restored; Sean's wipe-only ruling remains owned by its existing lanes.

No new product defect was observed for these known shapes; no manufactured RED
or speculative permission change is introduced. The missing work was tracing
and workflow evidence, not another duplicate implementation.

## Additional workflow qualification

`server/gh15-unattended-reporting-api.test.ts` launches the repository's
isolated control-surface fixture, adds only a fake ACP engine, raises its bot
through the real desktop permission-confirmation API, creates a Full access
routine and starts it. A separate case enables a one-time routine and waits
for the real scheduler: it sends no Run now request, and asserts
`triggerSource: schedule` and `manual: false`. Both cases use the original
codex/apply_patch shape. Without answering any permission request, each test requires the run to
complete, its final text to appear in the run conversation, no live approval
card, and an allow answer at the engine protocol boundary. The synthetic engine writes the proposed report file only after an allow reply,
and the workflow requires its exact bytes and delivery text. On Windows this
write runs through native Windows PowerShell; on Linux it uses node:fs.
This establishes actual fixture output, not real-provider generation. The optional
SC_ISSUES_EVIDENCE directory receives fixture metadata, run state, transcript
and the protocol decision. Scheduled evidence also requires delivery state
`sent` in the real run receipt. No live data or billable model is used. The fake ACP executable receives only
the Node executable directory on PATH, and uses the existing in-memory
hostPower.testUnwrapped marker in this test process. This isolates approval and
report delivery from an unstaged Linux bwrap binary; it is not sandbox or native
Windows qualification.

This can run on every OS; the Linux execution and Windows path/PowerShell
parser seams do not establish native PowerShell or packaged Windows
qualification. A repeat on the reporter's Windows install remains distinct
from proving the known implementation paths.

## Packaged Linux alternative

`scripts/verify-gh18-linux-package.mjs` also drives the packaged desktop's
reporting API through `verify-gh15-linux-package.mjs`. It registers only the
fake ACP executable as a Fuigo instance, raises a new bot through the real
owner confirmation flow, and runs both manual and scheduled Full access
routines. Fuigo uses its ordinary Linux launch path; this check sets no test
mode or host-power bypass in the packaged app.

Each run must create its own `gh15-report.md` with exact synthetic bytes after
the protocol allow reply. The scheduled run must record `triggerSource:
schedule`, `manual: false`, and delivery `sent`. The transcript must include
the report text and contain no unanswered approval card. `gh15-reporting.json`
retains both runs, actual file contents, messages and decisions. The package
receipt identifies the executable, ASAR hash and build commit. This is the
brief's packaged Linux alternative, not a native PowerShell or reporter-profile
claim. The source regression separately asserts file existence so an omitted
write fails an assertion even when the synthetic engine emits completion text.
