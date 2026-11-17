# S0: Hermes 0.22.2 ACP wire evidence

Captured 2026-11-10 for Murage 1.0.19 at `91888216a57ed7eba158287db77a6dc3994b7f97`.
Only fixtures and capture tooling changed. **36 scenarios, 106 real tool/permission frames**,
covering all 19 `HERMES_ASK_FREE_TOOLS` entries, terminal, execute_code and one stdio MCP tool.

This is the public, unmodified v0.22.2 Python source release at
[`d923a5eb`](https://github.com/NousResearch/hermes-agent/tree/d923a5eb487a17c0a68801bba9ef0f56c81040a8),
run through its real CLI/ACP server and executor. It is not a fake ACP engine or direct calls to
adapter builders. The existing gate-box executable was unavailable; byte equivalence to that
installation is **not established**. Pin this capture to this source and dependency manifest,
not every 0.22.x release. `PROVENANCE.json` records executable/source hashes and reported version.

## Answers and consequences for S2/S3

**An execution title is not generally the bare tool name.** The builder emits the exact engine
name, then `": " + preview` when there is a preview; otherwise only the name. Its exception
fallback also uses the bare name. Match a known name with the boundary `^(?:NAME)(?:: |$)`;
ignore the entire argument-derived suffix. Cross-check the pinned kind. No captured title is
wholly argument text. Examples: `terminal: printf s0-terminal`, `read_file: seed.txt`, bare
`skills_list`, and bare `patch` for the V4A invocation. Completion frames carry kind and status,
but no title. Permission-completion frames carry only call ID and status.

**Fresh default ACP sessions ask for supported write_file/patch edits. This is not universal.**
Default asked for file creation, replacement patch, V4A add, a repeated overwrite attempt,
and edits after returning from another mode. Native edit options are only `allow_once` and
`deny`. The repeated overwrite was subsequently refused by Hermes's stale-write guard even
after a read in a separate turn; the evidence does not claim it succeeded. Denying the final
write left `denied.txt` absent. In both `accept_edits` and `dont_ask`, workspace writes and
patches completed with **zero asks** and final contents `after\n`. The source still asks for
sensitive paths in those modes. Invalid proposals can fail before an ask.

At the Murage base, `hermesSpawnArgs` names a profile, and `configureSession` sets only the
model. Hermes has no Murage `askStop.sessionMode`; fresh sessions therefore use default mode,
independent of Murage's Ask/Auto/Full access/No limits labels. This capture does not verify
restored user sessions or an end-to-end Murage conversation. D3's native-edit route is viable
only with default mode enforced/known; otherwise use the proposed hook route.

**Three design assumptions need correction before later slices are implemented:**

1. Most built-in execution starts omit `rawInput` entirely (table below), and completions do
   not restore it. There is no transport-field deletion list that makes a whole hook input
   equal to absent execution input. Terminal's full arguments, including the deliberate
   `tool_name: "read_file"`, survive in the hook ask but disappear from execution rawInput.
   MCP preserves exactly `{text:"s0-mcp"}` on both sides. Do not silently drop all arguments
   or claim §5 digest parity from these frames.
2. Native edit asks have title `Approve edit: PATH`, kind `edit`, and an engine-built envelope
   `rawInput: {tool: "write_file" | "patch", arguments: ORIGINAL_INPUT}`. The title/kind alone
   cannot distinguish those tools. The source proves that envelope's `tool` is runtime-owned;
   accepting it needs an explicit exception to the design's blanket rawInput prohibition.
   Mapping asks to `hermes/edit` will not equal execution identities for write_file/patch.
3. Hook ask → permission-completion → execution start is the hook order. **Native edits send
   execution start → edit ask → permission-completion → execution completion**, with distinct
   IDs (`tc-*`, `edit-approval-*`). A tripwire cannot treat every start as execution that must
   already have an allow. Wrapped shell code also produces both a hook ask and a native shell
   ask. All correlations/order are preserved in `tool-frames.json` and `frames.jsonl`.

The 4,613-character execute_code payload reaches the hook intact (`truncated:false`); its title
is shortened. Python `-c`, a Python heredoc and `bash -c` all ran harmless fixture programs.
The conflicting `tool_name` argument never changed the terminal title/kind or hook placeholder.

## Pinned kinds and input availability

All names use the grammar above. `observations.json` gives exact titles and original wire lines.

| Kind | Tools | Execution rawInput |
|---|---|---|
| read | read_file, skills_list, skill_view, vision_analyze | absent |
| search | search_files | absent |
| fetch | web_search, web_extract | absent |
| execute | terminal, execute_code | absent |
| edit | write_file, patch | absent |
| other | session_search, todo_list, clarify, memory, read_terminal, read_window_below | absent |
| other | tool_describe, video_analyze, show_tip, x_search, mcp__s0__echo | present with nonempty arguments |

For generic tools with empty arguments, rawInput is absent too. `other` comes from the adapter's
fallback map, not proof of read-only behavior. In particular **memory successfully saved a note**
without an ask. The free set is not uniformly read-only; do not describe its standing allows as
such. `todo_list` was a read of an empty list here, not proof that every todo invocation is a read.

Service/UI-dependent tools have genuine start + failed completion frames: web_search (network
unavailable), web_extract (private URL blocked), vision/video (missing local media), clarify and
desktop tools (no UI callback), x_search (empty query), skill_view (missing skill). These prove
adapter shape on failure, not external service success. No external service was contacted
successfully. All OS networking was restricted to loopback.

Source hashes, isolation, exact runtime provenance and capture instructions are in
`PROVENANCE.json` and `README.md`. `python3 verify.py` checks this evidence offline.
