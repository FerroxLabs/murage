# ISSUE-PERMS-1010: three routine-stopping holds (murage-releases #9, #7a, #7b)

Base ed8af4fd5 (1.0.9 as shipped). Branch fix/1010-issue-perms. Rev 3, 2026-10-30.

Rev 3 answers round 2 (Astra BLOCK, High on B): the patch reader is replaced by a strict reader of the engines' real
grammar that fails closed (section "Rev 3: #7(b) the patch reader"); A's stored "other" origin now wins over a routine
level for the waiver. Exposure of shipped 1.0.9: designs/PATCH-READER-EXPOSURE-1010.md.

Rev 2 answers round 1 (GrokBuild BLOCK, Astra BLOCK): A keeps the owner-channel and unstated-origin holds of 1.0.8 E1;
B judges what a patch takes away (Delete File, a moved file's old name) as deletes and reads `*** End of File`;
C is moved whole to its own design lane, ACP-OWNTOOLS-1010 (House Rule 5: a second failed review of C would stop
A and B, which are ready), with every round 1 finding on C written into that lane's requirements below.

Each fix makes the owner's level apply to a call Murage can identify by a fact the model does not write.
Nothing here touches the never-list (server/always-ask.ts), the key guard, the stop line or the
destructive guard: they still run first, on every level, for every call below.

## Fix A: murage-releases #7 (a), a slow environment check held every routine command at Full access

**Cause.** server/auto-approve.ts:1022 waives `envUnchecked` (the F12 environment check timed out or
could not start) only when `context.fullAccessOrigin === "owner" && hasFullAccess(bot)`. A scheduled
or manual routine run is origin "routine" (server/index.ts:11033-11037, and fullAccessOriginOf), so
one slow check holds every Fuigo or Codex command of a Full access routine on a card nobody sees.

**Change.** The waiver is `(context.fullAccessOrigin === "owner" || origin === "routine") && fullAccessCovers(bot, origin)`
with `origin = fullAccessOriginOf(context)`. True for an owner turn stated as such at Full access (as today) and for a
routine run judged at Full access or No limits (origin "routine" needs `routineLevel` and not `unattended`; the caller has
already applied the routine's own level to `bot`). False for Ask and Auto (hasFullAccess is false), for "other" (a
webhook, someone else's message, a stored "other" origin: fullAccessOriginOf honours a stored origin first), for the
owner's channel message (kept as 1.0.8 E1 holds it, option on or off) and for a turn whose origin is not stated.
The E1 test's two routine rows move from held to waived; every other E1 row is unchanged.

**Why it cannot be spoofed.** The origin and the level come from Murage's own turn record and the
routine's saved level, never from the call or the model. Nothing about the waived call changes:
`envUnread` (the check ran and the map could not be read) still holds at every level, and the
never-list, key guard and stop line still read the command.

**Not done (gap test 5, simpler cut).** No retry of the check with a longer budget: at Full access the
waiver already lets the command through exactly as an owner turn does today, and at Auto/Ask a retry
would add a second wait with no change in outcome. Kill criterion: a routine at Auto still showing
U20 cards in the decisions log after 1.0.10, then add the retry.

## Fix B: murage-releases #7 (b), Fuigo's apply_patch was held at every level

**Cause.** Fuigo's `codex` toolset (fuigo-agent config.rs codex_toolset) files `apply_patch` as ACP kind
`edit`, title "Apply patch", no `locations`, rawInput `{patch}` (fuigo-shell acp_session_impl
tool_calls.rs ToolInput::ApplyPatch), stamped `_meta["fuigo/tool"] = {version 1, namespace "codex",
name "apply_patch"}`. STAMP_NAMESPACES is `["mcp","fuigo_build"]` and STAMPED_TOOLS knows only
opencode/write (shared/app-action-grant.ts:83, :192), so the call resolves unproven at every level.

**Change.**
1. shared/app-action-grant.ts STAMPED_TOOLS gains `["codex", Map([["apply_patch","edit"]])]`. Like
   opencode/write: the exact name AND the ACP kind it is filed under must both match; any other codex
   name, or apply_patch under another kind, stays unproven ("a codex tool Murage does not read").
2. server/drivers/acp/core.ts, at the permission ask, for exactly that stamp and kind: the patch is read
   with the one existing reader, `parseApplyPatch` (server/drivers/codex-hook.ts, the Codex driver's
   reader: Add/Update/Delete/Move headers, a whole envelope or nothing). Its destinations become the
   call's `locations` (`[{path}]`, merged after any the engine sent) before `filePaths`, the summary
   and `toolCall.input` are built, so the ACP edit contract, the stop line, the own-workspace and
   project-root checks, realKeyPaths and the push risk all read the real destinations, relative ones
   against the turn's cwd as for every ACP edit (own-workspace refuses a relative path; realKeyPaths places
   it). The added bodies stay in `rawInput.patch`, which the key guard's argument scan already reads whole.
4. What a patch takes away is a delete (round 1 High, both reviewers). `parseApplyPatch` also returns
   `removed`: every `*** Delete File:` path and the old name of every Update that a `*** Move to:` renames.
   server/stop-line.ts classifyAsk, for a call resolved as engine `apply_patch` with the `codex` stamp, judges
   `removed` as `delete` paths (`classifyStopLine("delete", {paths})`), so deleting or moving a file out from
   outside the folder stops exactly as a kind `delete` call does, at Full access and on every routine (No limits
   lifts it only on the owner's own turn, as for every delete). A `Move to` with no file before it is unread.
5. `*** End of File` (the marker inside an Update hunk) is read; the reader refused it as an unknown header
   (Astra r1, codex-hook.ts:678), which also held such patches on the Codex driver.
3. A patch `parseApplyPatch` cannot read whole (not a string, over the size limit, a header it does not
   know) files `toolInputMissing: "patch"`: an unread card with its reason, never an edit with no path.

**Why it cannot be spoofed.** The identity is the engine's stamp (Rule 8), checked by exact namespace,
name and filed kind; the paths come from the patch the engine will apply (the same text Fuigo parses),
never from the title. A model that writes a misleading title changes nothing; a patch that names a key
file or a folder outside the project is judged on that path.

**Scope note.** The codex toolset's read_file, list_dir and grep_files are not added: the reporter's
bundle shows only apply_patch cards. The Fuigo real-engine row (below) records whether Fuigo asks for
them at all; if it does, they join with their own contract rows in this lane.

## Rev 3: #7(b) the patch reader (House Rule 5 design pass after the second BLOCK)

**Cause of the second BLOCK.** `parseApplyPatch` matched only unindented headers and read a space-prefixed line as hunk
context. Fuigo 1.0.32 (`parser.rs:200` `lines[0].trim()`) and every gated Codex (0.129.0 `parser.rs:266`; 0.165.0
`streaming_parser.rs:176`) trim a hunk header that follows an Add File or Delete File hunk. ` *** Delete File: /x` was
invisible to Murage, but the engine ran it. The same trace found that Codex is exposed in shipped 1.0.9
(PATCH-READER-EXPOSURE-1010.md), along with two Full access gaps (G2, G3) closed here too.

**Decision (MurageMain): fail closed and port the engines' header rules.** One strict reader, `parseApplyPatch`
(server/drivers/codex-hook.ts), keeps its name and callers (Codex hook route, ACP core.ts, stop-line.ts). Rule: it accepts
only a patch both engines read the same way, hunk for hunk. Anything either engine might read differently is unread
(null), and the patch keeps its card ("Murage could not read this call whole").

1. **Envelope, as both engines.** The whole text is trimmed with Rust `char::is_whitespace`: U+0009-000D, U+0020,
   U+0085, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000. It is split on `\n`, with one trailing `\r`
   dropped per line (Rust `lines()`). The first and last line, trimmed the same way, must be `*** Begin Patch` and
   `*** End Patch`. Otherwise, only when the first line is exactly `<<EOF`, `<<'EOF'` or `<<"EOF"`, the last line ends
   with `EOF` and there are at least 4 lines, the inner lines must pass the same check (both engines' lenient mode).
2. **The `***` rule (fail closed).** A body line is a marker line when, trimmed of every Rust or JS whitespace character
   (the union, so U+FEFF too), it starts with `***`. A marker line must equal its trimmed form: no leading or trailing
   whitespace at all, in any hunk. Then, by position, it must be exactly one of these:
   - `*** Add File: P`, `*** Delete File: P` or `*** Update File: P`, where P is non-empty and P equals its own trim.
     The hunk before it must be complete: an Update with at least one change line, and no chunk left empty.
   - `*** Move to: P`, only on the line directly after an `*** Update File:` header (both engines).
   - `*** End of File`, only inside an Update chunk that already has a change line. After it, only an empty line, an
     `@@` line or a header may follow.
   Any other marker line makes the patch unread: `*** Environment ID:`, a second `*** End Patch`, an indented header in
   an Update hunk (context to Codex, ambiguous across engines), or a header with a trailing tab or a CR left over.
3. **Body lines, as both engines.** Before the first hunk, nothing is allowed. In an Add hunk, only a `+` line. In a
   Delete hunk, nothing (the next line must be a header). In an Update hunk: `""`, or a line starting with a space, `+`
   or `-`; `@@` or `@@ <ctx>` opens a chunk, but not straight after an empty `@@`. Any other line is unread. At the end,
   there must be at least one hunk and the last Update must not be empty.
4. **Output (unchanged shape).** `destinations` (each hunk's path and each Move target, in order), `added` (the `+` bodies
   per destination, a Move carrying its Update's body), and `removed` (each Delete path and each moved file's old name).
5. **G2, Codex driver: a patch-delete outside the folder reaches the stop line.** `routeDelivery`'s apply_patch ask puts
   `removed` in its toolCall input (`{paths, cwd, removed}`). `classifyAsk` judges a `removed` string array on an `edit`
   call as `delete` paths, as it does for the Fuigo stamp. A Murage-built input can only add a stop, never clear one. The
   in-project own-workspace allow is unchanged, because a delete inside the folder is not a stop.
6. **G3, shell form (1.0.10, designs ISSUE-PERMS-DESIGN-1010 section 3 item 4).** Any shell command whose text matches
   `/apply_?patch/i` is an unknown delete, with no accepted form, on every OS and every engine (`classifyStopLine`, before
   the shell or PowerShell reader runs; Auto's `deletesPlacedInside` refuses such a line too). Codex runs the plain argv and
   heredoc forms as its own apply_patch tool, which the strict reader above judges; only other forms reach its PATH helper.
   Accepted cost: `grep apply_patch README.md` cards at Full access. The rev 3-5 shell-form readers (one plain accepted
   form, `dynamicProgram`, wrapper value options, `eval`/`source`/`env -S`/depth rules) are dropped and the rest of the
   shell reader is the one shipped in 1.0.9; the obfuscated-shell class (`a$'pply_patch'`, `r$'m'`, `$v`) is unchanged from
   1.0.9 and is closed whole by 1.0.11's proven grammar. Tests: R3-8, R3-16 and server/stop-line-bypass-corpus.test.ts.

**Why it cannot be spoofed.** Murage judges only the hunks both engines would run. A spelling that one engine might
treat differently is never read as harmless. It is unread, and the card stays. The cost is a card for rare legitimate
patches, such as an indented `***` line inside an Update or an Environment ID. Kill criterion: a decisions log showing
such cards on real Codex/Fuigo turns after 1.0.10. Then port that one form exactly, with its test.

**Tests (server/drivers/acp/issue-perms-1010.test.ts, Rev 3 block).** Each runs the same patches on the Fuigo ACP path
and the Codex hook path (`routeDelivery` plus `classifyAsk`):
- R3-1: a leading space, two spaces, a tab and an NBSP before `*** Delete File:` / `*** Add File:` / `*** Update File:`
  after an Add hunk: unread on both (Fuigo `toolInputMissing: patch`; Codex `ask`, `toolInputMissing: patch`).
- R3-2: the same indented header inside an Update hunk: unread (ambiguous).
- R3-3: CRLF line endings on a well-formed patch: read, with the same destinations as LF. A header ending `\r\r`, or
  with a trailing space or tab: unread.
- R3-4: unknown `***` lines (`*** Environment ID: x`, `*** Frobnicate`, `***`, a middle `*** End Patch`): unread.
- R3-5: a Move to outside the project, at Full access: the stop line holds (old name in `removed`); a Move that is not
  directly after its Update header is unread.
- R3-6: a Delete outside the project at Full access: the stop line holds on Fuigo and on Codex (G2); inside the project
  it runs.
- R3-7: a heredoc-wrapped and a whitespace-padded envelope are read like the plain one.
- R3-8: (G3) `apply_patch <<'EOF' ... *** Delete File: /outside/x ... EOF` and `applypatch '<patch>'` as a shell command
  at Full access: stop line; `echo "$P" | apply_patch`: stop line (unknown delete); an in-project shell patch: no stop.
- R3-9: Astra r2's exact regression (Add inside, then ` *** Delete File: /elsewhere/ledger.csv`): unread on both.
- A7 (#7(a) Medium): a stored `fullAccessOrigin: "other"` with `routineLevel: true`, `unattended: false` at Full access
  with `envUnchecked`: held (U20).

## Rev 3: #7(a) stored "other" wins for the waiver

`fullAccessOriginOf` returns "routine" before it reads a stored origin (auto-approve.ts:976). That order is left alone
for every other use. The U20 waiver alone now reads the stored origin first:
`(stored === "owner" || (origin === "routine" && stored !== "other" && stored !== "owner-channel")) && fullAccessCovers(bot, origin)`.
A turn whose record says someone else started it is never waived, whatever its routine level.

## Fix C: murage-releases #9, moved to its own lane ACP-OWNTOOLS-1010 (design first, 1.0.10)

**Cause (unchanged).** An unstamped ACP engine asks for an MCP call with kind "other" and a title; Rule 9 never trusts a
title, so the call resolves unproven (app-action-grant.ts:199-201) and holds ahead of every level (auto-approve.ts:1026).

**Why it leaves this lane.** Round 1 found that the rev 1 layers are not yet a design that can be agreed. Its
requirements, for the ACP-OWNTOOLS-1010 design:
1. An exact per-tool allow entry in the engine's config is not server identity on Cursor (it still loads
   `~/.cursor/mcp.json`, cursor.ts:372-386, :464-470) or OpenCode (project config stays on in the owner's project,
   opencode-go.ts:728-734; `server_tool` spelling collides, e.g. `agents_create` + `bot`). Either the engine loads only
   Murage's handed servers, or the collision check covers the complete effective server set, or the entry is bound to
   the server's command/URL as Droid's persistentPermissions are (droid.ts:313-346).
2. Pre-allowing OWN_UNASKED changes Ask on ACP (auto-approve.ts:1185 needs Auto for acting rows): state the Ask
   policy per row and the handler boundary that replaces the verdict's guards, as Claude does.
3. Layer 2 must ask in every `/api/internal/*` route an own tool reaches (agents-proxy.ts callTool dispatches to many,
   :1011-1037, :1608-1612; murage_help is answered in the proxy, :1111), not one mount endpoint.
4. Custom ACP and any engine without a bound allow mechanism: a supported bridge or an explicit scope ruling from
   Sean (Astra r1 Critical 2: a card at every level is the reported failure).
5. Release rows for every engine it touches and for direct endpoint calls, on the packaged build.
Until it lands, the #9 workaround already given on the issue stands (run the bot on an engine that names its tools).

## Tests (each fails on ed8af4fd5, passes after; fake ACP engines; added to ci/gate-tests.txt)

- `server/drivers/acp/issue-perms-1010.test.ts`
  - A1: routine origin at Full access, `envUnchecked` timeout, Fuigo command: approved (fails before: unread-call U20).
  - A2: same at No limits: approved. A3: same at Auto: held with U20 (unchanged). A4: origin "other" at Full access: held. A5: owner-channel at Full access with the option off: held. A6: `envUnread` at Full access routine: held.
  - B1: resolveCall on codex/apply_patch filed `edit`: engine, name apply_patch (fails before: unproven).
  - B2: codex/apply_patch filed `other`, and codex/read_file: unproven.
  - B3: fake ACP engine (fuigo driver) asks for apply_patch with an Add File patch inside the project at Full access routine: approved; `filePaths` carry the destination.
  - B4: same patch adding `~/.ssh/id_rsa`: held by the key guard. B5: Delete File outside the project at Full access (not No limits): stop line holds. B6: a malformed patch: unread card `patch`.
  - B7: a Move whose old name is outside the project stops at Full access; the same move inside runs. B8: `*** End of File` is read. B9: `removed` lists Delete File paths and moved old names.
  - The E1 test (server/full-access-env-unchecked-108.test.ts) routine rows now expect the waiver.

## Real-engine rows (release gate, Full access routine, packaged build)

| Row | Engine | Routine step | Pass when |
|---|---|---|---|
| R1 | Fuigo (codex toolset) | edit a file in the project with apply_patch | no card; decisions log `auto-approved`, `filePaths` = the destination |
| R2 | Fuigo | shell command with the env check forced slow (MURAGE env-check budget 1 ms) | no card at Full access; a U20 card at Auto |
| R3 | Codex | shell command with the env check forced slow | same as R2 |
| R4 | Grok Build | shell command with the env check forced slow; one own tool (list_bots) | no card at Full access |
| R5 | Fuigo | apply_patch that adds a file under ~/.ssh | card, key guard |
| R6 | Fuigo | read_file / list_dir under the codex toolset | record whether Fuigo asks; if it does, file the rows |

## House rules check

- Rule 1 (every engine, every OS): A is in the shared verdict, so every driver and OS. B covers every engine that
  runs Fuigo's codex toolset (Fuigo, Grok Build). C (#9) is not fixed by this lane; ACP-OWNTOOLS-1010 owns it in 1.0.10.
- Rule 2 (the level means it; precedence): owner deny rules, then the never-list, then the level. A and B change only
  holds that came from Murage not reading something it can read; judge() still runs alwaysAskCommand (auto-approve.ts
  :940-946) before the level and before the U20 waiver, and the key guard and stop line before every grant. B adds a
  stop (removed paths), it removes none.
- Rule 3 (hard limits in the harness): verdict, stop line and driver only.
- Rule 4 (no dead ends): an unreadable patch keeps one card with its reason.
- Rule 5: C moved whole to its own lane after round 1, before a second review.
- Rule 7: no new setting, hold or surface.
- Rule 8: #7 (a) and (b) are Critical (they stop a routine); R1-R6 are their gate rows on the packaged build.
- Rule 9: no new copy.
- G3 rev 5 (dynamic program word): Rule 2 holds, it only adds stops (an unknown delete), never removes one; Rule 4: the
  card names the command; the accepted cost (`$EDITOR file` cards at Full access) is MurageMain's decision, logged here.
