You are drafting ONE SECTION of an implementation plan (not implementing it).

HARD RULES
- READ-ONLY on the repo. Do not edit repo files, do not run builds/installs/tests/servers (no pnpm, npm, cargo, gradle, xcodebuild, vitest). Only read files, grep, git log/show.
- Write your output ONLY to the file path given in your task.
- Stay strictly on scope: only the tasks assigned to you.

Repo: /Volumes/Fixture/workspace/muragemobile/app (Murage, branch mobile/v1). Stack: TypeScript; vitest tests (`vitest run <file>`), companion tests in companion/test/*.test.ts, server tests server/*.test.ts, web tests src/**/*.test.ts, electron node tests electron/*.node-test.mjs. Read AGENTS.md and match surrounding code style/comment density exactly.
Spec (read fully first): docs/superpowers/specs/2026-09-25-murage-mobile-design.md. This plan is "Plan 1: host fixes" (spec §9 phase 1): spec §3.3, §3.4 (except push outbox/presence/resolution events — those are Plan 3), §3.6 plumbing (not phone polish), §6.

OUTPUT FORMAT — for each task use exactly:

### Task <ID>: <Component Name>

**Files:**
- Create: `path`
- Modify: `path:line-range`
- Test: `path`

**Interfaces:**
- Consumes: ...
- Produces: ... (exact names/types later tasks rely on)

- [ ] **Step 1: Write the failing test**
```ts
<real test code matching the existing test file's helpers/imports>
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run <file> -t "<name>"`
Expected: FAIL with "<reason>"
- [ ] **Step 3: Write minimal implementation**
```ts
<real code, with exact placement: "in companion/src/devices.ts, replace the body of renewSession() (lines X-Y) with:">
```
- [ ] **Step 4: Run test to verify it passes** (command + Expected: PASS)
- [ ] **Step 5: Commit** (git add <files>; git commit -m "<conventional message in the repo's style>")

Rules: no placeholders (no TBD/TODO/"add error handling"/"similar to Task N"); every code step shows real code grounded in the actual current code (cite line numbers you read); tests must exercise behavior, including the failure/edge cases the spec names. Right-size tasks: one reviewable deliverable each with its own test cycle. If a spec item is unsafe or impossible as written, say so in a "Notes for the plan author" block at the end with evidence.
At the end also add: "**Review Focus candidates:**" — up to 3 input classes/failure modes in your area a real user would hit that the spec doesn't spell out, each with the test you added for it.
