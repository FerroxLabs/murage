# Batch D checklist: int green to "server sha to MurageMobile"
1. Pin the sha: `git -C /work/mb-105-git.git rev-parse feat/1019-restore-park-int` = INT_SHA. Freeze: no more merges to int while review runs (new commits restart from step 2).
2. build host: df -h, load under 25 (else one container). Full email suite + shared + tsc (tsconfig.server.json and tsconfig.json) on INT_SHA via run.sh lane scripts; diff reds against base fad83e823; branch-only reds must be empty.
3. Run proof: `bash proof/run-proof.sh int-<short> INT_SHA`. Required: all steps green incl. step 5 (not BLOCKED-STUB), crash C4-C10/C12-C14 green, DELETE block diff = 1 line.
4. Record C1-C3 and C11 as gaps in the evidence unless covered.
5. Mutants: rerun park-B mutants.py and A3 mutants on INT_SHA; all killed.
6. Prompts: sed INT_SHA into PROMPT-batchD-{opus,astra,fable}.md; attach proof summary.txt path. Confirm INT_SHA is in the wt-ch1g-deploy repo object store (else fetch, never checkout).
7. Reviews: Astra via `CODEX_HOME=<acct> codex exec -m gpt-6-astra </dev/null`, check log header; Fable via MurageMain; Opus last. Astra MUST cover the phone other-setups remove route (MurageMain merge condition). Cross-check of translations (records feda55e1111e, 5ca42da1f829, same-as-english) goes to Astra/Sol.
8. Verdicts: Opus PASS, Astra and Fable AGREE. Any must-fix: fix on a new commit (no amend), restart at step 1.
9. Copy: confirm only approved strings changed (N1-N3 + 11-11 set); translations merged and keys used via t().
10. Stamp `date -u`; write handoff; send MurageMain (not MurageMobile directly) the INT_SHA, wire-contract diffs, and proof summary.
11. MurageMain sends server sha to MurageMobile. Owe: any field move vs OWNER-VIEW-WIRE-CONTRACT.
12. Cleanup: remove park-D src-*/out-*, worktree, containers (parkD-*).
