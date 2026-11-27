# PKT0-19d handoff (2026-11-10)

Lane /root/fuigo-builds/pkt0/wt, branch fix/1019-browser-pkt0 (head eb08fe5c7). Base 87d645cc6. Shared repo /root/mb-105-git.git has no remote: "dev push" = a refs/heads/dev/* branch in it.

## Part 1 (browser lock): integrator fix DONE
- dev/1019-browser-pkt0-p1 = 2ee7d66cb = cc36a0c7b + one commit (same content as eb08fe5c7). Part 1 only, no Part 2 code.
- MurageMain's tsc errors were real, and showed a wiring bug: `frames` had been added to the ENGINE transport (service.ts createEngine), so the executor never got a frame listing and the extension-route lock never ran in the service. Now `frames` is on the executor `transport` (service.ts ~1204). Service-level test fakes (18 files) now answer Murage.getAllFrames with a lone top frame.
- tsc -p tsconfig.server.json and tsc -b: both clean. vitest server/browser-extension: 1405 passed, 0 failed tests; 7 files fail at import with "verification server exited before it was ready" = the same 7 file-level failures as base (base-run.log).
- Full head suite (browser, use-my-chrome, drivers, cloud-home) vs base 87d645cc6: NOT re-run on the final tree (the earlier run was against stale token code and is void). Do: ./run.sh "pnpm exec vitest run server/browser server/use-my-chrome server/drivers server/cloud-home > /work/head4.raw 2>&1", compare FAIL lines to /root/fuigo-builds/pkt0/base.fails (strip ansi, ignore ms). Expect the same 32 tests + file-level import failures.

## Part 2 (AB engine token): STOPPED on Astra BLOCK 2
- Patch commit 1ccca49 in /root/fuigo-builds/abpatch/src (patch murage-control-token.patch, dist binary sha 31d2d1c6..., smoke 401/401/200 ok, target dir deleted). Murage side 9af74b859 (vitest 16/16).
- Astra acct4 review 2 (designs/PKT0-AB-ASTRA-REVIEW2.txt): BLOCK. Items 1,3,5,6,7 fixed. Item 4 (handshake deadline) is STILL partial = the same item blocked twice -> stop rule. Item 2 fix has no regression test. NEW item 8 (high): daemon.rs ~570 reads an unbounded line before the MAC check (memory exhaustion by a relay); CLI and HTTP-forward readers the same.
- Needed: per-operation remaining-deadline in control_token.rs ~386 plus a slow-peer test; bound every framed read (line length cap) with an oversized unterminated test; negative-counter test. Then a THIRD Astra read; per the rule, have Sean or MurageMain decide whether a second reviewer (Fable) joins before it.
- Codex on hz is 0.151 (too old for gpt-6-astra): use `npm install --prefix /root/fuigo-builds/abpatch/cx @openai/codex@0.163.0` and run cx/node_modules/.bin/codex; delete cx after.
- Not done: AB-ENGINE-PATCH-1019.md release section, push of Part 2.

## Evidence
designs/PKT0-IFRAME-LOCK-EVIDENCE.md: 9 of 15 real sites lock, 6 only because of frames. No lock change built.

## Cleanup state
abpatch: src, dist, patch, logs remain (no target dir, cx removed). pkt0: wt and base worktrees remain; scratch raw files and the p1 worktree removed.
