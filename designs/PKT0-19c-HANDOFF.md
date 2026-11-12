# PKT0-19c handoff (2026-11-10, context limit)

Branch fix/1019-browser-pkt0, worktree fuigo-builds/pkt0/wt. Base 87d645cc6.

## Part 1 (browser packet): DONE
- cc36a0c7b head of the lock work: old-extension fallback (only error code method_denied -> DOM.getDocument pierce tree, iframe/frame/object/embed with no contentDocument locks, never cached), review fixes. tsc 0; guard+extension suites green; real-Chrome oopif test 3/3; extension node gate fails only for the missing Chrome for Testing (environmental).
- Base diff: head and base (87d645cc6) both fail the SAME 32 tests in 8 files (root/HOME and environment), 0 NEW. Includes the NOLIMITS 1.0.19 U8 test.
- Reviews: Astra acct6 PASS on 3rd read (BLOCK 1 and 2 fixed); Fable PASS, FIX items 2-5 fixed, item 1 (every cross-site iframe locks ads/embeds) is a decision for Sean.
- Accepted limit: sandboxed same-origin iframe not seen by the URL verdict on the extension route.

## Part 2 (AB engine token): code written, final checks OPEN
- Plan v3 in AB-ENGINE-PATCH-1019.md, Astra acct4 AGREE. Engine lane fuigo-builds/abpatch (src = v0.36.0 + commit 01dd010, patch murage-control-token.patch, dist/agent-browser-linux-x64 sha 31f3a92d...; target dir deleted, rebuild needed).
- Murage side: commit 26644d702 (browser-control-token.ts + test, engine env, relay header, stale-daemon recovery). UNCOMMITTED in wt: no-legacy-downgrade and negative-counter fixes to server/browser-control-token.ts and its test.
- Astra acct4 patch review: BLOCK with 7 findings (legacy downgrade, negative counter crash, Authorization in body, handshake deadline, non-UTF8 env, 2 vacuous tests). ALL FIXED in scratchpad copies, uploaded to abpatch/src and wt (uncommitted); a cargo test run was started (log abpatch/test4.log, build4.log).
## Next steps
1. Read abpatch/test4.log; if green: git commit --amend in abpatch/src, regenerate patch, cargo build --release, re-smoke (curl 401/200), copy binary to dist, delete target dir (check path first).
2. In wt run vitest server/browser-control-token.test.ts + tsc; commit.
3. Astra acct4 second read of the patch (a second BLOCK on the same item = stop and report).
4. Append fuigo-builds/pkt0/release-section.md (scratchpad copy) to AB-ENGINE-PATCH-1019.md after removing the legacy-fallback wording (no downgrade now: an unpatched Windows daemon is refused and Murage falls to the pid stop).
5. Compare wt/head2-suite.raw failing set with base (base.fails): must stay the same 32.
6. FIX-LEDGER row: the live ledger file was not found (only stale swarm1018 copies); ask MurageMain for its path.
7. Cleanup: fuigo-builds/pkt0 (wt, base worktree, scripts) and abpatch when closed; /tmp/abt-smoke is already removed. Nothing billable created.
