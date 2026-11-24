# C-pre: baseline learning releases

Base: c12aaad9341e8f87126a193f35b5c2768f0aa66f. Test-only changes; no product edits.
Historical fixture source: 98fd90c1c6008f4c1bcfa1c3fc395b298fab9b75, adapted to the current bot-folder fixture. Historical green is not inherited.

Executed through it-remote.sh, IT_JOB=bld-scopes7c, IT_W=/fixture/jobs/bld-scopes7c/wt, IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh. TMPDIR=/tmp/e2e. Real SQLite connections and the shipped adapters with isolated fake CLIs; no live installation or external engine credentials.

* RED: `pnpm exec vitest run server/memory/learning-send-race.p1.test.ts server/memory/learning-send-race-engines.p1.test.ts --maxWorkers=2`: 3 failed, 3 passed. Claude stdin.end, Codex turn/start and ACP session/prompt each observed `hide-committed, bytes`, rather than `hide-busy, bytes`. Each prior-hide control passed with zero writes. Log: `/fixture/jobs/bld-scopes7c/evidence/c-pre-red.log`.
* RED: the H1-CAPABILITY case in cli-memory-learning.test.ts returned `[]` and dispatched to the adapter without fenced-learning capability. Existing 19 neighbour cases passed. Log: `evidence/a0-c-pre-red.log` in the same lane directory. The unrelated A import error in that run is infrastructure evidence, not behavioral RED.
* GREEN controls: learning-send.test.ts, learning-send-fence.test.ts, learning-send-transports.test.ts, acp/send-fence.test.ts and stop-gate.test.ts passed in `evidence/foundation-neighbours.log`. That combined run deliberately also contains A/B RED tests; it is not a green combined suite.
* Typecheck: `pnpm exec tsc --noEmit` exit 0 in `evidence/foundation-tsc.log` before subsequent A/B test additions.

C0/C1 must turn the three actual-write races and capability witness green and preserve accounting and Stop controls. C2 still owes final inventory mutants, measurements and integrated-SHA evidence. No release readiness is claimed by this test-only slice.
