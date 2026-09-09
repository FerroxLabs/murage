# ACP diagnostic correlation 0.1.50

Contract: expose the failed known ACP request method together with existing numeric RPC code and HTTP status in runtime.error details. Correlate only the current child process pending request ID, allowlist method names, never copy provider method fields, nested bodies, URLs, keys or request parameters into details. Preserve unknown-response handling and accepted cancellation/ANSI behavior. No live provider, customer root-cause claim, UI edits, release or publication.

H1: core pending RPC entries discard their local method, so response rejection retains code/data but cannot identify the failed operation. Current source confirms this loss.

Fixture: existing isolated fake CLI speaks line-delimited JSON-RPC, completes handshake by default, and will emit synthetic -32603/HTTP 500 on the selected operation; unmatched response IDs must leave a happy turn successful. Only synthetic canaries. Ownership: core.ts, acp.test.ts, narrow fake-acp-cli.ts modes, this record.

Acceptance/check set frozen: full server/drivers/acp/acp.test.ts via Vitest (including prior cancellation/ANSI coverage), TypeScript server check, focused oxlint on three changed TS files, git diff --check. Regression cases: initialize, session/new, session/prompt local method correlation despite a spoofed method in provider error; unknown response ID ignored; helper allowlist and numeric bounds. These establish synthetic ACP runtime behavior only, not customer/provider or native-platform proof.

Budget: maximum two verification rounds and two unsuccessful corrections. Current: ACCEPTED, implemented and synthetically verified; rounds 1/2, corrections 0/2. Parent owns serial integration; worker may commit, never push/publish.

R1 evidence (2026-09-10 local, base 78ca1662): `pnpm exec vitest run server/drivers/acp/acp.test.ts` PASS 68/68 in 15.60s; `pnpm exec tsc --noEmit -p tsconfig.server.json` PASS; `pnpm exec oxlint server/drivers/acp/core.ts server/drivers/acp/acp.test.ts server/testing/fake-acp-cli.ts` exit 0 with two unchanged no-useless-spread warnings (core loops, not change-induced); `git diff --check` PASS. No corrections or extra verification rounds required. Unknown response remains ignored, spoofed remote method cannot override local correlation, and original 55 tests remain passing. Method IDs stay within the existing child-local pending map. Customer -32603 cause and native platform behavior remain unproven; this adds diagnostic evidence only. No live credentials/providers or normal sessions used. Task-owned node_modules symlink retained for parent integration checks; no running fixture remains.

Commit skill used for conventional subject only: its background cross-critique would expand the frozen check set and is excluded by the user scope/verification instructions. Next authorized action: parent serial cherry-pick and integration verification.
