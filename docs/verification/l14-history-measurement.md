# L14 continuation history measurement

The API test used one synchronous command to insert the additional 450,000 messages and records. The test waited only 60 seconds for that command to acknowledge. That deadline included fixture construction, before any continuation measurement. A slow setup could therefore fail with an unchanged result file without measuring the product at all.

The original test passed twice in this round, so the reported timeout was not reproduced. The pristine run did record a 34,996 ms event-loop stall during setup (`../evidence/l14-history-before.json`, server log `/tmp/murage-verification-evidence/server-1793999010955-3435.log`). The change addresses the setup timeout mechanism without claiming a reproduced product regression.

Setup now acknowledges at most 500 threads (12,500 messages) per command. Before each profile starts, an SQL count verifies the actual seeded history. Every measured scenario must contain nonzero profiler samples. All original assertions, including the command acknowledgement deadline, exact query plan comparison, positive query counts, per-pass deduplication and scope visit bounds, remain.

The revised isolated API test passed at both history sizes:

| Messages | Scenario | Queries | Cited pairs | Scope visits | Profiler samples |
| --- | --- | --- | --- | --- | --- |
| 50,000 | Engine switches | 2 | 4 | 4 | 1,276 |
| 50,000 | Stop and continue | 3 | 12 | 12 | 460 |
| 500,000 | Engine switches | 2 | 12 | 12 | 1,291 |
| 500,000 | Stop and continue | 3 | 24 | 24 | 561 |

Proof: `../evidence/l14-history-after.json` and `../evidence/l14-history-after.log`. Run with `L14_EVIDENCE_FILE=/absolute/evidence/path.json corepack pnpm exec vitest run server/continuation-history-api.test.ts`. This test is absent from base `b2588099f9`; the original HEAD test was run in a detached worktree.

The transport tests were unchanged. All eight passed at base and twice at the original HEAD, retaining the T5b release checks and T18e 50 ms p99 bound (`l14-base.log`, `l14-head-before.log`, `l14-pristine-api-transports.log`).
