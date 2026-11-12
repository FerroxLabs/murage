Field replay fix-round HANDOFF gate

The gate at reds-rest/evidence/handoffs.md assigns these complete suites to s2m:

- server/memory/lineage-allowance-reads.test.ts (lines 1112–1144)
- server/memory/upgrade-fix-r3.test.ts (lines 1146–1159)

Both pass unchanged on replay input 9c25dcadad6550fc080d2e0d36d1fea90260e6f6:
12 lineage tests + 19 upgrade tests = 31 passing tests. The first cold-chain
measurement is 11 rows at each of 300, 1,500 and 12,000 sets; the paged
measurement is at most 651 rows against its 652-row limit. The writable-opener
inventory passes on this tree; highlevel/thread-marks-restore.ts is absent here.
Do not infer a pass on an integration tree that adds another database opener.

Command (network-none container, the fixture setup supplies temporary HOME/data):

    pnpm exec vitest run server/memory/lineage-allowance-reads.test.ts server/memory/upgrade-fix-r3.test.ts --maxWorkers=1

Evidence: /work/build/afix-bld-s2m-r4/evidence/handoff-before.log
and handoff-before-container.log. Final-tip reruns and deliberate regressions
are recorded in the same job's DONE and evidence directory. These are passing
suite runs, not waivers of the inherited failure report. No product lineage
or upgrade implementation changed for this fix round.
