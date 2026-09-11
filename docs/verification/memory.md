# Memory verification

Canonical contract: `.planning/MURAGE-MEMORY-BUILD-PLAN.md`. Execution counters and current gates live in `.planning/STATE.md`. Receipts are in `.planning/memory-evidence/P00.md` onward. This document does not replace their acceptance criteria.

## Identity and isolation

The development candidate is an uncommitted isolated worktree based on `395844de`. The running `release-private-395844de` app is private.7 and is separate. No new memory release or live-profile migration is implied by source, test or build evidence.

Use Node 24 and task-owned temporary profiles. Run shell commands through RTK. Preserve fixture logs, failed screenshots and process receipts before cleanup. Never point mutation or recovery checks at the user's installation.

## Named checks

```sh
rtk proxy pnpm exec vitest run server/memory/p10.test.ts
rtk proxy node --experimental-strip-types scripts/eval-memory.ts --fixture server/memory/testing/corpus.json --out .planning/memory-evidence/eval.json
rtk proxy node --experimental-strip-types scripts/verify-memory-dispatch.ts
rtk proxy node --experimental-strip-types scripts/verify-memory-skill-review.ts
rtk proxy pnpm exec tsc -p src/e2e/memory.tsconfig.json
MURAGE_E2E_DATA_DIR=<scratch dir outside the repo> rtk proxy node node_modules/@playwright/test/cli.js test --config src/e2e/memory.config.ts
```

These are documented commands, not instructions to restart consumed verification cycles. Reuse valid receipts and obtain an explicit extension when the recorded package limit is exhausted. The browser fixture owns its server/Vite/profile, runs desktop and mobile sequentially, and preserves screenshots under `$MURAGE_E2E_DATA_DIR/memory-results/` for visual inspection (the variable is required; browser evidence is never written inside the repository).

The evaluation script uses the frozen 240-query corpus, real authoritative service/worker/local model and the notebook baseline. Long-history fixture expansion is declared in its source and report. It never generates fake native answers or silently spends on a model. All 60 native answer cases require separate recorded cost admission and actual provider results.

## Evidence boundaries

- P06 service latency/resource passes do not establish final adapter, UI or load acceptance.
- Registry sinks and fake CLI transport establish local wiring. They do not establish native model quality or cross-platform parity.
- A worker smoke using staged `dist-server` files and an existing Electron executable is build-stage proof, not a new privately packaged app.
- SQL quota exhaustion must be distinguished from an OS-volume-full fault. Emulated Linux results are not native Linux performance evidence.
- Missing Windows, Intel Mac or Linux native proof stays unverified. No public release, notarization or update-feed result may be inferred from a private build.

## Native budget

The owner authorized at most US$10 in new charges and 64 native model turns across P07/P10, using existing credentials and isolated data. `.planning/memory-evidence/native-budget.json` is the root-owned reservation ledger. Reserve a verified worst-case amount before forwarding inference. Unknown cost admission blocks that route; uncertain settlement retains its reservation. No subscription/provider/live-profile changes are authorized by that evaluation budget.

## Current delivery state

The owner deferred sustained stress qualification and approved normal-use verification based on observed usage. The final isolated normal-use profile passed:20updates,40recalls,two current-revision fact checks and complete drainage within224ms. Retrieval quality, native owner UI, focused regressions and current packaged worker/server/MCP/signature checks passed. See `.planning/memory-evidence/NORMAL-USE-ACCEPTANCE.md` for the exact workload, evidence and limitations.

Current artifact is macOSarm64 `private.memory.3`, includingFuigo1.0.7; identity and checksums are in `.planning/memory-evidence/p11-memory3-artifact-identity.json`. It is privately packaged, not published/notarized/installed. Liveprofile migration was not performed. Stress failures are retained as deferred capacity findings; other native engine/MCP/answer-matrix and native platform coverage remains unverified. Normal-use acceptance does not establish whole-program parity.
