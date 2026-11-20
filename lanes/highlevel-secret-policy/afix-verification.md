# BLOCK repair evidence

Review baseline: `473788a199d8f14e9a4669b652a49f568894094f`.
Original behavioral baseline: `5daadeac8ebbdc4100d9b9f2805c5e4135262c5a`.
Only the three BLOCK findings in `arev-hl-c1-secret-policy/REVIEW-from-last.txt` are addressed.

All commands run through `/root/fuigo-builds/tools/it-remote.sh`, with
`IT_JOB=afix-hl-c1-secret-policy`, `IT_W` equal to this worktree and
`IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh`. Network is disabled;
runs are serial and launch load is below 60. All provider/storage responses
are fakes; filesystem durability uses an isolated temporary file.

The untracked `afix-evidence/` directory is retained beside this file.

1. `durability-red.log`: the actual main-process `updateDocument` callback is
   executed with real temporary bytes. The Windows filesystem model rejects
   a read-only flush, yielding `storage` instead of a successful commit.
   `durability-green.log`: Windows and Linux models save, flush and activate in
   order, preserve bytes, close handles, and prevent activation on flush error.
   This is portable OS-model coverage, not a native Windows run.
   `M-WINDOWS-READONLY-FLUSH` restores the old open mode and fails assertions.
2. `selectors-red.log`: independent 76/128-character vectors receive successful
   plans, and target 500 with a long ID reaches the wrong refusal branch.
   `selectors-green.log`: 75 is supported, 76/128 refuse `unsupported_locator`
   before scope inventory or any provider call, and 500 distinct 75-character
   IDs fit the request ceiling and five preparation batches. Public schemas
   are unchanged; input IDs are preserved. `M-BULK-UNSUPPORTED-SELECTOR`
   raises the internal bound to 128 and fails assertions.
3. `baseline-red.log`: three executable behavioral failures against the original
   baseline, with corresponding `baseline-green.log` against candidate code:
   plaintext opt-in permits basic_text, the packaged HighLevel credential save
   rolls back after a lost activation acknowledgement, and the host authorizes
   custom-field preparation with endpoint permission alone. The old handler
   and authorization method execute verbatim with fake surrounding dependencies;
   the latter has only TypeScript types stripped. The storage function imports
   directly from the baseline snapshot. No missing-module fallback, constructor
   stub or rewritten baseline implementation is used. The new capability bank
   replaces the old PIT save path for the uncertain-commit GREEN witness.
   `M-BASELINE-UNSAFE-STORAGE`, `M-BASELINE-ROLLBACK-UNCERTAIN-BANK` and
   `M-BASELINE-ENDPOINT-ONLY` independently restore those behaviors and must
   each be assertion-killed by the matching candidate witnesses.

The earlier `secret-red.log`, `secret-red-node.log` and `policy-red.log` remain
historical artifacts. Their missing-module/uncommitted-stub failures are not
accepted behavioral RED evidence; these witnesses supersede those claims.

Recreate the baseline snapshot from the repository on the host (no tests run):

```sh
base=5daadeac8ebbdc4100d9b9f2805c5e4135262c5a
out=lanes/highlevel-secret-policy/afix-evidence/baseline
mkdir -p "$out/electron" "$out/server/highlevel"
for file in electron/main.mjs electron/secret-storage-policy.mjs electron/secure-credential-state.mjs server/highlevel/host.ts; do
  git show "$base:$file" > "$out/$file"
done
```

Container commands, with output redirected into `afix-evidence/`:

```sh
HL_WITNESS_MODE=baseline node --test lanes/highlevel-secret-policy/baseline-behavior.node-test.mjs
HL_WITNESS_MODE=candidate node --test lanes/highlevel-secret-policy/baseline-behavior.node-test.mjs
node --test electron/highlevel-credentials.node-test.mjs
node node_modules/vitest/vitest.mjs run server/highlevel/scope-policy.test.ts
node lanes/highlevel-secret-policy/run-afix-mutants.mjs
```

The baseline command intentionally exits nonzero with three `ERR_ASSERTION`
failures. Candidate commands must exit zero. The mutant runner restores exact
product bytes in `finally` and writes each assertion failure plus `mutants.json`.
Final container gate: **134/134 passed** (119 Vitest: policy 89, coordinator 10,
S0 planning 6, contract freeze 10, snapshot 4; Node: bridge 12 and baseline
witnesses 3). All five repair mutants are assertion-killed. Full `pnpm typecheck`
exits 0; main syntax passes. A fresh `launchVerificationServer` fixture with
only the fake engine returns Doctor `ok:true` via its explicit URL/dataDir.
`fixture.close()` stops its exact child and removes its temporary profile.
Launch/Doctor JSON, server log and exact commands are retained in `afix-evidence/`.

Leak guard v2 reports 0 added matches; the unchanged whole-tree count is 582
inherited matches. Raw leak reports stay untracked in `afix-evidence/`.
No exclusions were added. No new design deviation or file-ownership extension
was needed. Original C2-host integrated late-check and release handoffs remain
as previously documented; they were outside these three BLOCK repairs.
