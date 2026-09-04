export const meta = {
  name: 'upstream-sweep-2026-09',
  description: 'Apply the triaged OpenMausBot cherry-picks in isolated lanes, verify each adversarially, stage a merge branch',
  phases: [
    { title: 'Apply', detail: 'four parallel lanes in worktrees, then routines, then MCP' },
    { title: 'Verify', detail: 'one read-only refuter per lane' },
    { title: 'Stage', detail: 'merge SOUND lanes into upstream-sweep-2026-09 and run the full suite' },
  ],
}

// Every fact an executor needs is in the two plan files; the prompt points at
// them rather than restating, so the plan stays the single source of truth.
const PLAN = 'docs/plans/UPSTREAM-SWEEP-EXECUTION-2026-09-04.md'
const TRIAGE = 'docs/plans/UPSTREAM-SWEEP-2026-09-04.md'
const REPO = '/Volumes/Mando/WaylandBots/murage-app'

const LANE_SCHEMA = {
  type: 'object',
  required: ['lane', 'branch', 'commits', 'tests', 'controls', 'skipped', 'ownershipViolations'],
  properties: {
    lane: { type: 'string' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', required: ['item', 'sha', 'title'], properties: { item: { type: 'string' }, sha: { type: 'string' }, title: { type: 'string' } } } },
    tests: { type: 'object', required: ['passed', 'failed', 'paths'], properties: { passed: { type: 'number' }, failed: { type: 'number' }, paths: { type: 'array', items: { type: 'string' } } } },
    controls: { type: 'array', items: { type: 'object', required: ['item', 'reverted', 'redText'], properties: { item: { type: 'string' }, reverted: { type: 'string' }, redText: { type: 'string' } } } },
    skipped: { type: 'array', items: { type: 'object', required: ['item', 'why'], properties: { item: { type: 'string' }, why: { type: 'string' } } } },
    ownershipViolations: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['lane', 'verdict', 'findings'],
  properties: {
    lane: { type: 'string' },
    verdict: { enum: ['SOUND', 'FIX-LIST', 'REJECT'] },
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'claim', 'evidence'], properties: { severity: { enum: ['high', 'medium', 'low'] }, file: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } } } },
  },
}

const lanePrompt = (lane, items, extra = '') => `
You are executing LANE ${lane} of the upstream sweep for Murage (${REPO}).

READ FIRST, in full: ${PLAN} (the execution plan — your lane's table, the ground
rules in §0, the rebrand table, the in-flight-work table, and the ownership
matrix in §2). Then ${TRIAGE} for the reasoning behind each verdict.

You are in your own git worktree already. Create and stay on branch sweep/${lane}.
Never touch main. Never push. Upstream is fetched as 'upstream'; it is read-only.

Apply these items IN THIS ORDER, one commit each (squash groups as the plan says):
${items}

Obey every ground rule, especially: negative control on every testable production
change (revert → RED with real failure text → restore → GREEN); no upstream
identity strings; the exec-route gate; files outside your ownership row are
forbidden. Skip an item only for the reasons the plan allows, and say so.
${extra}
Before you finish run the per-lane verification block in §3 verbatim and include
its results. Your final answer is the JSON the schema asks for — nothing else.
`

const verifyPrompt = (lane, report) => `
Read-only adversarial review of LANE ${lane} of the Murage upstream sweep.
Repo: ${REPO}. Branch under review: ${report.branch}. Plan: ${PLAN}. Triage: ${TRIAGE}.

The executor reported: ${JSON.stringify(report)}

Your job is to REFUTE, not confirm. Run: git diff main...${report.branch}.
Read every hunk. Hunt specifically for: an HTTP route that spawns a process or
writes spawn-deciding config without the requestSurface(...) !== "desktop" → 404
gate; any of openmausbot|milind|omb_|ogb|openmaus|"maus"|MausState surviving;
a console.error that logs prompt text; a squash rule violated (a commit that the
plan says must never land alone, landing alone); a test that still passes with
the production change reverted (re-run one control yourself); a file outside
the lane's ownership row in §2; any edit to the in-flight-work files in §0;
typecheck or lint failures (run them). Never run a writing git command.
Verdict SOUND only if you found nothing above 'low'. Answer with the JSON the
schema asks for — nothing else.
`

// ---------------------------------------------------------------- Phase 1
phase('Apply')
log('Phase 1: lanes S, E, D, U in parallel worktrees')

const phase1 = await parallel([
  () => agent(lanePrompt('server', `
  #1  006c977f + 7fa78666 (squash)
  #2  48ed8acb
  #3  2689be08 + bfe6df25 + bb0a36d9 (ONE commit)
  #8  e1f4207e — STATUS HALF ONLY; delete the [omb-turn] console.error
  #9  8be0d3fb — ComposerQueuedMessages is the FIRST child of the composer column
  #11 3ba0ba0d + eac313db (squash; Goal chip hand-placed at Composer.tsx:771)
  NOTE: #10 is NOT yours. It edits acp/core.ts, which Lane E owns.`),
    { label: 'apply:server', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' }),
  () => agent(lanePrompt('engines', `
  #6  3ab2426d → 4a72db5a
  #7  ed7a1515 — MURAGE_ACP_* env names, defaults 60-90s NOT 300s; add the
      null session/load test; run fuigo.test.ts and hermes.test.ts`,
    `You own acp/core.ts, fake-acp-cli.ts and acp.test.ts. Item #10 lands in a
     later serial lane on top of your work — do not attempt it here.`),
    { label: 'apply:engines', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' }),
  () => agent(lanePrompt('desktop', `
  #4  509a34b2
  #5  9f27177a → 4eedf162
  #13 7fc09de4
  #21 2ba2dff0 — HAND-PORT for FerroxLabs/murage-releases + RELEASES_PAT; do NOT run any workflow`),
    { label: 'apply:desktop', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' }),
  () => agent(lanePrompt('sidebar', `
  #12 de7f0232 — keep the desktop === true gate on BOTH SidebarPhoneButton sites`),
    { label: 'apply:sidebar', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' }),
])

// A worktree agent can silently not run (HANDOFF gotcha). Fail loudly, not quietly.
const p1 = phase1.filter(Boolean)
if (p1.length !== 4) log(`WARNING: expected 4 lane reports, got ${p1.length} — a lane did not run`)
for (const r of p1) log(`${r.lane}: ${r.commits.length} commits, ${r.tests.passed} passed / ${r.tests.failed} failed, ${r.skipped.length} skipped, ${r.ownershipViolations.length} ownership violations`)

// ---------------------------------------------------------------- Phase 1b/1c: serial lanes
// Routines needs LANE S's index.ts landed first; MCP needs both. They run
// against a worktree that has merged the earlier lanes, so the executor is
// told which branches to merge in before starting.
const serverBranch = p1.find(r => r.lane === 'server')?.branch
const enginesBranch = p1.find(r => r.lane === 'engines')?.branch

// #10 was originally inside Lane S. Two independent auditors (GPT-5.6 and
// Gemini 3.8 Flash) caught that it edits acp/core.ts -- Lane E's file, and the
// path the default engine runs through. It now runs alone, on top of both.
const acpImages = serverBranch && enginesBranch
  ? await agent(lanePrompt('acp-images', `
  (first: git merge --no-ff ${serverBranch}, then ${enginesBranch}, into your branch)
  #10 e8869da2 — the dry-run CLEAN is FALSE: it references generatedImagesByTurn
      from S#9 and fails typecheck without it. Run acp.test.ts, fuigo.test.ts,
      hermes.test.ts, and typecheck.`),
      { label: 'apply:acp-images', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' })
  : null
if (!acpImages) log('acp-images lane did not run (server or engines missing)')
const routines = serverBranch
  ? await agent(lanePrompt('routines', `
  (first: git merge --no-ff ${serverBranch} into your branch)
  #14 ac41eb81 + 2c4e5b70 + bd59135e (squash; every "maus" → "ember")
  #15 cd67a557 — MURAGE_GOAL_WAIT_MAX_MS default 5 minutes
  #16 803ba1cc + f4a6b89a + d9099fbe (squash) — GATED on Sean's decision: ${args?.roomsWait === true ? 'DECIDED YES, apply' : 'UNDECIDED, SKIP #16 and #17 and report'}
  #17 ecf211aa — only with #16
  #18 3e23961d PART (a) ONLY
  #19 50ddda4d + 75b7c154 web hunks (squash) — hand-port; boot check required
  #20 e74e85c1 web hunk`),
      { label: 'apply:routines', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' })
  : null
if (!routines) log('routines lane did not run (no server branch to build on)')

const mergedSoFar = [serverBranch, routines?.branch].filter(Boolean)
const mcp = mergedSoFar.length === 2
  ? await agent(lanePrompt('mcp', `
  (first: git merge --no-ff ${mergedSoFar.join(' then ')} into your branch)
  #22 074d2f7e — drop server/request-auth.ts and its test; rebrand RESERVED_MCP_NAMES
      to our current list; ALL SIX routes gated requestSurface(...) !== "desktop" → 404;
      AND close the second write path: PUT/PATCH /api/config (server/index.ts:9556)
      must not be able to write mcpServers -- strip/reject it in parseConfigPatch,
      with a test proving a non-desktop PUT /api/config carrying mcpServers changes
      nothing. Audit every HTTP-reachable saveConfig caller before calling it done.
      Boot check from desktop AND a phone-surface curl → 404`),
      { label: 'apply:mcp', phase: 'Apply', schema: LANE_SCHEMA, isolation: 'worktree' })
  : null
if (!mcp) log('mcp lane did not run (server or routines missing)')

// ---------------------------------------------------------------- Phase 2
phase('Verify')
const reports = [...p1, acpImages, routines, mcp].filter(Boolean)
const verdicts = await parallel(reports.map(r => () =>
  agent(verifyPrompt(r.lane, r), { label: `verify:${r.lane}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
))
const v = verdicts.filter(Boolean)
for (const x of v) log(`${x.lane}: ${x.verdict} (${x.findings.length} findings)`)

// ---------------------------------------------------------------- Phase 3
phase('Stage')
const sound = v.filter(x => x.verdict === 'SOUND').map(x => x.lane)
const order = ['server', 'engines', 'acp-images', 'desktop', 'sidebar', 'routines', 'mcp'].filter(l => sound.includes(l))
const branches = order.map(l => reports.find(r => r.lane === l).branch)

// The staging merge is deliberately an agent in ITS OWN worktree, so a merge
// conflict or a red full suite never touches the checked-out main.
const staged = branches.length
  ? await agent(`
In ${REPO}, in your own worktree: git checkout -b upstream-sweep-2026-09 main, then
git merge --no-ff each of these IN ORDER: ${branches.join(', ')}.
If a merge conflicts, STOP and report the conflicting files — do not resolve by hand.
Then run exactly: pnpm typecheck && pnpm lint && npx vitest run
(grep the vitest output for PASS|FAIL|Tests ; the known-flaky files are named in
${PLAN} §0 rule 6 — re-run those once in isolation before calling them red).
Then boot: MURAGE_PORT=18877 node --experimental-strip-types server/index.ts & and
curl -s http://127.0.0.1:18877/api/instances, confirm the fuigo instance is present with models > 0, then kill it.
Never push. Report: branch name, merge results, typecheck/lint/test counts, boot result.
`, { label: 'stage:merge', phase: 'Stage', isolation: 'worktree' })
  : 'nothing staged — no lane was SOUND'

return {
  lanes: reports.map(r => ({ lane: r.lane, branch: r.branch, commits: r.commits.length, skipped: r.skipped })),
  verdicts: v,
  notSound: v.filter(x => x.verdict !== 'SOUND').map(x => ({ lane: x.lane, verdict: x.verdict, findings: x.findings })),
  staged,
  next: 'Sean reviews upstream-sweep-2026-09; fast-forward to main is a human decision',
}
