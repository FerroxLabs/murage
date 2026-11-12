# F7 shared payment boundaries

The hlf7 audit at hub tip `28c8cd98419eb7be3d3c02882e04c83afd43e12e`
identified five failures: invoice collection recovery, documented invoice
identities, missing review totals/snapshots, read response location binding,
and `altId` binding when freezing requests.

`server/highlevel/operations/payments-seams.test.ts` contains the five original
regressions and additional adversarial cases. The tests use the real host,
client, held requests and action/approval journals with FakeHighLevel. They
cover create/text2pay replay, conflicting returned identities, ordinary and
reviewed reads, immutable review values, incomplete/old/foreign recovery
witnesses, retained discounts/taxes, and invoice changes during approval.

The explicit shared contract amendment adds an optional server-derived approval
context to prepared requests, copies it into the held request, and includes its
hash in the review digest. Values remain in memory. Recovery persists only the
ownership IDs it needs. Existing wire schemas, scopes, endpoints and preflight
allowlists are unchanged. Historical F0/F0.1 hash tests normalize only the
listed additions; current frozen snapshots pin the amended signatures and
invoice identity aliases.

Invoice updates recheck the complete preflight invoice's digest after admission
waits. A changed invoice stales before dispatch. This does not create a provider
conditional write; a provider change after the final read is still possible.

Run verification only through the job's offline container runner:

```sh
bash /work/fuigo-builds/swarm-b/afix-hlf7-r3/it.sh 'pnpm exec vitest run server/highlevel shared/highlevel.test.ts scripts/release-workflows.test.mjs src/components/HighLevelReviewValues.test.ts && pnpm i18n:check && pnpm typecheck'
bash /work/fuigo-builds/swarm-b/afix-hlf7-r3/it.sh 'node --experimental-strip-types scripts/highlevel-hlf7-fixture.mjs'
bash /work/fuigo-builds/swarm-b/afix-hlf7-r3/it.sh 'node scripts/highlevel-hlf7-mutants.mjs'
```

The fixture follows `docs/verification/README.md`: it launches an isolated
server with a temporary home/data directory, runs Doctor against its explicit
URL, drives fake payment workflows, saves the results and closes that exact
server. Evidence is under `.test-tmp/afix-hlf7-r3`. It proves applied update,
cached RPC replay, exact review values, foreign response refusal and stale draft
refusal. It does not prove native renderer or owner Settings/grant workflows.
The mutation runner creates a separate temporary source copy and restores each
mutated file before the next case.

There are no new English UI strings in this amendment. The changed-state error
reuses the existing sentence “The reviewed request changed.” Review values use
the existing JSON value view.
