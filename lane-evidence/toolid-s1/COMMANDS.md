# Container verification commands

Every test command used `/fixture-home/fuigo-builds/tools/it-remote.sh` with:

```
IT_JOB=bld2-toolid-s1
IT_W=/fixture-home/fuigo-builds/swarm-b/toolid-s1/wt
IT_ORIG=/fixture-home/fuigo-builds/tools/it-local-generic.sh
```

One container at a time, `node:24-bookworm`, non-root uid 2001, network disabled. Observed local loads 9–18; sampled remote loads 3–8, below 85. No vtq and no billable engine calls.

Commands inside the container:

1. `node_modules/.bin/vitest run shared/canonical-json.test.ts shared/tool-identity.test.ts --reporter=verbose` → `collection.log` (18 assertions-bearing tests executed).
2. `node_modules/.bin/vitest run shared/tool-identity-r12.test.ts --reporter=verbose` → `r12-red.log` (17 assertion failures, one pass; collection succeeded).
3. `node_modules/.bin/vitest run shared/tool-identity-r12.test.ts shared/tool-identity.test.ts shared/canonical-json.test.ts --reporter=verbose` → `parity.log`.
4. `node_modules/.bin/vitest run server/drivers/acp/tool-identity-reload.test.ts server/drivers/acp/hermes.test.ts server/runtime-event-out.test.ts --reporter=verbose` → `driver.log` (the command also listed the nonexistent `approval-delivery.test.ts`; that filter matched nothing, so the correct file was explicitly run next).
5. `node_modules/.bin/vitest run server/tool-identity-structure.test.ts server/drivers/acp/approval-delivery-108.test.ts server/drivers/acp/tool-identity-reload.test.ts server/drivers/acp/hermes.test.ts shared/tool-identity-r12.test.ts shared/tool-identity.test.ts shared/canonical-json.test.ts --reporter=verbose` → `green.log` (245 passed; inventory scanner mismatch failed and was corrected to match the reference binary exclusion).
6. `node_modules/.bin/vitest run server/tool-identity-structure.test.ts server/drivers/acp/tool-identity-reload.test.ts shared/tool-identity-r12.test.ts shared/tool-identity.test.ts shared/canonical-json.test.ts --reporter=verbose` → `final.log` (136 passed).
7. `node --experimental-strip-types lane-evidence/toolid-s1/verify-fixture.mjs` → `fixture.log`, `fixture.json`, `fixture-server.log`. This calls the documented `launchVerificationServer`, runs all control commands with the explicit fixture URL, and closes only its owned child/data.
8. After the same-id pairing tightening: `node_modules/.bin/vitest run shared/tool-identity.test.ts shared/tool-identity-r12.test.ts server/tool-identity-structure.test.ts --reporter=verbose` → `pairing-final.log`, followed with `&&` by `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` → `typecheck-final.log`, and `final-status.txt` only on success.

Intermediate type errors/import-path failures are retained in the earlier logs; `typecheck-final.log` and `final-status.txt` are the final typecheck evidence. The server fixture JSON records the launch URL, PID, temporary data and original log path, command sequence and results, and confirms cleanup. The original log is copied into `fixture-server.log` before the disposable container exits.
