# Log sweep 108: source-only checks

Inspected `fix/108-log-noise` at `b4579e28e` (int/108), 2026-10-27.
Source: `/Volumes/Scratch/work/104-lastresort-evidence/reports-107/sean-log-sweep/FINDINGS.md`.
No builds, tests, network, live-data access, or runtime fixture verification performed.
These are static findings; the historical ~10 resets/day rate was not remeasured.

## 4a: Warm Claude continuation resets — cause still present

- `server/index.ts:11646` calls `continuationMemoryRevoked`; a true result logs a reset
  at `:11650` and clears the resume cursor at `:11674`. After-recall checks can also reset
  (`:11739`); `:11754` explicitly resets even an idle retained Claude session.
- `server/memory/disclosures.ts:142` judges the retained session; `:143` treats every
  non-`shown` verdict, including temporary `checking`, as revoked.
- Likely trigger: a turn arrives while memory revocation is pending over its retained context.
  `server/memory/deny-read.ts:86` reads thread/global pending windows; `:587` returns
  `checking("pending")` when that window reaches the session's last LSN.
  Missing lineage/not-ready threads also return checking (`:583`); session deny marks
  (`:571`) and policy/deletion-epoch changes (`:579`) produce deny-session/watermark resets.
- `server/drivers/claude.ts:5303` closes the retained process for "memory context reset".
  `server/memory/reset-watch.ts:30` only reports repeated resets; it does not prevent them.
  The log's generic "checking" reason cannot establish which pending/lineage case occurred.

## 4b: Deleted chat's Claude copy — still possible, but no longer unconditional

- `server/conversation-deletion.ts:1182` now runs an open-engine pass for foreign holders.
  `server/engine-history-run.ts:261` requires no process to name the conversation and all
  holders proven clear; `:287` retains only removal steps allowed by
  `server/engine-plan-core.ts:664`, leaving shared rewrites for the closed pass.
- Thus `<CLAUDE_CONFIG_DIR>/history.jsonl` (default `~/.claude/history.jsonl`) remains
  pending while Claude stays open, along with its referenced `paste-cache/<hash>.txt`:
  `server/engine-plan-files.ts:159` plans the shared rewrite and `:180` the dependent removal.
- If holders are not proven clear, or Murage's own active turn cannot be held
  (`server/conversation-deletion.ts:1223`, `engine-running`), the transcript also remains:
  `<CLAUDE_CONFIG_DIR>/projects/<claudeProjectKey(workspace)>/<session-id>.jsonl`, with
  its subagent/tool files. That path is planned at `server/engine-plan-files.ts:70` and `:172`;
  it is deferred by the safety gate, not absent from the planner.
- Pending records retry (`server/conversation-deletion.ts:1032`); source inspection does
  not prove any of Sean's historical deletions subsequently completed.
