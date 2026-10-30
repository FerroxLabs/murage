# PATCH-READER-EXPOSURE-1010: what shipped 1.0.9 lets a Codex patch do unseen

Base ed8af4fd5 (1.0.9 as shipped). Source-traced, nothing executed. 2026-10-30.

## Answer

Real, rated **High, not Critical**. In 1.0.9, at **No limits**, a Codex patch whose `*** Add File` / `*** Delete File` /
`*** Update File` header starts with a space can write or delete any file the owner can, including the key files the
key guard protects at every level. There is no card. The tripwire stops the turn only after the change has landed. At Ask, Auto and Full access the
same trick is caught before the change, except for paths inside Codex's own writable roots that are outside the project
(`/tmp`, `$TMPDIR`, and any `writable_roots` in the owner's Codex config).

Two related gaps, found in the same trace, apply at **Full access**. Neither needs the whitespace trick:
- G2: a Codex apply_patch `*** Delete File:` outside the project is judged as an edit, never as a delete. The stop line
  never sees it, so Full access approves it with no card. Full access promises to stop before deleting outside the folder.
- G3: Codex runs `apply_patch` / `applypatch` written as a shell command itself (an argv or a `bash -lc` heredoc). It
  also puts an `apply_patch` helper on the shell's PATH. Murage's stop line reads that command as an unknown program, so
  a patch-delete outside the project passes at Full access (and on non-owner No limits turns).

## Versions

- Codex: every gated build, CODEX_GATE_MIN 0.129.0 (server/drivers/codex-hook.ts:44) to the current 0.165.0 (latest
  stable tag `rust-v0.165.0`). Murage does not bundle Codex; the owner's install is used.
  - 0.129.0 `codex-rs/apply-patch/src/parser.rs:266` `let first_line = lines[0].trim();` (each hunk header trimmed).
  - 0.163.0 / 0.165.0 `codex-rs/apply-patch/src/streaming_parser.rs:176` `let trimmed = line.trim();`, matched as a header
    in StartedPatch/AddFile/DeleteFile modes (:188, :199, :217). Update mode uses `trim_end` only (:228), so an indented
    header there is a context line (test `keeps_indented_update_markers_as_context_lines`).
  - Both: whole patch `trim()`, first/last line trimmed, `<<EOF` heredoc wrapper accepted (parser.rs 0.165.0:194-254).
    0.165.0 also accepts `*** Environment ID:` right after Begin (streaming_parser.rs:84-101).
  - Shell form: `core/src/tools/handlers/unified_exec/exec_command.rs:359` `intercept_apply_patch`; forms in
    `apply-patch/src/invocation.rs:27` (`apply_patch`, `applypatch`), :112 argv, :274 `bash -lc` heredoc, :62 PowerShell.
  - Hook payload: `core/src/tools/handlers/apply_patch.rs:411-416`, `tool_input = {command: <patch>}`.
- Fuigo 1.0.32 (QUALIFIED_FUIGO_VERSION, server/fuigo-native-update.ts:43), `fuigo-tools/.../codex/apply_patch/parser.rs:200`
  `lines[0].trim()`. Not exposed in 1.0.9: Fuigo's apply_patch was held unproven at every level there. It becomes
  exposed only with branch a2a403d66, which is what the second BLOCK found.

## The mechanism (Codex driver, 1.0.9)

```text
*** Begin Patch
*** Add File: probe.txt
+ok
 *** Delete File: /Users/owner/Documents/ledger.csv
*** End Patch
```

1. Murage `parseApplyPatch` (codex-hook.ts:657) reads the space-prefixed line as hunk context and sees one in-project
   destination, so `routeDelivery` (codex-hook.ts:745-755) returns `allow, final, own-workspace`. No verdict, no key guard,
   no never-list, no stop line.
2. Codex is in AddFile mode, so it trims the line, matches the Delete header, and plans both hunks.
3. `emitter.begin` (apply_patch.rs:569) emits `item/started` fileChange with both paths *before* the orchestrator's
   approval and apply. Murage's tripwire (codex.ts:1825-1830, codex-hook.ts:836-842 `sameDestinations` set equality)
   sees a mismatch, so it refuses the turn and sends `turn/interrupt`.
4. Codex `assess_patch_safety` (core/src/safety.rs:67-125), with the gated `on-request` policy (codex-isolation.ts:120):
   - Ask/Auto/Full access run `workspace-write`. A path outside the writable roots gives `AskUser`. That approval
     reaches Murage after the refusal, so it is declined (codex.ts:1509). Result: **nothing changes and the turn stops**.
     A path inside a writable root that is not the project gives `AutoApprove`. Result: **applied before the interrupt**.
   - No limits (`fullAuto`) runs `danger-full-access`, so the result is `AutoApprove` for any path. Result: **applied**.
     The turn is stopped afterwards and shows "Codex ran `fileChange` without Murage's check".

## Levels affected and user outcome

| Level | Turn | Today (no trick) | With the indented header |
|---|---|---|---|
| No limits | any | key-file write: key guard card; non-owner delete outside: stop-line card | written or deleted, no card; turn stopped after |
| Full access | any | see G2/G3 (no card for a patch-delete outside) | caught before apply, except Codex writable roots |
| Auto, Ask | any | edit outside the project: card | caught before apply, except Codex writable roots |

Severity, by user outcome: High. A No limits bot fed a crafted patch (prompt injection through a page, an email or a
webhook) can add a key to `~/.ssh/authorized_keys` or delete a file outside its folder with no card. The owner learns
only from the stopped turn. It is not Critical: it needs No limits, the owner's own most-permissive level, and a patch
that a model does not write unprompted. At the other levels, the tripwire and Codex's sandbox catch it before the change.
G2/G3 are High at Full access: a file outside the folder can be deleted without the stop card, which is a data risk.

## Fixed in fix/1010-issue-perms (designs/ISSUE-PERMS-1010.md rev 3, #7(b))

One strict reader serves both engines, so the whitespace trick, G2 and G3 close together. Nothing here needs a Codex or
Fuigo change.
