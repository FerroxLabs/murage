#!/usr/bin/env node
// @ts-expect-error The isolated replay harness is JavaScript test support.
import { replayBrowserRead } from "../../scripts/web-read-replay/run.mjs";
import { withFixtureMountMetadata } from "./fixture-mount-metadata.ts";
import { holdFixtureRelayClient } from "./relay-client-lifetime.ts";
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_LOAD_NULL  answer session/load with null, the way a real agent
//                       reports a session it no longer has, so the resume
//                       cursor is dropped and the driver falls to session/new
//   FAKE_CUSTOM_TOOL_SERVER / FAKE_CUSTOM_TOOL_LOG  every prompt calls the first
//                   tool of that owner server from session/new's mcpServers
//                   (fake-custom-tool.ts)
//   FAKE_ACP_MODE   happy (default) | project-propose (the Chief's New project
//                   proposal through the mounted agents server; see fake-mcp-propose.ts) | text-propose
//                   (the proposal as a block in the reply, after a refused shell ask) | lead-delegate | lead-loop | image | empty-reply | reasoning-only | exit-early | fail-after-text | hang | stall-after-text | no-auth | auth-required | permission
//                   | slow-tool (start a tool call and send nothing while it
//                     "runs" for FAKE_ACP_TOOL_MS, default 600, a quiet
//                     `sleep` or build, then finish it and answer)
//                   | stall-after-tool (finish a tool call, then go fully
//                     silent forever: the guard must still fire once no tool
//                     is running)
//                   | stall-after-text (stream one message chunk, then go
//                     fully silent forever — no update, no result, no exit:
//                     a wedged agent mid-answer. Nothing else will arrive, so
//                     the driver's prompt idle guard must fail the turn)
//                     | wrapped-tool  one tool call made through a "use a tool"
//                     wrapper, failing with a reason in its content
//                   | tool-image  two completed tool calls whose output carries
//                     an image: a custom MCP server's, and the computer
//                     surface's (a live frame, not a deliverable)
//                   | computer-exec-image  the computer surface called with a
//                     shell command in its arguments, answering with a frame
//                   | wrapped-tool-image  a custom MCP server's screenshot made
//                     through a "use a tool" wrapper, answering with an image
//                   | permission-always-only (same ask, offering only
//                     allow_always and reject_once)
//                   | permission-session-first (same ask, but the options are
//                     ordered the way Fuigo's edit prompt really orders them:
//                     `allow_always` "allow all edits this session" BEFORE
//                     `allow_once`; the client's reply is written to
//                     FAKE_ACP_DUMP as `decision`)
//                   | question-tool (AskUserQuestion routed through request_permission)
//                   | fuigo-question (Fuigo's `_fuigo/ask_user_question` ext request)
//                   | vendor-question (the ext request FAKE_ACP_ASK_METHOD with
//                     the JSON params FAKE_ACP_ASK_PARAMS, a sessionId there set
//                     to this session's, held until answered;
//                     the reply is written to FAKE_ACP_DUMP as `decision`)
//                   | fuigo-elicit (Fuigo's `_fuigo/mcp/elicit` bridge of an MCP form elicitation)
//                   | grok-elicit (the same bridge as Grok Build sends it, `_x.ai/mcp/elicit`,
//                     or FAKE_ACP_ELICIT_METHOD)
//                   | folder-trust (Fuigo 1.0.13's folder-trust gate: with
//                     `--trust` in argv the folder is trusted and the reply
//                     quotes ./AGENTS.md; without it the fake sends
//                     `_fuigo/folder_trust/request` after session/new IF the
//                     client advertised `fuigo/folderTrust.interactive`, writes
//                     the answer to FAKE_ACP_DUMP as `decision`, and — like the
//                     real engine, which reads instructions at session build —
//                     still replies with AGENTS.md withheld this session.
//                     Like the engine it also reads the user's own store,
//                     `<FUIGO_HOME | ~/.fuigo>/trusted_folders.toml`: a
//                     `[folders."<cwd>"]` table with `trusted = true` trusts
//                     the folder at build without `--trust` (a linked git
//                     worktree is keyed on its main checkout, like the
//                     engine's workspace_key). With
//                     FAKE_ACP_TRUST_PROMPT_FIRST=1 the prompt completes at
//                     once while its trust request is still open — the real
//                     engine's timing when the turn outruns the card. With
//                     FAKE_ACP_TRUST_STORE_REJECTED=1 the store reads as
//                     EMPTY whatever it says — the engine's `toml` crate
//                     rejecting a hand-edited document — so the fake asks
//                     although Murage's own reader may have accepted it.
//                     With FAKE_ACP_TRUST_FAIL_PROMPT=1 the prompt FAILS
//                     with a JSON-RPC error while its trust request is
//                     still open — a turn that fails under a late card.
//                     FAKE_ACP_TRUST_V=2 is the 1.0.35 protocol: it asks only a
//                     client that advertised `v2`, whenever its store has no
//                     consent-2 trust and no stored decline at the key; the
//                     request carries `workspace`, `scope` and `reason` ("new",
//                     or "upgrade" for an unstamped trust); a grant persists
//                     consent 2 for exactly that key; a reject is not saved and
//                     silences that key for the rest of this process. Without
//                     FAKE_ACP_VERSION it reports a version on the matching side
//                     of 1.0.35, so an unset V is generation 1.
//                     FAKE_ACP_TRUST_WORKSPACE names any key for any cwd (default
//                     the cwd). FAKE_ACP_TRUST_DISABLED=1 is Fuigo's trust switch
//                     off: trusted, no request. FAKE_ACP_TRUST_KINDS is a comma
//                     list of configKinds (default instructions; empty for none).
//                     FAKE_ACP_TRUST_SCOPE replaces `scope` ("none" leaves it out,
//                     the request a 1.0.34 engine sends). FAKE_ACP_TRUST_LOG gets
//                     one JSON line per request and per raw reply.
//                     FAKE_ACP_TRUST_DELAY_MS raises the V=2 request that long after
//                     the session reply: a warm has parked by then.
//                     FAKE_ACP_TRUST_FORCE_REQUEST=1 asks even with --trust, exercising a late native fallback.
//                     FAKE_ACP_TRUST_THEN_COMMAND=<cmd> asks to run that command (id 9301) once the
//                     trust request is answered, logs the reply as "command-reply", then answers.
//                     FAKE_ACP_TRUST_ON_PROMPT=1 raises the V=2 request only when
//                     session/prompt arrives, so the prompt is already written:
//                     with FAKE_ACP_TRUST_PROMPT_FIRST the turn outruns the card.)
//                   | elicitation-form | elicitation-url | elicitation-legacy
//                     (ACP `elicitation/create` form / url, and the older
//                     `session/elicitation` spelling); the client's reply is
//                     written to FAKE_ACP_DUMP as `decision`
//                   | exit-on-cancel | exit-on-prompt | exit-with-ansi
//                   | exit-hostile-stderr (exit before the prompt result with
//                     stderr the driver must sanitise: a bidi override, a BEL,
//                     an https URL with a ?key= and a user:pass@IP authority)
//                   | exit-noisy-stderr (exit before the prompt result after
//                     writing what a real CLI agent writes on the way down:
//                     kilobytes of structured NDJSON records, with the fatal
//                     line LAST)
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                     (FAKE_ACP_DELEGATE_MESSAGE overrides the task text, default
//                     "delegated task"; FAKE_ACP_DELEGATE_TO names the peer by its
//                     exact display name instead of the first listed bot)
//                   | chief-delegate (delegates only for an ASSIGN_TO_PEER
//                     prompt; ordinary follow-ups stay responsive)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//   FAKE_ACP_PERMISSION_COMMAND  the command a permission-mode ask names
//                   (default "echo hi")
//   FAKE_ACP_PERMISSION_TOOLCALL  JSON tool call a permission-mode ask sends
//   FAKE_ACP_PERMISSION_TOOLCALL_NEXT  JSON tool call the second ask (TWICE=1) sends
//   FAKE_ACP_PERMISSION_SESSION=1  the permission-mode ask names the live session
//                   verbatim instead of the default shell command
//   FAKE_ACP_PERMISSION_TIMING_FILE  append {askedAt, waitMs} per answered
//                   permission-mode ask: how long the client took to answer,
//                   as the engine sees it (Grok's own wait_ms)
//   FUIGO_POLICY_PATH / FUIGO_POLICY_SHA256  Fuigo 1.0.36+ launch policy, as 1.0.38 handles it: the file must hash to
//                   the env value or the process prints one {"policy_error":...} line and exits 78; session/new and
//                   session/load carrying `_meta` fuigo/permissionPolicyPath + Sha256 are checked the same way
//                   (-32602 with the record as data) and acknowledged in `_meta["fuigo/permissionPolicy"]`.
//   FAKE_ACP_POLICY_ACK=0  behave like an engine older than 1.0.36: ignore the policy, never acknowledge it
//   FAKE_ACP_AUTOPILOT=1  session/set_config_option takes Kiro 3.1.0's `autopilot` ("on" or "off")
//   FAKE_ACP_POLICY_PIN=1  keep the verified policy file open for the life of the process, as Fuigo 1.0.36+ does
//                   (fuigo-workspace permission/launch_policy.rs keeps a same_file::Handle of it in its static pins)
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_LOAD_ERROR  JSON-RPC error object session/load answers with
//                   (a refusal, or OpenCode's session-not-found shape)
//   FAKE_ACP_PROMPT_DUMP  path to write the last session/prompt's content
//                   blocks as JSON, so a test can assert what reached the
//                   engine (text, and any inline image parts)
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_THINKING_SETTABLE=1  with FAKE_ACP_VARIANT_WITHOUT_DEFAULT, session/set_config_option
//                        takes an offered `thinking` value and answers with it as currentValue
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does);
//                        "fuigo-billed": Fuigo 1.0.47+ _meta with billed* and no usage;
//                        "fuigo-billed-part": billedOutputTokens only
//
// Process pool fixtures (#1575):
//   FAKE_ACP_SPAWN_LOG   append this child's pid, one line per process start,
//                        so a test can count spawns across turns
//   FAKE_ACP_RPC_LOG     append one JSON line per request or notification this
//                        child receives,
//                        {pid, method, noReplay?, agentsToken?}; unlike
//                        FAKE_ACP_RPC_DUMP it survives a respawn. The
//                        token is a fingerprint (fixture-dump.ts), as are
//                        credential-named MCP env entries in every dump
//   FAKE_ACP_AGENTS_CAPABILITY  path to write the agents server's env as
//                        handed, for the one test that must call Murage
//                        with the turn's own capability; never a dump
//   FAKE_ACP_UNIQUE_SESSIONS=1  every session/new opens its own session id
//                        (`fake-acp-session-<launch-id>-<n>`), the way a real engine does
//   FAKE_ACP_LATE_FRAMES_MS  N: N ms after this process's FIRST prompt completes,
//                        send that session's late output (an agent_message_chunk
//                        "LATE FRAME FROM THE EARLIER SESSION") and a
//                        session/request_permission (id 9300) naming it; the
//                        client's reply is appended to FAKE_ACP_LATE_REPLY_LOG
//   FAKE_ACP_PROMPT_SCOPE=1  the initialize answer advertises the prompt-scope
//                        capability (agentCapabilities._meta["fuigo/promptScope"] = 1);
//                        and (design-1022-grokwarm A, the Fuigo 1.0.48 shape) every
//                        notification/request the fixture sends without `_meta.promptId`
//                        is stamped with the prompt id of the session/prompt it is
//                        answering (null before the first one), and each prompt ends with
//                        `_fuigo/session_notification` turn_completed {prompt_id, background}
//   FAKE_ACP_RAW_IN_LOG  append every raw stdin line (JSON-quoted) before any parse
//   FAKE_ACP_INIT_CAPTURE  a real Fuigo release's captured initialize answer
//                        (server/drivers/acp/__fixtures__/fuigo-init/initialize-<version>.json):
//                        its agentCapabilities answer initialize verbatim, and a capture
//                        that advertises `fuigo/promptScope: 1` turns on that release's
//                        prompt-scoped frames exactly as FAKE_ACP_PROMPT_SCOPE=1 does
//   FAKE_ACP_PSCOPE_BACKGROUND  with FAKE_ACP_PROMPT_SCOPE: the turn_completed
//                        `background` count (default 0; "absent" omits the field)
//   FAKE_ACP_PSCOPE_TURN2  with FAKE_ACP_PROMPT_SCOPE: on this process's SECOND
//                        prompt (FAKE_ACP_PSCOPE_AT=n: its n-th), before its own reply, write these comma-separated
//                        frames: stale-request (request_permission id 9300 stamped
//                        with prompt 1's id), drain (a drain turn: request_permission
//                        9300 + a chunk "STALE DRAIN TEXT", promptId "drain-1",
//                        originPromptId = prompt 1), missing (request 9300, no _meta),
//                        null (request 9310, promptId null), stale-text (a chunk
//                        "STALE TURN ONE TEXT" stamped with prompt 1's id), unknown
//                        (a session/update of an unknown kind, promptId null),
//                        status (available_commands_update, promptId null); the
//                        client's answers to 9300/9310 go to FAKE_ACP_LATE_REPLY_LOG
//   FAKE_ACP_PSCOPE_SPLIT  with FAKE_ACP_PROMPT_SCOPE: after the FIRST prompt's reply,
//                        write the first third of one frame with no newline; the next
//                        session/prompt writes its middle (no newline), then 60 ms later
//                        its end + newline + one chunk "SPLIT CURRENT TEXT" stamped with
//                        that prompt's id, then answers the prompt (so the frame's first
//                        byte arrives before the next turn adopts the process and its
//                        newline after, three reads in all): "request" (request_permission
//                        id 9300, no _meta) or "status" (available_commands_update, promptId null)
//   FAKE_ACP_BARE_REJECT_CANCELS=1  Grok Build / Fuigo's rule: a permission
//                        answered with a reject option and no
//                        `_meta.followup_message` ends the prompt with
//                        stopReason "cancelled"; with the follow-up note the
//                        prompt answers "FOLLOWUP: <note>" and finishes
//                        end_turn (the tool stays unexecuted).
//                        =always: every reject ends the prompt "cancelled",
//                        note or not (an engine that ignores the note)
//   FAKE_ACP_REJECT_LIVE_LOAD  refuse session/load of a session that is
//                        already live in this process (an engine that cannot
//                        re-establish a resident session)
//   FAKE_ACP_GROK_MODELS_CACHE=1  grok's model surface: advertise the bundled grok-4.6, grok-4.5 (current
//                        grok-4.6) plus the ids of $GROK_HOME/models_cache.json (`models` as an array of {id}
//                        or keyed by id), and answer session/set_model for an id not advertised with -32602
//   FAKE_ACP_GROK_CATALOG_GATE=<file>  with FAKE_ACP_GROK_CATALOG_IDS, announce once this file exists (instead of the n ms below)
//   FAKE_ACP_GROK_CATALOG_MS=<n> + FAKE_ACP_GROK_CATALOG_IDS=a,b  n ms after session/new, write those ids
//                        into $GROK_HOME/models_cache.json, advertise them, and send `_x.ai/models/update`
//                        (grok's background catalog fetch landing). Unset: never
//   FAKE_ACP_SET_MODEL_STALL=1  never answer session/set_model (the request-timeout case)
//   FAKE_ACP_SET_MODEL_DELAY_MS=<n>  with the grok surface, refuse the FIRST set_model (-32602) after n ms
//   FAKE_ACP_SET_MODEL_GATE=<file>  hold the answer to the first session/set_model until this file exists
//   FAKE_ACP_SET_MODEL_GATE_ANSWER=ok|refuse  that answer: accepted (default), or refused (-32602)
//   FAKE_ACP_SESSION_NEW_REFUSE_GATE=<file>  hold session/new until this file exists, then fail it (-32000)
//   FAKE_ACP_SET_MODE_REFUSE=1  session/set_mode answers -32601 while set_model works
//   Every session/set_model attempt, refused ones included, is listed in $FAKE_ACP_DUMP.setmodel.json.
//   FAKE_ACP_MCP_READY=1  announce `_fuigo/mcp_initialized {sessionId}` after
//                        session/new or session/load hands it servers, and —
//                        like Fuigo — after a resident load only when the
//                        servers actually changed
//   FAKE_ACP_MCP_READY_DELAY_MS  announce that long after the servers were
//                        handed over (a real engine announces once they settle)
//   FAKE_ACP_MCP_READY_AFTER_LIST=1  with MCP_CONNECT, announce only after
//                        every handed server answers a real tools/list
//   FAKE_ACP_MCP_READY_GATE_FILE  also wait for this file before announcing
//                        readiness, so a test can inspect the real process tree
//                        before a reused turn reconciles its replacement servers
//                        (writes `<path>.waiting` while held)
//   FAKE_ACP_MCP_LIST_READY_AFTER_MS  with FAKE_ACP_MCP_LIST "all:<status>",
//                        report every server "initializing" until that long
//                        after the servers were handed over
//   FAKE_ACP_MCP_LIST_OVERSIZE_AT  "N:ms": that long after list call N, write
//                        one frame over the limit (the driver's overflow handler)
//   FAKE_ACP_MCP_LIST_OVERRIDE  JSON {name: status} laid over FAKE_ACP_MCP_LIST "all:<status>"
//   FAKE_ACP_MCP_LIST_UNANSWERED  1-based list calls this process never answers,
//                        comma separated; "N+" is call N and every later one
//                        (a busy engine whose list RPC times out)
//   FAKE_ACP_MCP_CONNECT=1  connect to every handed server the way a real
//                        engine does: start it (command, args, env as handed),
//                        initialize, then tools/list; a session/load with
//                        changed servers restarts them. With
//                        FAKE_ACP_MCP_CONNECT_DELAY_MS, start them that late
//   FAKE_ACP_MCP_TIMELINE  append one JSON line {event, at, name?} per MCP
//                        readiness moment: "ready" (announced, or the list
//                        first showed every server settled), "listed" (a
//                        connected server answered tools/list) and "prompt"
//                        (a session/prompt arrived)
//   FAKE_ACP_MCP_READY_NEW_ONLY=1  announce readiness after session/new only,
//                        never after session/load (servers that never report
//                        ready on a reused process)
//   FAKE_ACP_MCP_CHILD_LOG  run each handed server set as a real child
//                        process (the first server's command and args, as
//                        handed; `sleep 300` when none), the way Fuigo starts its MCP
//                        servers: session/new starts one, and a resident
//                        session/load with changed servers stops it and starts
//                        a replacement (a new pid). Each pid is appended to the log
//   __fixture_cancel_ack__  (prompt marker) hold THIS prompt open and answer
//                        it "cancelled" on session/cancel, staying alive: a
//                        cooperative cancel on a process that is otherwise
//                        in its ordinary mode
//   FAKE_ACP_NAMED_UPDATES=1  every session/update the fixture sends names the
//                        live session (a real engine always does)
//   FAKE_ACP_LATE_SHAPE  with FAKE_ACP_LATE_FRAMES_MS: "sessionless" sends the
//                        late chunk and permission request naming no session;
//                        "helper" announces a helper (child_session_id
//                        "late-helper") under the earlier session, then sends
//                        the permission request from that helper's session
//   __fixture_tool_after_turn__  (prompt marker) finish the turn, then report a
//                        tool call (and its progress) 150 ms later, while idle
//   __fixture_wake_after_turn__  (prompt marker) finish the turn, then 2 s later
//                        report turn_completed on _fuigo/session_notification,
//                        the way Fuigo starts a turn of its own after end_turn
//   FAKE_ACP_SESSION_NEW_GATE  path: answer session/new only once this file exists
//                        (writes `<path>.waiting` while held): the window between
//                        the turn's id going back and its prompt's write, where a
//                        memory revoke makes the fence refuse the send
//   FAKE_ACP_INIT_DELAY_MS  answer initialize only after this long: a startup
//                        cost, so a reused process's saving is measurable
//   __fixture_child_later__  (prompt marker) finish the turn, then start
//                        `sleep 30` as its own child FAKE_ACP_CHILD_DELAY_MS
//                        (default 800) later and write its pid to
//                        FAKE_ACP_CHILD_PID_FILE: a child that appears after
//                        the park check passed
//   __fixture_child_after_turn__  (prompt marker) start `sleep 30` as its own
//                        child, write its pid to FAKE_ACP_CHILD_PID_FILE, then
//                        finish the turn with the child still running
//   __fixture_request_after_turn__  (prompt marker) finish the turn, then
//                        ask for a permission 150 ms later, while idle
//   Like Fuigo, session/load of the session this process already holds
//   re-applies the `mcpServers` it carries (the agents server a peer-comms
//   mode calls is the new one); a load on a fresh process is unchanged.
//
// Close-confirmed stop fixtures (A2):
//   FAKE_ACP_MODE=cancel-ack  hold session/prompt open; answer it with
//                        stopReason "cancelled" on session/cancel and stay alive
//   FAKE_ACP_PID_FILE    write this child's pid (after probe branches exit)
//   FAKE_ACP_MODE=gated-result:text|empty|other|error|overflow  hold session/prompt until FAKE_ACP_PROMPT_GATE exists, then end_turn with a reply /
//                        end_turn with nothing / stopReason max_tokens / a -32000 rejection / one oversized frame and no result
//   FAKE_ACP_TERM        ignore | linger | gate: SIGTERM handling. POSIX-only
//                        observation — Windows taskkill /F runs no handler
//   FAKE_ACP_TERM_MS     linger delay before exiting (default 400, max 10 s)
//   FAKE_ACP_TERM_MARK   path written when SIGTERM arrives
//   FAKE_ACP_EXIT_GATE   with TERM=gate, exit once this file exists (max 10 s)
//
// Engine error fixtures (MU):
//   FAKE_ACP_MODE=engine-error-data:object|string|hostile  fail session/prompt
//   FAKE_ACP_MODE=engine-error-message:hostile|plain  fail session/prompt with
//     the content in the JSON-RPC message instead of `error.data`
//                        with -32603 whose data is Fuigo 1.0.18's typed object
//                        ({message, error_kind}), Fuigo <=1.0.17's plain string,
//                        or hostile text the driver must sanitise
//   FAKE_ACP_MODE=cancel-ignore  hold session/prompt open like cancel-ack, but never
//                        answer session/cancel at all (the driver's grace timer must end it)
//   FAKE_ACP_MODE=cancel-reject  hold session/prompt open like cancel-ack, but
//                        answer session/cancel by REJECTING the prompt (-32603,
//                        error_kind cancelled) and stay alive
//   FAKE_ACP_MODE=cancel-other-reason  hold session/prompt open like cancel-ack,
//                        but answer session/cancel by RESOLVING the prompt with
//                        a stop reason that is not "cancelled" ("refusal")
//   FAKE_ACP_MODE=cancel-end-turn  hold session/prompt open with nothing sent
//                        (no reply, image or tool), then answer session/cancel by
//                        RESOLVING the prompt with end_turn, as OpenCode does
//   FAKE_ACP_MODE=stderr-rpc-error|stderr-happy  write more than 8 KiB of stderr
//                        (ANSI styling, a key-shaped canary, a known last line),
//                        then fail session/prompt with -32603 or complete it
//   FAKE_ACP_MODE=retry-status-thought  Fuigo 1.0.18's retry progress: an
//                        agent_thought_chunk tagged _meta["fuigo/retryStatus"],
//                        then ordinary reasoning and the answer
//   FAKE_ACP_MODE=plan   ACP `plan` session updates (the protocol's to-do list):
//                        a first plan, a malformed one, an update that ticks
//                        an entry off, then the answer
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { r3Barrier, r3Record, r3Root } from "./r3-engine-barrier.ts";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fixtureCredentialFingerprint } from "./fixture-dump.ts";
import { logProposalTurn, proposalFrom, proposalReply, proposeThroughMcp } from "./fake-mcp-propose.ts";
import { fakeReviewByTool, fakeReviewReply, fakeReviewToolArgs } from "./fake-review.ts";
import { replayWebRead, replayCommands } from "./fake-web-read.ts";
import { callFirstCustomTool, customToolReply, customToolServer } from "./fake-custom-tool.ts";
import { fixtureRequested } from "./fixture-request.ts";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const initCapture = process.env.FAKE_ACP_INIT_CAPTURE ? JSON.parse(readFileSync(process.env.FAKE_ACP_INIT_CAPTURE, "utf8")).result : null;
if (initCapture?.agentCapabilities?._meta?.["fuigo/promptScope"] === 1) process.env.FAKE_ACP_PROMPT_SCOPE = "1";
// Separate cages may both call their engine PID 2. Files and session identities
// must distinguish launches independently of the PID namespace.
const launchId = randomUUID();
// permission modes: the command the approval asks about (default "echo hi")
const permissionCommand = process.env.FAKE_ACP_PERMISSION_COMMAND || "echo hi";
// A whole tool call (JSON) for a permission-mode ask, verbatim, so a test can
// replay the exact shape an engine sent (an MCP tool through use_tool).
/** Fuigo 1.0.47: the client's initialize said `fuigo/permissionPrompts`. FAKE_ACP_REQUIRE_PERMISSION_PROMPTS=1: an engine that is
 *  not told denies an outside-workspace change silently (no ask) and ends the turn, as a Generic client got. */
let permissionPrompts = false;
type HeldEntry = { name: string; heldReason?: string; heldDigest?: string };
/** Fuigo 1.0.47 held servers as the engine holds them now (FAKE_ACP_MCP_LIST_HELD, then FAKE_ACP_MCP_LIST_HELD_AFTER_SHOWN). */
let heldNow: HeldEntry[] | undefined;
let heldChanged = false;
const permissionToolCall = process.env.FAKE_ACP_PERMISSION_TOOLCALL ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOLCALL) : null;
// FAKE_ACP_PERMISSION_TOOLCALL_NEXT: the tool call the second ask (FAKE_ACP_PERMISSION_TWICE=1) sends instead,
// e.g. OpenCode's bash ask under the same toolCallId after its external_directory ask.
const permissionToolCallNext = process.env.FAKE_ACP_PERMISSION_TOOLCALL_NEXT ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOLCALL_NEXT) : null;
const permissionFile = process.env.FAKE_ACP_PERMISSION_FILE || "/tmp/fake-acp-edit.md";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A second, distinguishable 1x1 raster: the computer surface's frame.
const SCREEN_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
// JSON form preserves native model IDs that themselves contain commas.
const modelValues: unknown = process.env.FAKE_ACP_MODELS_JSON === undefined
  ? (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean)
  : JSON.parse(process.env.FAKE_ACP_MODELS_JSON);
if (!Array.isArray(modelValues) || modelValues.some(value => typeof value !== "string")) throw new Error("invalid fixture model catalog");
const models: string[] = modelValues;
// OpenCode merges inline provider declarations into the session's catalog.
try {
  const providers = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")?.provider ?? {};
  for (const [provider, entry] of Object.entries<any>(providers)) {
    for (const id of Object.keys(entry?.models ?? {})) {
      if (models.length && !models.includes(`${provider}/${id}`)) models.push(`${provider}/${id}`);
    }
  }
} catch {}

let currentModel: string | null = models[0] ?? null;
let currentThinking = "high";
const configOptions = () =>
  models.length
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
        ...(process.env.FAKE_ACP_VARIANT_WITHOUT_DEFAULT === "1" ? [{
          id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: currentThinking,
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
        }] : []),
      ]
    : null;
// cursor-shaped surface: the session advertises `models.availableModels` with
// parameterised ids (`default[]`) that differ from the argv `--model` slugs
// (`auto`). Off unless FAKE_ACP_SESSION_MODELS is set, so every existing mode
// stays byte-identical. Format: "id|Name,id|Name" — the name is optional.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
// grok-shaped surface (FAKE_ACP_GROK_MODELS_CACHE=1): the bundled list plus every id of $GROK_HOME/models_cache.json,
// the way grok offers the fetched catalog only once its cache exists; plus the ids a late catalog announced.
const grokLateIds: string[] = [];
const grokCacheModels = (): string[] => {
  try {
    const cache = JSON.parse(readFileSync(join(process.env.GROK_HOME ?? "", "models_cache.json"), "utf8")) as { models?: unknown };
    const models = cache.models;
    if (Array.isArray(models)) return models.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
    return models && typeof models === "object" ? Object.keys(models) : [];
  } catch { return []; }
};
const grokAdvertised = (): string[] => [...new Set([...grokCacheModels(), ...grokLateIds, "grok-4.6", "grok-4.5"])];
const sessionModels = () => {
  if (process.env.FAKE_ACP_GROK_MODELS_CACHE === "1") return { currentModelId: "grok-4.6", availableModels: grokAdvertised().map((modelId) => ({ modelId })) };
  return acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;
};
/** Every session/set_model attempt this run, refused ones included. */
const setModelAttempts: string[] = [];

const argv = process.argv.slice(2);
// The inert DeepSeek peer exposes the same bounded config query as its CLI.
// Only an explicitly supplied fixture tree answers; missing data stays unknown.
if (argv.length === 3 && argv[0] === "--profile" && argv[1] === "acp" && argv[2] === "--dump-config"
  && process.env.FAKE_DSH_CONFIG !== undefined) {
  process.stdout.write(process.env.FAKE_DSH_CONFIG);
  process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "config") {
  process.stdout.write(process.env.FAKE_OPENCODE_CONFIG ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  process.exit(0);
}

// Explicit assertion fields only, never the inherited environment.
// Credentials are fingerprints (fixture-dump.ts), never values.
const dumpCredentials = new Set([
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "BOX_TOKEN",
  "MURAGE_TTS_KEY",
  "FACTORY_API_KEY",
  "UNSLOTH_STUDIO_AUTH_TOKEN",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "KIMI_MODEL_API_KEY",
  "MURAGE_PROVIDER_API_KEY",
  "MY_AGENT_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLINE_API_KEY",
  "META_API_KEY",
  // every provider key name Fuigo 1.0.32 discovers (fuigo-secrets child_env.rs provider_key_env_vars)
  "FUIGO_API_KEY",
  "FUIGO_CODE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROK_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "LC_ANTHROPIC_AUTH_TOKEN",
]);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "TEST_POLICY",
    "FUIGO_POLICY_PATH",
    "FUIGO_POLICY_SHA256",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "FUIGO_HOME",
    "MURAGE_CLOUD_TURN_RENDER",
    "FUIGO_DISABLE_MODEL_REFRESH",
    "FUIGO_SUBAGENTS",
    "FUIGO_WORKFLOWS",
    "FUIGO_SCHEDULER_BACKGROUND_LOOPS",
    "FUIGO_GOAL",
    "FUIGO_ENVRC_TIMEOUT_SECS",
    "FUIGO_AGENT",
    "FUIGO_WORKSPACE_REWIND_GIT",
    // FUIGO-NO-SILENT-HANG pins: retries, connect limit, uncharged 401 park
    "FUIGO_MAX_RETRIES",
    "FUIGO_CONNECT_TIMEOUT_SECS",
    "FUIGO_COMPACTION_WALL_CLOCK_SECS",
    "FUIGO_UNCHARGED_401_PARK",
    "HERMES_HOME",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    // Flux Memory headers: config overlays and settings paths, no secret
    "FUIGO_CONFIG",
    "GROK_CONFIG",
    "QWEN_CODE_SYSTEM_SETTINGS_PATH",
    "HERMES_MANAGED_DIR",
    "OPENCODE_CONFIG_CONTENT",
    // routing switches: stripped unconditionally, never allowlistable
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    // GitHub Copilot (acp/copilot.ts): its allow-all switch and the tokens that would outrank its login (fixture values)
    "COPILOT_ALLOW_ALL",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    // Command Code (acp/command-code.ts): the one key its credentialEnv grants
    "COMMAND_CODE_API_KEY",
    // Kiro (acp/kiro.ts): its one key
    "KIRO_API_KEY",
    // OMP (acp/omp.ts): the session folder discovery points away from the person's own
    "PI_CODING_AGENT_SESSION_DIR",
    ...dumpCredentials,
    // engine isolation switches (no secret): compat cells, memory, discovery off
    ...Object.keys(process.env).filter((key) => /^(?:GROK|FUIGO)_[A-Z]+_[A-Z]+_ENABLED$|^(?:GROK|FUIGO)_MEMORY$|^OPENCODE_DISABLE_|^OPENCODE_PURE$|^(?:GEMINI_CLI|QWEN_CODE)_SYSTEM_SETTINGS_PATH$|^GEMINI_CLI_HOME$|^GEMINI_SANDBOX$|^GROK_HOME$|^OPENCODE_CONFIG_DIR$|^FACTORY_HOME_OVERRIDE$/.test(key)),
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, dumpCredentials.has(key) ? fixtureCredentialFingerprint(process.env[key]!) : process.env[key]]] as const)),
);
// Folder-trust readers must see a complete snapshot at each publication.
// Other fake modes retain their existing direct-write behavior.
let folderTrustDumpSequence = 0;
function writeMainDump(path: string, encoded: string): void {
  if (mode !== "folder-trust") {
    writeFileSync(path, encoded);
    return;
  }
  const temporary = `${path}.${process.pid}.${++folderTrustDumpSequence}.tmp`;
  writeFileSync(temporary, encoded);
  renameSync(temporary, path);
}
const dumpState: Record<string, unknown> = { argv, env: dumpEnv };
if (process.env.FAKE_ACP_DUMP) {
  writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
async function printProbeAndExit(text: string): Promise<never> {
  // Forced exit can discard pending pipe output. Probe callers must receive
  // the complete response before this short-lived fixture terminates.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, error => error ? reject(error) : resolve());
  });
  process.exit(0);
}
if (argv.includes("--version")) {
  // FAKE_ACP_VERSION sets the reported version (the default is past every engine's scoped-home floor, so a turn is not rejected as too old); FAKE_ACP_VERSION_LOG counts probes; FAKE_ACP_VERSION_FAIL=1 makes `--version` fail (a working CLI with a broken probe).
  if (process.env.FAKE_ACP_VERSION_LOG) appendFileSync(process.env.FAKE_ACP_VERSION_LOG, "probe\n");
  if (process.env.FAKE_ACP_VERSION_FAIL === "1") process.exit(1);
  await printProbeAndExit(process.env.FAKE_ACP_VERSION ?? (mode === "folder-trust" && process.env.FAKE_ACP_TRUST_V !== "2" ? "fake-acp 1.0.32" : "fake-acp 1.0.62"));
}
// Cursor's driver probes `agent status` / `agent models` on the same binary
// it later spawns for ACP. Answer those without entering the JSON-RPC loop
// so catalog/auth tests do not hang on stdin.
if (argv[0] === "status" || argv[0] === "whoami") {
  // FAKE_ACP_AUTH=crash: the status check dies with nothing said, so the login stays unverified.
  if (process.env.FAKE_ACP_AUTH === "crash") { process.stderr.write("fake-acp: status crashed\n"); process.exit(2); }
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  await printProbeAndExit(JSON.stringify({ isAuthenticated: authenticated }));
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  if (models.length) {
    const verbose = argv.includes("--verbose");
    await printProbeAndExit(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
  }
  await printProbeAndExit(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
}

let outputBatch: unknown[] | undefined;
/** FAKE_ACP_PSCOPE_SPLIT: the rest of a frame whose first third is already on stdout. The next session/prompt writes it in
 *  two more reads (the second with no newline); any other write before that leads with it whole, so no frame is torn. */
let pscopeSplitTail: string | null = null;
const rawOut = (obj: unknown) => {
  if (process.env.FAKE_ACP_OUTPUT_LOG) appendFileSync(process.env.FAKE_ACP_OUTPUT_LOG, JSON.stringify(obj) + "\n");
  if (outputBatch) { outputBatch.push(obj); return true; }
  const tail = pscopeSplitTail === null ? "" : pscopeSplitTail + "\n";
  pscopeSplitTail = null;
  return process.stdout.write(tail + JSON.stringify(obj) + "\n");
};
// FAKE_ACP_NAMED_UPDATES=1: every session/update names the live session, as the
// ACP spec has a real engine do (the fixture's own shorthand frames omit it).
/** FAKE_ACP_PROMPT_SCOPE: the prompt ids this process was sent, in order, and the one it is answering now. */
const pscopePrompts: Array<string | null> = [];
let pscopeCurrent: string | null = null;
const out = (obj: unknown) => {
  const scoped = obj as { id?: unknown; method?: unknown; params?: Record<string, any> } | null;
  if (process.env.FAKE_ACP_PROMPT_SCOPE === "1" && typeof scoped?.method === "string" && scoped.params && typeof scoped.params === "object"
    && !(scoped.params._meta && typeof scoped.params._meta === "object" && "promptId" in scoped.params._meta)) {
    obj = { ...scoped, params: { ...scoped.params, _meta: { ...(scoped.params._meta ?? {}), promptId: pscopeCurrent } } };
  }
  const frame = obj as { method?: unknown; params?: { sessionId?: unknown } } | null;
  if (process.env.FAKE_ACP_NAMED_UPDATES === "1" && frame?.method === "session/update" && frame.params && frame.params.sessionId === undefined && liveSession) {
    return rawOut({ ...frame, params: { sessionId: liveSession, ...frame.params } });
  }
  return rawOut(obj);
};
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts (this
// fake stays dependency-free). "é" is two UTF-8 bytes: the text alone is one
// KiB over the limit, so the limit is counted in bytes, not characters.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeImageBase64 = () => Buffer.alloc(10 * 1024 * 1024, 7).toString("base64");
// Markers count only on the prompt's last line (fixture-request.ts): old replayed markers must not re-trigger a fixture.
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });

// Fuigo 1.0.36+ launch policy (see FUIGO_POLICY_PATH above). Returns the error record, or null when the bytes match.
const policyKnown = process.env.FAKE_ACP_POLICY_ACK !== "0";
/** Open handles of verified policy files, never closed (FAKE_ACP_POLICY_PIN). */
const policyPins: number[] = [];
function policyFileError(path: unknown, sha256: unknown): Record<string, unknown> | null {
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return { policy_error: "hash_missing", path, line: null, message: "hash missing" };
  if (typeof path !== "string" || !isAbsolute(path)) return { policy_error: "not_absolute", path, line: null, message: "not absolute" };
  let bytes: Buffer;
  try {
    if (lstatSync(path).isSymbolicLink()) return { policy_error: "symlink", path, line: null, message: "symlink" };
    bytes = readFileSync(path);
  } catch { return { policy_error: "not_found", path, line: null, message: "not found" }; }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return { policy_error: "hash_mismatch", path, line: null, message: "hash mismatch" };
  if (process.env.FAKE_ACP_POLICY_PIN === "1") policyPins.push(openSync(path, "r"));
  return null;
}
if (policyKnown && process.env.FUIGO_POLICY_PATH !== undefined) {
  const failed = policyFileError(process.env.FUIGO_POLICY_PATH, process.env.FUIGO_POLICY_SHA256);
  if (failed) { process.stderr.write(`${JSON.stringify(failed)}\n`); process.exit(78); }
}
/** The session answer's policy `_meta`, an error already sent (true), or nothing (no policy on the request). */
function sessionPolicy(msg: any): { _meta?: Record<string, unknown> } | true {
  const meta = msg.params?._meta;
  if (!policyKnown || !meta || typeof meta !== "object" || !("fuigo/permissionPolicyPath" in meta || "fuigo/permissionPolicySha256" in meta)) return {};
  const failed = policyFileError(meta["fuigo/permissionPolicyPath"], meta["fuigo/permissionPolicySha256"]);
  if (failed) { out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params", data: failed } }); return true; }
  if (process.env.FAKE_ACP_DUMP) appendFileSync(`${process.env.FAKE_ACP_DUMP}.policy.jsonl`, `${JSON.stringify({ method: msg.method, path: meta["fuigo/permissionPolicyPath"], sha256: meta["fuigo/permissionPolicySha256"] })}\n`);
  return { _meta: { "fuigo/permissionPolicy": { sha256: meta["fuigo/permissionPolicySha256"] } } };
}
// FAKE_ACP_PRE_FRAMES: a JSON list of session/update bodies ({ update, meta? }) sent just before the answer to session/new
// or session/load, so before any prompt: a load's history replay, or a tool frame an engine sends before it is asked.
const preFrames = (sid: unknown, mount?: unknown) => {
  for (const frame of JSON.parse(process.env.FAKE_ACP_PRE_FRAMES ?? "[]")) {
    // a frame with its own `params` (a status notification) is sent as given, naming the session about to be answered; the name
    // "$agents" becomes the name this session gave Murage's agents server
    out({ jsonrpc: "2.0", method: frame.rail ?? "session/update", params: frame.params ? { ...frame.params, ...(frame.params.name === "$agents" ? { name: mount } : {}), sessionId: sid } : { sessionId: sid, update: frame.update, ...(frame.meta ? { _meta: frame.meta } : {}) } });
  }
};
/** A test's own gate: `then` runs once the file exists. */
const whenFile = (file: string, then: () => void) => { if (existsSync(file)) then(); else setTimeout(() => whenFile(file, then), 10); };
// `_fuigo/interject`, Fuigo's steer into a running prompt (Grok Build: `_x.ai/interject`,
// answered on its own `_x.ai/` rail). FAKE_ACP_INTERJECT:
// "fallback" answers queued and echoes it, then runs it as its own
// `interject-fallback-` turn after the prompt result (a steer that missed the
// turn's final drain); "silent" answers nothing and echoes it after
// FAKE_ACP_LATE_ECHO_MS. Unset: method not found, as other engines answer.
const strandedInterjections: Array<{ text: string; ns: string }> = [];
let fallbackTurns = 0;
const runStrandedInterjection = () => {
  const stranded = strandedInterjections.shift();
  if (stranded === undefined) return;
  const { text, ns } = stranded;
  const promptId = `interject-fallback-${++fallbackTurns}`;
  setTimeout(() => {
    out({ jsonrpc: "2.0", method: `${ns}/queue/changed`, params: { entries: [], runningPromptId: promptId, runningText: text, runningKind: "prompt" } });
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ` fallback reply #${fallbackTurns}` } } } });
    // FAKE_ACP_FALLBACK_STALL=tool: the fallback turn starts a tool and then sends nothing at all (FUIGO-NO-SILENT-HANG).
    if (process.env.FAKE_ACP_FALLBACK_STALL === "tool") {
      out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: `fb-tool-${fallbackTurns}`, title: "run", kind: "execute", status: "in_progress" } } });
      return;
    }
    setTimeout(() => {
      out({ jsonrpc: "2.0", method: `${ns}/session_notification`, params: { update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } } });
      out({ jsonrpc: "2.0", method: `${ns}/queue/changed`, params: { entries: [] } });
    }, 300);
  }, 100);
};
// FAKE_ACP_MODE=fuigo-script (FUIGO-NO-SILENT-HANG): FAKE_ACP_SCRIPT is a JSON list of steps, each run `at` ms after
// session/prompt arrives (or after Murage answers request id `after`), doing one of: `update` (a session update, on
// `rail`, default session/update, with optional `meta`), `notify` {method, params}, `request` {id, method, params}
// (an engine request), `result` (the prompt's result; an accepted interjection then runs as a fallback turn) or
// `error` (the prompt's RPC error); a step with `gate`: <file> waits for the file first. FAKE_ACP_RETRY_DISCARD=1 advertises Fuigo's retryDiscard at initialize (its discards carry streamStartMs). Each answer to a scripted request is appended to FAKE_ACP_SCRIPT_LOG.
const scriptRequestIds = new Set<unknown>();
const scriptAnswerWaiters = new Map<unknown, Array<() => void>>();
let scriptStartedAt = 0;
const runFuigoScript = (prompt: any) => {
  const sid = prompt.params?.sessionId;
  scriptStartedAt = Date.now();
  // `repeat`: N on a step: that step N times, each copy with every "$i" in it replaced by its index (a script too long to pass in the environment)
  // FAKE_ACP_SCRIPT_FILE: the same list in a file, for a script past the per-variable environment limit (one 10,000-location call)
  const steps: any[] = (JSON.parse(process.env.FAKE_ACP_SCRIPT_FILE ? readFileSync(process.env.FAKE_ACP_SCRIPT_FILE, "utf8") : process.env.FAKE_ACP_SCRIPT ?? "[]") as any[]).flatMap((step) => typeof step?.repeat === "number"
    ? Array.from({ length: step.repeat }, (_v, i) => JSON.parse(JSON.stringify({ ...step, repeat: undefined }).replaceAll("$i", String(i)))) : [step]);
  const run = (step: any) => {
    // `grow`: {key, char, length}: the update's `key` is that character repeated (a value too long to pass in the environment)
    if (step.update && step.grow) step.update[step.grow.key] = String(step.grow.char).repeat(step.grow.length);
    if (step.update) out({ jsonrpc: "2.0", method: step.rail ?? "session/update", params: { sessionId: sid, update: step.update, ...(step.meta ? { _meta: step.meta } : {}) } });
    // a raw notification names the live session as the string "$SID" (a test cannot know the id in advance)
    else if (step.notify) out({ jsonrpc: "2.0", method: step.notify.method, params: step.notify.raw === true ? JSON.parse(JSON.stringify(step.notify.params).replaceAll('"$SID"', JSON.stringify(sid))) : { sessionId: sid, ...step.notify.params } });
    else if (step.request) {
      scriptRequestIds.add(step.request.id);
      out({ jsonrpc: "2.0", id: step.request.id, method: step.request.method, params: { sessionId: sid, ...step.request.params } });
    } else if (step.result) { result(prompt.id, step.result); setImmediate(runStrandedInterjection); }
    else if (step.error) out({ jsonrpc: "2.0", id: prompt.id, error: step.error });
    else if (typeof step.exit === "number") process.exit(step.exit);
  };
  for (const step of steps) {
    if (step.after !== undefined) {
      const waiting = scriptAnswerWaiters.get(step.after) ?? [];
      waiting.push(() => setTimeout(() => run(step), step.at ?? 0));
      scriptAnswerWaiters.set(step.after, waiting);
    } else if (typeof step.gate === "string") {
      // `gate`: <file>: the step runs `at` ms after the file exists (a test revokes the lease before the engine speaks).
      const poll = setInterval(() => { if (existsSync(step.gate)) { clearInterval(poll); setTimeout(() => run(step), step.at ?? 0); } }, 10);
    } else setTimeout(() => run(step), step.at ?? 0);
  }
  setInterval(() => {}, 1_000);
};
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
};

if (process.env.FAKE_ACP_PID_FILE) writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
const termBehavior = process.env.FAKE_ACP_TERM;
if (termBehavior === "ignore" || termBehavior === "linger" || termBehavior === "gate") {
  process.on("SIGTERM", () => {
    if (process.env.FAKE_ACP_TERM_MARK) writeFileSync(process.env.FAKE_ACP_TERM_MARK, String(Date.now()));
    if (termBehavior === "ignore") return;
    if (termBehavior === "linger") {
      setTimeout(() => process.exit(0), Math.min(10_000, Math.max(1, Number(process.env.FAKE_ACP_TERM_MS) || 400)));
      return;
    }
    const gate = process.env.FAKE_ACP_EXIT_GATE;
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (!gate || existsSync(gate) || Date.now() >= deadline) process.exit(0);
      else setTimeout(poll, 20);
    };
    poll();
  });
}
let pendingCancelAckPrompt: unknown = null;

/** Test-only resource fixture. Existing modes retain their exact output.
 * The gate and PNG are explicit task-owned paths; nothing is fetched. */
async function loadProof(id: unknown, sessionId: unknown) {
  const write = async (frame: unknown) => {
    if (!process.stdout.write(JSON.stringify(frame) + "\n")) await once(process.stdout, "drain");
  };
  const update = (content: object) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content } } });
  try {
    const gate = process.env.FAKE_LOAD_GATE, image = process.env.FAKE_LOAD_IMAGE;
    if (!gate || !image || !isAbsolute(gate) || !isAbsolute(image)) throw new Error("INVALID_INPUT");
    const timeout = Math.min(30000, Math.max(1, Number(process.env.FAKE_LOAD_TIMEOUT_MS) || 30000));
    await update({ type: "text", text: "LOAD_PROOF_READY" });
    const deadline = performance.now() + timeout;
    while (!existsSync(gate)) {
      if (performance.now() >= deadline) throw new Error("GATE_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - performance.now()))));
    }
    const before = lstatSync(image);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error("IMAGE_LIMIT");
    const fd = openSync(image, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("IMAGE_CHANGED");
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) throw new Error("IMAGE_CHANGED");
        offset += count;
      }
      const after = fstatSync(fd);
      if (readSync(fd, Buffer.alloc(1), 0, 1, null) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("IMAGE_CHANGED");
    } finally { closeSync(fd); }
    const text = "L".repeat(1024);
    for (let n = 0; n < 64; n++) await update({ type: "text", text });
    const data = bytes.toString("base64");
    for (let n = 0; n < 3; n++) await update({ type: "image", data, mimeType: "image/png" });
    recordMethod("session/prompt.result");
    await write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 16384 } } });
  } catch (error) {
    const code = error instanceof Error && ["INVALID_INPUT", "GATE_TIMEOUT", "IMAGE_LIMIT", "IMAGE_CHANGED"].includes(error.message) ? error.message : "IO_FAILED";
    await write({ jsonrpc: "2.0", id, error: { code: -32000, message: `fake acp load-proof failed (${code})` } });
  }
}

// session/set_mode + session/set_model calls seen this run
const configCalls: Array<{ method: string; params: unknown }> = [];

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
/** project-propose mode's own permission asks, answered by id. */
const proposalAsks = new Map<number, (result: any) => void>();
let onPermissionAnswered: (() => void) | null = null;
/** FAKE_ACP_BARE_REJECT_CANCELS: the newest permission answer was a reject with no follow-up note. */
let bareRejectAnswered = false;
/** FAKE_ACP_BARE_REJECT_CANCELS: the follow-up note a reject carried, which the prompt answers before end_turn. */
let rejectFollowup: string | null = null;
/** When the open permission ask was sent (FAKE_ACP_PERMISSION_TIMING_FILE). */
let permissionAskedAt: number | null = null;
// folder-trust mode: what the client advertised and whether the folder was
// trusted when the session was built (argv --trust, the way `fuigo --trust`
// grants the process cwd up front)
let folderTrustInteractive = false;
const trustV2 = process.env.FAKE_ACP_TRUST_V === "2";
let folderTrustClientV2 = false;
/** Fuigo 1.0.40: a client that set reopenNotice gets one `config_notice` after a grant. */
let folderTrustReopenNotice = false;
/** Keys a reject silenced: Fuigo keeps these for the life of the process, nowhere else. */
const trustRejected = new Set<string>();
/** Keys a `duration: "process"` trust covers (Fuigo 1.0.38): this process only, never the store. */
const trustProcessOnly = new Set<string>();
/** The raw reply line, for byte-exact assertions. */
let lastInboundLine = "";
const trustLog = (entry: Record<string, unknown>) => { if (process.env.FAKE_ACP_TRUST_LOG) appendFileSync(process.env.FAKE_ACP_TRUST_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const fuigoHomeDir = () => process.env.FUIGO_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fuigo");
/** The key the engine names: the override, else the canonical cwd. */
const trustWorkspace = (): string => {
  if (process.env.FAKE_ACP_TRUST_WORKSPACE) return process.env.FAKE_ACP_TRUST_WORKSPACE;
  try { return realpathSync.native(process.cwd()); } catch { return process.cwd(); }
};
/** The store's table for `key`, read fresh: the file a home holds, seeded or the owner's. */
const storedTrust = (key: string): { trusted: boolean; consent: number | null } | null => {
  try {
    const text = readFileSync(join(fuigoHomeDir(), "trusted_folders.toml"), "utf8");
    const table = text.indexOf(`[folders.${JSON.stringify(key)}]`);
    if (table < 0) return null;
    const body = text.slice(table).split("\n").slice(1).join("\n");
    const next = body.search(/^\[/m);
    const own = next < 0 ? body : body.slice(0, next);
    const consent = /^consent = (\d+)$/m.exec(own);
    return { trusted: /^trusted = true$/m.test(own), consent: consent ? Number(consent[1]) : null };
  } catch {
    return null;
  }
};
/** Store coverage (F5): the deepest record on the cwd's path that shares the key decides
 * when it is a "no", so a declined subfolder beats a trusted parent with no question. A
 * strict ancestor of the key shares no key with it. Otherwise the record of the key decides. */
const trustCoverage = (key: string): { trusted: boolean; consent: number | null } | null => {
  for (let folder = realpathSync.native(process.cwd()); ; folder = dirname(folder)) {
    const entry = key.startsWith(`${folder}/`) ? null : storedTrust(folder);
    if (entry) return entry.trusted ? storedTrust(key) : entry;
    if (folder === dirname(folder)) return storedTrust(key);
  }
};
/** What the 1.0.35 precedence says for this process's key. */
const trustVerdict = (): "trusted" | "declined" | "new" | "upgrade" => {
  if (process.env.FAKE_ACP_TRUST_DISABLED === "1") return "trusted";
  if (trustProcessOnly.has(trustWorkspace())) return "trusted";
  const entry = trustCoverage(trustWorkspace());
  if (!entry) return "new";
  if (!entry.trusted) return "declined";
  return (entry.consent ?? 0) >= 2 ? "trusted" : "upgrade";
};
/** A grant persists consent 2 for exactly the key the client was shown. */
const persistGrant = (key: string) => {
  mkdirSync(fuigoHomeDir(), { recursive: true });
  appendFileSync(join(fuigoHomeDir(), "trusted_folders.toml"), `[folders.${JSON.stringify(key)}]\ntrusted = true\nconsent = 2\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`);
};
// the engine's own store (fuigo-workspace/src/trust.rs): an exact match on
// the workspace key is enough for a fixture — the server's reader mirrors
// the real cascade. The key is the cwd's git root, collapsed onto the main
// checkout's root for a linked worktree (`workspace_key`; the conventional
// `<main>/.git` layout only), else the cwd itself — canonical either way,
// as the engine's dunce::canonicalize keeps it (a cwd handed over as an 8.3
// short name on Windows is stored under its long one).
const fakeWorkspaceKey = (): string => {
  const cwd = process.cwd();
  const canonical = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const gitDir = resolve(cwd, execFileSync("git", ["rev-parse", "--git-dir"], { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (top && realpathSync.native(common) !== realpathSync.native(gitDir) && basename(common) === ".git") return realpathSync.native(dirname(common));
    return top ? realpathSync.native(top) : canonical(cwd);
  } catch {
    return canonical(cwd);
  }
};
const storeTrustsCwd = (): boolean => {
  if (process.env.FAKE_ACP_TRUST_STORE_REJECTED === "1") return false;
  const home = process.env.FUIGO_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fuigo");
  try {
    const text = readFileSync(join(home, "trusted_folders.toml"), "utf8");
    // the key as the engine's `toml` crate writes it: a basic string, so a
    // Windows path's backslashes are escaped
    const table = text.indexOf(`[folders.${JSON.stringify(fakeWorkspaceKey())}]`);
    if (table < 0) return false;
    const body = text.slice(table).split("\n").slice(1).join("\n");
    const next = body.search(/^\[/m);
    return /^trusted = true$/m.test(next < 0 ? body : body.slice(0, next));
  } catch {
    return false;
  }
};
const folderTrustedAtBuild = argv.includes("--trust") || (mode === "folder-trust" && (trustV2 ? trustVerdict() === "trusted" : storeTrustsCwd()));
const agentsMdForReply = () => {
  // Fuigo's first-turn grant check rediscovers withheld instructions after a
  // process reply (acp_session_impl/withheld_instructions.rs). Keep a snapshot
  // at prompt admission so a later reply cannot rewrite an already running turn.
  if (!folderTrustedAtPrompt) return "withheld";
  try {
    return readFileSync("AGENTS.md", "utf8").trim();
  } catch {
    return "absent";
  }
};
let folderTrustedAtPrompt = folderTrustedAtBuild;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { name?: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
/** memory-search mode: the session's memory MCP server (the memory proxy). */
let memoryMcp: McpEntry | null = null;
const memoryServerOf = (servers: unknown): McpEntry | null => Array.isArray(servers)
  // the bare memory proxy, or (a bound mount, as Fuigo is handed it) the relay shim named by its per-turn murage-memory-<hex> alias
  ? (servers.find((s: any) => Array.isArray(s?.args) && s.args.some((arg: unknown) => /memory-proxy/.test(String(arg)))
    || /^murage-memory-[a-f0-9]{20}$/.test(String(s?.name ?? ""))) as McpEntry | undefined) ?? null
  : null;
/** The session this process built or loaded, as Fuigo keeps it resident. */
let liveSession: string | null = null;
/** The serialized servers the live session was last handed. */
let liveServers: string | null = null;
let markerCancelAck = false;
/** FAKE_ACP_MCP_CHILD_LOG: the running stand-in for the session's MCP servers. */
let mcpChild: ReturnType<typeof spawn> | null = null;
const startMcpChild = (servers: unknown) => {
  const log = process.env.FAKE_ACP_MCP_CHILD_LOG;
  if (!log) return;
  mcpChild?.kill("SIGKILL");
  const first = Array.isArray(servers) ? servers[0] as { command?: unknown; args?: unknown; env?: Array<{ name: string; value: string }> } | undefined : undefined;
  const nativeEnv = Object.fromEntries((first?.env ?? []).map(entry => [entry.name, entry.value]));
  mcpChild = typeof first?.command === "string"
    ? spawn(first.command, Array.isArray(first.args) ? first.args.map(String) : [], { windowsHide: true, env: { ...process.env, ...nativeEnv }, stdio: nativeEnv.MURAGE_RELAY_TICKET ? ["pipe", "pipe", "pipe"] : "ignore" })
    : spawn("sleep", ["300"], { windowsHide: true, stdio: "ignore" });
  if (nativeEnv.MURAGE_RELAY_TICKET) {
    mcpChild.stdout?.resume(); mcpChild.stderr?.resume();
    mcpChild.stdin?.on("error", () => {});
    mcpChild.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
  }
  appendFileSync(log, `${mcpChild.pid}\n`);
};
/** The server names the last session/new or session/load carried (FAKE_ACP_MCP_LIST "all:<status>"). */
let lastMcpServerNames: string[] = [];
/** When those servers were handed over, and whether the list has shown them settled since. */
let mcpHandedAt = 0;
let mcpListSettledLogged = false;
/** FAKE_ACP_MCP_LIST_UNANSWERED: list calls seen by this process. */
let mcpListCalls = 0;
const mcpTimeline = (event: "ready" | "listed" | "prompt", name?: string) => {
  const file = process.env.FAKE_ACP_MCP_TIMELINE;
  if (file) appendFileSync(file, `${JSON.stringify({ event, at: Date.now(), ...(name ? { name } : {}) })}\n`);
};
const announceMcpReady = (sessionId: string, servers: unknown) => {
  if (Array.isArray(servers)) lastMcpServerNames = servers.map((server) => String((server as { name?: unknown })?.name ?? "")).filter(Boolean);
  mcpHandedAt = Date.now();
  mcpListSettledLogged = false;
  const afterListing = process.env.FAKE_ACP_MCP_READY_AFTER_LIST === "1";
  const serverCount = Array.isArray(servers) ? servers.length : 0;
  const canAnnounce = process.env.FAKE_ACP_MCP_READY === "1" && serverCount > 0;
  let connectionGeneration = 0;
  // Grok Build announces the same thing under its own name (FAKE_ACP_MCP_READY_METHOD).
  const announce = () => {
    if (afterListing && (connectionGeneration !== mcpConnectionGeneration || connectedMcp.some(child => child.exitCode !== null || child.signalCode !== null))) return;
    const gate = process.env.FAKE_ACP_MCP_READY_GATE_FILE;
    if (gate && !existsSync(gate)) {
      // `<gate>.waiting` says the session was answered and the first prompt is held on readiness
      if (!existsSync(`${gate}.waiting`)) writeFileSync(`${gate}.waiting`, "");
      setTimeout(announce, 10).unref();
      return;
    }
    mcpTimeline("ready");
    for (const method of process.env.FAKE_ACP_MCP_READY_METHOD ? [process.env.FAKE_ACP_MCP_READY_METHOD] : ["_fuigo/mcp_initialized", "_x.ai/mcp_initialized"])
      out({ jsonrpc: "2.0", method, params: { sessionId, mcpToolCount: serverCount, elapsedMs: 1 } });
  };
  const schedule = () => {
    if (!canAnnounce) return;
    const delay = Number(process.env.FAKE_ACP_MCP_READY_DELAY_MS) || 0;
    if (delay > 0) setTimeout(announce, delay); else announce();
  };
  connectMcpServers(servers, afterListing ? schedule : undefined);
  connectionGeneration = mcpConnectionGeneration;
  if (!afterListing) schedule();
  // FAKE_ACP_MCP_PROGRESS=<n>: report the engine's connect count (n of the servers handed) 100 ms later, under
  // FAKE_ACP_MCP_PROGRESS_METHOD (default `_fuigo/mcp_progress`), and never announce more.
  const progress = process.env.FAKE_ACP_MCP_PROGRESS;
  if (progress !== undefined && serverCount > 0) setTimeout(() => out({ jsonrpc: "2.0", method: process.env.FAKE_ACP_MCP_PROGRESS_METHOD ?? "_fuigo/mcp_progress", params: { sessionId, total: serverCount, connected: Number(progress) } }), 100).unref();
};
/** FAKE_ACP_MCP_CONNECT: the servers this engine holds open, as a real engine does. */
let connectedMcp: Array<ReturnType<typeof spawn>> = [];
process.on("exit", () => { for (const child of connectedMcp) child.kill(); });
// A real engine stops its MCP servers and waits for them before it exits; a
// child left to its own parent's death would linger unreaped (a zombie keeps
// the process group alive where nothing reaps orphans, as in a container).
if (process.env.FAKE_ACP_MCP_CONNECT === "1" && !process.env.FAKE_ACP_TERM) {
  process.once("SIGTERM", () => {
    const alive = connectedMcp.filter((child) => child.exitCode === null && child.signalCode === null);
    if (!alive.length) process.exit(0);
    let left = alive.length;
    for (const child of alive) {
      child.once("exit", () => { if (--left === 0) process.exit(0); });
      child.kill("SIGTERM");
    }
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
let mcpConnectionGeneration = 0;
function connectMcpServers(servers: unknown, listedAll?: () => void): void {
  const generation = ++mcpConnectionGeneration;
  if (process.env.FAKE_ACP_MCP_CONNECT !== "1" || !Array.isArray(servers)) return;
  for (const child of connectedMcp) child.kill();
  connectedMcp = [];
  const waiting = new Set(servers.map((_entry, index) => index));
  const start = () => {
    if (generation !== mcpConnectionGeneration) return;
    for (const [index, entry] of (servers as McpEntry[]).entries()) {
      if (typeof entry?.command !== "string") continue;
      const env = { ...process.env };
      for (const { name, value } of entry.env ?? []) env[name] = value;
      const child = spawn(entry.command, entry.args ?? [], { windowsHide: true, env, stdio: ["pipe", "pipe", "ignore"] });
      connectedMcp.push(child);
      child.on("error", () => undefined);
      child.stdin.on("error", () => undefined);
      const write = (message: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`); };
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let message: any;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.id === 1 && message.result) {
            write({ jsonrpc: "2.0", method: "notifications/initialized" });
            write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (message?.id === 2 && message.result) {
            mcpTimeline("listed", entry.name);
            if (Array.isArray(message.result.tools) && waiting.delete(index) && !waiting.size && generation === mcpConnectionGeneration) listedAll?.();
          }
        }
      });
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-acp", version: "0" } } });
    }
  };
  const delay = Number(process.env.FAKE_ACP_MCP_CONNECT_DELAY_MS) || 0;
  if (delay > 0) setTimeout(start, delay); else start();
}
const agentsTokenOf = (servers: unknown): string | undefined => {
  if (!Array.isArray(servers)) return undefined;
  const agents = servers.find((s: any) => s?.name === "agents") as McpEntry | undefined;
  const token = agents?.env?.find(entry => entry.name === "MURAGE_COMMS_TOKEN")?.value;
  return token === undefined ? undefined : fixtureCredentialFingerprint(token);
};
/** The handed MCP servers as the dumps record them: a credential-named env
 * entry or header is a fingerprint (fixture-dump.ts), never its value. */
const CREDENTIAL_NAME = /token|key|secret|password|passwd|auth|credential|cookie/i;
const dumpedServers = (servers: unknown): unknown => {
  if (!Array.isArray(servers)) return servers;
  const rows = (list: unknown) => Array.isArray(list)
    ? list.map((row: any) => typeof row?.name === "string" && typeof row?.value === "string" && CREDENTIAL_NAME.test(row.name) ? { ...row, value: fixtureCredentialFingerprint(row.value) } : row)
    : list;
  return servers.map((server: any) => server && typeof server === "object"
    ? { ...server, ...(server.env !== undefined ? { env: rows(server.env) } : {}), ...(server.headers !== undefined ? { headers: rows(server.headers) } : {}) }
    : server);
};
if (process.env.FAKE_ACP_SPAWN_LOG) appendFileSync(process.env.FAKE_ACP_SPAWN_LOG, `${process.pid}\n`);
if (process.env.FAKE_ACP_PARENT_LOG) appendFileSync(process.env.FAKE_ACP_PARENT_LOG, `${process.ppid}\n`);

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>, concurrent = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { windowsHide: true, env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    // FAKE_ACP_MCP_TIMEOUT_MS: the engine gives up on a tool call that long
    // after it started (the tool's own connection closes), as a real engine's
    // tool timeout does; the turn then goes on
    // A real engine stops a server it is done with and waits for it: the
    // answer goes on only once the child has exited (and is reaped), so no
    // server outlives this process unreaped.
    const stopThen = (done: () => void) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", () => done());
      child.kill();
    };
    // A relay shim is the engine's persistent connection: a tool timeout
    // abandons the call and leaves the connection to the engine's own exit
    // (closing it would seal the whole mount and end the turn in error).
    // Once the call is given up, an answer that still arrives starts nothing: no later call of the script is sent.
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      if (holdFixtureRelayClient(child, entry.args)) return reject(new Error("mcp timeout"));
      stopThen(() => reject(new Error("mcp timeout")));
    }, Number(process.env.FAKE_ACP_MCP_TIMEOUT_MS) || 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      if (abandoned) return;
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        if (holdFixtureRelayClient(child, entry.args)) return resolve(last);
        return stopThen(() => resolve(last));
      }
      const send = (call: typeof calls[number], index: number) => write({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
      if (!concurrent || step % 2 === 0) calls.slice(step, step + (concurrent ? 2 : 1)).forEach((call, index) => send(call, step + index));
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        if (process.env.FAKE_REVIEW_REPLAY_LOG) appendFileSync(process.env.FAKE_REVIEW_REPLAY_LOG, JSON.stringify({ response: msg.id, reply: last, isError: msg.result?.isError === true }) + "\n");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

/** Scripted reasoning-only turn: thought chunks and nothing else, the shape
 * of a provider that never leaves its thinking stream yet still answers
 * end_turn, which the driver must report as a lost turn, not a success. */
function playReasoningTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "considering the request at length" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: " without ever producing an answer" } } } });
}

// Isolated recall fixtures can request a unique generated source reply, as the Claude fake does.
function playTurn(promptText = "") {
  const marker = process.env.FAKE_ACP_MENTION_MARKER;
  const reply = marker && promptText.includes(marker) ? process.env.FAKE_ACP_MENTION_REPLY : undefined;
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: reply ?? "hello from fake acp" } } } });
  // Permission-routing fixtures ask before any execution; the generic tool row is unrelated to that request.
  // A text answer needs no tool. Permission fixtures can request a tool later.
  if (process.env.FAKE_ACP_TEXT_ONLY === "1") return;
  // FAKE_ACP_TOOL_KIND: the ACP kind of this scripted tool row. Unset, the row has no kind (ACP reads it as `other`), which
  // the NOLIMITS-MEANS-IT outside mark (M2) rightly reads as an outside tool; a suite that needs a clean owner turn names a
  // local kind (`think`).
  const kind = process.env.FAKE_ACP_TOOL_KIND;
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run", ...(kind ? { kind } : {}) } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

/** A wrapper-tool turn: the engine exposes one "use a tool" tool and passes
 * the real call through in its arguments, then fails it with a reason. Both
 * halves are what a chip has to survive — the wrapper name and the reason. */
function playWrappedToolTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-w", title: "use_tool",
    rawInput: { tool_name: "murage-memory-1f83c2b455279a599bd7__memory_search", tool_input: { query: "quarterly plan" } } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-w", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "Memory is not available for this turn.\nsearch timed out after 5s" } }] } } });
}

/** Two completed tool calls whose output carries an image: one from a custom
 * MCP server (a deliverable) and one from Murage's own computer surface
 * (a live frame that must not be retained). ACP wraps each output part as
 * `{type:"content", content:<block>}`. */
function playToolImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-img", title: "mcp__omarchy__screenshot" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-img", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "captured" } }, { type: "content", content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" } }] } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-screen", title: "mcp__computer__screenshot" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-screen", status: "completed",
    content: [{ type: "content", content: { type: "image", data: SCREEN_PIXEL_PNG, mimeType: "image/png" } }] } } });
}

/** Murage's own computer surface, reached through ACP with a shell command in
 * its arguments (`computer_exec`). The chip deliberately reads as the command
 * — that is what a person wants to see — but the frame the call answers with
 * is still a live screen preview, not a deliverable. */
function playComputerExecImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-exec", title: "mcp__computer__computer_exec",
    rawInput: { command: "firefox", observe: true } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-exec", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "exit 0" } }, { type: "content", content: { type: "image", data: SCREEN_PIXEL_PNG, mimeType: "image/png" } }] } } });
}

/** A custom MCP server's screenshot reached through a wrapper tool. The chip
 * drops the server namespace — the person cares about the tool — so the
 * retention decision must not be taken on the chip's name: `screenshot` alone
 * looks like Murage's own screen surface, and this image is a deliverable. */
function playWrappedToolImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-wimg", title: "use_tool",
    rawInput: { tool_name: "mcp__omarchy-bridge__screenshot", tool_input: { window: "editor" } } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-wimg", status: "completed",
    content: [{ type: "content", content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" } }] } } });
}

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

// Linear line split: only each new chunk is searched for a newline and the parts of an unfinished line are joined
// once, so a 64 MiB line arriving in small chunks is read in time (searching the whole buffer per chunk was quadratic).
let parts: string[] = [];
process.stdin.on("data", (c) => {
  let rest = String(c);
  let nl;
  while ((nl = rest.indexOf("\n")) !== -1) {
    const line = parts.join("") + rest.slice(0, nl);
    parts = [];
    rest = rest.slice(nl + 1);
    // FAKE_ACP_RAW_IN_LOG: every raw stdin line exactly as written (JSON-quoted, one per log line), before any parse
    if (process.env.FAKE_ACP_RAW_IN_LOG) appendFileSync(process.env.FAKE_ACP_RAW_IN_LOG, JSON.stringify(line) + "\n");
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    lastInboundLine = line;
    handle(msg);
  }
  if (rest) parts.push(rest);
});

// folder-trust mode, after session/new OR session/load: Fuigo's
// `maybe_spawn_interactive_trust_prompt` runs after either session reply
// (session_setup.rs `new_session_inner` / `load_session_inner`), only for an
// interactive client, only when the store has no grant. Detached from the
// prompt: the client may answer it before or after it sends session/prompt.
// (FUIGOTRUST3: the session/load branch was missing, so a second turn on a
// thread — resumed through its cursor — neither asked nor recorded
// `folderTrust` in the dump, and a test reading it after such a turn was
// timing-dependent.)
/** FAKE_ACP_REQUEST_GATE=<file>: hold the trust request until the file exists (a test revokes the lease before the engine asks). */
function gatedByFile(fn: () => void): () => void {
  const gate = process.env.FAKE_ACP_REQUEST_GATE;
  if (!gate) return fn;
  return () => { const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); fn(); } }, 10); };
}
/** FAKE_ACP_TRUST_ON_PROMPT: the V=2 request waiting for session/prompt. */
let trustRaiseOnPrompt: (() => void) | null = null;
function afterSessionBuilt() {
  if (mode !== "folder-trust") return;
  if (trustV2) {
    const key = trustWorkspace();
    const verdict = trustVerdict();
    // Exercise a native ask that arrives despite a process-level launch grant.
    const asks = (!argv.includes("--trust") || process.env.FAKE_ACP_TRUST_FORCE_REQUEST === "1") && (verdict === "new" || verdict === "upgrade") && folderTrustClientV2 && !trustRejected.has(key);
    let storeText: string | null = null;
    try { storeText = readFileSync(join(fuigoHomeDir(), "trusted_folders.toml"), "utf8"); } catch { /* no store */ }
    trustLog({ event: "start", key, verdict, asks, home: fuigoHomeDir(), store: storeText });
    dumpState.folderTrust = { trustedAtBuild: folderTrustedAtBuild, interactive: folderTrustInteractive, v2: folderTrustClientV2, verdict, requested: asks };
    if (process.env.FAKE_ACP_DUMP) writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
    if (!asks) return;
    pendingPermissionId = 9006;
    const scope = process.env.FAKE_ACP_TRUST_SCOPE ?? "configAndCommands";
    const kinds = process.env.FAKE_ACP_TRUST_KINDS ?? "instructions";
    const params = { sessionId: "fake-acp-session", cwd: process.cwd(), workspace: key, configKinds: kinds ? kinds.split(",") : [], ...(scope === "none" ? {} : { scope }), reason: verdict };
    const raiseNow = () => {
      // FAKE_ACP_TRUST_DECLINE_FILE + FAKE_ACP_TRUST_DECLINE_KEY: a "no" for that key lands in that trust file just before the ask (a decline
      // written mid-turn, after the client's own trust step); the key may be several, one per line
      if (process.env.FAKE_ACP_TRUST_DECLINE_FILE && (process.env.FAKE_ACP_TRUST_DECLINE_KEY ?? "").split("\n").includes(key))
        appendFileSync(process.env.FAKE_ACP_TRUST_DECLINE_FILE, `[folders.${JSON.stringify(key)}]\ntrusted = false\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`);
      trustLog({ event: "request", params });
      out({ jsonrpc: "2.0", id: pendingPermissionId, method: "_fuigo/folder_trust/request", params });
    };
    const raise = gatedByFile(raiseNow);
    const delay = Number(process.env.FAKE_ACP_TRUST_DELAY_MS) || 0;
    if (process.env.FAKE_ACP_TRUST_ON_PROMPT === "1") trustRaiseOnPrompt = raise;
    else if (delay) setTimeout(raise, delay);
    else raise();
    return;
  }
  dumpState.folderTrust = { trustedAtBuild: folderTrustedAtBuild, interactive: folderTrustInteractive, requested: false };
  if (process.env.FAKE_ACP_DUMP) writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
  if (!folderTrustedAtBuild && folderTrustInteractive) {
    (dumpState.folderTrust as { requested: boolean }).requested = true;
    if (process.env.FAKE_ACP_DUMP) writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
    pendingPermissionId = 9006;
    gatedByFile(() => out({
      jsonrpc: "2.0",
      id: pendingPermissionId,
      method: "_fuigo/folder_trust/request",
      params: { sessionId: "fake-acp-session", cwd: process.cwd(), workspace: process.cwd(), configKinds: ["instructions"] },
    }))();
  }
}

/** `__fixture_subagents__` (Fuigo's shape): three sub agents are announced on
 * `_fuigo/session_notification`, the prompt ends `end_turn` while they run,
 * then each raises permission asks of its own, then they finish.
 *   FAKE_ACP_BG_ASKS  asks raised after the prompt result (default 2)
 *   FAKE_ACP_BG_HOLD  "1": the sub agents never finish (Stop and cap tests)
 *   FAKE_ACP_BG_WAKE  "1": the last finish says will_wake, and a reply plus
 *                     turn_completed follow it
 *   FAKE_ACP_BG_LOG   one line per ask verdict and per finish */
const bgAnswers = new Map<number, (outcome: any) => void>();
const bgLog = (line: string) => { if (process.env.FAKE_ACP_BG_LOG) appendFileSync(process.env.FAKE_ACP_BG_LOG, `${line}\n`); };
async function playSubagents(promptMsg: any) {
  const sessionId = promptMsg.params?.sessionId;
  const note = (update: Record<string, unknown>) => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId, update } });
  const chunk = (text: string) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  const ids = ["sub-1", "sub-2", "sub-3"];
  chunk("Three helpers are reading.");
  for (const id of ids) note({ sessionUpdate: "subagent_spawned", subagent_id: id, parent_session_id: sessionId, child_session_id: `child-${id}`, subagent_type: "explore", description: `Helper ${id}` });
  result(promptMsg.id, { stopReason: "end_turn", _meta: { inputTokens: 1, outputTokens: 1 } });
  const asks = Number(process.env.FAKE_ACP_BG_ASKS ?? "2");
  for (let i = 0; i < asks; i += 1) {
    note({ sessionUpdate: "subagent_progress", subagent_id: ids[0], parent_session_id: sessionId, child_session_id: "child-sub-1", duration_ms: 5, turn_count: 1, tool_call_count: i + 1, tokens_used: 1, context_window_tokens: 100, context_usage_pct: 1, tools_used: ["read"], error_count: 0 });
    const id = 9200 + i;
    const answered = new Promise<any>((resolve) => bgAnswers.set(id, resolve));
    out({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: `child-sub-1`, toolCall: { toolCallId: `bg-${i}`, title: "Read /outside/cwd/file.md", kind: "read" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
    const outcome = (await answered)?.outcome;
    bgLog(`verdict:${outcome?.outcome === "selected" ? outcome.optionId : String(outcome?.outcome)}`);
  }
  if (process.env.FAKE_ACP_BG_HOLD === "1") { bgLog("held"); return; }
  ids.forEach((id, index) => {
    const last = index === ids.length - 1;
    note({ sessionUpdate: "subagent_finished", subagent_id: id, child_session_id: `child-${id}`, status: "completed", tool_calls: 1, turns: 1, duration_ms: 9, tokens_used: 1, will_wake: last && process.env.FAKE_ACP_BG_WAKE === "1" });
  });
  if (process.env.FAKE_ACP_BG_WAKE === "1") {
    await new Promise((resolve) => setTimeout(resolve, 30));
    chunk("All helpers reported.");
    note({ sessionUpdate: "turn_completed", prompt_id: "wake-1", stop_reason: "end_turn" });
  }
  bgLog("finished");
}

let sessionSeq = 0;
let lateScheduled = false;
function scheduleLateFrames(sessionId: unknown) {
  const ms = Number(process.env.FAKE_ACP_LATE_FRAMES_MS);
  if (lateScheduled || !Number.isFinite(ms) || ms <= 0 || typeof sessionId !== "string") return;
  lateScheduled = true;
  setTimeout(() => {
    const shape = process.env.FAKE_ACP_LATE_SHAPE;
    const named = shape === "sessionless" ? {} : { sessionId };
    if (shape === "helper") {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "subagent_spawned", subagent_id: "late", parent_session_id: sessionId, child_session_id: "late-helper", subagent_type: "explore", description: "Late helper" } } });
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "late-helper", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE FRAME FROM THE EARLIER SESSION" } } } });
      out({ jsonrpc: "2.0", id: 9300, method: "session/request_permission", params: { sessionId: "late-helper", toolCall: { toolCallId: "late-1", title: "Late ask from the earlier session", kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
      return;
    }
    rawOut({ jsonrpc: "2.0", method: "session/update", params: { ...named, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE FRAME FROM THE EARLIER SESSION" } } } });
    rawOut({ jsonrpc: "2.0", id: 9300, method: "session/request_permission", params: { ...named, toolCall: { toolCallId: "late-1", title: "Late ask from the earlier session", kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
  }, ms);
}

// C11's ACP fixture consumes real paginated MCP responses. Only the MCP
// responder owns publication, using the same flushed-output observer as proxies.
const c11Served = new Map<string, string[]>();
const c11Dirty: Array<() => Promise<void>> = [];
async function c11List(server: any, spec: any) {
  const names = spec.catalogs[server.name];
  const env = Object.fromEntries(server.env.map((e: any) => [e.name, e.value]));
  const relayed = server.args?.some((arg: string) => /cli-mount-shim/.test(arg));
  if (!Array.isArray(names) && !relayed) { // Explicit legacy/unknown fixture, never exact zero.
    writeFileSync(env.MURAGE_MCP_LISTED_FILE, String(Date.now())); return;
  }
  const child = spawn(relayed ? server.command : process.execPath, relayed ? server.args : [fileURLToPath(new URL("./fake-c11-mcp.mjs", import.meta.url))], {
    env: { ...process.env, ...env, FIXTURE_TOOLS: JSON.stringify(names), FIXTURE_RESOURCES: spec.resources ? "1" : "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (relayed) connectedMcp.push(child);
  // A relayed mount's shim env carries no listed-file path, only its lease's relay ticket: record a digest of it so each lease has its own real marker.
  let marker = env.MURAGE_MCP_LISTED_FILE ?? (env.MURAGE_RELAY_TICKET ? createHash("sha256").update(env.MURAGE_RELAY_TICKET).digest("hex").slice(0, 16) : undefined);
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { const value = JSON.parse(line); pending.get(value.id)?.(value.result); pending.delete(value.id); });
  const request = (method: string, params: object = {}) => new Promise<any>(resolve => {
    pending.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c11-acp", version: "1" } });
    marker = initialized._fixtureMarker ?? marker;
    const served: string[] = []; let cursor: string | undefined;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      served.push(...page.tools.map((tool: any) => tool.name)); cursor = page.nextCursor;
    } while (cursor);
    if (spec.catalogReadGate && !existsSync(spec.catalogReadGate)) {
      writeFileSync(spec.catalogReadGate + ".waiting", "");
      await new Promise<void>(resolve => whenFile(spec.catalogReadGate, resolve));
    }
    c11Served.set(server.name, [...new Set(served)]);
    appendFileSync(process.env.FAKE_C11_LOG!, JSON.stringify({ launchId, event: "catalog", server: server.name, marker, names: served }) + "\n");
    if (spec.dirtyAfterOutput) c11Dirty.push(async () => { await request("fixture/dirty"); if (!relayed) child.stdin.end(); });
  } finally { if (!spec.dirtyAfterOutput && !relayed) {
    const closed = spec.awaitCatalogExit ? new Promise<void>(resolve => child.once("close", () => resolve())) : undefined;
    child.stdin.end(); await closed;
  } }
}

function handle(msg: any) {
  if (r3Root && !msg.method && [9390, 9391, 9392].includes(msg.id)) {
    if (msg.id === 9390 && msg.result?.outcome?.optionId === "allow-once") r3Record("tool-ran");
    return;
  }
  if (mode === "fuigo-script" && msg.id !== undefined && !msg.method && scriptRequestIds.has(msg.id)) {
    scriptRequestIds.delete(msg.id);
    if (process.env.FAKE_ACP_SCRIPT_LOG) appendFileSync(process.env.FAKE_ACP_SCRIPT_LOG, JSON.stringify({ id: msg.id, at: Date.now() - scriptStartedAt, result: msg.result ?? null, error: msg.error ?? null }) + "\n");
    for (const then of scriptAnswerWaiters.get(msg.id) ?? []) then();
    scriptAnswerWaiters.delete(msg.id);
    return;
  }
  if ((msg.id === 9300 || msg.id === 9310) && !msg.method) {
    if (process.env.FAKE_ACP_LATE_REPLY_LOG) appendFileSync(process.env.FAKE_ACP_LATE_REPLY_LOG, JSON.stringify({ result: msg.result, error: msg.error }) + "\n");
    return;
  }
  if (msg.id !== undefined && !msg.method && bgAnswers.has(msg.id)) {
    const answered = bgAnswers.get(msg.id)!;
    bgAnswers.delete(msg.id);
    answered(msg.result ?? { outcome: { outcome: "error" } });
    return;
  }
  if (msg.id !== undefined && !msg.method && proposalAsks.has(msg.id)) {
    const answered = proposalAsks.get(msg.id)!;
    proposalAsks.delete(msg.id);
    answered(msg.result ?? { error: msg.error });
    return;
  }
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    const chosen = msg.result?.outcome?.optionId;
    if (mode === "folder-trust" && msg.id === 9301) trustLog({ event: "command-reply", raw: lastInboundLine });
    // GH15 qualification: perform the synthetic report only after the real
    // permission reply allows it. Never infer a file write from final prose.
    if (process.env.FAKE_ACP_GH15_REPORT === "1" && process.env.FAKE_ACP_DUMP
      && msg.result?.outcome?.outcome === "selected" && typeof chosen === "string" && chosen.startsWith("allow")) {
      const report = join(dirname(process.env.FAKE_ACP_DUMP), "gh15-report.md");
      const text = "GH15_SYNTHETIC_REPORT\n";
      if (process.platform === "win32") {
        const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const script = `[IO.File]::WriteAllText('${report.replaceAll("'", "''")}', '${text}', (New-Object Text.UTF8Encoding($false)))`;
        execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10000 });
      } else writeFileSync(report, text);
      out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Report written: ${text.trim()}` } } } });
    }
    bareRejectAnswered = typeof chosen === "string" && chosen.startsWith("reject")
      && (process.env.FAKE_ACP_BARE_REJECT_CANCELS === "always" || typeof msg.result?._meta?.followup_message !== "string");
    rejectFollowup = !bareRejectAnswered && typeof msg.result?._meta?.followup_message === "string" ? msg.result._meta.followup_message : null;
    if (process.env.FAKE_ACP_PERMISSION_TIMING_FILE && permissionAskedAt !== null) {
      appendFileSync(process.env.FAKE_ACP_PERMISSION_TIMING_FILE, `${JSON.stringify({ askedAt: permissionAskedAt, waitMs: Date.now() - permissionAskedAt })}\n`);
      permissionAskedAt = null;
    }
    if (trustV2 && msg.id === 9006) {
      trustLog({ event: "reply", raw: lastInboundLine });
      // Fuigo 1.0.38 keeps a `duration: "process"` trust in memory and writes
      // nothing; Murage sends that field only to an engine that reads it.
      if (msg.result?.outcome === "trust" && msg.result?.scope === "configAndCommands") {
        if (msg.result?.duration === "process") trustProcessOnly.add(trustWorkspace());
        else persistGrant(trustWorkspace());
      } else trustRejected.add(trustWorkspace());
    }
    // Fuigo 1.0.40: one live notice after a grant, only to a client that opted in.
    if (mode === "folder-trust" && msg.id === 9006 && folderTrustReopenNotice && msg.result?.outcome === "trust") {
      out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: "fake-acp-session", update: { sessionUpdate: "config_notice", message: "Folder trust is on. Reopen this session to use it." } } });
      dumpState.reopenNoticeSent = ((dumpState.reopenNoticeSent as number | undefined) ?? 0) + 1;
    }
    if (process.env.FAKE_ACP_DUMP && msg.id !== 9301) {
      dumpState.decision = msg.result ?? { error: msg.error };
      writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
    }
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);
  // FAKE_ACP_RPC_FULL_LOG: every client request and notification, whole (method and params), one JSON line each
  if (process.env.FAKE_ACP_RPC_FULL_LOG) appendFileSync(process.env.FAKE_ACP_RPC_FULL_LOG, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\n");
  if (process.env.FAKE_ACP_RPC_LOG) {
    const agentsToken = agentsTokenOf(msg.params?.mcpServers);
    appendFileSync(process.env.FAKE_ACP_RPC_LOG, JSON.stringify({
      pid: process.pid, method: msg.method,
      ...(msg.method === "initialize" ? { argv: process.argv.slice(2) } : {}),
      ...(msg.params?._meta?.noReplay === true ? { noReplay: true } : {}),
      ...(agentsToken !== undefined ? { agentsToken } : {}),
    }) + "\n");
  }

  // Synthetic diagnostics: use the real request ID, but a spoofed provider
  // method and private canaries that must never enter runtime.error details.
  if (mode === `rpc-error:${msg.method}`) {
    return out({ jsonrpc: "2.0", id: msg.id, error: {
      code: -32603, message: "Internal error", acpMethod: "session/cancel",
      data: { http_status: 500, message: "fixture provider failure https://billing.invalid/?key=fake-secret-canary", request: "fake-private-request", url: "https://billing.invalid/?key=fake-secret-canary" },
    } });
  }
  if (mode === "unknown-rpc-error" && msg.method === "session/prompt") {
    out({ jsonrpc: "2.0", id: -999, error: { code: -32603, message: "fake-secret-canary", data: { http_status: 500 } } });
  }

  if (mode === "c11-budget") {
    const spec = JSON.parse(process.env.FAKE_C11_SPEC ?? "{}");
    if (spec.catalogVariants || spec.resourceVariants) {
      const prior = existsSync(process.env.FAKE_C11_LOG!) ? readFileSync(process.env.FAKE_C11_LOG!, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event === "spawn") : [];
      const own = prior.findIndex(row => row.launchId === launchId), ordinal = own < 0 ? prior.length : own;
      if (spec.catalogVariants) spec.catalogs = spec.catalogVariants[Math.min(ordinal, spec.catalogVariants.length - 1)];
      if (spec.resourceVariants) spec.resources = spec.resourceVariants[Math.min(ordinal, spec.resourceVariants.length - 1)];
    }
    const log = (value: unknown) => appendFileSync(process.env.FAKE_C11_LOG!, JSON.stringify({ launchId, ...value as object }) + "\n");
    if (msg.method === "initialize" && spec.initialGate && !existsSync(spec.initialGate)) { writeFileSync(spec.initialGate + ".waiting", ""); whenFile(spec.initialGate, () => handle(msg)); return; }
    if (msg.method === "initialize" && spec.recoveryGate && existsSync(process.env.FAKE_C11_LOG!) && readFileSync(process.env.FAKE_C11_LOG!, "utf8").includes('"event":"prompt"') && !existsSync(spec.recoveryGate)) {
      writeFileSync(spec.recoveryGate + ".waiting", ""); whenFile(spec.recoveryGate, () => handle(msg)); return;
    }
    if (msg.method === "initialize" && spec.crashReplacement && existsSync(process.env.FAKE_C11_LOG!) && readFileSync(process.env.FAKE_C11_LOG!, "utf8").includes('"event":"prompt"')) { log({ event: "replacement-crash" }); process.exit(3); }
    if (msg.method === "initialize") log({ event: "spawn", overlay: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"), argv: process.argv.slice(2) });
    if (msg.method === "session/load" && spec.loadGate && !existsSync(spec.loadGate)) {
      writeFileSync(spec.loadGate + ".waiting", ""); whenFile(spec.loadGate, () => handle(msg)); return;
    }
    if (msg.method === "session/new" || msg.method === "session/load") {
      const servers = msg.params.mcpServers ?? [];
      log({ event: msg.method, sessionId: msg.params.sessionId, servers: servers.map((s: any) => s.name) });
      if (msg.method === "session/load" && spec.loadNull) { result(msg.id, null); return; }
      if (msg.method === "session/load" && spec.loadError) { out({ jsonrpc: "2.0", id: msg.id, error: spec.loadError }); return; }
      const listings: Promise<void>[] = [];
      for (const server of servers) {
        const path = server.env.find((e: any) => e.name === "MURAGE_MCP_LISTED_FILE")?.value;
        if (!path && !server.args?.some((arg: string) => /cli-mount-shim/.test(arg))) continue;
        const publish = () => c11List(server, spec).catch(error => { process.stderr.write(String(error)); process.exit(3); });
        if (spec.skipMarker === server.name) continue;
        if (spec.markerGate && server.name === spec.heldMount && !existsSync(spec.markerGate)) {
          writeFileSync(spec.markerGate + ".waiting", "");
          listings.push(new Promise<void>(resolve => whenFile(spec.markerGate, () => resolve(publish()))));
        } else listings.push(publish());
      }
      const sessionReady = () => result(msg.id, { sessionId: msg.params.sessionId ?? "c11-session" });
      // Early replies leave the driver's marker wait observable in this fixture.
      if (spec.awaitCatalogExit) void Promise.all(listings).then(sessionReady); else sessionReady();
      return;
    }
    if (msg.method === "session/prompt") {
      const permission = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}").permission ?? {};
      const ids = Array.from(c11Served).flatMap(([server, names]) => names.map(name => `${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_")));
      const visible = ids.filter(id => {
        let action = "ask";
        for (const [pattern, rule] of Object.entries(permission)) {
          const regex = new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
          if (regex.test(id) && typeof rule === "string") action = rule;
        }
        return action !== "deny";
      });
      const count = visible.length + spec.native;
      // The fixture models a provider limit change after the first completed
      // turn; a new native process must observe the same lower provider limit.
      const completedTurn = spec.limitAfterPrompt && readFileSync(process.env.FAKE_C11_LOG!, "utf8").includes('"event":"completed"');
      const limit = completedTurn ? spec.limitAfterPrompt : spec.limit;
      log({ event: "prompt", count, visible, prompt: msg.params.prompt });
      if (spec.output) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, ...(spec.replay ? { _meta: { isReplay: true } } : {}), update: spec.output } });
      const finish = () => {
      if (count > limit || spec.forceReject) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { errorName: "APIError", message: `tools: array too long. Expected an array with maximum length ${limit}, but got ${count}.` } } });
      else { log({ event: "completed" }); out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixture complete" } } } }); result(msg.id, { stopReason: "end_turn" }); }
      };
      if (spec.dirtyAfterOutput) void Promise.all(c11Dirty.map(change => change())).then(finish);
      else if (spec.promptGate && readFileSync(process.env.FAKE_C11_LOG!, "utf8").split('"event":"prompt"').length > 2 && !existsSync(spec.promptGate)) {
        writeFileSync(spec.promptGate + ".waiting", ""); whenFile(spec.promptGate, finish);
      } else finish();
      return;
    }
  }

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      // FAKE_ACP_AUTH_METHODS: a comma list of method ids to advertise (Cline's
      // provider ids, item 175); unset keeps the one cached_token method.
      const authMethods = mode === "no-auth" ? [] : process.env.FAKE_ACP_AUTH_METHODS ? process.env.FAKE_ACP_AUTH_METHODS.split(",").map((id) => ({ id })) : [{ id: "cached_token" }];
      permissionPrompts = msg.params?.clientCapabilities?._meta?.["fuigo/permissionPrompts"] === true;
      folderTrustInteractive = msg.params?.clientCapabilities?._meta?.["fuigo/folderTrust"]?.interactive === true;
      folderTrustClientV2 = msg.params?.clientCapabilities?._meta?.["fuigo/folderTrust"]?.v2 === true;
      folderTrustReopenNotice = msg.params?.clientCapabilities?._meta?.["fuigo/folderTrust"]?.reopenNotice === true;
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.initialize = msg.params ?? null;
        writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      const initDelay = Number(process.env.FAKE_ACP_INIT_DELAY_MS) || 0;
      const answer = () => result(msg.id, { protocolVersion: 1, authMethods, ...(process.env.FAKE_ACP_AGENT_VERSION ? { agentInfo: { name: "fixture", version: process.env.FAKE_ACP_AGENT_VERSION } } : {}), ...(mode.startsWith("fuigo-retry:disc-") || process.env.FAKE_ACP_RETRY_DISCARD === "1" ? { agentCapabilities: { _meta: { "fuigo/capabilities": { retryDiscard: { version: 1 } } } } } : {}), ...(process.env.FAKE_ACP_PROMPT_SCOPE === "1" ? { agentCapabilities: { _meta: { "fuigo/promptScope": 1 } } } : {}), ...(initCapture ? { agentCapabilities: initCapture.agentCapabilities } : {}), _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      if (initDelay > 0) setTimeout(answer, initDelay); else answer();
      break;
    }
    case "authenticate":
      // Recorded next to FAKE_ACP_DUMP so a test can see which method was picked.
      if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.auth.json`, JSON.stringify({ methodId: msg.params?.methodId ?? null }));
      result(msg.id, {});
      break;
    case "session/new": {
      // N5: persistent engine-home witness, enabled only by this isolated fixture.
      if (process.env.FAKE_ACP_HOME_SESSION === "1" && process.env.FUIGO_HOME) {
        mkdirSync(join(process.env.FUIGO_HOME, "sessions"), { recursive: true });
        writeFileSync(join(process.env.FUIGO_HOME, "sessions", "fake-session"), "Full access history");
      }
      if (process.env.FAKE_ACP_NEW_ERROR) {
        out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_ACP_NEW_ERROR) });
        break;
      }
      const sessionGate = process.env.FAKE_ACP_SESSION_NEW_GATE;
      if (sessionGate && !existsSync(sessionGate)) {
        writeFileSync(`${sessionGate}.waiting`, "");
        whenFile(sessionGate, () => handle(msg));
        break;
      }
      if (process.env.FAKE_ACP_SESSION_NEW_REFUSE_GATE) {
        const id = msg.id;
        whenFile(process.env.FAKE_ACP_SESSION_NEW_REFUSE_GATE, () => out({ jsonrpc: "2.0", id, error: { code: -32000, message: "The session could not start" } }));
        break;
      }
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const newPolicy = sessionPolicy(msg);
      if (newPolicy === true) break;
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.mcpServers = dumpedServers(servers);
        writeMainDump(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = withFixtureMountMetadata(servers.find((s: any) => s?.name === "agents" || /^murage-agents-[a-f0-9]{20}$/.test(String(s?.name))) ?? null);
      memoryMcp = memoryServerOf(servers);
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(dumpedServers(servers), null, 2));
      }
      if (process.env.FAKE_ACP_AGENTS_CAPABILITY && agentsMcp) {
        // always a new owner-only file: a stale file or a link left at the
        // path is removed first, never written through
        const path = process.env.FAKE_ACP_AGENTS_CAPABILITY;
        try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { writeSync(fd, JSON.stringify(agentsMcp.env ?? [])); } finally { closeSync(fd); }
      }
      const opts = configOptions();
      const mdls = sessionModels();
      const newSessionId = process.env.FAKE_ACP_UNIQUE_SESSIONS ? `fake-acp-session-${launchId}-${++sessionSeq}` : "fake-acp-session";
      liveSession = newSessionId;
      liveServers = JSON.stringify(servers);
      startMcpChild(servers);
      preFrames(newSessionId, agentsMcp?.name);
      result(msg.id, {
        sessionId: newSessionId,
        ...newPolicy,
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
        ...(process.env.FAKE_ACP_SESSION_MODES ? { modes: JSON.parse(process.env.FAKE_ACP_SESSION_MODES) } : {}),
      });
      announceMcpReady(newSessionId, servers);
      const catalogMs = Number(process.env.FAKE_ACP_GROK_CATALOG_MS);
      const catalogGate = process.env.FAKE_ACP_GROK_CATALOG_GATE;
      if (process.env.FAKE_ACP_GROK_MODELS_CACHE === "1" && (catalogGate || (Number.isFinite(catalogMs) && catalogMs >= 0 && process.env.FAKE_ACP_GROK_CATALOG_MS))) {
        const ids = (process.env.FAKE_ACP_GROK_CATALOG_IDS ?? "").split(",").filter(Boolean);
        const announce = () => {
          grokLateIds.push(...ids);
          try { writeFileSync(join(process.env.GROK_HOME ?? "", "models_cache.json"), JSON.stringify({ models: Object.fromEntries(ids.map((id) => [id, { id }])) })); } catch { /* the announcement still goes */ }
          // SYNTHETIC frame: grok 1.0.70 sends `_x.ai/models/update` once its background fetch lands (live, 10-29), but its params
          // were not captured yet; this is one of the shapes acpModelIdsIn reads. Replace with the captured shape at qualification.
          out({ jsonrpc: "2.0", method: "_x.ai/models/update", params: { sessionId: newSessionId, models: grokAdvertised().map((id) => ({ id })) } });
        };
        if (catalogGate) whenFile(catalogGate, announce);
        else setTimeout(announce, catalogMs);
      }
      // Fuigo 1.0.x and Grok Build advertise their "/" commands right after
      // session/new, before any prompt (session_setup.rs
      // send_available_commands_update). JSON array of ACP AvailableCommand.
      if (process.env.FAKE_ACP_COMMANDS) {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: newSessionId,
            update: { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.FAKE_ACP_COMMANDS) },
          },
        });
      }
      afterSessionBuilt();
      break;
    }
    case "session/load": {
      if (process.env.FAKE_ACP_HOME_SESSION === "1" && (!process.env.FUIGO_HOME || !existsSync(join(process.env.FUIGO_HOME, "sessions", "fake-session")))) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "session history missing from engine home" } });
        break;
      }
      const loadPolicy = sessionPolicy(msg);
      if (loadPolicy === true) break;
      const resident = liveSession !== null && msg.params?.sessionId === liveSession;
      if (resident && process.env.FAKE_ACP_REJECT_LIVE_LOAD) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "session is already loaded" } });
        break;
      }
      const loadServers = JSON.stringify(msg.params?.mcpServers ?? []);
      if (Array.isArray(msg.params?.mcpServers)) memoryMcp = memoryServerOf(msg.params.mcpServers) ?? memoryMcp;
      // a respawned agent loading its session gets the agents server there too (a real CLI mounts whatever session/load names)
      if (Array.isArray(msg.params?.mcpServers)) agentsMcp = withFixtureMountMetadata((msg.params.mcpServers as McpEntry[]).find((s: any) => s?.name === "agents" || /^murage-agents-[a-f0-9]{20}$/.test(String(s?.name))) ?? agentsMcp);
      const serversChanged = !resident || loadServers !== liveServers;
      if (Array.isArray(msg.params?.mcpServers)) {
        // Cold continuation and Fuigo's reconnect: the resident session takes the new servers
        const servers: McpEntry[] = msg.params.mcpServers;
        agentsMcp = withFixtureMountMetadata(servers.find((s: any) => s?.name === "agents" || /^murage-agents-[a-f0-9]{20}$/.test(String(s?.name))) ?? null);
        memoryMcp = memoryServerOf(servers);
        if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(dumpedServers(servers), null, 2));
        if (serversChanged) startMcpChild(servers);
      }
      if (process.env.FAKE_ACP_LOAD_ERROR) {
        out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_ACP_LOAD_ERROR) });
        break;
      }
      if (process.env.FAKE_ACP_LOAD_NULL) {
        result(msg.id, null);
        break;
      }
      // A fresh CLI loading durable history still starts its configured MCP
      // children. The resident reconnect branch above owns replacements only.
      if (!resident && Array.isArray(msg.params?.mcpServers)) startMcpChild(msg.params.mcpServers);
      const opts = configOptions();
      const mdls = sessionModels();
      if (typeof msg.params?.sessionId === "string") liveSession = msg.params.sessionId;
      liveServers = loadServers;
      preFrames(msg.params?.sessionId);
      result(msg.id, { ...loadPolicy, ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}), ...(process.env.FAKE_ACP_SESSION_MODES ? { modes: JSON.parse(process.env.FAKE_ACP_SESSION_MODES) } : {}) });
      if (serversChanged && typeof msg.params?.sessionId === "string" && process.env.FAKE_ACP_MCP_READY_NEW_ONLY !== "1") announceMcpReady(msg.params.sessionId, msg.params?.mcpServers);
      // the real engine runs the trust prompt after session/load too
      // (`load_session_inner`), so a resumed turn is gated like a new one
      afterSessionBuilt();
      break;
    }
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded next to FAKE_ACP_DUMP so a test can assert what was applied.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (msg.method === "session/set_model") {
        setModelAttempts.push(String(msg.params?.modelId));
        if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.setmodel.json`, JSON.stringify(setModelAttempts));
        if (process.env.FAKE_ACP_SET_MODEL_STALL === "1") break;
        if (process.env.FAKE_ACP_SET_MODEL_GATE && setModelAttempts.length === 1) {
          const id = msg.id;
          whenFile(process.env.FAKE_ACP_SET_MODEL_GATE, () => process.env.FAKE_ACP_SET_MODEL_GATE_ANSWER === "refuse"
            ? out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } })
            : result(id, {}));
          break;
        }
        const delayMs = Number(process.env.FAKE_ACP_SET_MODEL_DELAY_MS) || 0;
        if (delayMs > 0 && process.env.FAKE_ACP_GROK_MODELS_CACHE === "1" && setModelAttempts.length === 1) {
          // the refusal grok gives after waiting on its fetch in flight (about 5 s live), whatever arrives meanwhile
          const id = msg.id;
          setTimeout(() => out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }), delayMs);
          break;
        }
        if (process.env.FAKE_ACP_GROK_MODELS_CACHE === "1" && !grokAdvertised().includes(String(msg.params?.modelId))) {
          return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
        }
      }
      if (msg.method === "session/set_mode" && process.env.FAKE_ACP_SET_MODE_REFUSE === "1") {
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        // an agent whose ACP model namespace does not contain the id it was
        // sent — Cursor's answer when handed an argv slug like `auto`.
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      if (configId === "mode" && process.env.FAKE_ACP_DEVIN_MODE) {
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls));
        const currentValue = process.env.FAKE_ACP_DEVIN_MODE === "accept" ? value : "plan";
        result(msg.id, { configOptions: [...(configOptions() ?? []), { id: "mode", currentValue }] });
        break;
      }
      // FAKE_ACP_AUTOPILOT=1: Kiro 3.1.0's `autopilot` ("on" or "off"), recorded with the other config calls
      if (process.env.FAKE_ACP_AUTOPILOT === "1" && configId === "autopilot" && (value === "on" || value === "off")) {
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        result(msg.id, { configOptions: configOptions() });
        break;
      }
      if (process.env.FAKE_ACP_THINKING_SETTABLE === "1" && process.env.FAKE_ACP_VARIANT_WITHOUT_DEFAULT === "1" && configId === "thinking" && (value === "low" || value === "high")) {
        currentThinking = value;
        result(msg.id, { configOptions: configOptions() });
        break;
      }
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
      if (!process.env.FAKE_ACP_MODEL_STICKS) currentModel = value;
      result(msg.id, { configOptions: configOptions() });
      break;
    }
    case "session/prompt": {
      if (process.env.FAKE_ACP_PROMPT_SCOPE === "1" && pscopeSplitTail !== null) {
        // FAKE_ACP_PSCOPE_SPLIT: the held frame's middle (no newline) in one read, then its end, its newline and one frame
        // of THIS prompt in a later read; the prompt itself is answered after that
        const rest = pscopeSplitTail, mid = Math.floor(rest.length / 2);
        pscopeSplitTail = null;
        process.stdout.write(rest.slice(0, mid));
        const current = { jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, _meta: { promptId: msg.params?._meta?.promptId }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SPLIT CURRENT TEXT " } } } };
        setTimeout(() => { process.stdout.write(rest.slice(mid) + "\n" + JSON.stringify(current) + "\n"); handle(msg); }, 60);
        break;
      }
      if (process.env.FAKE_ACP_PROMPT_SCOPE === "1") {
        const sent = msg.params?._meta?.promptId;
        pscopeCurrent = typeof sent === "string" ? sent : null;
        pscopePrompts.push(pscopeCurrent);
        const script = process.env.FAKE_ACP_PSCOPE_TURN2;
        if (script && pscopePrompts.length === (Number(process.env.FAKE_ACP_PSCOPE_AT) || 2)) {
          const sid = msg.params?.sessionId, first = pscopePrompts[0] ?? null;
          const ask = (id: number, meta: Record<string, unknown> | undefined, title: string) => rawOut({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: sid, ...(meta ? { _meta: meta } : {}), toolCall: { toolCallId: `pscope-${id}`, title, kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
          const chunk = (text: string, meta: Record<string, unknown>) => rawOut({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, _meta: meta, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
          for (const step of script.split(",")) {
            if (step === "stale-request") ask(9300, { promptId: first }, "Stale ask from prompt one");
            else if (step === "drain") { ask(9300, { promptId: "drain-1", originPromptId: first }, "Drain ask from prompt one"); chunk("STALE DRAIN TEXT", { promptId: "drain-1", originPromptId: first }); }
            else if (step === "missing") ask(9300, undefined, "Ask with no prompt id");
            else if (step === "null") ask(9310, { promptId: null }, "Ask with a null prompt id");
            else if (step === "stale-text") chunk("STALE TURN ONE TEXT", { promptId: first });
            else if (step === "unknown") rawOut({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, _meta: { promptId: null }, update: { sessionUpdate: "fixture_unknown_kind" } } });
            else if (step === "status") rawOut({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, _meta: { promptId: null }, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
          }
          setTimeout(() => {
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn two reply" } } } });
            out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: pscopeCurrent, stop_reason: "end_turn", background: 0 } } });
            recordMethod("session/prompt.result");
            result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
          }, 400);
          break;
        }
      }
      if (r3Root) {
        void (async () => {
          const hook = execFileSync(process.execPath, ["-e", process.env.FAKE_R3_HERMES_HOOK!], { encoding: "utf8" });
          await r3Barrier(hook);
          r3Record("accepted");
          const ask = (id: number) => out({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
            sessionId: msg.params.sessionId, toolCall: { toolCallId: `r3-${id}`, kind: "execute", title: "fixture", rawInput: { command: "echo fixture" } },
            options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
          ask(9390);
          for (const id of [9391, 9392]) { r3Record("callback-attempt"); ask(id); }
          r3Record("output-attempt");
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "R3-LATE-OUTPUT" } } } });
          setTimeout(() => { result(msg.id, { stopReason: "end_turn" }); setTimeout(() => process.exit(0), 100); }, 300);
        })();
        break;
      }
      if (mode === "opencode-private-stderr") {
        const error = JSON.stringify('AI_APICallError: invalid API key "fixturePrivateCredentialAlpha"');
        const line = `timestamp=2026-11-06T14:22:31.873Z level=ERROR run=fixture message="stream error" providerID=fixture modelID=mock session.id=${msg.params?.sessionId} small=false agent=build mode=primary error.error=${error}\n`;
        // Split inside the opaque credential to exercise the parallel persistence sinks.
        const split = line.indexOf("Credential");
        process.stderr.write(line.slice(0, split), () => {
          setTimeout(() => process.stderr.write(line.slice(split), () => process.exit(4)), 20);
        });
        return;
      }
      if (mode === "opencode-quiet-progress") {
        // OPENCODE-QUIET-1023 W2(b): one owned record, then a reply chunk before 60 s, then silence.
        process.stderr.write(`timestamp=2026-11-06T14:22:31.873Z level=ERROR run=fixture message="stream error" providerID=fixture modelID=mock session.id=${msg.params?.sessionId} small=false agent=build mode=primary error.error="AI_APICallError: Local fixture rate limit"\n`);
        setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } } }), 1000);
        return;
      }
      if (mode === "opencode-quiet") {
        // Captured 1.19.5 grammar; the only substitution is this ACP session id.
        process.stderr.write(`timestamp=2026-11-06T14:22:31.873Z level=ERROR run=fixture message="stream error" providerID=fixture modelID=mock session.id=${msg.params?.sessionId} small=false agent=build mode=primary error.error="AI_APICallError: Local fixture rate limit"\n`);
        return;
      }
      trustLog({ event: "prompt" });
      folderTrustedAtPrompt = folderTrustedAtBuild || trustProcessOnly.has(trustWorkspace());
      mcpTimeline("prompt");
      if (mode === "fuigo-script") {
        if (process.env.FAKE_ACP_PROMPT_DUMP) writeFileSync(process.env.FAKE_ACP_PROMPT_DUMP, JSON.stringify(msg.params?.prompt ?? null));
        runFuigoScript(msg);
        return;
      }
      if (mode === "parallel-card-retry" && process.env.FAKE_ACP_FAIL_ONCE_FILE && !existsSync(process.env.FAKE_ACP_FAIL_ONCE_FILE)) {
        writeFileSync(process.env.FAKE_ACP_FAIL_ONCE_FILE, "failed launch");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "429 too many requests", data: { http_status: 429, error_kind: "rate_limited" } } });
        return;
      }
      // A marker is observable before the held prompt has a terminal message.
      if (process.env.FAKE_ACP_ACCEPT_DIR && ["parallel-card", "parallel-card-retry", "cancel-ack"].includes(mode)) {
        writeFileSync(join(process.env.FAKE_ACP_ACCEPT_DIR, `${launchId}-${msg.id}.accepted`), String(Date.now()));
      }
      if (process.env.FAKE_ACP_PROMPT_DUMP) writeFileSync(process.env.FAKE_ACP_PROMPT_DUMP, JSON.stringify(msg.params?.prompt ?? null));
      // FAKE_CUSTOM_TOOL_SERVER (fake-custom-tool.ts): call the first tool of
      // that owner server, started from the session's mcpServers entry.
      const customPrompt = (Array.isArray(msg.params?.prompt) ? msg.params.prompt : []).map((part: { text?: unknown }) => String(part?.text ?? "")).join("\n");
      const browserReplay = customPrompt.includes("__fixture_browser_read__:");
      const webReplay = /__fixture_(?:web|browser)_read__:(http:\/\/127\.0\.0\.1:\d+\/sales)/.exec(customPrompt);
      if (webReplay) {
        void (async () => {
          const update = (value: object) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: value } });
          let seq = 0;
          try {
            const servers: McpEntry[] = JSON.parse(liveServers ?? "[]");
            const entry = servers.find(s => s.name === (browserReplay ? "browser" : "agents")); if (!entry) throw Error("Replay tool mount missing");
            await (browserReplay ? replayBrowserRead : replayWebRead)({ command: entry.command, args: entry.args ?? [], env: Object.fromEntries((entry.env ?? []).map(e => [e.name, e.value])) }, webReplay[1], (input: any, output: unknown) => {
              const toolCallId = `web-${++seq}`;
              update({ sessionUpdate: "tool_call", toolCallId, title: browserReplay ? `browser__${input.name}` : "agents__web_read", kind: "fetch", status: "in_progress", rawInput: input });
              update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: output });
            });
            await replayCommands(customPrompt, async (command, i) => {
              const answer: any = await new Promise(resolve => {
                proposalAsks.set(9700 + i, resolve);
                out({ jsonrpc: "2.0", id: 9700 + i, method: "session/request_permission", params: { sessionId: msg.params.sessionId,
                  toolCall: { toolCallId: `shell-${i}`, title: command, kind: "execute", rawInput: { command } },
                  options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
              });
              if (answer?.outcome?.optionId !== "allow-once") throw Error("Replay shell refused");
            }, (command, output, i) => update({ sessionUpdate: "tool_call", toolCallId: `shell-${i}`, title: command, kind: "execute", status: "completed", rawInput: { command }, rawOutput: output }));
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Replay completed" } });
          } catch (error) { update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Replay failed: ${String(error)}` } }); }
          result(msg.id, { stopReason: "end_turn" });
        })(); return;
      }
      const customServer = customToolServer(customPrompt);
      if (customServer) {
        let servers: McpEntry[] = [];
        try { servers = JSON.parse(liveServers ?? "[]") as McpEntry[]; } catch { servers = []; }
        const entry = servers.find((server) => server?.name === customServer);
        const promptText = customPrompt;
        void (async () => {
          const outcome = entry
            ? await callFirstCustomTool("acp", customServer, { command: entry.command, args: entry.args ?? [], env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText)
            : { tools: [], text: `no ${customServer} server was mounted`, isError: true };
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: customToolReply(outcome) } } } });
          result(msg.id, { stopReason: "end_turn" });
        })();
        return;
      }
      if (mode.startsWith("fuigo18-contract:")) {
        const variant = mode.slice("fuigo18-contract:".length);
        dumpState.promptRequests = Number(dumpState.promptRequests ?? 0) + 1;
        if (process.env.FAKE_ACP_DUMP) writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState));
        const retry = (attempt: number, message: string) => out({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: message },
            _meta: { "fuigo/retryStatus": { type: "retrying", attempt, error_type: variant === "success" ? "api" : "empty_response", http_status: 503 } } },
        } });
        retry(1, "Retry status: HTTP 503, retrying request.\n\n");
        retry(2, "Retry status: final engine attempt.\n\n");
        if (variant === "success") {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The completed answer." } } } });
          result(msg.id, { stopReason: "end_turn", _meta: { pending_attempts: ["superseded-503-attempt"] } });
        } else {
          const data = variant === "empty" ? { message: "No visible answer after three attempts", error_kind: "empty_response" }
            : variant === "blank-http" ? { message: "   ", error_kind: "api", http_status: 503 }
              : variant === "untyped-prose" ? { message: "empty response from model (reasoning_only)" }
                : { message: "empty response from model (reasoning_only)", error_kind: "rate_limited" };
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data } });
        }
        return;
      }
      if (mode === "reasoning-only:string" || mode === "reasoning-only:object") {
        const message = "empty response from model (reasoning_only)";
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: mode.endsWith(":string") ? message : { message, error_kind: "empty_response" } } });
        return;
      }
      if (mode === "exit-with-stderr-history") {
        process.stderr.write("STDERR_EARLY_CANARY\nsk-test-" + "SYNTHETICKEYCANARY".repeat(24) + "\n" + ("x".repeat(4000) + "\n").repeat(4) + "STDERR_VISIBLE_END\n", () => process.exit(4));
        return;
      }
      if (mode === "fuigo-retry:restream" || mode === "fuigo-retry:tool" || (mode === "fuigo-retry:tool-burst" || mode === "fuigo-retry:tool-batch") || mode === "fuigo-retry:tool-coalesced") {
        // Fuigo resends the request after a mid-stream failure: the same
        // answer streams again from the start, announced by retry_state.
        if (mode === "fuigo-retry:tool-coalesced") outputBatch = [];
        const sid = msg.params.sessionId;
        const burst: unknown[] = [];
        const frame = (value: unknown) => (mode === "fuigo-retry:tool-burst" || mode === "fuigo-retry:tool-batch") ? burst.push(value) : out(value);
        const chunk = (text: string) => frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        const retrying = (n: number) => frame({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "retry_state", type: "retrying", attempt: n }, _meta: { eventId: `retry-${n}`, agentTimestampMs: Date.now() } } });
        if (mode === "fuigo-retry:restream") {
          chunk("A1"); retrying(1); chunk("A2"); retrying(2); chunk("A3");
        } else {
          chunk("Before. ");
          frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-retry", title: "run", kind: "execute" } } });
          frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-retry", status: "completed", rawOutput: "done" } } });
          chunk("After one. "); retrying(1); chunk("Final answer.");
        }
        if ((mode === "fuigo-retry:tool-burst" || mode === "fuigo-retry:tool-batch")) {
          burst.push({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          process.stdout.write(burst.map(value => JSON.stringify(value)).join("\n") + "\n");
        } else result(msg.id, { stopReason: "end_turn" });
        if (outputBatch) { const frames = outputBatch; outputBatch = undefined; process.stdout.write(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"); }
        return;
      }
      if (mode.startsWith("fuigo-retry:disc-")) {
        // Fuigo 1.0.22: retryDiscard advertised at initialize; the discarding
        // retry_state carries discardEmitted and streamStartMs, the dead
        // attempt's chunks carry _meta.streamStartMs.
        const sid = msg.params.sessionId;
        const chunk = (text: string, startMs?: number, kind = "agent_message_chunk", extra: any = {}) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: kind, content: { type: "text", text } }, ...(startMs !== undefined || extra.meta ? { _meta: { ...(startMs !== undefined ? { streamStartMs: startMs } : {}), ...(extra.meta ?? {}) } } : {}) } });
        const retry = (update: any, method = "_fuigo/session_notification", meta: any = {}) => out({ jsonrpc: "2.0", method, params: { sessionId: sid, update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, ...update }, _meta: { eventId: `r-${Math.random().toString(36).slice(2)}`, agentTimestampMs: Date.now(), ...meta } } });
        const completed = () => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "response_completed", stop_reason: "end_turn" }, _meta: {} } });
        const variant = mode.slice("fuigo-retry:disc-".length);
        if (variant === "hosted-burst") outputBatch = [];
        if (variant === "exact") {
          chunk("Earlier. ", 100); completed(); chunk("BAD", 200); retry({ discardEmitted: true, streamStartMs: 200 }); chunk("Final", 300);
        } else if (variant === "nodiscard") {
          chunk("A", 1); retry({}); chunk("B", 2); retry({ streamStartMs: 2 }); chunk("C", 3);
        } else if (variant === "boundary") {
          chunk("R1 "); completed(); chunk("R2bad"); retry({ discardEmitted: true }); chunk("R2ok");
        } else if (variant === "status") {
          chunk("Think. ", 1, "agent_thought_chunk"); chunk("BAD", 1); retry({ discardEmitted: true, streamStartMs: 1 });
          chunk("Retrying after a hiccup", undefined, "agent_thought_chunk", { meta: { "fuigo/retryStatus": { attempt: 1 } } });
          chunk("Final", 2);
        } else if (variant === "resurrect") {
          chunk("Old ", 1, "agent_thought_chunk"); chunk("Done.", 1);
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t-res", title: "look", kind: "read", status: "completed" } } });
          chunk("New", 2, "agent_thought_chunk"); retry({ discardEmitted: true, streamStartMs: 2 }); chunk("Final", 3);
        } else if (variant.startsWith("hosted")) {
          // Responses-path hosted tools: the row streams inside the attempt,
          // tagged with its streamStartMs and `_meta.backend`.
          const tool = (id: string, startMs: number, backend = true) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: id, title: backend ? "web_search" : "read", kind: backend ? "fetch" : "read", status: "in_progress" }, _meta: { streamStartMs: startMs, ...(backend ? { backend: true } : {}) } } });
          const done = (id: string, startMs: number, backend = true) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "ok" }, _meta: { streamStartMs: startMs, ...(backend ? { backend: true } : {}) } } });
          if (variant === "hosted") {
            chunk("A", 1); tool("ws-1", 1); done("ws-1", 1); retry({ discardEmitted: true, streamStartMs: 1 });
            chunk("A2", 2); tool("ws-2", 2); done("ws-2", 2); chunk(" Answer.", 2); completed();
          } else if (variant === "hosted-open") {
            chunk("A", 1); tool("ws-1", 1); retry({ discardEmitted: true, streamStartMs: 1 });
            chunk("A2", 2); tool("ws-2", 2); done("ws-2", 2); completed();
          } else if (variant === "hosted-nodiscard") {
            chunk("A", 1); tool("ws-1", 1); retry({}); chunk("B", 1); done("ws-1", 1); completed();
          } else if (variant === "hosted-ok" || variant === "hosted-burst") {
            // an ordinary successful hosted search; the untagged thought after
            // response_completed marks when the text was saved
            chunk("Let me search.", 1); tool("ws-1", 1); done("ws-1", 1); chunk("Here is what I found.", 1); completed();
            chunk("mark", undefined, "agent_thought_chunk");
          } else if (variant === "hosted-twin") {
            chunk("Let me search.", 1); tool("ws-1", 1); tool("ws-2", 1); done("ws-1", 1); done("ws-2", 1); chunk("Found.", 1); completed();
          } else if (variant === "hosted-local") {
            // a client-executed row (tagged, not backend), then a backend row
            // without streamStartMs: the text before each is committed first
            chunk("Let me read.", 1); tool("rd-1", 1, false); done("rd-1", 1, false); chunk("A", 1);
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "ws-1", title: "web_search", kind: "fetch", status: "in_progress" }, _meta: { backend: true } } });
            done("ws-1", 1); chunk("B", 1); completed();
          } else if (variant === "hosted-epoch") {
            // the discarding retry_state carries no streamStartMs
            chunk("A", 1); tool("ws-1", 1); retry({ discardEmitted: true }); chunk("A2", 2); completed();
          } else if (variant === "hosted-rowonly") {
            // the discarded attempt streamed only a running row, no text, and
            // the discarding retry_state carries no streamStartMs
            tool("ws-1", 1); retry({ discardEmitted: true }); tool("ws-2", 2); done("ws-2", 2); chunk("A2", 2); completed();
          } else if (variant === "hosted-rowonly-done") {
            // a row of a response that already completed is not that attempt's
            tool("ws-1", 1); completed(); retry({ discardEmitted: true }); done("ws-1", 1); chunk("B", 2); completed();
          } else if (variant === "hosted-many") {
            // a discarded attempt with 600 hosted rows still running: more
            // than the 512 the driver once tracked
            for (let index = 1; index <= 600; index++) tool(`ws-${index}`, 1);
            retry({ discardEmitted: true, streamStartMs: 1 }); chunk("A2", 2); completed();
          } else if (variant === "hosted-client") {
            chunk("R", 1); completed(); tool("rd-1", 1, false);
            chunk("X", 2); tool("ws-2", 2); retry({ discardEmitted: true, streamStartMs: 2 });
            done("rd-1", 1, false); chunk("Y", 3); completed();
          }
        } else if (variant === "carrier") {
          chunk("X", 5);
          retry({ discardEmitted: true, streamStartMs: 5 }, "_fuigo/session/update", { isReplay: true });
          chunk("Y", 6);
          retry({ discardEmitted: true, streamStartMs: 5 }, "_fuigo/session/update");
        }
        result(msg.id, { stopReason: "end_turn" });
        if (outputBatch) {
          const frames = outputBatch; outputBatch = undefined;
          process.stdout.write(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
        }
        return;
      }
      // no-reason:<observed|bare|blank>: the 1.0.19 meetgreet failure. The engine's own retries end (retry_state failed, kind api),
      // a stop notice says error/api, and session/prompt is rejected with -32603 and nothing that explains it.
      if (mode.startsWith("no-reason:")) {
        const variant = mode.slice("no-reason:".length);
        if (variant === "observed") {
          out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "retry_state", type: "failed", error_type: "api", creditLimit: false, hold: false }, _meta: { eventId: "fixture-no-reason-1", agentTimestampMs: Date.now() } } });
          out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params.sessionId, stopReason: "error", errorKind: "api" } });
        }
        out({ jsonrpc: "2.0", id: msg.id, error: variant === "bare" ? { code: -32603 } : { code: -32603, message: "Internal error" } });
        return;
      }
      if (mode.startsWith("fuigo-diagnostic:")) {
        const variant = mode.slice("fuigo-diagnostic:".length);
        const params: any = {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "retry_state", type: "failed", error_type: "api", message: "fake-secret-canary", reason: "fake-private-reason", url: "https://billing.invalid/?key=fake-secret-canary", promptUsage: "fake-private-prompt" },
          _meta: { eventId: "fixture-event-1", agentTimestampMs: Date.now() },
        };
        if (variant === "foreign") params.sessionId = "foreign-session";
        if (variant === "replay") params._meta.isReplay = true;
        if (variant === "old") params._meta.agentTimestampMs = 1;
        if (variant === "missing-time") delete params._meta.agentTimestampMs;
        if (variant === "future") params._meta.agentTimestampMs += 60_000;
        if (variant === "malformed") params.update = [params.update];
        if (variant === "unbounded") params.update.message = "x".repeat(9000);
        if (variant === "unknown") params.update.error_type = "fake-secret-canary";
        if (variant === "retry") params.update.type = "retrying";
        out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params });
        if (variant === "success" || variant === "unmatched") {
          if (variant === "unmatched") out({ jsonrpc: "2.0", id: -999, error: { code: -32603, message: "Internal error" } });
          // a success answers with something; a bare end_turn is a lost turn
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture reply" } } } });
          result(msg.id, { stopReason: "end_turn" });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { http_status: 404, message: "fixture rejection https://billing.invalid/?key=fake-secret-canary",...(variant==="terminal"?{error_kind:"max_tokens_truncation"}:{}) } } });
        }
        return;
      }
      if (mode === "cancel-end-turn") {
        pendingCancelAckPrompt = msg.id;
        setInterval(() => {}, 1_000);
        return;
      }
      // cancel-ignore (U24): hold session/prompt open and never answer session/cancel, so only the driver's grace timer ends the turn.
      if (mode === "cancel-ack" || mode === "cancel-rpc-error" || mode === "cancel-reject" || mode === "cancel-other-reason" || mode === "cancel-ignore") {
        pendingCancelAckPrompt = msg.id;
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      // unasked-edit: an engine that changes a file with no permission ask (Cursor in its agent mode, OpenClaw
      // without read-only), then keeps working until it is cancelled. refused-edit: the engine's own read-only
      // switch fails the same edit, and the turn ends normally.
      if (mode === "unasked-edit" || mode === "refused-edit") {
        pendingCancelAckPrompt = msg.id;
        const tool = (update: Record<string, unknown>) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { toolCallId: "tc-edit", ...update } } });
        tool({ sessionUpdate: "tool_call", title: "Write notes.txt", kind: "edit", status: "pending", rawInput: { file_path: "notes.txt" } });
        tool({ sessionUpdate: "tool_call_update", status: mode === "unasked-edit" ? "completed" : "failed" });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture after edit" } } } });
        if (mode === "refused-edit") { pendingCancelAckPrompt = null; result(msg.id, { stopReason: "end_turn" }); return; }
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-on-cancel") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "error-on-term") {
        // Stop All signals the engine: it answers the waiting prompt with an error while it goes down, before the driver sees the close. POSIX-only.
        const promptId = msg.id;
        process.once("SIGTERM", () => {
          out({ jsonrpc: "2.0", id: promptId, error: { code: -32603, message: "fixture engine closing" } });
          setTimeout(() => process.exit(0), 100);
        });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-on-prompt" || mode === "exit-with-ansi" || mode === "exit-hostile-stderr" || mode === "exit-noisy-stderr") {
        // Four kilobytes of structured debug records with the fatal line
        // last: how a CLI agent actually goes down, and the shape that says
        // whether the card quotes the END of a crash or its run-up.
        const noisy = `${Array.from({ length: 40 }, (_, i) =>
          `{"time":"2026-09-16T03:14:${String(i).padStart(2, "0")}Z","level":"debug","msg":"plugin ${i} registered from the model cache"}`).join("\n")
          }\nFATAL: engine could not open the model file: permission denied\n`;
        const diagnostic = mode === "exit-with-ansi"
          ? `\u001b[31mtool_error: fixture failure\u001b[0m\nsk-test-${"SYNTHETICKEYCANARY".repeat(24)}\n\u001b[32mSTDERR_VISIBLE_END\u001b[0m\n`
          // A bidi override, a BEL, a credential-bearing https URL and a
          // user:pass@IP-literal authority — the content the engine-error
          // fixtures put in `error.data`, written to stderr instead.
          : mode === "exit-hostile-stderr"
            ? `\u001b[31mtool_error: fixture failure\u001b[0m\n\u202ereached https://billing.invalid/?key=fake-secret-canary\u0007\nvia proxyuser:fakepass@10.1.2.3:8443/v1 and gave up\n`
            : mode === "exit-noisy-stderr" ? noisy : "fake-acp: simulated prompt exit\n";
        process.stderr.write(diagnostic, () => process.exit(1073807364));
        return;
      }
      if (mode === "load-proof") {
        void loadProof(msg.id, msg.params?.sessionId).catch(() => { process.exitCode = 1; });
        return;
      }
      if (mode.startsWith("engine-error-data:")) {
        const data = {
          object: { message: "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop", error_kind: "empty_response" },
          string: "No response from model for 90s — the model may be stuck",
          hostile: {
            message: `\u001b[31mupstream failed\u001b[0m\r\n\u0007at https://billing.invalid/?key=fake-secret-canary via proxyuser:fake-secret-canary@proxy.invalid:8080 with sk-test-${"SYNTHETICKEYCANARY".repeat(2)}: {"error":{"request":"fake-private-request"}}`,
            error_kind: "http\nEngine error code: 1",
            token: "fake-secret-canary",
          },
        }[mode.slice("engine-error-data:".length)];
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data } });
        return;
      }
      // The same hostile content in the JSON-RPC `error.message` instead of
      // `error.data`: an engine controls both, and both reach the card.
      if (mode.startsWith("engine-error-message:")) {
        const message = {
          hostile: `\u001b[31mupstream\u001b[0m\u0007 failed at https://billing.invalid/?key=fake-secret-canary via proxyuser:fake-secret-canary@proxy.invalid:8080`,
          plain: "fixture provider rejected the request",
        }[mode.slice("engine-error-message:".length)];
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } });
        return;
      }
      if (mode === "fuigo-live-notices") {
        // one diagnostic line over the old 64 KiB notice-line bound comes first: the notices after it are still read
        process.stderr.write("ordinary diagnostic\n" + "d".repeat(100 * 1024) + "\nfuigo: lowercase log line\nFu");
        setTimeout(() => {
          process.stderr.write("igo: found memory from an older version at /home/u/.fuigo/memory/old. It belongs to another repository. Memory for this repository now lives at /home/u/.fuigo/memory/new. Nothing was deleted.\r\nFuigo: the feedback session archive was NOT uploaded. token=fixture-secret-canary\nFuigo: " + "x".repeat(1400) + "\nFuigo: fourth shown\n");
          // A live output marker lets tests observe delivery without an exit.
          setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "notices written" } },
          } }), 25);
          // Stay live until interrupted so the test cannot pass on exit capture.
        }, 25);
        return;
      }
      if (mode === "stderr-rpc-error" || mode === "stderr-happy") {
        const lines = ["STDERR_EVICTED_FIRST_LINE"];
        for (let i = 0; i < 200; i++) lines.push(`\u001b[2mretry ${i}: empty response from model (reasoning_only), waiting\u001b[0m`);
        lines.push(`auth header sk-test-${"SYNTHETICKEYCANARY".repeat(2)}`);
        lines.push("\u001b[33mSTDERR_LAST_LINE retry 15/15 gave up\u001b[0m");
        process.stderr.write(`${lines.join("\n")}\n`, () => {
          // let the driver read stderr before the prompt settles
          setTimeout(() => {
            if (mode === "stderr-happy") {
              // a success answers with something; a bare end_turn is a lost turn
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture reply" } } } });
              result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
            }
            else out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { message: "fixture engine failure" } } });
          }, 200);
        });
        return;
      }
      if (mode === "credit-exhausted") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: {
          http_status: 402,
          // Fuigo 1.0.18 tags a provider rejection `api`. The typed kind rides
          // the whole path here: driver event -> bus -> store -> API -> card.
          error_kind: "api",
          // Three kinds of provider text: a sentence the reader knows but rewords, prose it does not know, and a link with a token.
          message: "API error (status 402 Payment Required): This team's credit balance is exhausted. FIXTURE_PROVIDER_PROSE_CANARY https://billing.invalid/?token=fake-secret-canary",
        } } });
        return;
      }
      if (mode.startsWith("flux-refusal:")) {
        const [, code, shape] = mode.split(":");
        const body = shape === "flat" ? { error: code } : { error: { code } };
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { http_status: 402, body } } });
        return;
      }
      if (mode === "flux-budget" || mode === "flux-hold") {
        // A Cloud model-credits refusal as a router sends it: budget used (with the reset instant) or a service hold (header only).
        // Held back a moment: the test switches the home role on while this waits (the role is read when the answer arrives).
        setTimeout(() => out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: {
          http_status: 402,
          message: "Your credit balance is exhausted. key fk_id_fake manage at https://fluxrouter.ai/home/keys?token=fake-secret-canary",
          ...(mode === "flux-budget" ? { provider_specific_fields: { error: "key_budget_reached", resets_at: "2030-03-05T00:00:00Z" } } : { headers: { "x-flux-hold-reason": "billing" } }),
        } } }), 700);
        return;
      }
      if (["payment-required:missing","payment-required:private","payment-required:flux-url"].includes(mode)) {
        out({ jsonrpc:"2.0", id:msg.id, error:{code:-32603,message:"Internal error",data:{http_status:402,
          ...(mode==="payment-required:missing"?{}:{message:mode==="payment-required:flux-url"?"Account access unavailable. https://fluxrouter.ai/home/billing?token=fake-secret-canary":"private response fake-secret-canary https://billing.invalid/private"}),
        }} });
        return;
      }
      if (fixtureRequested(String(msg.params?.prompt?.[0]?.text ?? ""), "__fixture_cancel_ack__")) {
        markerCancelAck = true;
        pendingCancelAckPrompt = msg.id;
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        return;
      }
      // gated-result:<text|empty|other|error>: hold session/prompt until FAKE_ACP_PROMPT_GATE exists, then answer it that way.
      if (mode.startsWith("gated-result:")) {
        const kind = mode.slice("gated-result:".length);
        setInterval(() => {}, 1_000);
        whenFile(process.env.FAKE_ACP_PROMPT_GATE!, () => {
          if (kind === "error") { out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "The prompt failed" } }); return; }
          // one valid frame over the limit and no result: the driver's overflow handler ends the turn
          if (kind === "overflow") { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: fixtureOversizeText() } } } }); return; }
          if (kind === "text") out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "late reply" } } } });
          result(msg.id, { stopReason: kind === "other" ? "max_tokens" : "end_turn" });
          // a steered line the prompt did not take runs as the engine's own fallback turn after the result (a failed prompt drops it)
          setImmediate(runStrandedInterjection);
        });
        return;
      }
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "slow-tool" || mode === "stall-after-tool") {
        const tool = (update: Record<string, unknown>) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { toolCallId: "tc-slow", ...update } } });
        // ACP's default status is pending: this tool_call carries none.
        tool({ sessionUpdate: "tool_call", title: "sleep", rawInput: { command: "sleep 45 && echo done" } });
        tool({ sessionUpdate: "tool_call_update", status: "in_progress" });
        const finishTool = () => tool({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } });
        if (mode === "stall-after-tool") {
          // FAKE_ACP_TOOL_NEVER_FINISHES: an engine that never reports the
          // tool as finished (the guard's tool cap is the only bound).
          if (!process.env.FAKE_ACP_TOOL_NEVER_FINISHES) finishTool();
          setInterval(() => {}, 1_000);
          return;
        }
        setTimeout(() => {
          finishTool();
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
        }, Number(process.env.FAKE_ACP_TOOL_MS ?? 600));
        return;
      }
      if (mode === "stall-after-text") {
        // Stream a chunk, then go fully silent forever: no further update, no
        // result, no exit. The shape of a wedged OpenCode agent that stopped
        // mid-answer. Nothing else will ever arrive, so only the driver's own
        // prompt idle guard can end this turn.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half an answer, then silence" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "fail-after-text") {
        // Stream real text, THEN fail the turn — the shape of a crash
        // mid-answer. This is the one case where the routine-failed/done
        // notification dedup is load-bearing: the reply is non-empty, so
        // nothing else suppresses the generic done.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        recordMethod("session/prompt.result");
        if (process.env.FAKE_ACP_PROMPT_SCOPE === "1") {
          const bg = process.env.FAKE_ACP_PSCOPE_BACKGROUND;
          out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "turn_completed", prompt_id: pscopeCurrent, stop_reason: "end_turn", ...(bg === "absent" ? {} : { background: Number(bg ?? 0) }) } } });
        }
        setImmediate(runStrandedInterjection);
        scheduleLateFrames(msg.params?.sessionId);
        if (process.env.FAKE_ACP_BARE_REJECT_CANCELS && bareRejectAnswered) {
          bareRejectAnswered = false;
          result(msg.id, { stopReason: "cancelled" });
          return;
        }
        if (process.env.FAKE_ACP_BARE_REJECT_CANCELS && rejectFollowup !== null) {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `FOLLOWUP: ${rejectFollowup}` } } } });
          rejectFollowup = null;
        }
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT === "fuigo"
            ? { stopReason: "end_turn", _meta: { inputTokens: 1, outputTokens: 2, usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, costUsdTicks: 2500000000 } } }
            // Fuigo 1.0.47+ after a retried call with no whole-prompt usage: last attempt unprefixed, every resend in billed*
            : process.env.FAKE_ACP_USAGE_ROOT === "fuigo-billed"
            ? { stopReason: "end_turn", _meta: { totalTokens: 12, inputTokens: 10, outputTokens: 2, billedTotalTokens: 36, billedInputTokens: 30, billedOutputTokens: 6 } }
            // "fuigo-billed-part": only billedOutputTokens beside the unprefixed counts (the input side was never resent)
            : process.env.FAKE_ACP_USAGE_ROOT === "fuigo-billed-part"
            ? { stopReason: "end_turn", _meta: { totalTokens: 12, inputTokens: 10, outputTokens: 2, billedOutputTokens: 6 } }
            // opencode 1.18.25 (upstream #1993): inputTokens is only the
            // uncached share, cache reads sit beside it, totalTokens is the sum.
            : process.env.FAKE_ACP_USAGE_ROOT === "cache-beside"
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 90, totalTokens: 105 }, _meta: {} }
            // an agent that marks its own usage incomplete
            : process.env.FAKE_ACP_USAGE_ROOT === "incomplete"
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 90, usageIsIncomplete: true }, _meta: {} }
            // cache reads beside a maximal input: the whole prompt is not representable
            : process.env.FAKE_ACP_USAGE_ROOT === "overflow"
            ? { stopReason: "end_turn", usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cachedReadTokens: 1 }, _meta: {} }
            // an agent that counts cache reads inside inputTokens
            : process.env.FAKE_ACP_USAGE_ROOT === "cache-inside"
            ? { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 90, totalTokens: 105 }, _meta: {} }
            : process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
        const split = process.env.FAKE_ACP_PSCOPE_SPLIT;
        if (process.env.FAKE_ACP_PROMPT_SCOPE === "1" && split && pscopePrompts.length === 1) {
          const sid = msg.params?.sessionId;
          const frame = JSON.stringify(split === "request"
            ? { jsonrpc: "2.0", id: 9300, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "pscope-split-9300", title: "Ask begun before the handoff", kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } }
            : { jsonrpc: "2.0", method: "session/update", params: {
              sessionId: split === "foreign-status" ? "fixture-other-session" : sid,
              _meta: { promptId: null, ...(split === "replay" ? { isReplay: true } : {}) },
              update: { sessionUpdate: "available_commands_update", availableCommands: [] },
            } });
          const cut = Math.floor(frame.length / 3);
          process.stdout.write(frame.slice(0, cut));
          pscopeSplitTail = frame.slice(cut);
        }
      };
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      // lane review: a review run answers with its verdict (fake-review.ts)
      const reviewText = fakeReviewReply(promptText);
      if (reviewText !== null) {
        const say = (text: string) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); };
        if (fakeReviewByTool() && agentsMcp && (process.env.FAKE_REVIEW_TOOL === "double" || process.env.FAKE_REVIEW_TOOL === "concurrent")) {
          const entry = agentsMcp;
          const call = { name: "project_review_result", args: () => fakeReviewToolArgs(promptText) };
          // Both calls share the admitted MCP connection, as concurrent calls from one real engine do.
          // Replay on that same connection after both replies and the answer block, before ending the turn.
          const replay = { name: call.name, args: () => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: reviewText } } } });
            if (process.env.FAKE_REVIEW_REPLAY_LOG) appendFileSync(process.env.FAKE_REVIEW_REPLAY_LOG, JSON.stringify({ sent: true }) + "\n");
            return call.args();
          } };
          void driveMcp(entry, [call, call, replay], process.env.FAKE_REVIEW_TOOL === "concurrent")
            .then(() => complete()).catch((e: Error) => say(`review tool error: ${e.message}`));
          return;
        }
        if (fakeReviewByTool() && agentsMcp) {
          void driveMcp(agentsMcp, [{ name: "project_review_result", args: () => fakeReviewToolArgs(promptText) }])
            .then(reply => say(`Reviewed with the tool: ${reply}`)).catch((e: Error) => say(`review tool error: ${e.message}`));
          return;
        }
        say(reviewText);
        return;
      }
      if (mode === "retry-status-thought") {
        // Wire shape of fuigo-shell retry_status_update (1.0.18): a thought, never answer text.
        const retryStatus = { type: "retrying", attempt: 1, max_retries: 2, reason: "empty response from model (reasoning_only)", error_type: "empty_response" };
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Retrying the model (1/2): empty response from model (reasoning_only)\n\n" }, _meta: { "fuigo/retryStatus": retryStatus } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fixture reasoning" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture final answer" } } } });
        complete();
        return;
      }
      if (mode === "plan") {
        // Wire shape of SessionUpdate::Plan (agent-client-protocol-schema 0.11):
        // every update carries the whole list; the client replaces its copy.
        const plan = (entries: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan", entries } } });
        plan([
          { content: "Read the folder", priority: "high", status: "in_progress" },
          { content: "Fix the bug", priority: "medium", status: "pending" },
        ]);
        plan("not a list");
        plan([
          { content: "Read the folder", priority: "high", status: "completed" },
          { content: "Fix the bug", priority: "medium", status: "in_progress" },
          { content: "", priority: "low", status: "pending" },
          { content: "Report back", priority: "low", status: "someday" },
        ]);
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture plan answer" } } } });
        complete();
        return;
      }
      if (mode === "folder-trust") {
        if (trustRaiseOnPrompt) {
          const raise = trustRaiseOnPrompt;
          trustRaiseOnPrompt = null;
          raise();
        }
        // the reply says what the session was built with, the way a real
        // turn's answer would (or would not) carry an AGENTS.md instruction
        const reply = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `agents: ${agentsMdForReply()}` } } } });
          complete();
        };
        const thenCommand = process.env.FAKE_ACP_TRUST_THEN_COMMAND;
        const answer = !thenCommand ? reply : () => {
          pendingPermissionId = 9301;
          onPermissionAnswered = reply;
          out({ jsonrpc: "2.0", id: 9301, method: "session/request_permission", params: { sessionId: msg.params?.sessionId,
            toolCall: { toolCallId: "t-trust-command", title: thenCommand, kind: "execute", rawInput: { command: thenCommand } },
            options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] } });
        };
        // The real engine's prompt runs gated while its request is open; the
        // fake instead finishes the turn only once the client has answered,
        // so a test can read the answer from the dump before the driver
        // tears the child down (the client always answers: a known decision
        // at once, a card when the owner does, and a cancel when the turn
        // ends).
        if (pendingPermissionId === 9006 && process.env.FAKE_ACP_TRUST_FAIL_PROMPT === "1") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "fake-acp: simulated prompt failure while the trust request is open" } });
          return;
        }
        if (pendingPermissionId === 9006 && !process.env.FAKE_ACP_TRUST_PROMPT_FIRST) {
          // FAKE_ACP_TRUST_HOLD_MS: the turn keeps running this long after the reply
          const hold = Number(process.env.FAKE_ACP_TRUST_HOLD_MS ?? 0);
          onPermissionAnswered = hold > 0 ? () => { setTimeout(answer, hold); } : answer;
          return;
        }
        answer();
        return;
      }
      // Bounded-ingress fixtures (A4), keyed on the prompt so one fake can
      // run an oversized turn beside an ordinary one.
      if (fixtureRequested(promptText, "__fixture_subagents__")) {
        void playSubagents(msg);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_tool_after_turn__")) {
        // a background task that keeps working after end_turn
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "handed to a background task" } } } });
        complete();
        setTimeout(() => {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "bg-1", title: "make clean", kind: "execute" } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "in_progress" } } });
        }, 150);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_summary_with_work__")) {
        // a trailing-allowed update type that smuggles a tool call or a prompt
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
        complete();
        const sid = msg.params?.sessionId;
        const extra = process.env.FAKE_ACP_SMUGGLE === "prompt"
          ? { prompt: [{ type: "text", text: "continue" }] }
          : { toolCall: { toolCallId: "late-tool", kind: "execute" } };
        setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "last_turn_summary" }, ...extra } }), 100);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_summary_after_turn__")) {
        // what real Fuigo sends after end_turn: last_turn_summary ~0.3 s, then title metadata
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
        complete();
        const sid = msg.params?.sessionId;
        setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "last_turn_summary", summary: "did a thing" } } }), 300);
        setTimeout(() => {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_summary_generated", title: "A title" } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_info_update", title: "A title" } } });
        }, 900);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_wake_after_turn__")) {
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "will wake later" } } } });
        complete();
        setTimeout(() => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "turn_completed", prompt_id: "self-1", stop_reason: "end_turn" } } }), 2_000);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_child_later__")) {
        // background work that starts its own child only after the turn ended
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a shell will start later" } } } });
        complete();
        setTimeout(() => {
          const later = spawn("sleep", ["30"], { windowsHide: true, stdio: "ignore" });
          if (process.env.FAKE_ACP_CHILD_PID_FILE) writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(later.pid));
        }, Number(process.env.FAKE_ACP_CHILD_DELAY_MS) || 800);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_child_after_turn__")) {
        // a shell a tool started during the turn and left running past end_turn
        const leftover = spawn("sleep", ["30"], { windowsHide: true, stdio: "ignore" });
        if (process.env.FAKE_ACP_CHILD_PID_FILE) writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(leftover.pid));
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "left a shell running" } } } });
        complete();
        return;
      }
      if (fixtureRequested(promptText, "__fixture_request_after_turn__")) {
        // background work that outlives the turn and asks for permission once
        // the turn is over (a Fuigo background task or subagent)
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started in the background" } } } });
        complete();
        setTimeout(() => out({
          jsonrpc: "2.0", id: 9100, method: "session/request_permission",
          params: { sessionId: msg.params?.sessionId, toolCall: { toolCallId: "late-1", title: "make clean", kind: "execute" },
            options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] },
        }), 150);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_oversize_frame__")) {
        // a VALID frame one KiB over the limit, then a clean success: the
        // driver must fail the turn rather than read past the dropped frame
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: fixtureOversizeText() } } } });
        complete();
        return;
      }
      if (fixtureRequested(promptText, "__fixture_oversize_open_frame__")) {
        // an oversized frame that never ends; stay alive until stopped
        process.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"${fixtureOversizeText()}`);
        setInterval(() => {}, 1_000);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_large_frame__")) {
        // an inline image at the harness's 10 MiB image cap: near the size a
        // real frame reaches, and well inside the frame limit
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: fixtureLargeImageBase64(), mimeType: "image/png" } } } });
        complete();
        return;
      }
      if (mode === "text-propose" && promptText.includes("<murage-project-proposal")) {
        // Lane N2: the Chief answers with the proposal block in its reply. First the model
        // tries a native shell command, as a gated engine asks for it; the answer is logged.
        const options = [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }];
        void new Promise<string>(resolve => {
          proposalAsks.set(9401, result => resolve(String(result?.outcome?.optionId ?? result?.outcome?.outcome ?? "none")));
          out({ jsonrpc: "2.0", id: 9401, method: "session/request_permission", params: { sessionId: msg.params?.sessionId, toolCall: { toolCallId: "t-shell", title: "cat /etc/hosts", kind: "execute", rawInput: { command: "cat /etc/hosts" } }, options } });
        }).then(shell => {
          logProposalTurn({ engine: process.env.FAKE_PROPOSE_ENGINE ?? "acp", asks: { shell }, agentsMounted: Boolean(agentsMcp) });
          // "[fail]" in the owner's words: half a reply, then the turn fails; "[stall]": a whole block, then silence
          if (promptText.includes("[fail]")) {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Half a thought about the report" } } } });
            out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
            return;
          }
          if (promptText.includes("[tool-stall]")) {
            // a line, a tool (the engine closes the text item there), then the whole block streams and the engine goes silent
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Let me look first." } } } });
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t-think", title: "Thinking", kind: "think", status: "completed" } } });
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
            return;
          }
          if (promptText.includes("[stall]")) {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
            return;
          }
          // Optional unapproved search: tripwire engines must reject it; ordinary proposal fixtures omit it.
          if (!agentsMcp && process.env.FAKE_ACP_PROPOSE_NO_UNASKED !== "1") out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t-search", title: "Web search", kind: "search", status: "completed", rawInput: { query: "quarterly report" } } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
          complete();
        });
        return;
      }
      if (mode === "project-propose" && agentsMcp && promptText.includes("project_propose")) {
        // The Chief's New project proposal (lane N): through the mounted agents server only.
        // First the engine asks, as a gated engine does: a native shell command, a native
        // edit dressed up as the propose tool, and Fuigo's own use_tool call of project_propose.
        const entry = agentsMcp;
        const options = [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }];
        const ask = (id: number, toolCall: Record<string, unknown>) => new Promise<string>(resolve => {
          proposalAsks.set(id, result => resolve(String(result?.outcome?.optionId ?? result?.outcome?.outcome ?? "none")));
          out({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: msg.params?.sessionId, toolCall, options } });
        });
        const toolName = `${(entry as { name?: string }).name ?? "agents"}__project_propose`;
        const proposal = proposalFrom(promptText);
        const fuigoUseTool = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", read_only: false } };
        if (process.env.FAKE_ACP_PROPOSE_UNASKED === "1") {
          // An engine that reads a file on its own, with no ask, then proposes a second later.
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "p-unasked", title: "Read", kind: "read", status: "pending", rawInput: { path: "/etc/hosts" } } } });
          void new Promise(resolve => setTimeout(resolve, 1000))
            .then(() => proposeThroughMcp({ command: entry.command, args: entry.args, env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText, { unasked: true }))
            .then(text => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); })
            .catch(() => complete());
          return;
        }
        // Fuigo's own tool items before the asks, as it stamps them: the catalog search (kind read) and the
        // use_tool call of project_propose, labelled by the inner name and carrying the model's input (R9-4)
        const item = (toolCallId: string, title: string, kind: string, rawInput: unknown, name: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput, _meta: { "fuigo/tool": { version: 1, namespace: "fuigo_build", name, kind: name, read_only: name === "search_tool" } } } } });
        item("p-search", "search_tool", "read", { query: "project_propose" }, "search_tool");
        item("p-use-item", toolName, "other", { variant: "UseTool", tool_name: toolName, tool_input: proposal }, "use_tool");
        void (async () => ({
          shell: await ask(9201, { toolCallId: "p-shell", title: "echo proposal > ./notes.txt", kind: "execute", rawInput: { command: "echo proposal > ./notes.txt" } }),
          disguised: await ask(9202, { toolCallId: "p-edit", title: "use_tool", kind: "edit", rawInput: { tool_name: toolName, input: proposal } }),
          read: await ask(9204, { toolCallId: "p-read", title: "use_tool", kind: "read", rawInput: proposal }),
          titled: await ask(9205, { toolCallId: "p-title", title: toolName, kind: "other", rawInput: { path: "/etc/hosts" } }),
          otherMount: await ask(9206, { toolCallId: "p-mount", title: "use_tool", kind: "other", rawInput: { variant: "UseTool", tool_name: "agents__project_propose", tool_input: proposal }, _meta: fuigoUseTool }),
          propose: await ask(9203, { toolCallId: "p-use", title: "use_tool", kind: "other", rawInput: { variant: "UseTool", tool_name: toolName, tool_input: proposal }, _meta: fuigoUseTool }),
        }))()
          .then(asks => proposeThroughMcp({ command: entry.command, args: entry.args, env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText, { asks }))
          .then(text => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); })
          .catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `propose error: ${(error as Error).message}` } } } }); complete(); });
        return;
      }
      if (mode === "chief-delegate" && (promptText.includes("CHIEF_RESULT_CONTEXT") || /the task you handed off/.test(promptText))) {
        const sawDelegatedResult =
          promptText.includes("@LongWorker replied to the delegated task")
          && promptText.includes("long delegated task");
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: sawDelegatedResult
                  ? "chief saw delegated result: long delegated task"
                  : "chief did not see delegated result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (
        mode === "chief-delegate"
        && agentsMcp
        && promptText.includes("ASSIGN_TO_PEER")
        && !promptText.includes("CHIEF_FOLLOW_UP")
      ) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "long delegated task",
              reason: "background assignment",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `assigned: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "memory-search" && memoryMcp) {
        // A bot's explicit recall: the prompt names the query after MSEARCH:,
        // the injected memory proxy is asked through memory_search, and the
        // outcome (never the remembered text) goes to FAKE_ACP_MEMORY_LOG.
        const allText = (Array.isArray(msg.params?.prompt) ? msg.params.prompt : []).map((part: { text?: unknown }) => String(part?.text ?? "")).join("\n");
        const query = /MSEARCH: ([^\n]+)/.exec(allText)?.[1]?.trim() || "weekly client report";
        const started = performance.now();
        const say = (text: string) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); };
        const note = (row: object) => { if (process.env.FAKE_ACP_MEMORY_LOG) appendFileSync(process.env.FAKE_ACP_MEMORY_LOG, JSON.stringify({ at: Date.now(), ms: Math.round(performance.now() - started), ...row }) + "\n"); };
        void driveMcp(memoryMcp, [{ name: "memory_search", args: () => ({ query }) }]).then(text => {
          let body: any = null;
          try { body = JSON.parse(text); } catch { /* the proxy's own sentence */ }
          note(body && typeof body === "object"
            ? { hits: Array.isArray(body.hits) ? body.hits.length : null, degradedReason: body.degradedReason ?? null, partial: body.partial ?? null, recentFallback: body.recentFallback ?? null, coverageComplete: body.coverageComplete ?? null, keys: Object.keys(body).filter(key => key !== "hits") }
            : { hits: null, proxy: text.slice(0, 120) });
          say(`memory search answered: ${body && Array.isArray(body.hits) ? body.hits.length : 0} hits`);
        }).catch(error => { note({ hits: null, error: String(error?.message ?? error).slice(0, 120) }); say("memory search failed"); });
        return;
      }
      if ((mode === "ask-peer" || mode === "create-peer") && agentsMcp
        && /^\[(?:Message from|Delegated by) @/m.test(promptText)) {
        // A nested helper answers its assignment, while proving that the
        // actual injected MCP server still supplies its scoped directory.
        // The native relay withholds private depth metadata. Script the peer
        // response from its visible assignment; comms tests independently
        // observe the real server-side depth and its absence on the wire.
        void driveMcp(agentsMcp, [{ name: "list_bots", args: () => ({}) }]).then(list => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `hello from fake acp; agents tools available\n${list}` } } } });
          complete();
        }).catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${error.message}` } } } }); complete(); });
        return;
      }
      if (mode === "batch-delegate" && agentsMcp) {
        // Result wakes continue the assignment; they do not request another
        // batch. Check them before the script below, including when a rebuilt
        // prompt carries the original user assignment in its history. This
        // must also work after session/load in a fresh fake process.
        if (/^- @.+ (?:replied to|did not finish) the task you handed off \(task id /m.test(promptText)) {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "BATCH RESUMED: read the teammates' replies" } } } });
          complete();
          return;
        }
        let targets: string[] = [];
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          ...Array.from({ length: 8 }, (_, index) => ({ name: "delegate_bot", args: (previous: string) => {
            if (index === 0) targets = previous.split("\n").filter(line => line.startsWith("- Batch helper ")).map(line => /id: ([\w-]+)/.exec(line)?.[1] ?? "");
            if (targets.length !== 8) throw new Error("batch fixture requires exactly eight helpers");
            return { bot_id: targets[index], message: `batch work ${index}` };
          } })),
        ]).then(reply => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `eight assignments queued: ${reply}` } } } }); complete(); })
          .catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `batch error: ${error.message}` } } } }); complete(); });
        return;
      }
      if (mode === "fuigo-surface" && agentsMcp) {
        // Emulate Fuigo's model surface: no MCP tool is callable bare. Follow
        // the prompt's qualified use_tool instruction, then dispatch via MCP.
        const qualified = /use_tool with tool_name "(agents__ask_bot)"/.exec(promptText)?.[1];
        const reply = (text: string) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); };
        if (!qualified) { reply("Tool not found: ask_bot"); return; }
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          { name: qualified.slice("agents__".length), args: list => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "PF qualified tool reached you" }) },
        ]).then(result => reply(`qualified MCP result: ${result}`)).catch(error => reply(`qualified MCP error: ${error.message}`));
        return;
      }
      const roomInstruction = promptText.lastIndexOf("(Reply to the conversation above as ");
      const roomResultWake = mode === "delegate-peer" && roomInstruction >= 0
        && promptText.slice(roomInstruction).includes("Results came back for work you handed over.");
      if (roomResultWake || ((mode === "ask-peer-resume" || mode === "delegate-peer" || mode === "create-peer")
        && /^\[Murage: while you were away, the teammate you asked finished\.\n- @.+ (?:replied to|did not finish) the task you handed off \(task id /m.test(promptText))) {
        // lane 0163-delegate-wake: the woken lead picks its work back up
        // Only the control-plane wake resumes it. An ordinary room prompt
        // can replay earlier handoff/reply words before a fresh assignment.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "LEAD RESUMED: finished with the teammate's reply" } } } });
        complete();
        return;
      }
      if (mode === "ask-peer" && /- @\S+ (?:replied to|did not finish) the task you handed off \(task id /.test(promptText)) {
        // RECALL-SKIP-DROP: a woken asker answers its wake and asks no one. Re-running the ask here sent a late wake
        // from one test to whichever bot the NEXT test had just made (the first one list_bots names), so on a slow
        // machine that test's ask found its peer busy: no card, no conversion reply.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "ASKER RESUMED: read the teammate's reply" } } } });
        complete();
        return;
      }
      if ((mode === "ask-peer" || mode === "ask-peer-resume") && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => {
              const requested = /Ask ([^\n]+) to reply\./.exec(promptText)?.[1];
              const peer = requested ? list.split("\n").find(line => line.startsWith(`- ${requested} [`)
                || line.startsWith(`- ${requested}:`) || line.startsWith(`- ${requested} (`)) ?? "" : list;
              return { bot_id: /id: ([\w-]+)/.exec(peer)?.[1] ?? "", message: "ping from fake" };
            },
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "delegate-staged-review" && agentsMcp) {
        if (promptText.includes('SEED_ROUTINE_REVIEW') && !promptText.includes('Hand Run task to staged B.')) { out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Routine seed complete.' } } } }); complete(); return; }
        const target = JSON.parse(readFileSync(process.env.FAKE_BOTCREATE_TARGET_FILE!, 'utf8')).id;
        void driveMcp(agentsMcp, [{ name: 'delegate_bot', args: () => ({ bot_id: target, message: 'CFIX_ROUTINE_PEER Run task' }) }]).then(async reply => {
          out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: reply } } } });
          while (!existsSync(process.env.FAKE_BOTCREATE_GATE!)) await new Promise(resolve => setTimeout(resolve, 50));
          complete();
        }).catch(error => { out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: String(error) } } } }); complete(); });
        return;
      }
      if(mode==="create-peer"&&promptText.includes("Results came back for work you handed over")) {
        out({jsonrpc:"2.0",method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{text:"Team handoff settled."}}}});complete();return;
      }
      if (mode === "create-peer" && agentsMcp && promptText.includes("Continue with Pixel and delegate the design review.")) {
        // Creation changes the roster and retires the old consuming turn.
        // On the person's fresh follow-up, discover the real created bot and
        // submit the handoff through this new turn's actual agents mount.
        void driveMcp(agentsMcp,[
          {name:"list_bots",args:()=>({})},
          {name:"delegate_bot",args:list=>({bot_id:/Pixel[^\n]*\bid: ([\w-]+)/.exec(list)?.[1]??(list.includes("Pixel")?"Pixel":""),message:"Review the new onboarding flow.",reason:"design review"})},
        ]).then(reply=>{out({jsonrpc:"2.0",method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{text:`team continued: ${reply}`}}}});complete();})
          .catch(error=>{out({jsonrpc:"2.0",method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{text:`team continuation error: ${String(error)}`}}}});complete();});
        return;
      }
      if (mode === "create-peer" && agentsMcp) {
        // a refused create surfaces its own words, not the empty delegate that follows it
        let createdReply = "";
        void driveMcp(agentsMcp, [
          {
            name: "create_bot",
            args: () => ({
              name: process.env.FAKE_BOTCREATE_NAME || "Pixel",
              role: "Product designer",
              instructions: "Design and review the user experience.",
            }),
          },
          {
            name: process.env.FAKE_BOTCREATE_TOOL || "delegate_bot",
            args: (created) => ({
              bot_id: /id: ([\w-]+)/.exec(createdReply = created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
          },
          ...(process.env.FAKE_BOTCREATE_TWO === '1' ? [{
            name: 'delegate_bot',
            args: () => ({ bot_id: /id: ([\w-]+)/.exec(createdReply)?.[1] ?? '', message: 'Review the second onboarding flow.', reason: 'second review' }),
          }] : []),
        ])
          .then(async (reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: /id: [\w-]+/.test(createdReply) ? `team created: ${reply}` : `create error: ${createdReply}` } } } });
            const gate = process.env.FAKE_BOTCREATE_GATE;
            while (gate && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 50));
            if (process.env.FAKE_BOTCREATE_OUTSIDE === '1') {
              out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'outside-after-hold', title: 'mcp__fixture__read_page', status: 'completed' } } });
            }
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated" || mode === "parallel-card" || mode === "parallel-card-retry") {
        // Parallel-card protocol: prove prompt acceptance, hold all workers at
        // the test's file barrier, then return one result. No network services.
        if (mode === "parallel-card" || mode === "parallel-card-retry") out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "PARALLEL_CARD_ACCEPTED\n" } } } });
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: mode !== "echo-gated" ? "Independent card finished." : `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      // FAKE_ACP_CONTINUATION_SILENT=1 (q1022 winproof): the turn that carries a routine run on after the owner answered its card
      // takes the prompt and then shows nothing at all (no text, no tool), until Murage cancels it
      if (mode === "project-image" && process.env.FAKE_ACP_CONTINUATION_SILENT === "1" && promptText.includes("this run was waiting on")) {
        pendingCancelAckPrompt = msg.id; markerCancelAck = true;
        return;
      }
      // room-credential-goal (1.0.23 winproof-fix): a room goal's lead asks the owner for a key through Murage's own request_credential
      // tool and pauses the goal on the owner (a valid needs-input decision, so the routine run stays live, waiting); the turn that
      // resumes it after the owner answers the key card takes the prompt and then shows nothing at all, until Murage cancels it
      if (mode === "room-credential-goal" && promptText.includes("Murage credential update")) {
        pendingCancelAckPrompt = msg.id; markerCancelAck = true;
        return;
      }
      if (mode === "room-credential-goal" && agentsMcp) {
        void driveMcp(agentsMcp, [{ name: "request_credential", args: () => ({ credential_id: "boxToken", reason: "The goal needs the Box key" }) }])
          .then(reply => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `key card: ${reply}\n<murage-goal>${JSON.stringify({ status: "needs-input", detail: "The goal needs the Box key from the owner" })}</murage-goal>` } } } }); complete(); })
          .catch((e: Error) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `key card error: ${e.message}` } } } }); complete(); });
        return;
      }
      if (mode === "project-image" && agentsMcp) {
        // a card run asks for an image through the mounted agents server and
        // waits on the owner's approval card (image-operations project hold)
        void driveMcp(agentsMcp, [{ name: "generate_image", args: () => ({ request_id: "late-allow-image", prompt: "A red cube on a white table" }) }])
          .then(reply => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `image: ${reply}` } } } }); complete(); })
          .catch((e: Error) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `image error: ${e.message}` } } } }); complete(); });
        return;
      }
      if (mode === "project-card-lead") {
        const woken = promptText.includes("Results came back for work you handed over");
        const assignee = /E2A_ASSIGN:([\w-]+)/.exec(promptText)?.[1];
        // lane review: a review that ended without a verdict leaves the lead to decide; this lead accepts
        const decide = /ended without a verdict, so you decide now \(card_id "([^"]+)"\)/.exec(promptText)?.[1];
        const text = decide ? `REVIEW_DECIDED\n<murage-goal>${JSON.stringify({ v: 2, status: "accept", card: decide })}</murage-goal>`
          : woken ? "CARD_RESULT_RECEIVED" : assignee
          ? `Assigning one card.\n<murage-goal>${JSON.stringify({ v: 2, status: "assign", cards: [{ key: "payments", assignee, title: "Assigned payments", description: "Count the payments and report the result", writes: false }] })}</murage-goal>`
          : "Waiting for the card assignment.";
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        complete(); return;
      }
      if ((mode === "lead-delegate" || mode === "lead-loop") && agentsMcp) {
        // turn-engine e2e (lane E1): a room lead hands work over with
        // delegate_bot; the teammate's result comes back as a wake whose
        // prompt says "Results came back". lead-delegate then reports what it
        // saw; lead-loop hands over again on every wake (the step cap test).
        const woken = promptText.includes("Results came back for work you handed over");
        const sawResult = woken && /<result from="[^"]+">/.test(promptText);
        if (woken && mode === "lead-delegate") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: sawResult ? "lead saw the result and is done" : "lead was woken without a result" } } } });
          complete();
          return;
        }
        if (!promptText.includes("LEAD_ASSIGN")) {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "lead has nothing to hand over" } } } });
          complete();
          return;
        }
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          // FAKE_ACP_DELEGATE_TO (as in delegate-peer): the peer to hand over to; default the first listed bot
          { name: "delegate_bot", args: (list) => ({ bot_id: process.env.FAKE_ACP_DELEGATE_TO ?? /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "LEAD_TASK please do the work", reason: "handover" }) },
        ])
          .then((reply) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `lead handed over: ${reply}` } } } }); complete(); })
          .catch((e) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `lead error: ${(e as Error).message}` } } } }); complete(); });
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              // FAKE_ACP_DELEGATE_TO: a peer's exact display name (a chain test picks its next hop); default the first listed bot
              bot_id: process.env.FAKE_ACP_DELEGATE_TO ?? /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: process.env.FAKE_ACP_DELEGATE_MESSAGE ?? "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "big-frame") {
        out({ jsonrpc: "2.0", method: "fake/bigFrame", params: { text: `BIGFRAME-CANARY ${"x".repeat(70_000)}` } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "A".repeat(70_000), mimeType: "image/png" } } } });
      }
      if (mode === "image") {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
            },
          },
        });
      } else if (mode === "interleave") playInterleaveTurn();
      else if (mode === "action-guard") {
        for (const update of [
          { sessionUpdate: "tool_call", toolCallId: "shell", title: "printf hello > notes.txt", kind: "execute", status: "in_progress", rawInput: { command: "printf hello > notes.txt" } },
          { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed", rawOutput: { exitCode: 0, stdout: "" } },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I saved the file." } },
        ]) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update } });
      }
      else if (mode === "wrapped-tool") playWrappedToolTurn();
      else if (mode === "tool-image") playToolImageTurn();
      else if (mode === "computer-exec-image") playComputerExecImageTurn();
      else if (mode === "wrapped-tool-image") playWrappedToolImageTurn();
      else if (mode === "reasoning-only") playReasoningTurn();
      else if (mode !== "empty-reply") playTurn(promptText);
      if (mode === "fuigo-question") {
        // Fuigo's AskUserQuestion over ACP: `_fuigo/ask_user_question` with
        // the exact AskUserQuestionExtRequest shape (types.rs), two
        // questions, one multi-select. Held until the client answers.
        pendingPermissionId = 9002;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "_fuigo/ask_user_question",
          params: {
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
            toolCallId: "tc-1",
            mode: "default",
            questions: [
              { question: "Which database?", options: [{ label: "Redis", description: "In-memory", preview: "<div/>" }, { label: "Postgres", description: "Relational" }] },
              { question: "Which frameworks?", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multiSelect: true },
            ],
          },
        });
        return;
      }
      if (mode === "vendor-question") {
        // A vendor's own ask (Grok Build's `x.ai/ask_user_question`, Cursor's
        // `cursor/ask_question`), exactly as the test hands it over.
        pendingPermissionId = 9007;
        onPermissionAnswered = complete;
        const askParams = JSON.parse(process.env.FAKE_ACP_ASK_PARAMS ?? "{}");
        // a sessionId in the given params names this session, as the real engine's does
        if ("sessionId" in askParams) askParams.sessionId = msg.params?.sessionId ?? "fake-acp-session";
        out({ jsonrpc: "2.0", id: pendingPermissionId, method: process.env.FAKE_ACP_ASK_METHOD, params: askParams });
        return;
      }
      if (mode === "fuigo-elicit" || mode === "grok-elicit") {
        // Fuigo's bridge of an MCP server's elicitation (McpElicitExtRequest):
        // ACP form fields plus serverName; the reply is tagged `outcome`.
        // Grok Build 1.0.70 sends the same request as `_x.ai/mcp/elicit`
        // (FAKE_ACP_ELICIT_METHOD picks another spelling).
        pendingPermissionId = 9005;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: mode === "grok-elicit" ? process.env.FAKE_ACP_ELICIT_METHOD || "_x.ai/mcp/elicit" : "_fuigo/mcp/elicit",
          params:
            mode === "grok-elicit"
              ? {
                  // an MCP server's billable confirm (a Yes/No form), as Grok forwards it
                  sessionId: msg.params?.sessionId ?? "fake-acp-session",
                  toolCallId: "mcp-elicit-grok-1",
                  serverName: "spicyapi",
                  message: "This run is billable. Continue?",
                  mode: "form",
                  requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Continue?" } }, required: ["confirm"] },
                }
              : {
                  sessionId: msg.params?.sessionId ?? "fake-acp-session",
                  toolCallId: "mcp-elicit-1",
                  serverName: "deployer",
                  message: "Which environment?",
                  mode: "form",
                  requestedSchema: { type: "object", properties: { environment: { type: "string", enum: ["staging", "production"] } }, required: ["environment"] },
                },
        });
        return;
      }
      // unknown-request: a vendor method nothing knows; FAKE_ACP_REQUEST_GATE holds it until the file exists.
      if (mode === "unknown-request") {
        pendingPermissionId = 9005;
        onPermissionAnswered = complete;
        const raise = () => out({ jsonrpc: "2.0", id: pendingPermissionId, method: "_vendor/unheard_of", params: { sessionId: msg.params?.sessionId ?? "fake-acp-session" } });
        const gate = process.env.FAKE_ACP_REQUEST_GATE;
        if (gate) { const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); raise(); } }, 10); } else raise();
        return;
      }
      // elicitation-malformed: a form whose schema the entry cannot read; FAKE_ACP_REQUEST_GATE holds the request until the file exists.
      if (mode === "elicitation-malformed") {
        pendingPermissionId = 9004;
        onPermissionAnswered = complete;
        const raise = () => out({ jsonrpc: "2.0", id: pendingPermissionId, method: "elicitation/create", params: { sessionId: msg.params?.sessionId ?? "fake-acp-session", mode: "form", message: "Bad form", requestedSchema: "not-a-schema" } });
        const gate = process.env.FAKE_ACP_REQUEST_GATE;
        if (gate) { const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); raise(); } }, 10); } else raise();
        return;
      }
      if (mode === "elicitation-form" || mode === "elicitation-legacy") {
        // ACP v1 elicitation/create in form mode (CreateElicitationRequest),
        // or the older Rust-crate spelling of the same request.
        pendingPermissionId = 9003;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: mode === "elicitation-legacy" ? "session/elicitation" : "elicitation/create",
          params: {
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
            toolCallId: "tc-2",
            mode: "form",
            message: "Deploy settings",
            requestedSchema: {
              type: "object",
              properties: {
                environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
                features: { type: "array", title: "Features", items: { type: "string", enum: ["cache", "cdn"] } },
                confirm: { type: "boolean", title: "Really?" },
              },
              required: ["environment", "confirm"],
            },
          },
        });
        return;
      }
      if (mode === "elicitation-url") {
        pendingPermissionId = 9004;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "elicitation/create",
          params: {
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
            mode: "url",
            elicitationId: "el-1",
            url: "https://example.com/authorize?state=abc",
            message: "Sign in to the deploy service to continue",
          },
        });
        return;
      }
      if (mode === "permission" || mode === "question-tool" || mode === "permission-session-first" || mode === "permission-edit-file" || mode === "permission-always-only") {
        // ask the client to approve a tool, then complete once answered.
        // question-tool: the agent routes its AskUserQuestion tool through
        // request_permission (named in the tool call), exactly the shape a
        // question must never be auto-approved from.
        if (process.env.FAKE_ACP_REQUIRE_PERMISSION_PROMPTS === "1" && !permissionPrompts) { complete(); return; }
        pendingPermissionId = 9001;
        permissionAskedAt = Date.now();
        onPermissionAnswered = complete;
        // FAKE_ACP_PERMISSION_TWICE=1: a new request after the first answer.
        // "replay": broken peer repeats the answered RPC with no intervening execution (GH-19).
        const ask = (askId: number) => out({
          jsonrpc: "2.0",
          id: askId,
          method: "session/request_permission",
          params: {
            // FAKE_ACP_PERMISSION_SESSION=1: name the live session, as the ACP
            // spec has a real engine do (the shorthand ask omits it)
            ...(process.env.FAKE_ACP_PERMISSION_SESSION === "1" && liveSession ? { sessionId: liveSession } : {}),
            toolCall: permissionToolCallNext && askId === 9002 && mode === "permission"
              ? permissionToolCallNext
              : permissionToolCall && mode === "permission"
              ? permissionToolCall
              : mode === "question-tool"
              ? {
                  kind: "other",
                  title: process.env.FAKE_ACP_QUESTION_TITLE || "AskUserQuestion",
                  rawInput: {
                    questions: [{
                      question: "Which branch should I use?",
                      header: "Branch",
                      options: [{ label: "main" }, { label: "develop" }],
                      multiSelect: false,
                    }],
                  },
                }
              : mode === "permission-edit-file"
              // An edit naming a file, the way an ACP engine reports one:
              // the protocol's `locations` plus the engine's structured
              // `rawInput`. FAKE_ACP_PERMISSION_FILE names the file.
              ? {
                  kind: "edit",
                  title: "Edit " + permissionFile,
                  rawInput: { file_path: permissionFile },
                  locations: [{ path: permissionFile }],
                }
              : { kind: "execute", rawInput: { command: permissionCommand }, title: permissionCommand },
            options: mode === "permission-session-first"
              // verbatim order and ids from a Fuigo 1.0.12 `Write` prompt
              ? [
                  { optionId: "allow-edits-session", kind: "allow_always", name: "Yes, allow all edits during this session" },
                  { optionId: "allow-once", kind: "allow_once", name: "Yes" },
                  { optionId: "reject-once", kind: "reject_once", name: "No, and tell Fuigo what to do differently" },
                ]
              : mode === "permission-always-only"
              // no one-time allow on offer: only a standing grant (an engine that remembers it)
              ? [
                  { optionId: "allow-always", kind: "allow_always", name: "Yes, and don't ask again for this command" },
                  { optionId: "reject-once", kind: "reject_once", name: "No" },
                ]
              : [
                  { optionId: "allow-once", kind: "allow_once" },
                  { optionId: "reject", kind: "reject_once" },
                ],
          },
        });
        // FAKE_ACP_REQUEST_GATE=<file>: hold the first ask until the file exists (a test revokes the lease before the engine asks).
        const requestGate = process.env.FAKE_ACP_REQUEST_GATE;
        if (requestGate) { const poll = setInterval(() => { if (existsSync(requestGate)) { clearInterval(poll); ask(9001); } }, 10); } else ask(9001);
        if (["1", "replay"].includes(process.env.FAKE_ACP_PERMISSION_TWICE ?? "")) {
          onPermissionAnswered = () => {
            pendingPermissionId = process.env.FAKE_ACP_PERMISSION_TWICE === "replay" ? 9001 : 9002;
            permissionAskedAt = Date.now();
            onPermissionAnswered = complete;
            ask(pendingPermissionId);
          };
        }
        return;
      }
      complete();
      break;
    }
    case "_x.ai/mcp/list":
    case "_fuigo/mcp/list": {
      // FAKE_ACP_MCP_LIST: per-server status JSON ({name: "ready" | "initializing"
      // | ...}), answered as Grok Build and Fuigo answer it; unset: method not found.
      if (!process.env.FAKE_ACP_MCP_LIST) { if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }); break; }
      const call = ++mcpListCalls;
      const unanswered = (process.env.FAKE_ACP_MCP_LIST_UNANSWERED ?? "").split(",").filter(Boolean);
      // FAKE_ACP_MCP_LIST_OVERSIZE_AT "N:ms": ms after list call N, one oversized frame (an overflow while that read is unanswered)
      const [oversizeAt, oversizeMs] = (process.env.FAKE_ACP_MCP_LIST_OVERSIZE_AT ?? "").split(":").map(Number);
      if (call === oversizeAt) setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: fixtureOversizeText() } } } }), oversizeMs || 0);
      if (unanswered.some((spec) => spec.endsWith("+") ? call >= Number(spec.slice(0, -1)) : call === Number(spec))) break;
      const listed = process.env.FAKE_ACP_MCP_LIST;
      const settling = Date.now() - mcpHandedAt < (Number(process.env.FAKE_ACP_MCP_LIST_READY_AFTER_MS) || 0);
      const states = listed.startsWith("all:")
        ? Object.fromEntries(lastMcpServerNames.map((name) => [name, settling ? "initializing" : listed.slice(4)]))
        : JSON.parse(listed) as Record<string, string>;
      // FAKE_ACP_MCP_LIST_OVERRIDE: JSON {name: status} laid over an "all:<status>" list (one server failed among ready ones).
      if (process.env.FAKE_ACP_MCP_LIST_OVERRIDE) for (const [name, status] of Object.entries(JSON.parse(process.env.FAKE_ACP_MCP_LIST_OVERRIDE) as Record<string, string>)) if (Object.hasOwn(states, name)) states[name] = status;
      if (!settling && listed.startsWith("all:") && !mcpListSettledLogged) { mcpListSettledLogged = true; mcpTimeline("ready"); }
      // FAKE_ACP_MCP_LIST_HELD: JSON array of Fuigo 1.0.47 held entries ({name, heldReason?, heldDigest?}), listed with no session.
      // FAKE_ACP_MCP_LIST_HELD_AFTER_SHOWN: the held set once one list has shown it (the owner edits the server after the card).
      heldNow ??= process.env.FAKE_ACP_MCP_LIST_HELD ? JSON.parse(process.env.FAKE_ACP_MCP_LIST_HELD) as HeldEntry[] : [];
      const held = heldNow;
      if (held.length && process.env.FAKE_ACP_MCP_LIST_HELD_AFTER_SHOWN && !heldChanged) { heldChanged = true; heldNow = JSON.parse(process.env.FAKE_ACP_MCP_LIST_HELD_AFTER_SHOWN) as HeldEntry[]; }
      result(msg.id, { servers: [...Object.entries(states).map(([name, status]) => ({ name, session: { enabled: true, status } })), ...held.map((entry) => ({ ...entry, held: true, session: null }))] });
      break;
    }
    case "_fuigo/mcp/toggle": {
      // FAKE_ACP_TOGGLE_ERROR: the engine's error text (a corrupt approvals store); unset answers {"ok":true}.
      if (process.env.FAKE_ACP_TOGGLE_ERROR) { if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: process.env.FAKE_ACP_TOGGLE_ERROR } }); break; }
      // Fuigo S3 (extensions/mcp.rs DEFINITION_CHANGED_AGAIN): a shown `digest` that is not the held one approves nothing.
      const current = heldNow?.find((entry) => entry.name === msg.params?.server_name);
      if (current && typeof msg.params?.digest === "string" && msg.params.digest !== current.heldDigest) {
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `MCP server \`${current.name}\`: definition changed again since it was shown; review it` } });
        break;
      }
      if (current) heldNow = heldNow!.filter((entry) => entry !== current);
      result(msg.id, { ok: true });
      break;
    }
    case "_fuigo/interject":
    case "_x.ai/interject": {
      const interjectMode = process.env.FAKE_ACP_INTERJECT;
      const ns = msg.method === "_x.ai/interject" ? "_x.ai" : "_fuigo";
      const echo = () => out({ jsonrpc: "2.0", method: `${ns}/session/interjection`, params: { sessionId: msg.params?.sessionId, text: msg.params?.text, interjectionId: msg.params?.interjectionId } });
      if (interjectMode === "fallback") {
        result(msg.id, { result: { status: "queued" } });
        echo();
        strandedInterjections.push({ text: String(msg.params?.text ?? ""), ns });
      } else if (interjectMode === "silent") {
        setTimeout(echo, Number(process.env.FAKE_ACP_LATE_ECHO_MS ?? 1000));
      } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      break;
    }
    case "session/cancel":
      if (markerCancelAck && pendingCancelAckPrompt !== null) {
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        markerCancelAck = false;
        // prompt scope (A8): a cancelled turn with no background work still reports itself quiet, so only the Stop keeps it unparked
        if (process.env.FAKE_ACP_PROMPT_SCOPE === "1") out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "turn_completed", prompt_id: pscopeCurrent, stop_reason: "cancelled", background: 0 } } });
        result(id, { stopReason: "cancelled" });
        break;
      }
      if (mode === "cancel-rpc-error" && pendingCancelAckPrompt !== null) {
        out({ jsonrpc: "2.0", id: pendingCancelAckPrompt, error: { code: -32603, message: "Internal error", data: "empty response from model (reasoning_only)" } });
        pendingCancelAckPrompt = null;
        break;
      }
      if ((mode === "cancel-ack" || mode === "unasked-edit") && pendingCancelAckPrompt !== null) {
        // A cooperative agent acknowledges promptly but only exits when the
        // client terminates it — the gap close-confirmed stop must cover.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "cancelled" });
        break;
      }
      if (mode === "cancel-reject" && pendingCancelAckPrompt !== null) {
        // The engine ends the cancelled prompt with a JSON-RPC error instead of
        // stopReason "cancelled", and keeps running until it is terminated.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { message: "turn cancelled by client", error_kind: "cancelled" } } });
        break;
      }
      if (mode === "cancel-end-turn" && pendingCancelAckPrompt !== null) {
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "end_turn" });
        break;
      }
      if (mode === "cancel-other-reason" && pendingCancelAckPrompt !== null) {
        // The engine ends the cancelled prompt with its own stop reason rather
        // than "cancelled", and keeps running until it is terminated.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "refusal" });
        break;
      }
      if (mode === "exit-on-cancel") {
        // Exit before replying to the outstanding prompt, inside the driver's
        // cancellation grace. POSIX truncates this Windows exit value to 4.
        process.exit(1073807364);
      }
      // the interrupted prompt resolves as cancelled
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
